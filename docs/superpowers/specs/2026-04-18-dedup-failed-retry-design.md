# Dedup: повторная попытка при неудачной остановке — Design Spec

**Дата:** 2026-04-18
**Статус:** Draft

---

## Проблема

`isAlreadyTriggeredToday` (internalQuery в ruleEngine.ts) имеет два дефекта:

1. **Не различает `status: "success"` и `status: "failed"`**. Если stopAd провалился (VK API timeout, 500, rate limit), actionLog записывается с `status: "failed"` → dedup блокирует повторную попытку на весь день → объявление крутится без контроля.

2. **Performance: `.collect()` всех логов правила** за всё время в память, фильтрует на клиенте. Для активных правил — лишняя нагрузка.

Дополнительно:
- **Notify-only правила**: actionLog всегда `status: "success"`, даже если Telegram не доставлен. Для notify-only это ложь — единственное действие не выполнено.
- **`incrementTriggerCount`**: вызывается безусловно до блока TG-уведомлений, включая failed попытки.

## Решение

### Архитектура: fast path + чистая функция

```
isAlreadyTriggeredToday(ruleId, adId, sinceTimestamp)
  │
  ├─ Fast path: permanent dedup
  │    query by_ruleId → filter(adId, success, stopped|stopped_and_notified) → .first()
  │    → если найден, return true (ad уже остановлен навсегда)
  │
  └─ Daily dedup + retry limit: делегирование чистой функции
       query by_ruleId_createdAt → .gte(sinceTimestamp) → filter(adId) → .collect()
       → shouldSkipDailyDedup(todayLogs, adId) → boolean
```

**Почему так:**
- Permanent dedup — тривиальная логика, выигрывает от `.first()` (останавливается на первом match, не грузит данные в память)
- Daily dedup + retry limit — сложная логика, выносим в чистую функцию `shouldSkipDailyDedup` для тестируемости
- Единый источник логики: query загружает данные, чистая функция принимает решение (нет дублирования)

### Чистая функция `shouldSkipDailyDedup`

Отвечает только за daily dedup + failed retry limit. Permanent dedup в ней нет.

```typescript
const MAX_FAILED_RETRIES = 3; // 3 × 5 мин = 15 мин retry window

export interface ActionLogEntry {
  adId: string;
  status: "success" | "failed" | "reverted";
  actionType: "stopped" | "notified" | "stopped_and_notified"
    | "budget_increased" | "budget_reset" | "zero_spend_alert";
  createdAt: number;
}

export function shouldSkipDailyDedup(
  todayLogs: ActionLogEntry[],
  adId: string
): boolean {
  const adLogs = todayLogs.filter(
    (log) => log.adId === adId && log.status !== "reverted"
  );

  // 1. Successful trigger today → skip
  if (adLogs.some((log) => log.status === "success")) return true;

  // 2. Failed retry limit: max 3 failed per day
  const failedCount = adLogs.filter((log) => log.status === "failed").length;
  return failedCount >= MAX_FAILED_RETRIES;
}
```

### Оптимизированный `isAlreadyTriggeredToday`

```typescript
handler: async (ctx, args) => {
  // Fast path: permanent dedup — successful stop any time
  const activeStop = await ctx.db
    .query("actionLogs")
    .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
    .filter((q) =>
      q.and(
        q.eq(q.field("adId"), args.adId),
        q.eq(q.field("status"), "success"),
        q.or(
          q.eq(q.field("actionType"), "stopped"),
          q.eq(q.field("actionType"), "stopped_and_notified")
        )
      )
    )
    .first();
  if (activeStop) return true;

  // Daily dedup + retry limit: delegate to pure function
  const todayLogs = await ctx.db
    .query("actionLogs")
    .withIndex("by_ruleId_createdAt", (q) =>
      q.eq("ruleId", args.ruleId).gte("createdAt", args.sinceTimestamp)
    )
    .filter((q) => q.eq(q.field("adId"), args.adId))
    .collect();

  return shouldSkipDailyDedup(todayLogs, args.adId);
}
```

**Оптимизация vs текущий код:**

| Аспект | Было | Стало |
|---|---|---|
| Permanent dedup | `.collect()` всех логов → фильтр в памяти | `.first()` server-side, останавливается на первом match |
| Daily dedup | `.collect()` всех → фильтр `createdAt >= sinceTimestamp` | `by_ruleId_createdAt` index range — только сегодняшние |
| Данные в памяти | Все actionLogs правила за всё время | Permanent: 0-1 запись. Daily: только сегодняшние для adId |
| Логика dedup | Вся в Convex query | Делегирована чистой функции (тестируемо) |

### Notify-only failure tracking

**Проблема:** Для notify-only правил (без stopAd) actionLog записывается как `"success"` до отправки TG. Если TG падает — actionLog врёт.

**Решение:**
1. Новый `updateActionLogStatus` internalMutation — патчит `status` и `errorMessage`
2. В catch-блоке TG: если `!rule.actions.stopAd`, обновить actionLog на `"failed"`

**Логика определения статуса:**
- stopAd + notify: статус по stopAd. Если stop=success, notify=fail → `"success"` (объявление остановлено, цель достигнута)
- notify-only: статус по notify. Если notify=fail → `"failed"` (единственное действие не выполнено → retry)

### incrementTriggerCount — только при успехе

Перемещается ПОСЛЕ блока TG-уведомлений. Вызывается только при `finalStatus === "success"`:

```typescript
const finalStatus = (!rule.actions.stopAd && notifyFailed) ? "failed" : status;
if (finalStatus === "success") {
  await ctx.runMutation(internal.ruleEngine.incrementTriggerCount, { ruleId: rule._id });
}
```

## Тесты: 11 unit-тестов для `shouldSkipDailyDedup`

| # | Тест | Input | Expected |
|---|---|---|---|
| 1 | Success today → skip (daily dedup) | 1 success notified today | `true` |
| 2 | 1 failed today → allow retry | 1 failed stopped today | `false` |
| 3 | 2 failed today → allow retry | 2 failed stopped today | `false` |
| 4 | 3 failed today → hit limit, skip | 3 failed stopped today | `true` |
| 5 | Failed notify-only → allow retry | 1 failed notified today | `false` |
| 6 | Failed then success → skip (daily) | 1 failed + 1 success today | `true` |
| 7 | Multiple failed then success → skip | 2 failed + 1 success today | `true` |
| 8 | budget_increased success today → daily dedup | 1 success budget_increased today | `true` |
| 9 | Reverted logs ignored | 1 reverted stopped today | `false` |
| 10 | Other ads ignored | 1 success stopped for different adId | `false` |
| 11 | No logs → allow | empty array | `false` |

Permanent dedup (successful stops all-time) — тривиален, покрывается integration тестами.

## Файлы

| Действие | Файл | Что меняется |
|---|---|---|
| Modify | `convex/ruleEngine.ts` | `shouldSkipDailyDedup` чистая функция + переписать `isAlreadyTriggeredToday` |
| Modify | `convex/ruleEngine.ts` | Добавить `updateActionLogStatus` internalMutation |
| Modify | `convex/ruleEngine.ts` | Notify-only failure tracking + `incrementTriggerCount` только при success |
| Modify | `tests/unit/ruleEngine.test.ts` | 11 тестов в отдельном describe |

## Что НЕ меняется

- Permanent dedup (успешная остановка) — без изменений
- Логика evaluateCondition — без изменений
- Формат actionLogs — без изменений (поля те же, только status обновляется при notify fail)
- Схема БД — без изменений (индекс `by_ruleId_createdAt` уже существует)
- Admin alerts — без изменений (dedup по ключу `ruleEngine:${ruleId}:${adId}`, окно 30 мин)
- `budget_increased`, `budget_reset`, `zero_spend_alert` — не создают permanent dedup

## Сценарии

| Сценарий | Попытка 1 | Попытка 2 (5 мин) | Попытка 3 (10 мин) | Попытка 4 (15 мин) |
|---|---|---|---|---|
| VK API timeout → retry → success | failed | failed | **success → остановлено** | dedup (permanent) |
| VK API постоянно 500 | failed | failed | failed | **dedup (лимит 3)** |
| Успех с первой попытки | **success → остановлено** | dedup | dedup | dedup |
| Notify-only, TG ошибка | **failed** | retry | retry | **dedup (лимит 3)** |
| Notify-only, TG ok | success | dedup (daily) | dedup | dedup |
