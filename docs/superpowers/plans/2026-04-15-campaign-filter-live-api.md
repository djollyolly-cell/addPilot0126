# Campaign Filter Live API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix broken campaign filter + fast_spend rules by replacing DB-dependent lookups with live VK API data, and keep `campaigns`/`ads` tables always fresh via auto-upsert.

**Architecture:** In syncAll per-account loop: fetch campaigns from VK API → auto-upsert campaigns/ads tables → build adCampaignMap → pass to new `checkRulesForAccount`. On API failure, fall back to DB (now always fresh). Per-account isolation replaces global `checkAllRules`.

**Tech Stack:** Convex (internalAction, internalMutation, internalQuery), VK Ads API (myTarget v2), TypeScript

**Spec:** `docs/superpowers/specs/2026-04-15-campaign-filter-live-api-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `convex/syncMetrics.ts` | Modify | Add getCampaignsForAccount call + circuit breaker, auto-upsert campaigns/ads, build adCampaignMap, call checkRulesForAccount per-account, remove global checkAllRules call, increase timeout |
| `convex/ruleEngine.ts` | Modify | New `checkRulesForAccount` internalAction with dual-path lookup, refactor `checkAllRules` to thin wrapper |
| `tests/unit/ruleEngine.test.ts` | Modify | Add `matchesCampaignFilter` tests with adPlanId |

---

### Task 1: Add `matchesCampaignFilter` tests with adPlanId

**Files:**
- Modify: `tests/unit/ruleEngine.test.ts`

Verifies the existing pure function handles all dual-matching scenarios before wiring to new data sources.

- [ ] **Step 1: Add matchesCampaignFilter import**

In `tests/unit/ruleEngine.test.ts`, add `matchesCampaignFilter` to the existing import from `../../convex/ruleEngine`.

- [ ] **Step 2: Write matchesCampaignFilter tests**

Add describe block at the end of the file:

```typescript
describe("matchesCampaignFilter", () => {
  it("matches by adGroupId", () => {
    expect(matchesCampaignFilter(["100", "200"], "100", null)).toBe(true);
  });

  it("matches by adPlanId", () => {
    expect(matchesCampaignFilter(["500"], null, "500")).toBe(true);
  });

  it("matches by adPlanId when adGroupId doesn't match", () => {
    expect(matchesCampaignFilter(["500"], "999", "500")).toBe(true);
  });

  it("returns false when neither matches", () => {
    expect(matchesCampaignFilter(["100", "200"], "300", "400")).toBe(false);
  });

  it("returns false when both are null", () => {
    expect(matchesCampaignFilter(["100"], null, null)).toBe(false);
  });

  it("matches when both adGroupId and adPlanId match", () => {
    expect(matchesCampaignFilter(["100", "200"], "100", "200")).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm run test -- tests/unit/ruleEngine.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```
test: add matchesCampaignFilter dual-matching tests
```

---

### Task 2: Create `checkRulesForAccount` in ruleEngine.ts

**Files:**
- Modify: `convex/ruleEngine.ts`

Extract per-account logic from `checkAllRules` (lines 1209–1646) into new `checkRulesForAccount` internalAction with dual-path campaign/budget lookup.

- [ ] **Step 1: Add `checkRulesForAccount` function**

Insert BEFORE the existing `checkAllRules` function. See spec section 4 for full signature and dual-path logic.

Key structural changes vs extracted code:
1. Receives `accountId` + optional `adCampaignMap` as args
2. Queries account → userId, loads rules filtered by `targetAccountIds.includes(accountId)`
3. If `adCampaignMap` provided → O(1) map lookup for campaign filter + fast_spend budget
4. If not provided → existing DB lookup via `getAdCampaignId` / `getAdPlanId` / `getCampaignDailyLimit`
5. All other logic (metrics snapshot, dedup, safety check, stopAd, notifications) — copy as-is

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors. Verify `SpendSnapshot`, `computeRealtimeDelta`, `buildReason`, `todayStr` are in scope.

- [ ] **Step 3: Commit**

```
feat: add checkRulesForAccount with dual-path campaign lookup
```

---

### Task 3: Refactor `checkAllRules` to thin wrapper

**Files:**
- Modify: `convex/ruleEngine.ts` (replace entire `checkAllRules` body, ~450 lines → ~15 lines)

- [ ] **Step 1: Replace `checkAllRules` function body**

Replace with thin wrapper that iterates accounts and calls `checkRulesForAccount` without map (DB fallback). See spec section 5.

Old `processedUsers` dedup is removed — `checkRulesForAccount` filters rules by `targetAccountIds.includes(accountId)`.

- [ ] **Step 2: Verify no dead code**

All internalQuery functions previously called from `checkAllRules` must still be referenced from `checkRulesForAccount`: `getAccountById`, `listActiveRules`, `getAccountTodayMetrics`, `getAccountAllAdIds`, `getAdCampaignId`, `getAdPlanId`, `getCampaignDailyLimit`, `getRealtimeHistory`, `isAlreadyTriggeredToday`, `getAdAggregatedMetrics`, `updateAdLeads`, `createActionLog`, `incrementTriggerCount`.

- [ ] **Step 3: Typecheck + run tests**

```bash
npx tsc --noEmit -p convex/tsconfig.json
npm run test -- tests/unit/ruleEngine.test.ts
```
Expected: No errors, all tests PASS

- [ ] **Step 4: Commit**

```
refactor: checkAllRules → thin wrapper calling checkRulesForAccount
```

---

### Task 4: Wire syncAll — getCampaignsForAccount + auto-upsert + per-account rules

**Files:**
- Modify: `convex/syncMetrics.ts`

This is the main wiring task. Five changes in one file:
1. Increase `ACCOUNT_TIMEOUT_MS` 90s → 120s
2. Add `MtCampaign` type import
3. Add circuit breaker variable + `getCampaignsForAccount` call with retry
4. Add auto-upsert campaigns/ads (try/catch, non-blocking)
5. Add `checkRulesForAccount` call per-account + remove global `checkAllRules` call

- [ ] **Step 1: Increase timeout + add import**

```typescript
const ACCOUNT_TIMEOUT_MS = 120_000; // 120s per account (includes getCampaigns + upsert + rule check)
```

Add `MtCampaign` to type import from `./vkApi`.

- [ ] **Step 2: Add circuit breaker variable**

Before per-account loop (`for (const account of accounts)`):

```typescript
let consecutiveCampaignApiFailures = 0;
```

- [ ] **Step 3: Add getCampaignsForAccount + map building**

Inside per-account `withTimeout` block, after `bannerCampaignMap` construction, before video auto-link section. See spec section 1 + section 2.

Includes:
- `getCampaignsForAccount` call with circuit breaker (threshold 3) + retry once
- On failure: log to `systemLogger`, continue with empty `vkCampaigns`
- Build `groupData` map: ad_group_id → { adPlanId, dailyBudget }
- Build `adCampaignMap` array: adId → { adGroupId, adPlanId, dailyBudget }
- Happy-path log: `[syncAll] Live campaign map: N ads, M campaigns for «name»`

- [ ] **Step 4: Add auto-upsert campaigns + ads**

After map building, before metrics save. See spec section 3a + 3b.

Both wrapped in try/catch — failure must NOT block metrics save or rule checking:
- Upsert campaigns via existing `api.adAccounts.upsertCampaign`
- Upsert ads via existing `api.adAccounts.upsertAd` (find campaign by `getCampaignByVkId` first)
- On failure: log to `systemLogger` (warn level), continue

- [ ] **Step 5: Add per-account rule check**

After metrics save (after `updateSyncTime`), before closing. See spec section 6.

```typescript
try {
  await ctx.runAction(internal.ruleEngine.checkRulesForAccount, {
    accountId: account._id,
    adCampaignMap: adCampaignMap.length > 0 ? adCampaignMap : undefined,
  });
} catch (err) {
  // log to systemLogger, continue
}
```

- [ ] **Step 6: Remove global checkAllRules call**

Delete the post-loop `checkAllRules` call (lines ~392-410 — the `withTimeout(ctx.runAction(internal.ruleEngine.checkAllRules, {}), ...)` block).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 8: Commit**

```
feat: wire syncAll with live campaign API + auto-upsert + per-account rules

- getCampaignsForAccount with retry + circuit breaker
- Auto-upsert campaigns/ads tables every cycle (non-blocking)
- Build adCampaignMap from live API data
- checkRulesForAccount per-account (replaces global checkAllRules)
- ACCOUNT_TIMEOUT_MS 90s → 120s
```

---

### Task 5: Full verification

**Files:** None (verification only)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`

- [ ] **Step 2: Run all unit tests**

Run: `npm run test`

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No new warnings (max 50 total)

- [ ] **Step 4: Build**

Run: `npm run build`

- [ ] **Step 5: Verify no token code was touched**

Run: `git diff HEAD~4 -- convex/auth.ts convex/tokenRecovery.ts`
Expected: No output (files unchanged)

- [ ] **Step 6: Review diff**

Run: `git diff HEAD~4 -- convex/ruleEngine.ts convex/syncMetrics.ts`

Verify:
- `checkRulesForAccount` has dual-path for campaign filter + fast_spend
- `checkAllRules` is a thin wrapper
- `syncAll` calls `getCampaignsForAccount` with retry + circuit breaker
- `syncAll` auto-upserts campaigns/ads with try/catch (non-blocking)
- `syncAll` calls `checkRulesForAccount` per-account inside loop
- Global `checkAllRules` call removed from post-loop
- `ACCOUNT_TIMEOUT_MS` is 120_000
- Happy-path log present
