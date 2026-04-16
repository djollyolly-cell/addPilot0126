# metricsRealtime Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить ротацию metricsRealtime (retention 4 дня) + оптимизировать запросы через составной индекс. Двухэтапный деплой для безопасной миграции индексов.

**Architecture:** internalAction-оркестратор вызывает internalMutation батчами по 500 записей с паузой 100ms. Heartbeat guard от дублирования. Cron ежедневно 05:00 UTC. Двухэтапный деплой: Deploy 1 добавляет индексы + cleanup код (старые запросы работают), Deploy 2 переключает запросы + удаляет старые индексы.

**Tech Stack:** Convex (internalAction, internalMutation, cron), Vitest + convex-test

**Spec:** `docs/superpowers/specs/2026-04-16-metrics-realtime-cleanup-design.md` (rev.7)

---

## Deploy 1: добавить индексы + cleanup код

### Task 1: Добавить новые индексы в schema.ts

**Files:**
- Modify: `convex/schema.ts:277-287`

- [ ] **Step 1: Добавить `by_adId_timestamp` и `by_timestamp` к metricsRealtime**

Старые индексы НЕ трогаем — они нужны пока новые строятся.

```ts
// Было:
metricsRealtime: defineTable({
  accountId: v.id("adAccounts"),
  adId: v.string(),
  timestamp: v.number(),
  spent: v.number(),
  leads: v.number(),
  impressions: v.number(),
  clicks: v.number(),
})
  .index("by_adId", ["adId"])
  .index("by_accountId_timestamp", ["accountId", "timestamp"]),

// Стало:
metricsRealtime: defineTable({
  accountId: v.id("adAccounts"),
  adId: v.string(),
  timestamp: v.number(),
  spent: v.number(),
  leads: v.number(),
  impressions: v.number(),
  clicks: v.number(),
})
  .index("by_adId", ["adId"])
  .index("by_accountId_timestamp", ["accountId", "timestamp"])
  .index("by_adId_timestamp", ["adId", "timestamp"])
  .index("by_timestamp", ["timestamp"]),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(schema): add by_adId_timestamp + by_timestamp indexes to metricsRealtime"
```

---

### Task 2: Добавить cleanup функции в metrics.ts

**Files:**
- Modify: `convex/metrics.ts`

- [ ] **Step 1: Добавить imports и константы в начало metrics.ts**

После существующего `import { v } from "convex/values";` и `import { mutation, query, internalMutation } from "./_generated/server";` добавить:

```ts
import { v } from "convex/values";
import { mutation, query, internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// ── Cleanup constants ──
const RETENTION_DAYS = 4;
const DEFAULT_BATCH_SIZE = 500;
const BATCH_DELAY_MS = 100;
const LOG_EVERY_N_BATCHES = 100;
const CLEANUP_MAX_RUNNING_MS = 12 * 60 * 60 * 1000; // 12h zombie threshold

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

Заменить первые 2 строки файла (import) на этот блок. Остальной код файла не трогать.

- [ ] **Step 2: Добавить `deleteRealtimeBatch` internalMutation в конец metrics.ts**

```ts
// ── Cleanup: batch delete old metricsRealtime records ──

export const deleteRealtimeBatch = internalMutation({
  args: { batchSize: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const records = await ctx.db
      .query("metricsRealtime")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", cutoff))
      .take(args.batchSize);
    for (const record of records) {
      await ctx.db.delete(record._id);
    }
    return { deleted: records.length, hasMore: records.length === args.batchSize };
  },
});
```

- [ ] **Step 3: Добавить `cleanupOldRealtimeMetrics` internalAction в конец metrics.ts**

```ts
export const cleanupOldRealtimeMetrics = internalAction({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

    // Guard: skip if already running, override if zombie (>12h)
    const hb = await ctx.runQuery(internal.syncMetrics.getCronHeartbeat, {
      name: "cleanup-realtime-metrics",
    });
    if (hb?.status === "running") {
      const elapsed = Date.now() - hb.startedAt;
      const minutesAgo = Math.round(elapsed / 60_000);
      if (elapsed < CLEANUP_MAX_RUNNING_MS) {
        console.log(
          `[cleanup-realtime] Already running (started ${minutesAgo}min ago), skipping`
        );
        return;
      }
      console.warn(
        `[cleanup-realtime] Previous run STUCK (${minutesAgo}min ago, >720min). Overriding.`
      );
    }

    await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
      name: "cleanup-realtime-metrics",
      status: "running",
    });

    let runningTotal = 0;
    let batchCount = 0;
    const startedAt = Date.now();

    try {
      while (true) {
        const batch = await ctx.runMutation(internal.metrics.deleteRealtimeBatch, {
          batchSize,
        });
        runningTotal += batch.deleted;
        batchCount++;

        if (batchCount % LOG_EVERY_N_BATCHES === 0) {
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = Math.round(runningTotal / (elapsed / 60));
          console.log(
            `[cleanup-realtime] Progress: deleted ${runningTotal}, rate ~${rate}/min, elapsed ${Math.round(elapsed)}s`
          );
        }

        if (!batch.hasMore) break;
        await sleep(BATCH_DELAY_MS);
      }

      const elapsed = (Date.now() - startedAt) / 1000;
      console.log(
        `[cleanup-realtime] Complete. Deleted ${runningTotal} records in ${Math.round(elapsed)}s (~${Math.round(elapsed / 60)} min)`
      );

      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "cleanup-realtime-metrics",
        status: "completed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[cleanup-realtime] ERROR: ${message}. Stopped at ${runningTotal} deleted. Will retry next cron cycle.`
      );
      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "cleanup-realtime-metrics",
        status: "failed",
        error: message,
      });
    }
  },
});
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/metrics.ts
git commit -m "feat(metrics): add deleteRealtimeBatch + cleanupOldRealtimeMetrics for retention cleanup"
```

---

### Task 3: Написать тесты для deleteRealtimeBatch

**Files:**
- Modify: `convex/metrics.test.ts`

- [ ] **Step 1: Добавить тест — удаляет старые записи, оставляет свежие**

В конец `describe("metrics", () => { ... })` добавить:

```ts
  // ── Cleanup: deleteRealtimeBatch ──

  test("deleteRealtimeBatch deletes records older than 4 days", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    const now = Date.now();
    const fiveDaysAgo = now - 5 * 86_400_000;
    const twoDaysAgo = now - 2 * 86_400_000;

    // Insert old record (5 days ago) — should be deleted
    await t.run(async (ctx) => {
      await ctx.db.insert("metricsRealtime", {
        accountId,
        adId: "ad_old",
        timestamp: fiveDaysAgo,
        spent: 100,
        leads: 1,
        impressions: 500,
        clicks: 10,
      });
    });

    // Insert fresh record (2 days ago) — should survive
    await t.run(async (ctx) => {
      await ctx.db.insert("metricsRealtime", {
        accountId,
        adId: "ad_fresh",
        timestamp: twoDaysAgo,
        spent: 200,
        leads: 2,
        impressions: 1000,
        clicks: 20,
      });
    });

    // Run cleanup batch
    const result = await t.mutation(internal.metrics.deleteRealtimeBatch, {
      batchSize: 500,
    });

    expect(result.deleted).toBe(1);
    expect(result.hasMore).toBe(false);

    // Verify old record gone, fresh record remains
    const oldRecord = await t.query(api.metrics.getRealtimeByAd, { adId: "ad_old" });
    expect(oldRecord).toBeNull();

    const freshRecord = await t.query(api.metrics.getRealtimeByAd, { adId: "ad_fresh" });
    expect(freshRecord).toBeDefined();
    expect(freshRecord?.adId).toBe("ad_fresh");
  });

  test("deleteRealtimeBatch returns hasMore=true when batch is full", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    const tenDaysAgo = Date.now() - 10 * 86_400_000;

    // Insert 3 old records
    for (let i = 0; i < 3; i++) {
      await t.run(async (ctx) => {
        await ctx.db.insert("metricsRealtime", {
          accountId,
          adId: `ad_batch_${i}`,
          timestamp: tenDaysAgo + i * 1000,
          spent: 100,
          leads: 0,
          impressions: 500,
          clicks: 10,
        });
      });
    }

    // Delete with batchSize=2 — should delete 2, hasMore=true
    const result = await t.mutation(internal.metrics.deleteRealtimeBatch, {
      batchSize: 2,
    });

    expect(result.deleted).toBe(2);
    expect(result.hasMore).toBe(true);

    // Second batch — should delete 1, hasMore=false
    const result2 = await t.mutation(internal.metrics.deleteRealtimeBatch, {
      batchSize: 2,
    });

    expect(result2.deleted).toBe(1);
    expect(result2.hasMore).toBe(false);
  });

  test("deleteRealtimeBatch returns 0 when nothing to delete", async () => {
    const t = convexTest(schema);

    const result = await t.mutation(internal.metrics.deleteRealtimeBatch, {
      batchSize: 500,
    });

    expect(result.deleted).toBe(0);
    expect(result.hasMore).toBe(false);
  });
```

- [ ] **Step 2: Добавить import internal в начало файла**

```ts
import { api, internal } from "./_generated/api";
```

Заменить существующий `import { api } from "./_generated/api";`.

- [ ] **Step 3: Запустить тесты**

Run: `npm run test -- convex/metrics.test.ts`
Expected: все тесты PASS (включая существующие)

- [ ] **Step 4: Commit**

```bash
git add convex/metrics.test.ts
git commit -m "test(metrics): add deleteRealtimeBatch cleanup tests"
```

---

### Task 4: Добавить cron в crons.ts

**Files:**
- Modify: `convex/crons.ts`

- [ ] **Step 1: Добавить cleanup cron перед `export default crons`**

После последнего `crons.cron(...)` / `crons.interval(...)` (строка 146, перед `export default crons;`) добавить:

```ts
// Clean up old metricsRealtime records (older than 4 days) — daily at 05:00 UTC
crons.cron(
  "cleanup-old-realtime-metrics",
  "0 5 * * *",
  internal.metrics.cleanupOldRealtimeMetrics
);
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/crons.ts
git commit -m "feat(crons): add daily cleanup-old-realtime-metrics at 05:00 UTC"
```

---

### Task 5: Обновить healthCheck — configurable maxRunningMin

**Files:**
- Modify: `convex/healthCheck.ts:73-96`

- [ ] **Step 1: Добавить `maxRunningMin` в тип CRON_CONFIGS**

Заменить:
```ts
    const CRON_CONFIGS: Array<{
      name: string;
      label: string;
      maxStaleMin?: number;
    }> = [
      { name: "syncAll", label: "sync-metrics", maxStaleMin: 10 },
      { name: "checkUzBudgetRules", label: "uz-budget-increase", maxStaleMin: 15 },
      { name: "resetBudgets", label: "uz-budget-reset" },
      { name: "sendDailyDigest", label: "daily-digest" },
      { name: "sendWeeklyDigest", label: "weekly-digest" },
      { name: "sendMonthlyDigest", label: "monthly-digest" },
      { name: "checkAgencyTokenHealth", label: "agency-token-health" },
      { name: "proactiveTokenRefresh", label: "proactive-token-refresh", maxStaleMin: 250 },
    ];
```

На:
```ts
    const CRON_CONFIGS: Array<{
      name: string;
      label: string;
      maxStaleMin?: number;
      maxRunningMin?: number;
    }> = [
      { name: "syncAll", label: "sync-metrics", maxStaleMin: 10 },
      { name: "checkUzBudgetRules", label: "uz-budget-increase", maxStaleMin: 15 },
      { name: "resetBudgets", label: "uz-budget-reset" },
      { name: "sendDailyDigest", label: "daily-digest" },
      { name: "sendWeeklyDigest", label: "weekly-digest" },
      { name: "sendMonthlyDigest", label: "monthly-digest" },
      { name: "checkAgencyTokenHealth", label: "agency-token-health" },
      { name: "proactiveTokenRefresh", label: "proactive-token-refresh", maxStaleMin: 250 },
      { name: "cleanup-realtime-metrics", label: "cleanup-realtime", maxStaleMin: 25 * 60, maxRunningMin: 12 * 60 },
    ];
```

- [ ] **Step 2: Заменить hardcoded stuck detection на configurable**

Заменить (healthCheck.ts:92):
```ts
      if (hb.status === "running" && minutesAgo(hb.startedAt) > 10) {
```

На:
```ts
      const maxRunMin = cfg.maxRunningMin ?? 10;
      if (hb.status === "running" && minutesAgo(hb.startedAt) > maxRunMin) {
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 4: Запустить все тесты**

Run: `npm run test`
Expected: все PASS

- [ ] **Step 5: Commit**

```bash
git add convex/healthCheck.ts
git commit -m "feat(healthCheck): configurable maxRunningMin + add cleanup-realtime to CRON_CONFIGS"
```

---

### Task 6: Deploy 1

- [ ] **Step 1: Деплой на прод**

```bash
git push origin main
```

GitHub Actions задеплоит Convex + Docker автоматически.

- [ ] **Step 2: Проверить построение индексов**

Открыть Convex Dashboard: `http://178.172.235.49:6792`
Перейти в Data → metricsRealtime → Indexes.
Дождаться статуса **Ready** для `by_adId_timestamp` и `by_timestamp`.
На 24 млн записях — ориентировочно 10-60 минут.

- [ ] **Step 3: Проверить что cleanup cron запустился**

В Dashboard → Functions → Logs:
- Дождаться 05:00 UTC или вручную запустить `internal.metrics.cleanupOldRealtimeMetrics` через Functions → Run.
- В логах должно появиться: `[cleanup-realtime] Progress: deleted ...` или `[cleanup-realtime] Complete.`

---

## Deploy 2: переключить запросы + удалить старые индексы

> **ВАЖНО:** Выполнять только после подтверждения что индексы `by_adId_timestamp` и `by_timestamp` в статусе Ready.

### Task 7: Переключить getRealtimeHistory на range scan

**Files:**
- Modify: `convex/ruleEngine.ts:289-295`

- [ ] **Step 1: Заменить full scan на range scan**

Заменить:
```ts
    const records = await ctx.db
      .query("metricsRealtime")
      .withIndex("by_adId", (q) => q.eq("adId", args.adId))
      .collect();
    return records.filter((r) => r.timestamp >= args.sinceTimestamp);
```

На:
```ts
    return await ctx.db
      .query("metricsRealtime")
      .withIndex("by_adId_timestamp", (q) =>
        q.eq("adId", args.adId).gte("timestamp", args.sinceTimestamp)
      )
      .collect();
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/ruleEngine.ts
git commit -m "perf(ruleEngine): getRealtimeHistory range scan via by_adId_timestamp"
```

---

### Task 8: Переключить getRealtimeByAd на новый индекс

**Files:**
- Modify: `convex/metrics.ts:177-183`

- [ ] **Step 1: Заменить индекс**

Заменить:
```ts
      .withIndex("by_adId", (q) => q.eq("adId", args.adId))
```

На:
```ts
      .withIndex("by_adId_timestamp", (q) => q.eq("adId", args.adId))
```

- [ ] **Step 2: Запустить тесты metrics**

Run: `npm run test -- convex/metrics.test.ts`
Expected: все PASS

- [ ] **Step 3: Commit**

```bash
git add convex/metrics.ts
git commit -m "perf(metrics): getRealtimeByAd uses by_adId_timestamp index"
```

---

### Task 9: Удалить старые индексы из schema.ts

**Files:**
- Modify: `convex/schema.ts:277-291`

- [ ] **Step 1: Удалить `by_adId` и `by_accountId_timestamp`**

Заменить:
```ts
metricsRealtime: defineTable({
  accountId: v.id("adAccounts"),
  adId: v.string(),
  timestamp: v.number(),
  spent: v.number(),
  leads: v.number(),
  impressions: v.number(),
  clicks: v.number(),
})
  .index("by_adId", ["adId"])
  .index("by_accountId_timestamp", ["accountId", "timestamp"])
  .index("by_adId_timestamp", ["adId", "timestamp"])
  .index("by_timestamp", ["timestamp"]),
```

На:
```ts
metricsRealtime: defineTable({
  accountId: v.id("adAccounts"),
  adId: v.string(),
  timestamp: v.number(),
  spent: v.number(),
  leads: v.number(),
  impressions: v.number(),
  clicks: v.number(),
})
  .index("by_adId_timestamp", ["adId", "timestamp"])
  .index("by_timestamp", ["timestamp"]),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Запустить все тесты**

Run: `npm run test`
Expected: все PASS

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts
git commit -m "chore(schema): remove unused by_adId + by_accountId_timestamp indexes from metricsRealtime"
```

---

### Task 10: Обновить database-schema.md

**Files:**
- Modify: `.claude/rules/database-schema.md`

- [ ] **Step 1: Обновить секцию metricsRealtime**

Найти и заменить:
```
### metricsRealtime
- `accountId`, `adId`, `timestamp`
- `spent`, `leads`, `impressions`, `clicks`
- Indexes: `by_adId`, `by_accountId_timestamp`
```

На:
```
### metricsRealtime
- `accountId`, `adId`, `timestamp`
- `spent`, `leads`, `impressions`, `clicks`
- Indexes: `by_adId_timestamp`, `by_timestamp`
- Retention: 4 дня (cleanup cron daily 05:00 UTC)
```

- [ ] **Step 2: Commit**

```bash
git add .claude/rules/database-schema.md
git commit -m "docs: update metricsRealtime indexes in database-schema.md"
```

---

### Task 11: Deploy 2

- [ ] **Step 1: Деплой на прод**

```bash
git push origin main
```

- [ ] **Step 2: Верификация**

1. Convex Dashboard → Data → metricsRealtime → Indexes: должны быть только `by_adId_timestamp` и `by_timestamp`
2. Проверить что правила работают: Dashboard → Functions → Logs → искать `[ruleEngine]` — не должно быть ошибок
3. Проверить что `getRealtimeByAd` работает: открыть фронтенд → Dashboard → метрики объявлений отображаются
