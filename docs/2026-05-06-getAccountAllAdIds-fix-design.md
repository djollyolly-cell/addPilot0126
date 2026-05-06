# Fix design: `getAccountAllAdIds` historical metrics timeout

Date: 2026-05-06
Branch context: `emergency/drain-scheduled-jobs` (concurrency bump in flight; this fix is a separate non-emergency track)
Related: `memory/todo-getAccountAllAdIds-pagination.md`
Status: **design proposal only — no code, no deploy as part of this document**

## Scope of this proposal

This document is **strictly a design proposal**. It does not authorize any code change, schema change, or deploy. Its purpose is to:

1. Fix the framing while context is fresh from RCA, before the emergency aftermath team forgets why this matters.
2. Explicitly separate a **quick bounded fix** (this function only, no schema change, no rule-engine refactor) from broader architectural questions (denormalization, generic pagination of rule evaluation, redesigning `since_launch` semantics).
3. Reduce the risk that emergency aftermath turns into a large refactor: by writing down the bounded fix now, future implementers have a clear "stop the bleeding" path that does not expand scope.

Implementation, code, tests, and deploy of either tier are **out of scope here** and require a separate dedicated session with its own go.

## Problem statement

`ruleEngine.getAccountAllAdIds` (`convex/ruleEngine.ts:647`) is the source of recurring `checkRulesForAccount failed: request timed out` errors on heavy accounts. It currently does:

```ts
export const getAccountAllAdIds = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) => q.eq("accountId", args.accountId))
      .collect();
    const adIds = new Set<string>();
    for (const r of records) {
      adIds.add(r.adId);
    }
    return [...adIds];
  },
});
```

It is called from `checkRulesForAccount` (line 1758) when `needsAllAds` is true, i.e. for these rule types with non-`daily` time windows: `cpl_limit`, `clicks_no_leads`, `low_impressions`. The most common trigger is `cpl_limit` with `timeWindow="since_launch"`.

### Observed impact (production, read-only confirmed 2026-05-06)

| Account | Status | Token | Recent timeouts |
|---|---|---|---|
| `j978z1sbh3ra5ym2hh3wqmb88184cs47` (Вардек мск спб) | active | fresh until `2026-05-07T13:12:04Z` | 4 in last 10 days, last `2026-05-06T12:20:12Z` (live mode) |
| `j974v8cpc3zg8tk07maqs39ejh842fz2` (Интерьер) | active | fresh until `2026-05-07T11:09:58Z` | 4 in last 10 days, last `2026-05-04T22:49:22Z` |

Two active accounts known affected within 10-day `systemLogs` retention. The bug pre-dates the 2026-05-04/05 incident; it is a long-standing production issue exposed by RCA during recovery.

### Why this is a real bug

Rule evaluation for the affected accounts silently fails. `cpl_limit since_launch` rules on these accounts are not enforced. Ads that should be stopped continue to run. Users do not see automation acting and do not see any explicit error in their UI.

This is a correctness bug, not a performance nuisance.

## Root cause

`getAccountAllAdIds` queries the wrong table for the wrong purpose.

- The function only needs the **set of unique ad IDs** for the account.
- It loads the entire `metricsDaily` history for the account to derive that set.
- `metricsDaily` is high-growth: one row per `adId × date`. An account with 1000 ads and 365 days of history yields ~365K rows.
- The Convex action time limit is hit before `.collect()` returns.

The `ads` table already stores `accountId` per ad and has the index `by_accountId_vkAdId`. It is bounded by the number of ads in the account, not by history length.

## Two tiers — keep them separate

This problem can be addressed at two very different scopes. Conflating them is exactly how emergency aftermath turns into a large refactor. They are explicitly separated below.

### Tier 1 — Quick bounded fix

- Scope: change body of one function (`getAccountAllAdIds`).
- No schema change. No new table. No companion-sync. No call-site changes.
- Goal: stop timeouts on heavy accounts, restore rule evaluation correctness for the affected accounts.
- This is what should happen first, in a dedicated short session, after Phase 8 closure.
- Tier-1 candidate is **Option A** below.

### Tier 2 — Broader architectural work (deferred)

- Scope: rule-engine architecture, possibly schema, possibly sync.
- Examples: denormalized account-to-adIds lookup, generic pagination of rule evaluation, redefining `since_launch` semantics with a hard time bound, audits of all `.collect()` paths in `ruleEngine.ts`.
- Goal: prevent this entire class of issue at the architecture level.
- This is **not** part of emergency aftermath. Decide separately, only after Tier 1 is observed in production for at least a week and the bounded fix is confirmed to actually solve the user-visible symptom.
- Tier-2 candidate is **Option C** below, plus other broader work that is intentionally not designed here.

The intentional rule: if a future change adds a new table, a new index, or a new env flag, it has crossed the line into Tier 2 and should be revisited as its own design.

## Design options

### Option A — Query `ads` table directly (Tier 1, recommended)

Replace the body of `getAccountAllAdIds`:

```ts
export const getAccountAllAdIds = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ads")
      .withIndex("by_accountId_vkAdId", (q) => q.eq("accountId", args.accountId))
      .collect();
    return ads.map((a) => a.vkAdId);
  },
});
```

**Pros**

- Single function change, no schema migration, no companion sync to maintain.
- `ads` table is bounded by current ad count for the account, not by metricsDaily growth.
- Same return type (`string[]` of vkAdIds), no caller change.
- Semantically more correct: rule engine can only act on ads that currently exist; `ads` table is the source of truth for that.
- Index `by_accountId_vkAdId` already exists in `convex/schema.ts:178`.

**Cons / risks**

- An adId that exists in historical `metricsDaily` but is no longer in `ads` table will not be returned. This is in fact the desired behavior:
  - Rule actions (`stopAd`, `notify`) call VK API for that adId. If the ad no longer exists in our `ads` table, downstream `getAdCampaignId` returns null and the rule path bails out anyway. Including such adIds wastes compute and produces no user-visible change.
  - Aggregated metrics for "since launch" are still computed correctly for ads that exist now (their full history in `metricsDaily` is queried per-adId via `getAdAggregatedMetrics`).

**Diff size**: ~5 lines.

**Deployment risk**: low. Reversible by reverting the function. No data migration. No schema change.

### Option B — Windowed query on `metricsDaily` with date bound (Tier 1 alternative, not recommended)

Pass `sinceDate` from caller, compute based on rule's `timeWindow`:

```ts
export const getAccountAllAdIds = internalQuery({
  args: { accountId: v.id("adAccounts"), sinceDate: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const q = ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (qb) => {
        const eq = qb.eq("accountId", args.accountId);
        return args.sinceDate ? eq.gte("date", args.sinceDate) : eq;
      });
    const records = await q.collect();
    const adIds = new Set<string>();
    for (const r of records) adIds.add(r.adId);
    return [...adIds];
  },
});
```

**Pros**

- Stays close to the original implementation.
- Useful for `timeWindow="24h"` and similar bounded windows.

**Cons**

- For `timeWindow="since_launch"` the natural `sinceDate` is undefined or a hard-coded fallback like 90 days. The fallback risks missing aggregation for ads with longer history; no fallback means the bug remains.
- Caller change required (one new arg in two call sites).
- Two affected accounts already have rule history that exceeds any reasonable fallback window; this option does not actually fix their case.

**Diff size**: ~15 lines (plus call-site changes).

**Verdict**: addresses the symptom partially, leaves the `since_launch` correctness gap. Not recommended.

### Option C — Denormalized account-to-adIds lookup table (Tier 2, deferred)

Maintain a new table `accountAdIndex { accountId, adId }` populated by sync.

**Pros**

- Pre-computed lookup, fastest at read time.

**Cons**

- New schema table.
- Companion-sync risk: per `CLAUDE.md` and `memory/feedback_diagnostic_discipline.md`, every mutation that creates/deletes an ad must also update this index. Easy to forget; gold-plated solution for a problem the existing `ads` table already solves.
- Migration: backfill from current `ads` table at deploy.

**Verdict**: overkill given Option A produces the same effective result for free.

## Recommended path

Adopt **Option A** as the Tier-1 quick bounded fix. It is the minimal correct change. Tier-2 work is **not** initiated by adopting Option A.

Explicit non-decisions made by this document:

- Whether to denormalize `accountAdIndex` — left open, will only be revisited if Tier 1 turns out insufficient.
- Whether to add hard time bounds to `since_launch` — left open.
- Whether to audit all `.collect()` paths in `ruleEngine.ts` — left open as a separate audit, not part of this fix.
- Whether to rename `getAccountAllAdIds` — left open, advisory note in the implementation hints.

### Pre-Tier-1 prerequisite gate

Before editing code, verify that `ads` is a complete enough source for the two known affected accounts:

1. Read `ads.by_accountId_vkAdId` for both affected account IDs.
2. Confirm the query returns quickly and returns a non-empty set.
3. Compare the returned count against the latest sync/account context, not against all historical `metricsDaily` rows. A smaller count than historical metrics is expected because deleted/archived ads should not be rule-action targets.
4. If `ads` is unexpectedly empty for an active affected account, stop and investigate sync/ad upsert health before implementing Option A.

This guardrail protects the bounded fix from silently switching to an incomplete source. If it passes, `ads` remains the better source because `checkRulesForAccount` can only act on currently-known ads.

Read-only gate result captured `2026-05-06`:

| Account | `ads.by_accountId_vkAdId` count | Metrics proxy | Result |
|---|---:|---:|---|
| `j978z1sbh3ra5ym2hh3wqmb88184cs47` (`Вардек мск спб`) | `1327` | last-7d `metricsDaily`: `1244` rows, `356` unique adIds | PASS: `ads` non-empty and larger than recent metrics proxy |
| `j974v8cpc3zg8tk07maqs39ejh842fz2` (`Интерьер`) | `1136` | last-30d `metricsDaily`: `23349` rows, `1136` unique adIds | PASS: exact unique-ad coverage match |

Conclusion: Option A is not blocked by `ads` coverage for the two known affected accounts. If future affected accounts fail this gate, do not apply Option A blindly for them; investigate sync/ad upsert health or revisit Tier 2.

Known limitation: the gate does not prove there are zero pure-historical adIds in old `metricsDaily` that are no longer present in `ads`, especially for `Вардек мск спб`, where a full historical `metricsDaily` scan is the timeout source. This is intentional and acceptable for Tier 1: such adIds are not actionable rule targets. Downstream action paths need current ad/campaign records; historical-only adIds would either bail out or waste compute. Option A may remove this noise, but it should not remove correct user-visible automation.

### Implementation hints (for whoever takes Tier 1 in a separate session)

This is **not an authorization to implement**. It is reference material so a future short session does not have to redo the analysis.

1. Read current `getAccountAllAdIds` and `checkRulesForAccount` call site (already done in this design).
2. Edit `convex/ruleEngine.ts:647-660` to query `ads` table.
3. Run `npx tsc --noEmit -p convex/tsconfig.json` (mandatory per `CLAUDE.md` pre-commit verification).
4. Add a unit/integration test that verifies the function returns the same set of `vkAdId`s the previous implementation returned for an account that has matching `ads` and `metricsDaily` populated. Test should not depend on real production state.
5. Diagnostic verification before commit (per `CLAUDE.md` API-write rule, adapted for read-only):
   - Read-only call to the new `getAccountAllAdIds` for `j978z1sbh3ra5ym2hh3wqmb88184cs47` from a one-off script.
   - Expected: returns within a few hundred ms (vs current timeout).
   - Expected: returned set matches `ads.by_accountId_vkAdId` collection for that account.
6. Deploy as a regular non-emergency deploy.
7. Verify on next sync tick: `systemLogs` no longer contains `checkRulesForAccount failed: request timed out` for the two affected accounts.

### Rollout safety

- No env flag needed: function signature unchanged, callers unchanged.
- Rollback: revert the file change, redeploy.
- No data is written.
- No external API call.

### Verification after fix

After deploy, run the same scope query as in `memory/todo-getAccountAllAdIds-pagination.md` over a few sync ticks:

```text
Expected: 0 new checkRulesForAccount timeout entries for both accounts.
Expected: cpl_limit since_launch rule action logs (stopped / notified)
          start appearing for the two accounts if their ads in fact violate the rule.
```

The second expected outcome is meaningful: it confirms the rules were silently broken before. If after the fix the rules trigger and stop ads on these accounts, the user will see automation finally working.

## Out of scope for this design (and intentionally not opened by Tier 1)

- Changes to `getAdAggregatedMetrics`. That function loads metricsDaily for one adId, bounded by per-ad history. Not currently observed to time out. Watch separately if heavy ads emerge.
- Adding rate-limiting / pagination across rule evaluation in general. Not needed if Option A removes the only reproducible timeout source.
- Pagination of `getAccountTodayMetrics` (line 558). It already filters by `(accountId, date)` so the result set is bounded by ads-touched-today. Currently fine.
- Schema changes.

## Open questions for implementer

- Should the function be renamed (e.g. `getAccountAdIds`) to reflect that it returns currently-known ads, not all-historical? Decision: keep current name to avoid caller churn; clarify in JSDoc.
- Should we also add a sanity-warning log if an adId appears in `metricsDaily` but is missing from `ads`? Decision: out of scope for the fix; this is a sync-correctness question, not a rule-engine question.

## Estimated effort (Tier 1 only)

- Code: 30 minutes including unit test.
- Diagnostic verification: 15 minutes.
- Deploy + post-deploy check: 30 minutes.
- Total: about 1.5 hours, in a non-emergency session.

Tier-2 effort is intentionally not estimated here. If Tier 1 closes the symptom and acceptance verification is clean, Tier 2 may not be needed at all.

## Decision request

This document asks the operator only for two decisions, both later, not now:

1. After Phase 8 closure, schedule a separate dedicated session to implement Tier 1 (Option A).
2. Defer Tier 2 until at least one week of post-Tier-1 observation. Re-evaluate based on whether new heavy accounts emerge or new `.collect()` timeouts appear elsewhere.

Anything beyond those two decisions is out of scope for this proposal.
