# Dedup: повторная попытка при неудачной остановке

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Если `stopAd` вернул ошибку, правило должно попытаться снова в следующем цикле (через 5 мин), а не блокироваться dedup на весь день

**Architecture:** Permanent dedup — в Convex query (fast path с `.first()` + desc). Daily dedup + retry limit — делегируется чистой функции `shouldSkipDailyDedup`. `isAlreadyTriggeredToday` ДОЛЖЕН вызывать чистую функцию, а не инлайнить логику.

**Tech Stack:** Convex (TypeScript), Vitest

---

## Проблема

Текущий dedup (`isAlreadyTriggeredToday` internalQuery, ruleEngine.ts:497-524):

```typescript
// Daily dedup: любой лог за сегодня (кроме reverted) → skip
return adLogs.some((log) => log.createdAt >= args.sinceTimestamp);
```

Два дефекта:
1. **Не различает `status: "success"` и `status: "failed"`**. Если остановка провалилась (VK API timeout, 500, rate limit), actionLog записывается с `status: "failed"` → dedup блокирует повторную попытку → объявление крутится весь день без контроля.
2. **Performance: `.collect()` всех логов правила**. Запрос с индексом `by_ruleId` возвращает ВСЕ actionLogs для правила за всё время, фильтрует в памяти. Для активных правил с сотнями/тысячами срабатываний — лишняя нагрузка.

## Решение

1. Извлечь daily dedup + retry limit в чистую функцию `shouldSkipDailyDedup` (тестируемость)
2. Permanent dedup остаётся в Convex query (fast path с `.first()` + `.order("desc")`)
3. `isAlreadyTriggeredToday` вызывает `shouldSkipDailyDedup`, не инлайнит логику
4. Оптимизировать query: `by_ruleId_createdAt` index range для daily
5. Для notify-only правил: обновлять actionLog на `"failed"` если Telegram не доставлен
6. `incrementTriggerCount` — только при реальном успехе

---

## Файлы

| Действие | Файл | Что меняется |
|---|---|---|
| Modify | `convex/ruleEngine.ts` | `shouldSkipDailyDedup` чистая функция + переписать `isAlreadyTriggeredToday` (fast path + вызов чистой функции) |
| Modify | `convex/ruleEngine.ts` | Добавить `updateActionLogStatus` internalMutation |
| Modify | `convex/ruleEngine.ts` | Notify-only: обновлять actionLog при ошибке TG + `incrementTriggerCount` только при успехе |
| Modify | `tests/unit/ruleEngine.test.ts` | 11 тестов для `shouldSkipDailyDedup` в отдельном describe |

---

### Task 1: Написать тесты для shouldSkipDailyDedup

**Files:**
- Modify: `tests/unit/ruleEngine.test.ts`

Проблема: `isAlreadyTriggeredToday` — это internalQuery (Convex), его нельзя напрямую тестировать юнит-тестом. Но мы можем извлечь daily-логику в чистую функцию и тестировать её.

Permanent dedup (successful stops all-time) — тривиален (`.first()` в Convex query), покрывается integration тестами. Чистая функция его НЕ содержит.

- [ ] **Step 1: Добавить чистую функцию в ruleEngine.ts (stub для компиляции тестов)**

В `convex/ruleEngine.ts`, перед `isAlreadyTriggeredToday`, добавить экспортируемую чистую функцию:

```typescript
// 3 попытки × 5 мин цикл = 15 минут retry window
const MAX_FAILED_RETRIES = 3;

export interface ActionLogEntry {
  adId: string;
  status: "success" | "failed" | "reverted";
  actionType: "stopped" | "notified" | "stopped_and_notified";
  createdAt: number;
}
// Бюджетные типы (budget_increased, budget_reset, zero_spend_alert) логируются
// через logBudgetAction, которая вызывается только из checkUzBudgetRules.
// Этот flow не проходит через isAlreadyTriggeredToday — бюджетные логи
// никогда не попадут в logs этой функции.

/**
 * Daily dedup + failed retry limit.
 * Pure function — testable without Convex context.
 *
 * Permanent dedup (successful stop any time) lives in the Convex query
 * (isAlreadyTriggeredToday fast path) — NOT duplicated here.
 *
 * Self-contained: defensively filters by adId, createdAt, reverted
 * even though query already applies these filters.
 */
export function shouldSkipDailyDedup(
  logs: ActionLogEntry[],
  adId: string,
  sinceTimestamp: number
): boolean {
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

- [ ] **Step 2: Написать тесты**

Добавить в `tests/unit/ruleEngine.test.ts` новый import и describe:

```typescript
// Добавить в import:
import {
  evaluateCondition,
  evaluateConditionTrace,
  calculateSavings,
  minutesUntilEndOfDay,
  matchesCampaignFilter,
  shouldSkipDailyDedup,
  ActionLogEntry,
  MetricsSnapshot,
  RuleCondition,
} from "../../convex/ruleEngine";
```

```typescript
// ═══════════════════════════════════════════════════════════
// shouldSkipDailyDedup — daily dedup + failed retry limit
// ═══════════════════════════════════════════════════════════

describe("shouldSkipDailyDedup", () => {
  const adId = "12345";
  const todayStart = new Date("2026-04-18T00:00:00Z").getTime();
  const now = new Date("2026-04-18T10:00:00Z").getTime();

  // --- Daily dedup (successful triggers today) ---

  it("skips when successfully notified today (daily dedup)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "success", actionType: "notified", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(true);
  });

  // --- Failed retry logic ---

  it("does NOT skip when only failed stop today (should retry)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "stopped_and_notified", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });

  it("does NOT skip when 2 failed attempts today (under limit)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "stopped", createdAt: now - 600000 },
      { adId, status: "failed", actionType: "stopped", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });

  it("skips after 3 failed attempts today (hit retry limit)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "stopped", createdAt: now - 1200000 },
      { adId, status: "failed", actionType: "stopped", createdAt: now - 600000 },
      { adId, status: "failed", actionType: "stopped", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(true);
  });

  it("allows retry for failed notify-only rule", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "notified", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });

  // --- Mixed scenarios ---

  it("skips after failed then success today (daily dedup)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "stopped", createdAt: now - 600000 },
      { adId, status: "success", actionType: "stopped", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(true);
  });

  it("skips when successful notify exists after failures (daily dedup)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "notified", createdAt: now - 600000 },
      { adId, status: "failed", actionType: "notified", createdAt: now - 300000 },
      { adId, status: "success", actionType: "notified", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(true);
  });

  // --- Edge cases ---

  it("ignores reverted logs", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "reverted", actionType: "stopped", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });

  it("ignores logs for other ads", () => {
    const logs: ActionLogEntry[] = [
      { adId: "99999", status: "success", actionType: "stopped", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });

  it("does NOT skip when no logs exist", () => {
    expect(shouldSkipDailyDedup([], adId, todayStart)).toBe(false);
  });

  it("does NOT skip when only yesterday's 3 failed logs (new day)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "stopped", createdAt: todayStart - 3000 },
      { adId, status: "failed", actionType: "stopped", createdAt: todayStart - 2000 },
      { adId, status: "failed", actionType: "stopped", createdAt: todayStart - 1000 },
    ];
    // Вчерашние failed не считаются — новый день, новая попытка
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });
});
```

- [ ] **Step 3: Запустить — тесты должны пройти (функция добавлена в Step 1)**

Run: `npm run test -- --run tests/unit/ruleEngine.test.ts`
Expected: ALL PASS (11 новых тестов)

---

### Task 2: Переписать isAlreadyTriggeredToday с оптимизацией и вызовом чистой функции

**Files:**
- Modify: `convex/ruleEngine.ts` (функция `isAlreadyTriggeredToday`)

- [ ] **Step 1: Переписать isAlreadyTriggeredToday**

Заменить тело `isAlreadyTriggeredToday` (от `handler:` до закрывающей `});`):

```typescript
export const isAlreadyTriggeredToday = internalQuery({
  args: {
    ruleId: v.id("rules"),
    adId: v.string(),
    sinceTimestamp: v.number(),
  },
  handler: async (ctx, args) => {
    // Fast path: permanent dedup — successful stop any time.
    // Uses by_ruleId_createdAt in desc order: newest logs first,
    // finds recent successful stops quickly. .first() stops at first match.
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

    // Daily dedup + retry limit: delegate to pure function.
    // Uses compound index by_ruleId_createdAt with range filter —
    // Convex only scans logs from sinceTimestamp onward.
    const todayLogs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId_createdAt", (q) =>
        q.eq("ruleId", args.ruleId).gte("createdAt", args.sinceTimestamp)
      )
      .filter((q) => q.eq(q.field("adId"), args.adId))
      .collect();

    return shouldSkipDailyDedup(todayLogs, args.adId, args.sinceTimestamp);
  },
});
```

**Оптимизация vs текущий код:**

| Аспект | Было | Стало |
|---|---|---|
| Permanent dedup | `.collect()` всех логов → фильтр в JS | `.first()` + desc order — останавливается на первом match |
| Daily dedup | `.collect()` всех → фильтр `createdAt >= sinceTimestamp` в JS | `by_ruleId_createdAt` index range `.gte()` — только сегодняшние |
| Daily dedup логика | Инлайн в Convex query handler | Делегирована `shouldSkipDailyDedup` (тестируемо) |
| Объём данных в памяти | Все actionLogs правила за всё время | Permanent: 0-1 запись. Daily: только сегодняшние для adId |

- [ ] **Step 2: Запустить тесты**

Run: `npm run test -- --run tests/unit/ruleEngine.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add convex/ruleEngine.ts tests/unit/ruleEngine.test.ts
git commit -m "fix: failed stopAd allows retry (max 3/day), optimize dedup query with index range"
```

---

### Task 3: Notify-only ошибки + incrementTriggerCount

**Две связанные проблемы** (объединены в один таск, т.к. разделение создаёт промежуточное некомпилируемое состояние — `notifyFailed` используется раньше, чем объявляется):

**Проблема A:** Когда правило с `notify` срабатывает, actionLog записывается со `status: "success"` ещё до отправки Telegram. Если Telegram падает — actionLog остаётся "success". Для notify-only правил (без stopAd) actionLog врёт: "успех", но пользователь ничего не получил.

**Проблема B:** `incrementTriggerCount` вызывается безусловно (строка 1718), включая failed попытки. С retry это завышает `triggerCount`. Кроме того, для notify-only правил `status` всегда `"success"` (дефолт), но если TG fails — `triggerCount` уже инкрементирован.

**Логика определения финального статуса:**
- `stopAd` + notify: статус определяется по stopAd (если stop=success, notify=fail → actionLog остаётся success, потому что основное действие выполнено)
- notify-only: статус определяется по notify (если notify=fail → actionLog = failed, потому что это единственное действие)

**Files:**
- Modify: `convex/ruleEngine.ts` (добавить `updateActionLogStatus` + перестроить конец per-ad loop)

- [ ] **Step 1: Добавить internalMutation updateActionLogStatus**

После закрывающей `});` функции `createActionLog`, добавить:

```typescript
/** Update actionLog status after-the-fact (e.g. when TG notification fails) */
export const updateActionLogStatus = internalMutation({
  args: {
    actionLogId: v.id("actionLogs"),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("reverted")
    ),
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

- [ ] **Step 2: Удалить текущий `incrementTriggerCount` блок (строки 1717-1721)**

Удалить:

```typescript
        // Update rule trigger count
        await ctx.runMutation(
          internal.ruleEngine.incrementTriggerCount,
          { ruleId: rule._id }
        );
```

- [ ] **Step 3: Добавить `let notifyFailed = false` перед блоком TG notification**

Перед `// Send Telegram notification if notify is enabled` добавить:

```typescript
        let notifyFailed = false;
```

- [ ] **Step 4: Обновить catch-блок TG notification**

В catch-блоке TG уведомления, после `systemLogger.log`, добавить:

```typescript
          } catch (notifErr) {
            const notifMsg = notifErr instanceof Error ? notifErr.message : String(notifErr);
            console.error(
              `[ruleEngine] Failed to send TG notification for rule ${rule._id}, ad ${adId}:`,
              notifMsg
            );
            try { await ctx.runMutation(internal.systemLogger.log, {
              userId: account.userId,
              level: "error",
              source: "ruleEngine",
              message: `TG notification failed for ad ${adId}: ${notifMsg.slice(0, 150)}`,
              details: { ruleId: rule._id, adId },
            }); } catch { /* non-critical */ }

            // Mark notify failure — used by incrementTriggerCount guard below
            notifyFailed = true;

            // Update actionLog status when notification fails for notify-only rules
            if (!rule.actions.stopAd && actionLogId) {
              try {
                await ctx.runMutation(internal.ruleEngine.updateActionLogStatus, {
                  actionLogId,
                  status: "failed",
                  errorMessage: `Telegram notification failed: ${notifMsg.slice(0, 200)}`,
                });
              } catch { /* non-critical */ }
            }
          }
```

- [ ] **Step 5: Добавить `incrementTriggerCount` ПОСЛЕ блока TG notification**

После закрывающей `}` блока `if (rule.actions.notify) { ... } else { ... }`, добавить:

```typescript
        // Update rule trigger count — only on actual success
        // For stopAd rules: success = stopAd succeeded (TG failure is non-critical)
        // For notify-only rules: success = TG notification delivered
        const finalStatus = (!rule.actions.stopAd && notifyFailed) ? "failed" : status;
        if (finalStatus === "success") {
          await ctx.runMutation(
            internal.ruleEngine.incrementTriggerCount,
            { ruleId: rule._id }
          );
        }
```

**Проверено:** `adminAlerts.notify` имеет dedup по ключу `ruleEngine:${rule._id}:${adId}` с окном 30 минут — спама алертов не будет при retry.

- [ ] **Step 6: Commit**

```bash
git add convex/ruleEngine.ts
git commit -m "fix: track notify-only failures in actionLog, incrementTriggerCount only on success"
```

---

### Task 4: Typecheck и build

- [ ] **Step 1: Typecheck Convex**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No new errors

- [ ] **Step 2: Build frontend**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Полный тест**

Run: `npm run test -- --run`
Expected: ALL PASS

---

## Итого

| Компонент | Было | Стало |
|---|---|---|
| Dedup при failed stop | Блокирует повтор на весь день | Разрешает до 3 retry, потом блокирует |
| Dedup при success | Блокирует навсегда (stop) / на день (notify) | Без изменений |
| `isAlreadyTriggeredToday` query | `.collect()` всех логов → фильтр в памяти | `.first()` для permanent + `by_ruleId_createdAt` range для daily |
| `isAlreadyTriggeredToday` логика | Вся логика внутри Convex query | Permanent в query, daily делегирован `shouldSkipDailyDedup` |
| Notify-only ошибка TG | actionLog = "success" (ложь) | actionLog = "failed" + errorMessage |
| `incrementTriggerCount` | Инкремент до TG, включая failed | После TG блока, только при `finalStatus === "success"` |
| Тестируемость | Нетестируемо (Convex query) | Чистая функция с 11 тестами |

## Сценарии

| Сценарий | Попытка 1 | Попытка 2 (5 мин) | Попытка 3 (10 мин) | Попытка 4 (15 мин) |
|---|---|---|---|---|
| VK API timeout → retry → success | failed | failed | **success → остановлено** | dedup (permanent) |
| VK API постоянно 500 | failed | failed | failed | **dedup (лимит 3)** |
| Успех с первой попытки | **success → остановлено** | dedup | dedup | dedup |
| Notify-only, TG ошибка | **failed** (фикс!) | retry | retry | **dedup (лимит 3)** |
| Notify-only, TG ok | success | dedup (daily) | dedup | dedup |

## Что НЕ меняется

- Permanent dedup (успешная остановка) — без изменений
- Логика evaluateCondition — без изменений
- Формат actionLogs — без изменений (поля те же, только status обновляется)
- Схема БД — без изменений (используем существующий индекс `by_ruleId_createdAt`)
- Admin alerts при failed — без изменений (dedup по ключу `ruleEngine:${ruleId}:${adId}`, окно 30 мин → max 1 алерт за 30 мин даже при retry)
- `budget_increased`, `budget_reset`, `zero_spend_alert` — логируются через `logBudgetAction` (другие ruleId), не затронуты этим изменением
