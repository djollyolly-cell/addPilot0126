# Rule Engine: Live VK API Campaign Data

**Date:** 2026-04-15
**Status:** Approved

## Problem

Three functions in `checkAllRules` depend on `ads`/`campaigns` DB tables that are only populated by manual "Sync" button (`syncNow`). New ads created in VK Ads have metrics (synced every 5 min) but no DB records, causing:

1. **Campaign filter broken** — `getAdCampaignId` / `getAdPlanId` return `null` for new ads → `matchesCampaignFilter` returns `false` → rules with `targetCampaignIds` silently skip these ads
2. **`fast_spend` broken** — `getCampaignDailyLimit` returns `null` for new ads → `evaluateCondition` returns `false` at line 127 (`if (!budget) return false`) → rule silently doesn't fire
3. **`adPlanId` never populated** — field exists in `campaigns` schema but is never set → dual matching (ad_group + ad_plan) always fails on the ad_plan side
4. **`ads`/`campaigns` tables stale** — only populated by manual sync → `actionLogs.adName` empty for new ads, DB fallback path broken for all ads created after last manual sync

UZ budget rules work fine because they query VK API directly via `getCampaignsForAccount`, bypassing DB tables.

## Solution

Two-part fix:
1. **Live API map for rule evaluation** — replace DB-dependent lookups with live VK API data map, using the same `getCampaignsForAccount` function proven in UZ budget rules. On API failure, fall back to DB lookups.
2. **Auto-upsert `campaigns`/`ads` tables in syncAll** — keep DB tables always fresh using data already fetched (`getMtBanners` + `getCampaignsForAccount`). Eliminates dependency on manual sync for DB fallback, actionLogs, and any other code using these tables.

### Why `getCampaignsForAccount` (not `getMtAdGroups`)

`getMtAdGroups` returns only `id, ad_plan_id`. But `fast_spend` needs `budget_limit_day` which is only in the full `MtCampaign` response:

```typescript
MtCampaign {
  id: number              // ad_group_id — needed for campaign filter
  ad_plan_id?: number     // needed for dual campaign matching
  budget_limit_day: string // needed for fast_spend
  name, status, budget_limit, package_id, delivery  // not needed now, available for future cache
}
```

`getCampaignsForAccount` already exists, is battle-tested in UZ cron, paginates at 250/page (usually 1 request per account).

### Architecture: Per-Account Rule Checking

**Why not a single global map:** 260 active accounts × ~50 ads each = ~13,000 entries. Serialized as Convex action arg (~100 bytes/entry) = ~1.3 MB, exceeding the 1 MB arg limit. Per-account map is ~2-20 KB — safely within limits.

**Before:**
```
syncAll → per account: [fetch metrics, save] → checkAllRules() (global, loads all accounts internally)
```

**After:**
```
syncAll → per account: [fetch metrics + getCampaigns, save, checkRulesForAccount(accountId, adCampaignMap)]
```

Key changes:
- New `checkRulesForAccount(accountId, adCampaignMap?)` — all per-account rule logic extracted here
- `checkAllRules` becomes a thin wrapper: iterates accounts, calls `checkRulesForAccount` without map (DB fallback path)
- In syncAll: call `checkRulesForAccount` with map from live API data
- If `adCampaignMap` provided → O(1) map lookup (fast path)
- If `adCampaignMap` not provided → DB lookup via existing functions (fallback path)

### Data Flow (new)

```
syncAll (every 5 min)
  ├── per account:
  │   ├── Promise.all([getMtStatistics, getMtLeadCounts, getMtBanners])  // existing, unchanged
  │   ├── getCampaignsForAccount (try/catch, retry once, circuit breaker) // NEW
  │   ├── build bannerCampaignMap: adId → ad_group_id                   // existing, unchanged
  │   ├── build groupData: ad_group_id → { adPlanId, dailyBudget }      // NEW
  │   ├── build adCampaignMap: adId → { adGroupId, adPlanId, dailyBudget } // NEW
  │   ├── upsert campaigns table (adPlanId + dailyLimit + status)       // NEW — auto-sync
  │   ├── upsert ads table (name + status + campaignId link)            // NEW — auto-sync
  │   ├── save metrics to metricsDaily/metricsRealtime                  // existing, unchanged
  │   └── checkRulesForAccount(accountId, adCampaignMap)                // NEW (per-account)
  │
  └── (checkAllRules removed from post-loop position)
```

## Detailed Design

### 1. `getCampaignsForAccount` call in syncAll

**Location:** `convex/syncMetrics.ts`, inside per-account loop, AFTER existing `Promise.all`

```typescript
// Existing — unchanged
const [stats, leadCounts, banners] = await Promise.all([
  getMtStatistics(...),
  getMtLeadCounts(...),
  getMtBanners(...)
]);

// NEW — separate try/catch, does not block metrics on failure
// Circuit breaker: skip API after 3 consecutive failures in this batch
let vkCampaigns: MtCampaign[] = [];
if (consecutiveCampaignApiFailures < 3) {
  try {
    vkCampaigns = await ctx.runAction(
      internal.vkApi.getCampaignsForAccount, { accessToken }
    );
    consecutiveCampaignApiFailures = 0; // Reset on success
  } catch (err) {
    console.warn(`[syncAll] getCampaignsForAccount failed for «${account.name}»: ${err}`);
    // Retry once
    try {
      vkCampaigns = await ctx.runAction(
        internal.vkApi.getCampaignsForAccount, { accessToken }
      );
      consecutiveCampaignApiFailures = 0;
    } catch (retryErr) {
      consecutiveCampaignApiFailures++;
      console.error(`[syncAll] getCampaignsForAccount retry failed for «${account.name}» (${consecutiveCampaignApiFailures}/3): ${retryErr}`);
      try { await ctx.runMutation(internal.systemLogger.log, {
        accountId: account._id,
        level: "error",
        source: "syncMetrics",
        message: `getCampaignsForAccount failed after retry: ${String(retryErr).slice(0, 180)}`,
      }); } catch { /* non-critical */ }
      // Continue with empty — metrics save normally, checkRulesForAccount uses DB fallback
    }
  }
} else {
  // Circuit breaker tripped — skip API, use DB fallback
  console.warn(`[syncAll] Circuit breaker active — skipping getCampaignsForAccount for «${account.name}»`);
}
```

**Circuit breaker variable** (declared before per-account loop):
```typescript
let consecutiveCampaignApiFailures = 0;
```

**Behavior on failure:**
- Retry once immediately in same cycle
- If retry fails: increment failure counter, log to `systemLogger` (error level)
- After 3 consecutive account failures: skip `getCampaignsForAccount` for remaining accounts in batch (prevents wasting ~4 sec × remaining accounts when VK API is down)
- Metrics save normally (independent)
- `checkRulesForAccount` called without `adCampaignMap` → DB fallback path (now reliable thanks to auto-upsert from previous cycles)
- Next cycle (5 min) resets circuit breaker and retries API for all accounts

### 2. Build campaign data map

**Location:** `convex/syncMetrics.ts`, after `getCampaignsForAccount` call

```typescript
// ad_group_id → { adPlanId, dailyBudget }
const groupData = new Map<string, { adPlanId: string | null; dailyBudget: number }>();
for (const c of vkCampaigns) {
  groupData.set(String(c.id), {
    adPlanId: c.ad_plan_id ? String(c.ad_plan_id) : null,
    dailyBudget: Number(c.budget_limit_day || "0"),
  });
}

// adId → { adGroupId, adPlanId, dailyBudget } for checkRulesForAccount
// Uses existing bannerCampaignMap (adId → ad_group_id from getMtBanners)
const adCampaignMap: Array<{ adId: string; adGroupId: string; adPlanId: string | null; dailyBudget: number }> = [];
for (const [adId, adGroupId] of bannerCampaignMap) {
  const data = groupData.get(adGroupId);
  adCampaignMap.push({
    adId,
    adGroupId,
    adPlanId: data?.adPlanId ?? null,
    dailyBudget: data?.dailyBudget ?? 0,  // 0 = budget not set, null not used — consistent with VK API
  });
}
```

**Value semantics for `dailyBudget`:**
- `0` — budget not set in VK (or ad_group not found in campaigns response). `fast_spend` correctly returns `false` (`if (!budget || budget <= 0)`)
- `> 0` — real daily budget from VK API, used by `fast_spend` for percentage calculation

### 3. Auto-upsert `campaigns` and `ads` tables

**Location:** `convex/syncMetrics.ts`, inside per-account loop

Data for upsert is already available — `vkCampaigns` from `getCampaignsForAccount` and `banners` from `getMtBanners`. No extra API calls needed.

#### 3a. Upsert campaigns

```typescript
// Upsert campaigns from VK API data (uses existing adAccounts.upsertCampaign)
// Wrapped in try/catch — upsert failure must not block metrics save or rule checking
if (vkCampaigns.length > 0) {
  try {
    for (const c of vkCampaigns) {
      await ctx.runMutation(api.adAccounts.upsertCampaign, {
        accountId: account._id,
        vkCampaignId: String(c.id),
        adPlanId: c.ad_plan_id ? String(c.ad_plan_id) : undefined,
        name: c.name || `Кампания ${c.id}`,
        status: c.status,
        dailyLimit: Number(c.budget_limit_day || "0") || undefined,
        allLimit: Number(c.budget_limit || "0") || undefined,
      });
    }
  } catch (err) {
    console.error(`[syncAll] upsertCampaigns failed for «${account.name}»:`, err);
    try { await ctx.runMutation(internal.systemLogger.log, {
      accountId: account._id,
      level: "warn",
      source: "syncMetrics",
      message: `Auto-upsert campaigns failed: ${String(err).slice(0, 180)}`,
    }); } catch { /* non-critical */ }
    // Continue — live map still works for current cycle, DB data stays from previous cycle
  }
}
```

Uses existing `upsertCampaign` mutation — same function called by manual `syncNow`. Idempotent: creates if missing, updates if changed.

#### 3b. Upsert ads (banners)

```typescript
// Upsert ads from getMtBanners data (uses existing adAccounts.upsertAd)
// Wrapped in try/catch — upsert failure must not block metrics save or rule checking
try {
  for (const banner of banners) {
    const campaignVkId = String(banner.campaign_id);
    // Find campaign in DB (just upserted above)
    const campaign = await ctx.runQuery(api.adAccounts.getCampaignByVkId, {
      accountId: account._id,
      vkCampaignId: campaignVkId,
    });
    if (campaign) {
      const bannerName = banner.textblocks?.title?.text || `Баннер ${banner.id}`;
      await ctx.runMutation(api.adAccounts.upsertAd, {
        accountId: account._id,
        campaignId: campaign._id,
        vkAdId: String(banner.id),
        name: bannerName,
        status: banner.status,
        approved: banner.moderation_status,
      });
    }
  }
} catch (err) {
  console.error(`[syncAll] upsertAds failed for «${account.name}»:`, err);
  try { await ctx.runMutation(internal.systemLogger.log, {
    accountId: account._id,
    level: "warn",
    source: "syncMetrics",
    message: `Auto-upsert ads failed: ${String(err).slice(0, 180)}`,
  }); } catch { /* non-critical */ }
  // Continue — live map still works for current cycle, DB data stays from previous cycle
}
```

Uses existing `upsertAd` mutation — same function called by manual `syncNow`. Creates ad records linked to campaigns, keeping `ads` table always fresh.

**Error handling:** Upsert is non-blocking — failure logged to `systemLogger`, but metrics save and `checkRulesForAccount` proceed normally. Live `adCampaignMap` works independently of DB tables, so current cycle is unaffected. DB data from previous successful cycle remains valid for fallback.

**Benefits:**
- DB fallback path now works for ALL ads (not just manually synced ones)
- `actionLogs.adName` always populated correctly
- `getAdCampaignId` / `getAdPlanId` return correct data even without live map
- No dependency on manual "Sync" button anymore
- Uses existing upsert functions — no new mutations needed

### 4. checkRulesForAccount — new function

**Location:** `convex/ruleEngine.ts`

**Extraction strategy:** Move ~450 lines of per-account logic from `checkAllRules` (lines 1209–1646) as-is into `checkRulesForAccount`. Two structural changes only:
1. Replace `processedUsers` dedup with `targetAccountIds.includes(accountId)` filter
2. Add dual-path lookup (map vs DB fallback) for campaign filter and fast_spend
All other logic (metrics snapshot, dedup via actionLogs, safety check, stopAd, notifications) stays identical.

```typescript
export const checkRulesForAccount = internalAction({
  args: {
    accountId: v.id("adAccounts"),
    adCampaignMap: v.optional(v.array(v.object({
      adId: v.string(),
      adGroupId: v.string(),
      adPlanId: v.union(v.string(), v.null()),
      dailyBudget: v.number(),
    }))),
  },
  handler: async (ctx, args) => {
    // 1. Get account → userId (one DB query)
    const account = await ctx.runQuery(
      internal.ruleEngine.getAccountById, { accountId: args.accountId }
    );
    if (!account) return;

    // 2. Load active rules for this user, filter to rules targeting this account
    const allRules = await ctx.runQuery(
      internal.ruleEngine.listActiveRules, { userId: account.userId }
    );
    const rules = allRules.filter(r =>
      r.targetAccountIds.includes(args.accountId as string)
    );
    if (rules.length === 0) return;

    // 3. Rebuild Map from serialized array (if provided)
    const campaignLookup = new Map<string, {
      adGroupId: string;
      adPlanId: string | null;
      dailyBudget: number;
    }>();
    if (args.adCampaignMap) {
      for (const entry of args.adCampaignMap) {
        campaignLookup.set(entry.adId, {
          adGroupId: entry.adGroupId,
          adPlanId: entry.adPlanId,
          dailyBudget: entry.dailyBudget,
        });
      }
    }
    const useMapLookup = campaignLookup.size > 0;

    // 4. Per-account rule logic (extracted from checkAllRules lines 1209-1646)
    // Token: getValidTokenForAccount(accountId) called on-demand for safety check / stopAd
    // Campaign filter + fast_spend use campaignLookup when available,
    // fall back to DB queries when not
  }
});
```

**Dual-path logic inside per-ad loop:**

```typescript
// Campaign filter
if (hasCampaignFilter) {
  if (useMapLookup) {
    // Fast path: O(1) map lookup
    const mapped = campaignLookup.get(adId);
    adGroupId = mapped?.adGroupId ?? null;
    adPlanId = mapped?.adPlanId ?? null;
  } else {
    // Fallback: DB lookup (existing functions)
    const [campId, planId] = await Promise.all([
      ctx.runQuery(internal.ruleEngine.getAdCampaignId, { adId }),
      ctx.runQuery(internal.ruleEngine.getAdPlanId, { adId }),
    ]);
    adGroupId = campId;
    adPlanId = planId;
  }
  if (!matchesCampaignFilter(rule.targetCampaignIds!, adGroupId, adPlanId)) continue;
}

// fast_spend daily budget
if (rule.type === "fast_spend") {
  let dailyBudget: number | null;
  if (useMapLookup) {
    dailyBudget = campaignLookup.get(adId)?.dailyBudget ?? 0;
  } else {
    dailyBudget = await ctx.runQuery(internal.ruleEngine.getCampaignDailyLimit, { adId });
  }
  // ... build context with dailyBudget
}
```

**Type contract:** `adPlanId` is `string | null` (not optional) — explicitly `null` when ad_group has no parent ad_plan. `dailyBudget` is `number` (not optional) — `0` when budget is not set or ad_group not found. No ambiguity between "data missing" and "value is zero".

**userId resolution:** `checkRulesForAccount` receives only `accountId`. It queries the account record to get `userId`, then loads rules for that user filtered by `targetAccountIds.includes(accountId)`. If a user has multiple accounts, each account gets its own `checkRulesForAccount` call — rules are loaded per-call (lightweight DB query, no optimization needed).

**Token handling:** `checkRulesForAccount` does NOT receive or cache tokens. When safety check or `stopAd` is needed, it calls `getValidTokenForAccount(accountId)` on-demand — exactly the same pattern as current `checkAllRules`. No new token reads, writes, refreshes, or storage. `getValidTokenForAccount` is an existing function that may refresh an expired token via OAuth — this is existing, unchanged behavior.

### 5. checkAllRules — thin wrapper

**Location:** `convex/ruleEngine.ts`

`checkAllRules` becomes a backward-compatible wrapper that iterates all accounts and calls `checkRulesForAccount` without map (always DB fallback path):

```typescript
export const checkAllRules = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.syncMetrics.listActiveAccounts);
    if (accounts.length === 0) return;

    // No processedUsers dedup needed — checkRulesForAccount loads rules
    // for the account's owner and filters by targetAccountIds.includes(accountId).
    // Each account processes only its own ads.
    for (const account of accounts) {
      try {
        await ctx.runAction(internal.ruleEngine.checkRulesForAccount, {
          accountId: account._id,
          // No adCampaignMap — uses DB fallback
        });
      } catch (err) {
        console.error(`[checkAllRules] Failed for account ${account._id}:`, err);
      }
    }
  }
});
```

**Note:** `checkAllRules` is no longer called from syncAll. It remains available for manual diagnostics or other callers.

### 6. syncAll — replace global checkAllRules with per-account call

**Location:** `convex/syncMetrics.ts`, inside per-account loop (after save metrics), and remove post-loop `checkAllRules` call

Inside per-account loop, after metrics save:
```typescript
// Run rules for this account with live campaign data
try {
  await ctx.runAction(internal.ruleEngine.checkRulesForAccount, {
    accountId: account._id,
    adCampaignMap: adCampaignMap.length > 0 ? adCampaignMap : undefined,
  });
} catch (err) {
  console.error(`[syncAll] checkRulesForAccount failed for «${account.name}»:`, err);
  try { await ctx.runMutation(internal.systemLogger.log, {
    accountId: account._id,
    level: "error",
    source: "syncMetrics",
    message: `checkRulesForAccount failed: ${String(err).slice(0, 180)}`,
  }); } catch { /* non-critical */ }
}
```

Remove lines 392-410 (old global `checkAllRules` call after loop). This is the **only** call site for `checkAllRules` in the codebase — it is NOT called from `crons.ts` or any other scheduler. After removal, `checkAllRules` wrapper remains callable only manually (diagnostics).

**Timeout:** Increase `ACCOUNT_TIMEOUT_MS` from 90 sec to **120 sec**. Adding `getCampaignsForAccount` (~1 sec) + auto-upsert campaigns/ads (~2-5 sec) + `checkRulesForAccount` (~2-5 sec) to existing metrics work (~5-15 sec) makes 90 sec tight. 120 sec gives comfortable headroom.

### 7. DB functions — fallback path (NOT dead code)

These functions remain and are actively used as fallback when `adCampaignMap` is not provided:
- `getAdCampaignId` — fallback for campaign filter
- `getAdPlanId` — fallback for campaign filter (dual matching)
- `getCampaignDailyLimit` — fallback for fast_spend

They are called from `checkRulesForAccount` when `useMapLookup = false` (API failure or direct `checkAllRules` invocation).

### 8. Unchanged

- `matchesCampaignFilter()` — no changes, same `(targetCampaignIds, adGroupId, adPlanId)` signature
- `evaluateCondition()` — no changes, receives `dailyBudget` in context as before
- `getCampaignsForAccount` in `vkApi.ts` — existing function, no changes
- UZ budget cron (`uzBudgetCron.ts`, `uzBudgetHelpers.ts`, `checkUzBudgetRules`) — completely independent, no changes
- `upsertCampaign` in `adAccounts.ts` — already supports `adPlanId`, no changes
- Schema (`schema.ts`) — `adPlanId` already in campaigns table
- Rule CRUD (`rules.ts`) — unchanged
- Telegram notifications — unchanged
- Token flows — unchanged (see Safety section)

## Safety: Token Protection

**This change does NOT touch any token/credential flows.**

- No reads or writes to: `vkAccessToken`, `vkRefreshToken`, `vkAdsAccessToken`, `vkAdsRefreshToken`, `accessToken`, `refreshToken` on any table
- No changes to: `auth.ts`, `tokenRecovery.ts`, `adAccounts.fetchAndConnect`, `adAccounts.connectAgencyAccount`
- `getCampaignsForAccount` receives `accessToken` as a read-only argument — same pattern as existing `getMtBanners`/`getMtStatistics` already called in syncAll
- No new token refresh, rotation, or storage logic

## Monitoring

### Per-cycle monitoring

| Event | Action |
|---|---|
| `getCampaignsForAccount` fails | Retry once immediately in same cycle |
| Retry fails | Increment failure counter, log to `systemLogger` (error) |
| 3 consecutive failures in batch | Circuit breaker trips: skip API for remaining accounts |
| `getCampaignsForAccount` returns empty | Log warning, `adCampaignMap` empty → DB fallback |
| `checkRulesForAccount` fails | Log + `systemLogger` (per-account isolation — other accounts unaffected) |
| Upsert campaigns/ads fails | Log warning, non-blocking — live map still works for current cycle |

### Circuit breaker

`consecutiveCampaignApiFailures` counter (per batch, reset each 5-min cycle):
- Incremented on retry failure, reset to 0 on any success
- Threshold: 3 consecutive failures → skip `getCampaignsForAccount` for remaining accounts
- Prevents wasting 80+ sec on retries when VK API is down for all accounts

### Graceful degradation on API failure

If `getCampaignsForAccount` fails for an account:
- Metrics still save normally (independent)
- `checkRulesForAccount` called without `adCampaignMap` → **DB fallback path**
- DB fallback now reliable thanks to auto-upsert keeping `campaigns`/`ads` tables fresh every cycle
- Rules WITH campaign filter — use DB lookup (works for all ads synced in previous cycles)
- `fast_spend` rules — use DB lookup for `dailyLimit` (fresh from previous cycle's upsert)
- Rules WITHOUT campaign filter and NOT fast_spend — work fully (no change)
- Next cycle (5 min) retries API normally

### Happy-path logging

To confirm the live API path is actively used (not silently falling back to DB), add `console.log` on the success path:

```typescript
// After building adCampaignMap
if (adCampaignMap.length > 0) {
  console.log(`[syncAll] Live campaign map: ${adCampaignMap.length} ads, ${vkCampaigns.length} campaigns for «${account.name}»`);
}
```

This log appears in Convex dashboard and confirms per-account that the fast path is working. No log = DB fallback was used (already logged as warning).

### Per-account isolation benefit

If one account fails (API error, timeout, or rule engine crash):
- Only that account is affected
- All other accounts continue processing normally
- Before: a single `checkAllRules` failure could skip rules for ALL accounts

## Edge Cases

| Case | Behavior |
|---|---|
| New account, no campaigns yet | `getCampaignsForAccount` returns empty → `adCampaignMap` empty → DB fallback (also empty) → campaign filter returns false, fast_spend gets null budget → correct |
| Banner's campaign_id not in campaigns response | `adPlanId` and `dailyBudget` default to null/0 → campaign filter matches only by adGroupId, fast_spend skips → degraded but safe |
| Large account (200+ ads) | Per-account map ~20 KB, well within Convex 1MB arg limit |
| `syncNow` and `syncAll` run simultaneously | Both call same `upsertCampaign`/`upsertAd` — idempotent, last writer wins with same data → safe |
| `adCampaignMap` arg not provided | Optional, defaults to empty → DB fallback path → same behavior as current code |
| Ad deleted in VK but still in metrics | Not in bannerCampaignMap → not in adCampaignMap → DB fallback may find it → safe |
| `budget_limit_day = "0"` or empty | dailyBudget = 0 → fast_spend returns false (`if (!budget \|\| budget <= 0)`) → same as current behavior |
| UZ cron also calls `getCampaignsForAccount` | Independent, runs on separate cron schedule, no conflict. Both use accessToken read-only. Future optimization: shared cache (out of scope) |
| User has multiple accounts | `checkRulesForAccount` called per-account in syncAll loop. Rules with `targetAccountIds` spanning multiple accounts: each account processed separately with its own map. Rule dedup (same ad same day) still works via `actionLogs` check. |
| `checkAllRules` called directly (diagnostics) | Works via DB fallback — no regression from current behavior |
| VK API down for all accounts | Circuit breaker trips after 3rd account — remaining accounts skip API (~1 sec each instead of ~4 sec with retry). DB fallback with fresh data from previous cycle's auto-upsert. Next cycle resets breaker. |
| API fails for one account then recovers | Counter resets to 0 on next success — no cascading effect |

## Files Changed

| File | Change | Risk |
|---|---|---|
| `convex/syncMetrics.ts` | Add `getCampaignsForAccount` call with retry, auto-upsert campaigns/ads, build map, call `checkRulesForAccount` per-account, remove global `checkAllRules` call | Medium |
| `convex/ruleEngine.ts` | New `checkRulesForAccount` with dual-path (map lookup + DB fallback). Extract per-account logic from `checkAllRules`. | Medium |
| `convex/ruleEngine.ts` | `checkAllRules` → thin wrapper calling `checkRulesForAccount` per account | Low |

## Files NOT Changed

| File | Why |
|---|---|
| `convex/vkApi.ts` | `getCampaignsForAccount` already exists, no changes needed |
| `convex/schema.ts` | `adPlanId` already in campaigns schema |
| `convex/adAccounts.ts` | `upsertCampaign` already supports `adPlanId` |
| `convex/uzBudgetCron.ts` | Independent UZ system, not touched |
| `convex/uzBudgetHelpers.ts` | Independent UZ system, not touched |
| `convex/auth.ts` | No token changes |
| `convex/tokenRecovery.ts` | No token changes |
| `convex/rules.ts` | Rule CRUD unchanged |
| `convex/telegram.ts` | Notification logic unchanged |

## Rollback Plan

If issues are detected after deploy:

1. **Immediate rollback:** `git revert <commit>` + deploy. `checkAllRules` wrapper ensures backward compatibility — rules revert to DB-only path (same as before this change).
2. **No data migration needed** — auto-upsert only adds/updates data that was missing before. Reverting doesn't corrupt anything; `campaigns`/`ads` tables remain populated from last successful cycle.

## Testing

1. **Campaign filter**: rule targeting campaign by ad_plan_id fires for new ads without manual sync
2. **fast_spend**: rule fires correctly using dailyBudget from API map (not DB)
3. **DB fallback**: simulate `getCampaignsForAccount` failure → rules still work via DB lookup (tables fresh from previous cycle's auto-upsert)
4. **Auto-upsert**: after syncAll cycle, `campaigns` and `ads` tables contain all current VK data without manual sync
5. **Per-account isolation**: one account error doesn't affect other accounts' rule checking
6. **Regression**: rules with `targetAdIds` only — still work (no campaign filter involved)
7. **Regression**: rules without campaign filter (spend_no_leads, cpl_limit etc.) — still work
8. **Failure handling**: `getCampaignsForAccount` failure → metrics save, DB fallback used, next cycle recovers
9. **adPlanId update**: campaigns table gets `adPlanId` populated automatically
10. **UZ rules**: verify UZ cron continues working independently (no regression)
11. **Token safety**: verify no token fields are read/written by any changed code
12. **checkAllRules wrapper**: direct call works via DB fallback (backward compatibility)
13. **Unit test**: `matchesCampaignFilter` with adPlanId (existing tests already cover)
14. **Scale test**: account with 200+ ads — map size within arg limits
15. **Circuit breaker**: simulate 3 consecutive API failures → remaining accounts skip API
16. **Circuit breaker reset**: success after failure resets counter → no false trips
