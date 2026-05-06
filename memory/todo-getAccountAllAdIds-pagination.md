# TODO: fix `getAccountAllAdIds` historical metrics timeout

Date opened: 2026-05-06
Date resolved: 2026-05-06
Scope: production bug / rule-engine scalability, not incident recovery.

## STATUS: production timeout trigger RESOLVED by B1; broader Tier 2 scope remains DEFERRED

What is resolved by B1 (Tier 1 / Option A, commit `9768449`, deployed `2026-05-06T19:53:27Z`):

- The specific production timeout in `getAccountAllAdIds` for heavy accounts (`Вардек мск спб` 1327 ads, `Интерьер` 1136 ads).
- The downstream `checkRulesForAccount failed: request timed out` symptom for the two known affected accounts.
- The `cpl_limit since_launch` silent rule failure on those accounts at the function level. (Full organic `syncBatchWorkerV2 → checkRulesForAccount` E2E confirmation was not observed within the post-deploy window — see `memory/b1-closure-2026-05-06.md` for why this is environment, not B1.)

Closure details and follow-up triggers: `memory/b1-closure-2026-05-06.md`.

What is NOT resolved by B1 — Tier 2 broader scope remains DEFERRED (intentionally, per `docs/2026-05-06-getAccountAllAdIds-fix-design.md`):

- Denormalized account-to-adIds lookup table (`accountAdIndex`).
- Generic pagination of rule evaluation across `ruleEngine.ts`.
- Hard time bounds on `since_launch` semantics.
- Audit of all `.collect()` paths in `ruleEngine.ts`.

These are NOT auto-promoted by B1 closure. Re-evaluate only if Tier 1 proves insufficient (new heavy accounts emerge, new `.collect()` timeouts appear elsewhere). At least one week of post-Tier-1 observation per design doc before Tier 2 decision.

Historical RCA for the original bug surface is preserved below — kept for context, not as outstanding work on the specific timeout trigger.

---

## Summary

`ruleEngine.getAccountAllAdIds` collects all historical `metricsDaily` rows for an account:

```ts
ctx.db
  .query("metricsDaily")
  .withIndex("by_accountId_date", (q) => q.eq("accountId", args.accountId))
  .collect()
```

This is unsafe for large accounts. The observed stack for `checkRulesForAccount` timeout points to `ruleEngine.ts:1759`, where `checkRulesForAccount` calls `getAccountAllAdIds` for rules that need all historical ads, including `cpl_limit` with `timeWindow="since_launch"`.

## Evidence

Observed production timeout:

- Time: `2026-05-06T12:20:12.163Z`
- Source: `systemLogs`, `source=syncMetrics`
- Message: `checkRulesForAccount failed: Error: Uncaught Error: Your request timed out`
- Account: `j978z1sbh3ra5ym2hh3wqmb88184cs47` (`Вардек мск спб`)

Account state:

- `status=active`
- `lastError=null`
- `lastSyncError=null`
- token fresh until `2026-05-07T13:12:04Z`

Historical evidence:

- Same account had `checkRulesForAccount` timeout records before UZ live restore:
  - `2026-05-03`
  - `2026-05-04`
- Another account with similar timeout history: `j974v8cpc3zg8tk07maqs39ejh842fz2`.
- A direct read-only call to `ruleEngine:getAccountAllAdIds` for `j978z1sbh3ra5ym2hh3wqmb88184cs47` timed out during investigation.

Affected-account snapshot from read-only `systemLogs` query, captured `2026-05-06`:

| accountId | name | status | timeout_count | first_seen | last_seen | tokenExpiresAt |
| --- | --- | --- | ---: | --- | --- | --- |
| `j978z1sbh3ra5ym2hh3wqmb88184cs47` | `Вардек мск спб` | `active` | 4 | `2026-05-03T04:22:01.391Z` | `2026-05-06T12:20:12.163Z` | `2026-05-07T13:12:04.049Z` |
| `j974v8cpc3zg8tk07maqs39ejh842fz2` | `Интерьер` | `active` | 4 | `2026-05-02T18:51:12.436Z` | `2026-05-04T22:49:22.516Z` | `2026-05-07T11:09:58.102Z` |

Query scope:

- `systemLogger:getRecentByLevel({ level: "error", since: now - 10d, limit: 10000 })`
- scanned `2100` error logs;
- matched `2` accounts with `source="syncMetrics"` and `message` containing both `checkRulesForAccount failed` and `request timed out`;
- both affected accounts are active with `lastError=null` and `lastSyncError=null`.

Active rules on the account at time of investigation:

- `uz_budget_manage`: `Вардек НУЗ 300 р + 50 р`
- `cpl_limit`: `ВАРДЕК подп сенл спб до 600 р обн 5 05`, `timeWindow="since_launch"`
- `cpl_limit`: `ВАРДЕК подп сенл мск до 1200 р обн 3 05`, `timeWindow="since_launch"`
- `cpc_limit`: `Вардек на сенлер цена клика до 60 р обн 30 04`

## Impact

- Affected accounts may sync metrics successfully but fail rule evaluation.
- Rules on those accounts may not stop or notify ads when conditions are met.
- This affects user-visible automation correctness, especially `cpl_limit` / `since_launch` rules on heavy accounts.
- This is pre-existing and not caused by UZ restore.

## Fix direction

Choose one bounded design:

- Replace unbounded `.collect()` with a windowed/ranged query using `by_accountId_date` and a capped date range.
- For `since_launch`, avoid loading all historical rows at runtime by maintaining a denormalized account-to-adIds or campaign-to-adIds table.
- Split rule evaluation into paginated batches and store continuation state.
- Add a guard: if historical ad set is too large, skip with a structured warning and surface a product/admin diagnostic rather than timing out invisibly.

## Investigation follow-up

Completed:

- Build a read-only affected-account list from historical `systemLogs`.
- Join with `adAccounts` for name/status/token freshness.

Remaining:

- Join/inspect active rules for the second affected account (`j974v8cpc3zg8tk07maqs39ejh842fz2`) and confirm whether it also has `timeWindow="since_launch"` or another all-history path.
- Build the fix and a narrow regression test for heavy accounts.

Do not treat this as a recovery rollback trigger unless it correlates with V8 slot pressure, failed scheduled jobs, or growing sync failure counters.
