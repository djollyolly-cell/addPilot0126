# Dedup: повторная попытка при неудачной остановке — Design Spec

**Дата:** 2026-04-18
**Статус:** Reviewed

---

## Проблема

`isAlreadyTriggeredToday` (internalQuery в ruleEngine.ts:497-524) имеет два дефекта:

1. **Не различает `status: "success"` и `status: "failed"`**. Если stopAd провалился (VK API timeout, 500, rate limit), actionLog записывается с `status: "failed"` → dedup блокирует повторную попытку на весь день → объявление крутится без контроля.

2. **Performance: `.collect()` всех логов правила** за всё время в память, фильтрует в JS. Для активных правил — лишняя нагрузка (десятки/сотни логов загружаются при каждой проверке).

Дополнительно:
- **Notify-only правила**: actionLog записывается как `status: "success"` ДО отправки TG (ruleEngine.ts:1686-1708). Если TG падает (строка 1756) — actionLog врёт, единственное действие не выполнено, retry не произойдёт.
- **`incrementTriggerCount`**: вызывается безусловно (строка 1720) до блока TG-уведомлений (строка 1725), включая failed попытки → статистика правила завышена.

## Решение

### Архитектура: fast path + чистая функция

```
isAlreadyTriggeredToday(ruleId, adId, sinceTimestamp)
  │
  ├─ Fast path: permanent dedup
  │    query by_ruleId_createdAt (desc) → filter(adId, success, stopped|stopped_and_notified) → .first()
  │    → если найден, return true (ad уже остановлен навсегда)
  │
  └─ Daily dedup + retry limit: делегирование чистой функции
       query by_ruleId_createdAt → .gte(sinceTimestamp) → filter(adId) → .collect()
       → shouldSkipDailyDedup(todayLogs, adId, sinceTimestamp) → boolean
```

**Почему так:**
- Permanent dedup — тривиальная логика, выигрывает от `.first()` (останавливается на первом match, не грузит все данные в память)
- Daily dedup + retry limit — сложная логика, выносим в чистую функцию `shouldSkipDailyDedup` для тестируемости
- Единый источник логики: query загружает данные, чистая функция принимает решение (нет дублирования)

**Архитектурное решение (reviewed):** Permanent dedup живёт ТОЛЬКО в Convex query (fast path). Чистая функция отвечает ТОЛЬКО за daily dedup + retry limit. Не дублировать permanent dedup в чистую функцию — это убило бы `.first()` оптимизацию (пришлось бы делать `.collect()` всех логов). План реализации ДОЛЖЕН вызывать `shouldSkipDailyDedup` из `isAlreadyTriggeredToday`, а не инлайнить логику — иначе тесты покрывают код, который не выполняется в production.

**Ограничение permanent dedup:** В Convex `.filter()` — post-index фильтрация. Для permanent dedup нет составного индекса `by_ruleId_adId`. В worst case (правило ни разу не останавливало этот adId) Convex прочтёт все логи правила до `.first()` match. На практике:
- Большинство правил имеют <100 логов → не проблема
- `.first()` + desc order: если ad был остановлен — находит быстро (последние записи проверяются первыми)
- Добавление нового составного индекса — out of scope (можно добавить позже если bottleneck проявится)

### Чистая функция `shouldSkipDailyDedup`

Отвечает только за daily dedup + failed retry limit. Permanent dedup в ней нет.

```typescript
const MAX_FAILED_RETRIES = 3; // 3 × 5 мин = 15 мин retry window

export interface ActionLogEntry {
  adId: string;
  status: "success" | "failed" | "reverted";
  actionType: "stopped" | "notified" | "stopped_and_notified";
  createdAt: number;
}
// Бюджетные типы (budget_increased, budget_reset, zero_spend_alert) логируются
// через logBudgetAction, которая вызывается только из checkUzBudgetRules.
// Этот flow не проходит через isAlreadyTriggeredToday — бюджетные логи
// никогда не попадут в todayLogs этой функции.

export function shouldSkipDailyDedup(
  logs: ActionLogEntry[],
  adId: string,
  sinceTimestamp: number
): boolean {
  // Defensive filter: query already filters by adId, today's range, and reverted,
  // but function is fully self-contained — duplicates all filters for:
  // 1. Independent testability (tests pass raw mixed data)
  // 2. Defense against query-layer bugs
  const adLogs = logs.filter(
    (log) =>
      log.adId === adId &&
      log.status !== "reverted" &&
      log.createdAt >= sinceTimestamp
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
  // Используем by_ruleId_createdAt в desc order для быстрого поиска последних записей
  const activeStop = await ctx.db
    .query("actionLogs")
    .withIndex("by_ruleId_createdAt", (q) => q.eq("ruleId", args.ruleId))
    .order("desc")
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

  return shouldSkipDailyDedup(todayLogs, args.adId, args.sinceTimestamp);
}
```

**Оптимизация vs текущий код:**

| Аспект | Было | Стало |
|---|---|---|
| Permanent dedup | `.collect()` всех логов → фильтр в JS | `.first()` + desc order — останавливается на первом match |
| Daily dedup | `.collect()` всех → фильтр `createdAt >= sinceTimestamp` в JS | `by_ruleId_createdAt` index range — только сегодняшние |
| Данные в памяти | Все actionLogs правила за всё время | Permanent: 0-1 запись. Daily: только сегодняшние для adId |
| Логика dedup | Вся в Convex query handler | Daily dedup делегирован чистой функции (тестируемо) |
| Failed retry | Любой лог за сегодня → skip | Только success → skip. Failed → retry до 3 раз |

### Notify-only failure tracking

**Проблема:** Для notify-only правил (без stopAd) actionLog записывается как `"success"` (строка 1705) до отправки TG (строка 1725). Если TG падает — actionLog врёт.

**Решение:**

1. Новый `updateActionLogStatus` internalMutation — патчит `status` и `errorMessage` по actionLogId.
   `createActionLog` уже возвращает `Id<"actionLogs">` (ruleEngine.ts:559), actionLogId доступен в scope.

```typescript
export const updateActionLogStatus = internalMutation({
  args: {
    actionLogId: v.id("actionLogs"),
    status: v.union(v.literal("success"), v.literal("failed"), v.literal("reverted")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.actionLogId, {
      status: args.status,
      ...(args.errorMessage !== undefined && { errorMessage: args.errorMessage }),
    });
  },
});
```

2. В catch-блоке TG (строка 1756): если `!rule.actions.stopAd`, обновить actionLog на `"failed"`:

```typescript
} catch (notifErr) {
  const notifMsg = notifErr instanceof Error ? notifErr.message : String(notifErr);
  // ... existing logging ...

  // Notify-only: TG failure = action failure → mark for retry
  if (!rule.actions.stopAd) {
    notifyFailed = true;
    await ctx.runMutation(internal.ruleEngine.updateActionLogStatus, {
      actionLogId,
      status: "failed",
      errorMessage: `TG notification failed: ${notifMsg.slice(0, 150)}`,
    });
  }
}
```

**Логика определения статуса:**
- stopAd + notify: статус по stopAd. Если stop=success, notify=fail → `"success"` (объявление остановлено, цель достигнута)
- notify-only: статус по notify. Если notify=fail → `"failed"` (единственное действие не выполнено → retry)

**Race window:** Между `createActionLog(status: "success")` и `updateActionLogStatus(status: "failed")` есть окно (~100ms), когда dedup может увидеть ложный "success". На практике это не проблема: cron запускается раз в 5 мин, вероятность попадания в окно ~0.03%. Если критично — можно в будущем перейти на `status: "pending"` (требует изменения схемы), но сейчас это over-engineering.

### incrementTriggerCount — только при успехе

Перемещается ПОСЛЕ блока TG-уведомлений (после строки 1774). Вызывается только при `finalStatus === "success"`:

```typescript
// After TG notification block
const finalStatus = (!rule.actions.stopAd && notifyFailed) ? "failed" : status;
if (finalStatus === "success") {
  await ctx.runMutation(internal.ruleEngine.incrementTriggerCount, { ruleId: rule._id });
}
```

## Тесты: 10 unit-тестов для `shouldSkipDailyDedup`

| # | Тест | Input | Expected |
|---|---|---|---|
| 1 | Success today → skip (daily dedup) | 1 success notified today | `true` |
| 2 | 1 failed today → allow retry | 1 failed stopped today | `false` |
| 3 | 2 failed today → allow retry | 2 failed stopped today | `false` |
| 4 | 3 failed today → hit limit, skip | 3 failed stopped today | `true` |
| 5 | Failed notify-only → allow retry | 1 failed notified today | `false` |
| 6 | Failed then success → skip (daily) | 1 failed + 1 success today | `true` |
| 7 | Multiple failed then success → skip | 2 failed + 1 success today | `true` |
| 8 | Reverted logs ignored | 1 reverted stopped today | `false` |
| 9 | Other ads ignored | 1 success stopped for different adId | `false` |
| 10 | No logs → allow | empty array | `false` |
| 11 | Yesterday's 3 failed → allow (new day) | 3 failed stopped yesterday (before sinceTimestamp) | `false` |

Permanent dedup (successful stops all-time) — тривиален, покрывается integration тестами.

## Файлы

| Действие | Файл | Что меняется |
|---|---|---|
| Modify | `convex/ruleEngine.ts` | `shouldSkipDailyDedup` экспортируемая чистая функция |
| Modify | `convex/ruleEngine.ts` | Переписать `isAlreadyTriggeredToday` (fast path + pure function) |
| Modify | `convex/ruleEngine.ts` | Добавить `updateActionLogStatus` internalMutation |
| Modify | `convex/ruleEngine.ts` | Notify-only: в catch TG обновлять status на "failed" |
| Modify | `convex/ruleEngine.ts` | `incrementTriggerCount` переместить после TG, вызывать только при success |
| Modify | `tests/unit/ruleEngine.test.ts` | 11 тестов для `shouldSkipDailyDedup` в отдельном describe |

## Что НЕ меняется

- Permanent dedup логика (успешная остановка блокирует навсегда) — сохраняется, оптимизируется запрос
- Логика evaluateCondition — без изменений
- Формат actionLogs — без изменений (поля те же, только status обновляется при notify fail)
- Схема БД — без изменений (индекс `by_ruleId_createdAt` уже существует, новых индексов не требуется)
- `hasRecentBudgetIncrease` — без изменений (уже корректно проверяет только `status: "success"`, failed budget actions уже retryable)
- `logBudgetAction` — без изменений (уже вызывает `incrementTriggerCount` только при `!args.error`)
- Admin alerts — без изменений (dedup по ключу `ruleEngine:${ruleId}:${adId}`, окно 30 мин). При 3 retry за 15 мин — максимум 1 admin alert.

## Сценарии

| Сценарий | Попытка 1 | Попытка 2 (5 мин) | Попытка 3 (10 мин) | Попытка 4 (15 мин) |
|---|---|---|---|---|
| VK API timeout → retry → success | failed | failed | **success → остановлено** | dedup (permanent) |
| VK API постоянно 500 | failed | failed | failed | **dedup (лимит 3)** |
| Успех с первой попытки | **success → остановлено** | dedup | dedup | dedup |
| Notify-only, TG ошибка | **failed** | retry | retry | **dedup (лимит 3)** |
| Notify-only, TG ok | success | dedup (daily) | dedup | dedup |
| Stop ok + TG fail | **success** (цель достигнута) | dedup (permanent) | dedup | dedup |
