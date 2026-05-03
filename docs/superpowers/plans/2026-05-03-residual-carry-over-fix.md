# Residual Memory Carry-Over Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Снизить `TooMuchMemoryCarryOver` с ~7/час до 0–1/час через adaptive chunking трёх sync batch flush mutations (`saveDailyBatch`, `saveRealtimeBatch`, `upsertAdsBatch`).

**Architecture:** Добавить три helper-функции в `convex/syncMetrics.ts` по образцу существующего `campaignUpsertChunkSize` (primary fix). Каждый helper возвращает chunk size в зависимости от количества items: `> HEAVY_BATCH_THRESHOLD` → small chunk, иначе → default. Применить во всех 6 caller-сайтах (`syncAll` + `syncBatchWorker`). Перед кодом — снять production taxonomy (распределение carry-over по функциям) и распределение ads per account для калибровки порога.

**Tech Stack:** Convex (self-hosted), TypeScript, Vitest, GitHub Actions.

**Spec:** `docs/2026-05-03-convex-residual-carry-over-design.md`.

---

## File Structure

| File | Role | Action |
|---|---|---|
| `convex/syncMetrics.ts` | Helper functions + 6 caller sites | Modify |
| `convex/syncMetrics.test.ts` | Unit tests for chunk-size helpers | **Create** (new file) |
| `convex/admin.ts` | Diagnostic `adsCountByAccount` internalQuery + `reportAdsCountByAccount` runner action (+ optional public fallback) | Modify (add → run → remove) |

**Why these files only:**
- Helper functions logically принадлежат `syncMetrics.ts` (рядом с existing `campaignUpsertChunkSize:40`).
- Diagnostic query короткоживущий — добавляется в `admin.ts` как Pre-Step B, удаляется в Task 7 после использования.
- Unit-тесты для chunk-size — pure functions, легко тестируются, дают regression защиту от случайного изменения порогов.

**Caller sites (точные строки в `syncMetrics.ts` ДО правок):**
- `:342` — `upsertAdsBatch` в `syncAll`, `CHUNK = DEFAULT_UPSERT_CHUNK_SIZE` (200)
- `:418` — `saveRealtimeBatch` в `syncAll`, `CHUNK = 200`
- `:427` — `saveDailyBatch` в `syncAll`, `CHUNK = 100`
- `:1115` — `upsertAdsBatch` в `syncBatchWorker`, `CHUNK = DEFAULT_UPSERT_CHUNK_SIZE` (200)
- `:1190` — `saveRealtimeBatch` в `syncBatchWorker`, `CHUNK = 200`
- `:1199` — `saveDailyBatch` в `syncBatchWorker`, `CHUNK = 100`

---

## Pre-Steps (Manual, before code)

### Pre-Step A: Production Taxonomy

**Цель:** убедиться что `saveDailyBatch` / `saveRealtimeBatch` / `upsertAdsBatch` действительно дают значительную долю carry-over событий, а не <10%. Если основная масса в `ruleEngine` или `getCampaignTypeMap` — текущий план неактуален и нужна другая стратегия (см. §3.3 спека).

- [ ] **Step 1: Снять taxonomy за 4 часа**

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker logs --since 4h adpilot-convex-backend 2>&1 \
   | grep TooMuchMemoryCarryOver \
   | sed -E "s/.*last request: \"([^\"]+)\".*/\\1/" \
   | sort | uniq -c | sort -nr'
```

Expected output: список вида `"  N <UDF|Action: file.js:functionName>"`, sorted by count.

- [ ] **Step 2: Decision rule**

Доля «batch flush» = `(saveDailyBatch + saveRealtimeBatch + upsertAdsBatch) / total`.

| Доля batch flush | Действие |
|---|---|
| ≥ 50% событий | Продолжать план (Pre-Step B). Ожидать снижение carry-over до 0–1/час. |
| 20–50% | **Не блокер**, продолжать план. Ожидать **частичное** снижение carry-over пропорционально доле (например, 7/час → 3–4/час). Module-state работа потом — отдельным планом. |
| ≤ 10% (основная масса на `ruleEngine.checkRulesForAccount` / `getCampaignTypeMap` / `auth.*`) | **Стоп.** План лечит не ту половину проблемы. Возвращаться к спеку §3.3 (диагностика module state). |

Если попали в строку 3 — задокументировать taxonomy в `docs/2026-05-03-convex-residual-carry-over-design.md` Раздел 1 как обновлённый «Симптом», и закрыть этот план без реализации.

Граничная зона 10–20% — на усмотрение исполнителя: если последние 24 часа стабильны и cost фикса небольшой (как тут — 3 helper'а), можно продолжать; если есть основания думать что batch flush — побочка module pressure, лучше сначала диагностика.

### Pre-Step B: Ads-Per-Account Distribution

**Цель:** калибровать `HEAVY_BATCH_THRESHOLD`. Если *средний* аккаунт имеет 800+ ads, порог 500 бьёт всех (теряем смысл «adaptive»). Если максимум 300 — порог 500 не сработает никогда.

- [ ] **Step 0: Verify schema indexes**

Run: `grep -A20 'ads:' convex/schema.ts | grep -E 'index|withIndex'`
Expected: список индексов на таблице `ads`. Должен присутствовать индекс по `accountId` (точное имя — `by_accountId_vkAdId` или `by_accountId`; зафиксировать какое).

Если есть `by_accountId_vkAdId` — использовать его (Step 1 ниже написан под него). Если только `by_accountId` — заменить в Step 1: `withIndex("by_accountId_vkAdId", ...)` → `withIndex("by_accountId", ...)`. Если ни одного нет — план не запускать, сначала добавить индекс отдельным PR.

- [ ] **Step 1: Добавить bounded paginated diagnostic query + runner в `convex/admin.ts`**

Modify: `convex/admin.ts` — в конец файла, добавить **обе** функции (query + action wrapper):

```typescript
// DIAGNOSTIC (temporary): adsCountByAccount — used to calibrate
// HEAVY_BATCH_THRESHOLD in syncMetrics. Bounded/paginated to avoid
// becoming the very memory pressure we're hunting. Remove after measurement.
export const adsCountByAccount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    const results: Array<[string, number, string]> = [];

    for (const account of accounts) {
      let count = 0;
      let cursor: string | null = null;
      while (true) {
        const page = await ctx.db
          .query("ads")
          .withIndex("by_accountId_vkAdId", q => q.eq("accountId", account._id))
          .paginate({ cursor, numItems: 200 });
        count += page.page.length;
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      results.push([account._id, count, account.name]);
    }

    return results.sort((a, b) => b[1] - a[1]).slice(0, 20);
  },
});

// DIAGNOSTIC (temporary): runner that invokes adsCountByAccount and
// logs result. Self-hosted Convex Dashboard может не давать UI для
// internalQuery; этот action видится в Functions list и его легко
// триггернуть через `npx convex run`. Remove with adsCountByAccount.
export const reportAdsCountByAccount = internalAction({
  args: {},
  handler: async (ctx) => {
    const top = await ctx.runQuery(internal.admin.adsCountByAccount, {});
    console.log("[diag] adsCountByAccount top-20:", JSON.stringify(top));
    return top;
  },
});
```

Verify imports at top of `admin.ts`: `internalQuery`, `internalAction`, `internal` (from `./_generated/api`). Если используется fallback `reportAdsCountByAccountPublic` (см. ниже) — также добавить `action` (из `./_generated/server`). Add missing if any — `tsc` поймает.

**Why paginated:** `ctx.db.query("ads").collect()` на 50k+ ads = именно тот carry-over, который мы охотимся ловить. Paginate по 200 держит peak memory bounded. `adAccounts.collect()` остаётся — таблица ограничена ~300 аккаунтов и не triggerит carry-over.

**Why action wrapper:** self-hosted Convex Dashboard в нашей версии не всегда даёт UI для запуска `internalQuery`. Action wrapper решает это: его всегда видно, его можно вызвать через CLI или Dashboard. Plus `console.log` дублирует результат в docker logs — гарантированный способ прочитать результат даже если CLI/Dashboard капризничают.

**Если internal action не вызывается через `npx convex run` или Dashboard в self-hosted setup** (зависит от версии CLI/backend): временный fallback — поднять wrapper в `action` (public) с required arg `secret: v.string()` и literal-сравнением с известным короткоживущим значением:

```typescript
// FALLBACK only if internal action not invokable from CLI/Dashboard.
// Remove together with adsCountByAccount in Task 6.
export const reportAdsCountByAccountPublic = action({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    if (args.secret !== "diag-2026-05-03-residual") throw new Error("nope");
    const top = await ctx.runQuery(internal.admin.adsCountByAccount, {});
    console.log("[diag] adsCountByAccount top-20:", JSON.stringify(top));
    return top;
  },
});
```

Затем `npx convex run admin:reportAdsCountByAccountPublic '{"secret":"diag-2026-05-03-residual"}'`. Это **временный** обход tooling-проблемы, не security model. Cleanup в Task 6 удаляет всё.

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output (no errors).

- [ ] **Step 3: Deploy and run diagnostic**

```bash
git add convex/admin.ts
git commit -m "chore(diag): add adsCountByAccount internalQuery (temporary)"
git push origin main
```

После завершения GitHub Actions Deploy — три способа получить результат, использовать первый сработавший:

**(a) Convex Dashboard (если умеет показывать internalQuery):**
- Functions → `admin:adsCountByAccount` → Run with `{}`

**(b) `npx convex run` для action wrapper (CLI-агностично):**
```bash
CONVEX_SELF_HOSTED_URL=https://convex.aipilot.by \
CONVEX_SELF_HOSTED_ADMIN_KEY="<generated_key>" \
npx convex run admin:reportAdsCountByAccount '{}'
```
(Admin key генерируется как описано в `.claude/rules/deploy-and-testing.md` / memory `convex-deploy.md`.)

**(c) Trigger action любым способом + читать результат из docker logs:**
```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker logs --since 5m adpilot-convex-backend 2>&1 \
   | grep "\[diag\] adsCountByAccount"'
```

Записать top-10 значений (например `[["accId1", 2087], ["accId2", 1300], ...]`).

- [ ] **Step 4: Калибровать HEAVY_BATCH_THRESHOLD**

Решение зависит от двух входов: распределение из Step 3 + доля batch flush из Pre-Step A.

| Распределение top-20 | Pre-Step A: batch flush ≥ 30%? | Действие |
|---|---|---|
| Top-1 < 500 ads | да | **Понизить порог:** `HEAVY_BATCH_THRESHOLD = max(250, top-1 - 50)`. Иначе helper не сработает ни на одном аккаунте при текущих 500. |
| Top-1 < 500 ads | нет (<30%) | План не нужен — закрыть. Малые аккаунты без значимой batch flush доли — adaptive chunk не даст эффекта. |
| Top-1 = 500–1000, остальные < 200 | любая | `HEAVY_BATCH_THRESHOLD = 500` (как в спеке) |
| Несколько аккаунтов > 1000, средний < 300 | любая | `HEAVY_BATCH_THRESHOLD = 800` |
| Большинство (>10 из 20) > 500 ads | любая | План недостаточен — chunk на всех = больше mutations без relief. Возвращаться к спеку §3.3. |

Записать выбранный порог в комментарий в плане:

```
[ ] Decision: HEAVY_BATCH_THRESHOLD = ___ (top-1 = ___, top-5 median = ___, batch flush share = ___%)
```

**ВАЖНО — exit-cleanup из Pre-Step B:** если решение «План не нужен — закрыть» или «Возвращаться к §3.3», diagnostic функции (`adsCountByAccount`, `reportAdsCountByAccount`, опционально `reportAdsCountByAccountPublic`) уже **задеплоены на prod** в Step 1-3. Перед закрытием плана **обязательно перейти к Task 6 cleanup** — удалить эти функции и запушить, иначе временный диагностический код останется в prod на неопределённый срок. Task 6 в этом случае выступает не финальным шагом, а exit-gate; Tasks 1-5 и 7 пропускаются.

---

## Implementation Tasks

### Task 1: Add chunk-size helper functions and unit tests

**Files:**
- Modify: `convex/syncMetrics.ts:18-44` (constants block + new helpers рядом с existing `campaignUpsertChunkSize`)
- Create: `convex/syncMetrics.test.ts`

- [ ] **Step 1: Write failing tests**

Тесты пишутся через **импортированную константу `HEAVY_BATCH_THRESHOLD`**, не магические числа. Это значит, что Pre-Step B может выставить любое значение порога (500, 800, 1000) — тесты остаются valid: они тестируют поведение helper'а *относительно* порога.

Create new file `convex/syncMetrics.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  HEAVY_BATCH_THRESHOLD,
  dailyMetricsChunkSize,
  realtimeMetricsChunkSize,
  adUpsertChunkSize,
} from "./syncMetrics";

describe("dailyMetricsChunkSize", () => {
  it("returns DEFAULT chunk at and below HEAVY_BATCH_THRESHOLD", () => {
    expect(dailyMetricsChunkSize(0)).toBe(100);
    expect(dailyMetricsChunkSize(HEAVY_BATCH_THRESHOLD - 1)).toBe(100);
    expect(dailyMetricsChunkSize(HEAVY_BATCH_THRESHOLD)).toBe(100);
  });
  it("returns HEAVY chunk above HEAVY_BATCH_THRESHOLD", () => {
    expect(dailyMetricsChunkSize(HEAVY_BATCH_THRESHOLD + 1)).toBe(25);
    expect(dailyMetricsChunkSize(HEAVY_BATCH_THRESHOLD * 4)).toBe(25);
  });
});

describe("realtimeMetricsChunkSize", () => {
  it("returns DEFAULT chunk at and below HEAVY_BATCH_THRESHOLD", () => {
    expect(realtimeMetricsChunkSize(0)).toBe(200);
    expect(realtimeMetricsChunkSize(HEAVY_BATCH_THRESHOLD - 1)).toBe(200);
    expect(realtimeMetricsChunkSize(HEAVY_BATCH_THRESHOLD)).toBe(200);
  });
  it("returns HEAVY chunk above HEAVY_BATCH_THRESHOLD", () => {
    expect(realtimeMetricsChunkSize(HEAVY_BATCH_THRESHOLD + 1)).toBe(50);
    expect(realtimeMetricsChunkSize(HEAVY_BATCH_THRESHOLD * 4)).toBe(50);
  });
});

describe("adUpsertChunkSize", () => {
  it("returns DEFAULT chunk at and below HEAVY_BATCH_THRESHOLD", () => {
    expect(adUpsertChunkSize(0)).toBe(200);
    expect(adUpsertChunkSize(HEAVY_BATCH_THRESHOLD - 1)).toBe(200);
    expect(adUpsertChunkSize(HEAVY_BATCH_THRESHOLD)).toBe(200);
  });
  it("returns HEAVY chunk above HEAVY_BATCH_THRESHOLD", () => {
    expect(adUpsertChunkSize(HEAVY_BATCH_THRESHOLD + 1)).toBe(50);
    expect(adUpsertChunkSize(HEAVY_BATCH_THRESHOLD * 4)).toBe(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.config.ts convex/syncMetrics.test.ts`
Expected: FAIL with import error — neither `HEAVY_BATCH_THRESHOLD` nor the three helper functions are exported from `./syncMetrics` yet.

- [ ] **Step 3: Add helpers to `convex/syncMetrics.ts`**

Modify `convex/syncMetrics.ts:18-21` constants block — replace:

```typescript
const SYNC_BANNER_FIELDS = "id,campaign_id,textblocks,status,moderation_status";
const DEFAULT_UPSERT_CHUNK_SIZE = 200;
const HEAVY_ACCOUNT_UPSERT_CHUNK_SIZE = 50;
const HEAVY_ACCOUNT_CAMPAIGN_THRESHOLD = 500;
```

With:

```typescript
const SYNC_BANNER_FIELDS = "id,campaign_id,textblocks,status,moderation_status";
const DEFAULT_UPSERT_CHUNK_SIZE = 200;
const HEAVY_ACCOUNT_UPSERT_CHUNK_SIZE = 50;
const HEAVY_ACCOUNT_CAMPAIGN_THRESHOLD = 500;

// Residual carry-over fix: adaptive chunks for sync batch flush mutations.
// Threshold = items count in single batch (== ads count for daily/realtime,
// ads count for upsert). Calibrated via Pre-Step B production measurement
// (admin.adsCountByAccount). Exported so unit tests can assert behaviour
// relative to the threshold rather than hardcoded magic numbers.
export const HEAVY_BATCH_THRESHOLD = 500; // <-- substitute Pre-Step B value
const DEFAULT_DAILY_CHUNK = 100;
const HEAVY_DAILY_CHUNK = 25;
const DEFAULT_REALTIME_CHUNK = 200;
const HEAVY_REALTIME_CHUNK = 50;
const DEFAULT_AD_UPSERT_CHUNK = 200;
const HEAVY_AD_UPSERT_CHUNK = 50;
```

Then modify `convex/syncMetrics.ts:40-44` — replace existing helper:

```typescript
function campaignUpsertChunkSize(count: number): number {
  return count > HEAVY_ACCOUNT_CAMPAIGN_THRESHOLD
    ? HEAVY_ACCOUNT_UPSERT_CHUNK_SIZE
    : DEFAULT_UPSERT_CHUNK_SIZE;
}
```

With (keep existing + add three new, all exported):

```typescript
function campaignUpsertChunkSize(count: number): number {
  return count > HEAVY_ACCOUNT_CAMPAIGN_THRESHOLD
    ? HEAVY_ACCOUNT_UPSERT_CHUNK_SIZE
    : DEFAULT_UPSERT_CHUNK_SIZE;
}

export function dailyMetricsChunkSize(itemsCount: number): number {
  return itemsCount > HEAVY_BATCH_THRESHOLD
    ? HEAVY_DAILY_CHUNK
    : DEFAULT_DAILY_CHUNK;
}

export function realtimeMetricsChunkSize(itemsCount: number): number {
  return itemsCount > HEAVY_BATCH_THRESHOLD
    ? HEAVY_REALTIME_CHUNK
    : DEFAULT_REALTIME_CHUNK;
}

export function adUpsertChunkSize(itemsCount: number): number {
  return itemsCount > HEAVY_BATCH_THRESHOLD
    ? HEAVY_AD_UPSERT_CHUNK
    : DEFAULT_AD_UPSERT_CHUNK;
}
```

**Why `export`:**
- `HEAVY_BATCH_THRESHOLD` экспортирован, чтобы тесты могли assert'ить поведение через константу, а не магическое число — Pre-Step B может выбрать любой порог без правки тестов.
- Три helper-функции экспортированы для unit-тестов (pure functions, легко покрыть).
- Existing `campaignUpsertChunkSize` НЕ экспортирован — оставляю как есть, не трогаю primary-fix контракт.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts convex/syncMetrics.test.ts`
Expected: PASS — 6 tests passing (3 helpers × 2 cases each).

- [ ] **Step 5: Run full typecheck and lint**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output (no errors).

Run: `npm run lint`
Expected: warnings count not increased above current 57. If new warnings added by these changes — fix them inline (typically import ordering or unused exports).

- [ ] **Step 6: Commit**

```bash
git add convex/syncMetrics.ts convex/syncMetrics.test.ts
git commit -m "$(cat <<'EOF'
feat(sync): add adaptive chunk-size helpers for batch flush mutations

Three new exported helpers (dailyMetricsChunkSize, realtimeMetricsChunkSize,
adUpsertChunkSize) by analogy with campaignUpsertChunkSize from primary
memory-fix. They return small chunks (25/50/50) when batch.length exceeds
HEAVY_BATCH_THRESHOLD, default (100/200/200) otherwise.

HEAVY_BATCH_THRESHOLD is exported so unit tests assert behaviour relative
to the threshold rather than hardcoded numbers — value calibrated via
admin.adsCountByAccount diagnostic query (Pre-Step B).

No caller-side changes yet — applied in subsequent commits.

Spec: docs/2026-05-03-convex-residual-carry-over-design.md
EOF
)"
```

---

### Task 2: Apply adaptive chunking in `syncAll` path (3 caller sites)

**Files:**
- Modify: `convex/syncMetrics.ts` lines `:342`, `:418`, `:427`

- [ ] **Step 1: Read current state of all three caller blocks**

Run: `grep -n "CHUNK = " convex/syncMetrics.ts | head -10`
Expected: confirm lines 341, 418, 427 with `const CHUNK = ...`.

- [ ] **Step 2: Replace `:342` (upsertAdsBatch in syncAll)**

Modify `convex/syncMetrics.ts:341-347` — replace:

```typescript
          if (adBatch.length > 0) {
            try {
              const CHUNK = DEFAULT_UPSERT_CHUNK_SIZE;
              for (let i = 0; i < adBatch.length; i += CHUNK) {
                await ctx.runMutation(internal.adAccounts.upsertAdsBatch, {
                  accountId: account._id,
                  ads: adBatch.slice(i, i + CHUNK),
```

With:

```typescript
          if (adBatch.length > 0) {
            try {
              const chunk = adUpsertChunkSize(adBatch.length);
              for (let i = 0; i < adBatch.length; i += chunk) {
                await ctx.runMutation(internal.adAccounts.upsertAdsBatch, {
                  accountId: account._id,
                  ads: adBatch.slice(i, i + chunk),
```

- [ ] **Step 3: Replace `:418` (saveRealtimeBatch in syncAll)**

Modify `convex/syncMetrics.ts:417-423` — replace:

```typescript
        if (realtimeBatchAll.length > 0) {
          const CHUNK = 200;
          for (let i = 0; i < realtimeBatchAll.length; i += CHUNK) {
            await ctx.runMutation(internal.metrics.saveRealtimeBatch, {
              accountId: account._id,
              items: realtimeBatchAll.slice(i, i + CHUNK),
            });
```

With:

```typescript
        if (realtimeBatchAll.length > 0) {
          const chunk = realtimeMetricsChunkSize(realtimeBatchAll.length);
          for (let i = 0; i < realtimeBatchAll.length; i += chunk) {
            await ctx.runMutation(internal.metrics.saveRealtimeBatch, {
              accountId: account._id,
              items: realtimeBatchAll.slice(i, i + chunk),
            });
```

- [ ] **Step 4: Replace `:427` (saveDailyBatch in syncAll)**

Modify `convex/syncMetrics.ts:426-432` — replace:

```typescript
        if (dailyBatchAll.length > 0) {
          const CHUNK = 100;
          for (let i = 0; i < dailyBatchAll.length; i += CHUNK) {
            await ctx.runMutation(internal.metrics.saveDailyBatch, {
              accountId: account._id,
              items: dailyBatchAll.slice(i, i + CHUNK),
            });
```

With:

```typescript
        if (dailyBatchAll.length > 0) {
          const chunk = dailyMetricsChunkSize(dailyBatchAll.length);
          for (let i = 0; i < dailyBatchAll.length; i += chunk) {
            await ctx.runMutation(internal.metrics.saveDailyBatch, {
              accountId: account._id,
              items: dailyBatchAll.slice(i, i + chunk),
            });
```

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: all tests pass (6 new from Task 1 + 651 existing = 657 total). 0 failed.

- [ ] **Step 7: Commit**

```bash
git add convex/syncMetrics.ts
git commit -m "$(cat <<'EOF'
perf(sync): adaptive chunking in syncAll path (3 batch flush sites)

Apply dailyMetricsChunkSize / realtimeMetricsChunkSize / adUpsertChunkSize
helpers at three caller sites in syncAll: upsertAdsBatch, saveRealtimeBatch,
saveDailyBatch. On heavy accounts (batch > 500 items) chunks shrink from
100/200/200 to 25/50/50 to relieve Convex transaction write-set pressure.

Spec: docs/2026-05-03-convex-residual-carry-over-design.md §3.1
EOF
)"
```

---

### Task 3: Apply adaptive chunking in `syncBatchWorker` path (3 caller sites)

**Files:**
- Modify: `convex/syncMetrics.ts` lines `:1115`, `:1190`, `:1199`

- [ ] **Step 1: Verify current state of caller sites**

Run: `awk 'NR>=1110 && NR<=1210 {print NR": "$0}' convex/syncMetrics.ts | grep "CHUNK = "`
Expected: 3 lines with `CHUNK = DEFAULT_UPSERT_CHUNK_SIZE`, `CHUNK = 200`, `CHUNK = 100`.

- [ ] **Step 2: Replace `:1115` (upsertAdsBatch in syncBatchWorker)**

Modify the equivalent block in `syncBatchWorker` (around `:1110-1120`) — same shape as Task 2 Step 2 but inside `syncSingleAccount` function.

Replace:

```typescript
        if (adBatch.length > 0) {
          try {
            const CHUNK = DEFAULT_UPSERT_CHUNK_SIZE;
            for (let i = 0; i < adBatch.length; i += CHUNK) {
              await ctx.runMutation(internal.adAccounts.upsertAdsBatch, {
                accountId: account._id,
                ads: adBatch.slice(i, i + CHUNK),
              });
```

With:

```typescript
        if (adBatch.length > 0) {
          try {
            const chunk = adUpsertChunkSize(adBatch.length);
            for (let i = 0; i < adBatch.length; i += chunk) {
              await ctx.runMutation(internal.adAccounts.upsertAdsBatch, {
                accountId: account._id,
                ads: adBatch.slice(i, i + chunk),
              });
```

- [ ] **Step 3: Replace `:1190` (saveRealtimeBatch in syncBatchWorker)**

Replace:

```typescript
        if (realtimeBatch.length > 0) {
          const CHUNK = 200;
          for (let i = 0; i < realtimeBatch.length; i += CHUNK) {
            await ctx.runMutation(internal.metrics.saveRealtimeBatch, {
              accountId: account._id,
              items: realtimeBatch.slice(i, i + CHUNK),
            });
```

With:

```typescript
        if (realtimeBatch.length > 0) {
          const chunk = realtimeMetricsChunkSize(realtimeBatch.length);
          for (let i = 0; i < realtimeBatch.length; i += chunk) {
            await ctx.runMutation(internal.metrics.saveRealtimeBatch, {
              accountId: account._id,
              items: realtimeBatch.slice(i, i + chunk),
            });
```

- [ ] **Step 4: Replace `:1199` (saveDailyBatch in syncBatchWorker)**

Replace:

```typescript
        if (dailyBatch.length > 0) {
          const CHUNK = 100;
          for (let i = 0; i < dailyBatch.length; i += CHUNK) {
            await ctx.runMutation(internal.metrics.saveDailyBatch, {
              accountId: account._id,
              items: dailyBatch.slice(i, i + CHUNK),
            });
```

With:

```typescript
        if (dailyBatch.length > 0) {
          const chunk = dailyMetricsChunkSize(dailyBatch.length);
          for (let i = 0; i < dailyBatch.length; i += chunk) {
            await ctx.runMutation(internal.metrics.saveDailyBatch, {
              accountId: account._id,
              items: dailyBatch.slice(i, i + chunk),
            });
```

- [ ] **Step 5: Verify typecheck and tests**

Run: `npx tsc --noEmit -p convex/tsconfig.json && npm test`
Expected: tsc clean, all tests pass.

(Только новый test file во время отладки: `npx vitest run --config vitest.config.ts convex/syncMetrics.test.ts`.)

- [ ] **Step 6: Verify all caller-side `CHUNK` literals replaced**

Точечная проверка только локальных `const CHUNK = ...` (caller-side variable), без затрагивания module-level констант типа `DEFAULT_DAILY_CHUNK`, `HEAVY_AD_UPSERT_CHUNK` etc.

Run: `grep -nE "^[[:space:]]+const CHUNK[[:space:]]*=" convex/syncMetrics.ts`
Expected: **zero matches**. Все 6 caller-сайтов теперь используют helper-функции.

(Module-level константы `DEFAULT_*_CHUNK` / `HEAVY_*_CHUNK` остаются — они корректны и не должны попадать в этот grep, потому что они на column 1, не индентированы.)

- [ ] **Step 7: Commit**

```bash
git add convex/syncMetrics.ts
git commit -m "$(cat <<'EOF'
perf(sync): adaptive chunking in syncBatchWorker path (3 batch flush sites)

Same change as syncAll path, applied to syncBatchWorker. With this commit
all six caller sites of saveDailyBatch / saveRealtimeBatch / upsertAdsBatch
use adaptive helpers; no fixed CHUNK literals remain in syncMetrics.ts.

Spec: docs/2026-05-03-convex-residual-carry-over-design.md §3.1
EOF
)"
```

---

### Task 4: Pre-push verification

**Files:** none (verification only)

- [ ] **Step 1: Final typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output, exit code 0.

- [ ] **Step 2: Final lint**

Run: `npm run lint`
Expected: `0 errors`, warnings count ≤ 60 (current limit).

- [ ] **Step 3: Final test suite**

Run: `npm test`
Expected: all tests pass (6 new from Task 1 + 651 existing = 657 total). 0 failed.

- [ ] **Step 4: Sanity diff review**

Run: `git diff origin/main..HEAD -- convex/syncMetrics.ts | head -200`
Expected: only chunk-size constants, helpers, and 6 caller-site replacements. No accidental edits to other parts of `syncMetrics.ts`.

- [ ] **Step 5: Confirm uncommitted state is clean**

Run: `git status`
Expected: working tree clean (or only files unrelated to this PR — pre-existing untracked).

---

### Task 5: Push to main and watch CI/Deploy

**Files:** none

- [ ] **Step 1: Push**

Run: `git push origin main`
Expected: push succeeds, GitHub Actions Deploy + CI start automatically.

- [ ] **Step 2: Watch Deploy run (~60s)**

```bash
gh run list --limit 2
# Get the Deploy run id from "in_progress" line
gh run watch <DEPLOY_RUN_ID> --exit-status
```

Expected: Deploy completes with `success` (~55s based on last deploy).

- [ ] **Step 3: Watch CI run in background**

```bash
gh run watch <CI_RUN_ID> --exit-status
```

Run in foreground and wait — CI typically 10–15 minutes (E2E Playwright). Expected: `success`.

If CI fails:
- Read `gh run view <CI_RUN_ID> --log-failed | tail -100`
- Diagnose. Most likely: lint warning over limit, or test failure unrelated to our change. Fix in a separate `chore(lint)` or `fix(test)` commit and push.

---

### Task 6: Cleanup — remove diagnostic query (UNCONDITIONAL)

**Files:**
- Modify: `convex/admin.ts` (delete `adsCountByAccount`)

**ALWAYS RUN, regardless of verification outcome.** Эту задачу нельзя пропустить или отложить «до результатов». Diagnostic query больше не нужна (порог уже выбран в Pre-Step B и зашит в код), и оставлять её в prod — это дополнительная attack surface + risk что кто-то вызовет её с увеличившимся ads count и поймает carry-over от той же diagnostic.

Если Task 7 verification провалится → сначала закрыть Task 6 (cleanup), потом открывать follow-up plan на §3.3 module-state.

- [ ] **Step 1: Delete the temporary diagnostic functions**

Modify `convex/admin.ts` — delete BOTH temporary functions added in Pre-Step B:
- `adsCountByAccount` (internalQuery, marked with `// DIAGNOSTIC (temporary):` comment)
- `reportAdsCountByAccount` (internalAction wrapper, marked with `// DIAGNOSTIC (temporary):` comment)

Each block ends after closing `});`.

- [ ] **Step 2: Verify**

Source-only check (исключая autogenerated `_generated/**`, который может ещё содержать старые имена до пересборки кодгена):

```bash
grep -rn --exclude-dir=_generated "adsCountByAccount\|reportAdsCountByAccount" convex/
```

Or with ripgrep:

```bash
rg "adsCountByAccount|reportAdsCountByAccount" convex --glob '!_generated/**'
```

Expected: no matches (both functions fully removed from source). Files in `convex/_generated/` обновятся при следующем `npx convex deploy` (или GitHub Actions pipeline после push); проверять их вручную не нужно.

Если использовался fallback `reportAdsCountByAccountPublic` (см. Pre-Step B Step 1) — добавить его имя в grep pattern:

```bash
grep -rn --exclude-dir=_generated \
  "adsCountByAccount\|reportAdsCountByAccount\|reportAdsCountByAccountPublic" convex/
```

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

- [ ] **Step 3: Commit and push**

```bash
git add convex/admin.ts
git commit -m "chore(diag): remove adsCountByAccount after threshold calibration"
git push origin main
```

Wait for Deploy success (~60s) before proceeding to Task 7. The diagnostic query must be off prod **before** the verification window so post-cleanup metrics are clean.

---

### Task 7: Post-deploy monitoring (verification §6 of spec)

**Files:** none

- [ ] **Step 1: Wait 30 minutes from Deploy completion**

The Convex Isolate needs time to accumulate state under the new code. Earlier than ~30 min the carry-over count is not informative.

- [ ] **Step 2: Snapshot — Acceptance §6.1 + §6.2**

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'echo "=== saveDailyBatch carry-over (target: 0) ==="; \
   docker logs --since 30m adpilot-convex-backend 2>&1 \
     | grep saveDailyBatch | grep -c TooMuchMemoryCarryOver; \
   echo "=== saveRealtimeBatch + upsertAdsBatch carry-over (target: 0) ==="; \
   docker logs --since 30m adpilot-convex-backend 2>&1 \
     | grep -E "saveRealtimeBatch|upsertAdsBatch" | grep -c TooMuchMemoryCarryOver'
```

Expected: both counts = 0.

- [ ] **Step 3: Snapshot — Acceptance §6.3 (total)**

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker logs --since 1h adpilot-convex-backend 2>&1 | grep -c TooMuchMemoryCarryOver'
```

Expected: 0–1 (down from 7 baseline).

- [ ] **Step 4: Snapshot — Acceptance §6.5 (trivial markers)**

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker logs --since 30m adpilot-convex-backend 2>&1 \
   | grep -E "updateSyncTime|getInternal|getVkAdsCredentials" \
   | grep -c TooMuchMemoryCarryOver'
```

Expected: 0.

If any marker > 0 — **module state hypothesis is real**. План не закрыл residual carry-over. **Не пропускать остальные шаги Task 7** — даже при провале acceptance проходим Step 5 (p95) и Step 6 (Record results) до конца, чтобы зафиксировать failure, baseline-цифры и пойнт-перехода в spec. Это и есть документ-handoff в follow-up plan.

После Step 6: skip further chunk-tuning, открыть отдельный план для спека §3.3 (diagnostic) → §3.4–3.5 (module audit / split). В §11 Decision указать `continue with §3.3 module-state diagnostic`.

- [ ] **Step 5: Snapshot — Acceptance §6.4 (p95 didn't regress)**

Open Convex Dashboard → Functions → check p95 duration for `metrics:saveDailyBatch`, `metrics:saveRealtimeBatch`, `adAccounts:upsertAdsBatch`. Compare with pre-deploy baseline (Dashboard typically retains 24h history).

Expected: p95 ≤ baseline + 30%. If p95 grew >30% on heavy accounts — chunks too small, fragmentation eats latency. Decision:
- Минорное превышение (30–50%) — оставить, мониторить ещё сутки.
- Сильное превышение (>50%) — поднять `HEAVY_BATCH_THRESHOLD` (500 → 800) или `HEAVY_DAILY_CHUNK` (25 → 50). Отдельный коммит + push.

- [ ] **Step 6: Record results**

Append to spec `docs/2026-05-03-convex-residual-carry-over-design.md` после §10:

```markdown
---

## 11. Implementation results (filled after deploy)

- Deploy commit: <sha>
- Deploy timestamp UTC: ____
- Pre-deploy carry-over/h: 7
- Post-deploy carry-over/h (T+30m): ____
- saveDailyBatch carry-over: ____
- saveRealtimeBatch + upsertAdsBatch carry-over: ____
- Trivial markers carry-over: ____
- p95 saveDailyBatch (pre / post): ____ms / ____ms
- Decision: [closed / continue with §3.3 module-state diagnostic]
```

Commit:

```bash
git add docs/2026-05-03-convex-residual-carry-over-design.md
git commit -m "docs(spec): record residual carry-over fix results"
git push origin main
```

---

## Self-Review Checklist

**1. Spec coverage:**
- §3.0 Pre-fix taxonomy → Pre-Step A ✓
- §3.1 Adaptive chunk for 3 mutations → Tasks 1–3 ✓
- §3.2 Read-set optimization → **NOT in this plan** (spec says "optional, after §3.1" — wait for verification first)
- §3.3–3.5 Module state diagnostic → **NOT in this plan** (spec §9 says "only if §3.1 didn't close it")
- §6.1–6.5 Verification → Task 7 ✓
- §7 Risks (atomicity loss) → no test for it because following 5-min sync compensates; documented risk in spec
- §9 Implementation order — plan follows: Pre-Step A → Pre-Step B → §3.1 (Tasks 1–3) → push (Task 5) → cleanup diagnostic (Task 6, unconditional) → 30–60min monitoring (Task 7) → conditional §3.3–3.5 (out of scope) ✓
- Pre-Step B (ads-per-account) → mapped to Pre-Step B in plan, with bounded paginated query to avoid being the carry-over source itself ✓

**2. Placeholder scan:** no `TODO`, `TBD`, "implement later", or "similar to Task N" — every step contains exact code, exact file paths, and concrete commands.

**3. Type consistency:**
- `dailyMetricsChunkSize`, `realtimeMetricsChunkSize`, `adUpsertChunkSize` — same names across all tasks ✓
- `HEAVY_BATCH_THRESHOLD` — same exported constant referenced in Pre-Step B decision, Task 1 implementation, AND test assertions ✓
- Tests assert behaviour relative to the threshold (not magic numbers), so Pre-Step B can choose any value without breaking tests ✓
- All three helpers have identical signature `(itemsCount: number) => number` ✓
- Caller sites use `chunk` (lowercase) for adaptive variant, replacing `CHUNK` (uppercase) literal — naming consistent across Tasks 2 and 3 ✓
- Grep verification (`Step 6 of Task 3`) targets only indented `const CHUNK = ` (caller-side variables), not module-level `DEFAULT_*_CHUNK` / `HEAVY_*_CHUNK` constants ✓

**4. No spec gaps that lack tasks:**
- Spec §5 «Опционально (диагностика, не лечение)» — temporary heap logger — explicitly opt-in, not in plan unless §6.5 fails. OK.
- Spec §8 «Источники истины» — purely reference, not actionable.
- Spec §10 «Связь с auto-link cron» — tells us NOT to mix; this plan respects that (no cron work). OK.

---

## Execution Handoff

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks. Best when implementor is a separate agent and changes are independent.

2. **Inline Execution** — execute tasks in current session using `superpowers:executing-plans`, batch with checkpoints.

Tell the executor which to use. **In either case:** Pre-Step A and Pre-Step B are blocking — do NOT skip them. They protect against doing a cosmetic fix on the wrong half of the problem.
