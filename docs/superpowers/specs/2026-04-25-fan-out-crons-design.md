# Fan-Out Architecture for Heavy Crons

**Date:** 2026-04-25
**Status:** Draft
**Scope:** syncAll, checkUzBudgetRules, proactiveTokenRefresh, health check thresholds

## Problem

Три основных крона обрабатывают аккаунты последовательно в одном длинном action. При 262 аккаунтах:

- **syncAll** (каждые 5 мин): BATCH_SIZE=40, полный цикл ~33 мин. Один зависший аккаунт блокирует остальные 39.
- **checkUzBudgetRules** (каждые 5 мин): аналогичная sequential обработка.
- **proactiveTokenRefresh** (каждые 4ч): перебирает все expiring accounts/users последовательно. Интервал 4ч приводит к тому, что токены доходят до 1ч до истечения.

Health check показывает 118/262 "проблемных" кабинетов, из которых 116 — false positives из-за некорректных порогов, рассчитанных под sequential batch. Health check раз в 6ч — слишком медленно для обнаружения реальных проблем.

При росте до 1000+ аккаунтов ситуация станет критической.

## Solution: Fan-Out Pattern

### Architecture

Каждый тяжёлый крон разделяется на три компонента:

```
dispatcher (internalAction, лёгкий, секунды)
  │
  ├─ проверяет здоровье (алерт при проблемах)
  ├─ получает список целей
  ├─ фильтрует (skip recently processed)
  └─ вызывает batchDispatch (internalMutation)
       │
       └─ scheduler.runAfter(0, worker, { id }) × N

worker (internalAction, изолированный, ~30с)
  └─ вся логика на одну единицу работы
```

`batchDispatch` — отдельная internalMutation, потому что `ctx.scheduler` доступен только из mutations, не из actions.

### Concurrency

Convex self-hosted: дефолт 16 concurrent actions. При 262 аккаунтах и 30с на action: `262 / 16 × 30с ≈ 8 мин` — не укладывается в 5-минутный интервал.

**Решение:** `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=32` в docker-compose.

```
262 / 32 × 30с ≈ 4 мин — укладывается в 5-минутный интервал
```

При росте до 1000 аккаунтов: `1000 / 32 × 30с ≈ 16 мин` — поднять до 48-64 когда понадобится.

Convex сам управляет очередью — actions ставятся в очередь и выполняются по мере освобождения слотов. Ручной stagger или семафор не нужен.

VK API rate limit (429) обрабатывается существующим retry с backoff в `callMtApi`.

---

## 1. syncAll → syncDispatch + syncOneAccount

### syncDispatch (internalAction)

Файл: `convex/syncMetrics.ts`

Каждые 5 мин (cron):

1. Записать heartbeat "running"
2. **Health check** (см. секцию 5)
3. Вызвать `listActiveAccounts` — все active/error аккаунты (без BATCH_SIZE, без slice)
4. Фильтр: `SKIP_IF_SYNCED_WITHIN_MS = 4 мин` (как сейчас)
5. Вызвать `batchDispatch({ functionName: "syncOneAccount", items: [{ accountId }, ...] })`
6. Записать heartbeat "completed"

**Убирается:**
- Hard lock (STUCK_THRESHOLD_MS) — dispatcher лёгкий, застрять не может
- BATCH_SIZE — dispatch-ятся все аккаунты, concurrency управляется Convex

### syncOneAccount (internalAction)

Файл: `convex/syncMetrics.ts`

Args: `{ accountId: v.id("adAccounts") }`

Вся логика из текущего `for (const account of accounts)` цикла (строки 63-600) переносится без изменения бизнес-логики:

1. Проверить `SKIP_IF_SYNCED_WITHIN_MS` (early exit если уже синхронизирован)
2. Auto-recovery для error аккаунтов (quickTokenCheck)
3. `getValidTokenForAccount`
4. `getMtBanners` (только active/blocked)
5. `getMtStatistics` + `getMtLeadCounts` (параллельно)
6. `getCampaignsForAccount` + `getMtAdPlans`
7. upsertCampaign для каждой кампании
8. upsertMetrics
9. `checkRulesForAccount`
10. `updateSyncTime` при успехе
11. Обработка ошибок: TOKEN_EXPIRED → tokenRecovery, transient errors → incrementSyncErrors

**Убирается:**
- `consecutiveCampaignApiFailures` (circuit breaker) — при fan-out каждый worker независим, circuit breaker не имеет смысла. VK API ошибки обрабатываются retry в `callMtApi`.

**Остаётся без изменений:**
- `ACCOUNT_TIMEOUT_MS = 120s` — timeout одного action
- Campaigns запрашиваются из VK API каждый sync (без кэша) — нужны актуальные бюджеты для `fast_spend`
- Вся логика обработки ошибок, token recovery, transient error threshold

### batchDispatch (internalMutation)

Файл: `convex/syncMetrics.ts`

Универсальная мутация для планирования worker-ов:

```typescript
export const dispatchSyncBatch = internalMutation({
  args: { accountIds: v.array(v.id("adAccounts")) },
  handler: async (ctx, args) => {
    for (const accountId of args.accountIds) {
      await ctx.scheduler.runAfter(0, internal.syncMetrics.syncOneAccount, { accountId });
    }
  },
});
```

Каждый крон получает свою dispatch-мутацию (syncDispatch использует dispatchSyncBatch, UZ использует dispatchUzBatch и т.д.).

---

## 2. checkUzBudgetRules → uzBudgetDispatch + uzBudgetOneAccount

### uzBudgetDispatch (internalAction)

Файл: `convex/ruleEngine.ts`

Каждые 5 мин (cron):

1. Записать heartbeat "running"
2. Health check (ошибки uz_budget в systemLogs)
3. Получить все active UZ-правила (`getActiveUzRules`)
4. Собрать уникальные accountId из всех правил
5. Dispatch `uzBudgetOneAccount` для каждого accountId
6. Записать heartbeat "completed"

### uzBudgetOneAccount (internalAction)

Файл: `convex/ruleEngine.ts`

Args: `{ accountId: v.id("adAccounts") }`

1. Перезапросить UZ-правила для этого аккаунта (лёгкий query, не передавать через args)
2. `getValidTokenForAccount`
3. `getCampaigns` из VK API
4. `getCampaignsSpentTodayBatch`
5. Evaluate каждое правило → increase budget / unblock / reset
6. Обработка ошибок

**Убирается:**
- Hard lock
- Sequential обработка всех аккаунтов

---

## 3. proactiveTokenRefresh → tokenRefreshDispatch + tokenRefreshOne

### tokenRefreshDispatch (internalAction)

Файл: `convex/auth.ts`

Каждые **2ч** (было 4ч):

1. Записать heartbeat "running"
2. Health check: сколько аккаунтов с `tokenExpiresAt < 1ч`? Алерт если > 0 и предыдущий refresh не помог
3. Получить expiring accounts (`getExpiringAccounts`) + expiring users (`getExpiringUserTokens`)
4. Dispatch `tokenRefreshOne` для каждого account и user
5. Записать heartbeat "completed"

### tokenRefreshOne (internalAction)

Файл: `convex/auth.ts`

Args: `{ targetType: v.union(v.literal("account"), v.literal("user")), targetId: v.string() }`

Для account:
1. `getValidTokenForAccount({ accountId })`
2. Verify: re-read `tokenExpiresAt`, проверить что обновился
3. При failure: если unrecoverable → `clearAccountRefreshToken` → `tryRecoverToken`
4. Логирование результата

Для user:
1. `getValidVkAdsToken({ userId })`
2. Verify: re-read `vkAdsTokenExpiresAt`
3. При failure: если unrecoverable → `clearUserVkAdsRefreshToken`
4. Логирование результата

**Убирается:**
- `scheduleProactiveRetry` (retry через 30 мин) — компенсируется уменьшением интервала с 4ч до 2ч
- Sequential обработка

**Интервал 2ч вместо 4ч:** с proactive window 12ч и интервалом 2ч, каждый токен будет проверен 6 раз до истечения. Ситуация "1ч до истечения" исключена.

---

## 4. Health Check: исправление порогов

### checkCronSyncResults (`healthCheck.ts:124`)

**Было:** `lastSyncAt < 10 мин` → "синхронизирован"
**Стало:** `lastSyncAt < 15 мин` → "синхронизирован"

При fan-out все аккаунты обновляются за ~4 мин каждые 5 мин. 15 мин = 3 пропущенных цикла — реальная проблема.

### checkAccountSync (`healthCheck.ts:303`)

**Было:** `lastSyncAt > 30 мин` → stale (warning)
**Стало:** `lastSyncAt > 20 мин` → stale (warning)

При fan-out каждый аккаунт должен обновляться каждые 5 мин. 20 мин без обновления = 4 пропущенных цикла — реальная проблема, не false positive.

---

## 5. Алерты в dispatcher-ах

Каждый dispatcher перед dispatch-ем проверяет здоровье и алертит в Telegram при проблемах.

### syncDispatch

```
1. staleCount = аккаунты с lastSyncAt > 15 мин
2. errorCount = ошибки sync в systemLogs за последние 10 мин
3. Если staleCount > 20% от total ИЛИ errorCount > 30:
   → Telegram алерт: "⚠️ Sync: 45/262 аккаунтов не синхронизированы >15 мин\nОшибки за 10 мин: 23"
```

### uzBudgetDispatch

```
1. errorCount = ошибки uz_budget в systemLogs за последние 10 мин
2. Если errorCount > 10:
   → Telegram алерт
```

### tokenRefreshDispatch

```
1. urgentCount = аккаунты с tokenExpiresAt < 1ч
2. Если urgentCount > 0:
   → Telegram алерт: "⚠️ Токены: N аккаунтов истекают < 1ч"
```

### Дедупликация

Не слать одинаковый алерт чаще чем раз в 30 мин. Запись `lastAlertSentAt` в `cronHeartbeats` для каждого типа алерта.

---

## 6. Миграция

### Порядок

1. Добавить новые функции: `syncOneAccount`, `syncDispatch`, `dispatchSyncBatch`, `uzBudgetOneAccount`, `uzBudgetDispatch`, `dispatchUzBatch`, `tokenRefreshOne`, `tokenRefreshDispatch`, `dispatchTokenBatch`
2. В `crons.ts` заменить entry points:
   - `internal.syncMetrics.syncAll` → `internal.syncMetrics.syncDispatch`
   - `internal.ruleEngine.checkUzBudgetRules` → `internal.ruleEngine.uzBudgetDispatch`
   - `internal.auth.proactiveTokenRefresh` → `internal.auth.tokenRefreshDispatch`
   - Интервал proactive-token-refresh: `{ hours: 4 }` → `{ hours: 2 }`
3. Обновить пороги в `healthCheck.ts`
4. Добавить `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=32` в `docker/docker-compose.convex-selfhosted.yml`
5. Деплой — один push в main

### Старый код

`syncAll`, `checkUzBudgetRules`, `proactiveTokenRefresh` — остаются в файлах, но больше не вызываются из crons. Удаляются в следующем деплое после подтверждения работоспособности.

### Rollback

В `crons.ts` вернуть старые entry points + убрать env var concurrency. Один коммит, один деплой.

---

## Файлы для изменения

| Файл | Изменения |
|------|-----------|
| `convex/syncMetrics.ts` | + `syncOneAccount`, `syncDispatch`, `dispatchSyncBatch`. Старый `syncAll` остаётся, не удалять. |
| `convex/ruleEngine.ts` | + `uzBudgetOneAccount`, `uzBudgetDispatch`, `dispatchUzBatch`. Старый `checkUzBudgetRules` остаётся. |
| `convex/auth.ts` | + `tokenRefreshOne`, `tokenRefreshDispatch`, `dispatchTokenBatch`. Старый `proactiveTokenRefresh` остаётся. |
| `convex/crons.ts` | Замена entry points, интервал token refresh 4ч → 2ч |
| `convex/healthCheck.ts` | Пороги: sync 10 → 15 мин, stale 30 → 20 мин |
| `docker/docker-compose.convex-selfhosted.yml` | + `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=32` |

## Что НЕ меняется

- Бизнес-логика sync, UZ budget, token refresh — переносится as-is
- `callMtApi` и VK API retry — без изменений
- Campaigns запрашиваются из VK API каждый sync (без кэша)
- Schema, таблицы, индексы — без изменений
- Frontend — без изменений
