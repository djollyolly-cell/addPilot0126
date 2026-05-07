# Phase 6 sync canary status

Date: 2026-05-07
Branch: `emergency/drain-scheduled-jobs`
Latest recorded runbook commit before this memory update: `e777248`

## Sync throughput worker bump closed clean (`SYNC_WORKER_COUNT_V2 1 → 2`)

- Runbook: `docs/2026-05-07-sync-throughput-worker-1-to-2-runbook.md`.
- Runbook committed/pushed first: `e777248 docs(sync): add worker throughput bump runbook`.
- Env bump executed `2026-05-07T03:10Z` after explicit go: `SYNC_WORKER_COUNT_V2 1 → 2`.
- Pre-bump baseline `2026-05-07T03:09:26Z`: `/version` HTTP 200, `pg_wal=1,577,058,304` bytes, stale `212/212`, `syncBatchWorkerV2|success|28`, failed counters flat.
- Hard env gate passed: `SYNC_WORKER_COUNT_V2=1`, `SYNC_BATCH_SIZE_V2=20`, `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`, `SYNC_METRICS_V2_ENABLED=1`, `SYNC_METRICS_V2_POLL_MODERATION=0`, `SYNC_ESCALATION_ALERTS_ENABLED=0`, `UZ_BUDGET_V2_ENABLED=1`, `DISABLE_ERROR_ALERT_FANOUT=1`.
- First organic worker-count-2 tick `2026-05-07T03:19:10Z`: `syncDispatch` completed/error null, `syncBatchWorkerV2 28→30`, failed `0`, backend rollback grep `0`, per-account sync failures `0`, `adminAlerts.notify=0`, `/version` HTTP 200, `pg_wal` flat at `1,577,058,304`, direct account-update audit found `19` accounts updated with empty `lastError` / `lastSyncError`.
- Second organic worker-count-2 tick `2026-05-07T04:04:10Z`: `syncDispatch` completed/error null, `syncBatchWorkerV2 30→32`, failed `0`, backend rollback grep `0`, per-account sync failures `0`, `adminAlerts.notify=0`, `/version` HTTP 200, `pg_wal` flat at `1,577,058,304`, direct account-update audit found `19` accounts updated with empty `lastError` / `lastSyncError`.
- Surrounding crons clean: token refresh `2026-05-07T03:09:36Z` completed/error null; UZ `2026-05-07T03:57:10Z` completed/error null, `uzBudgetBatchWorkerV2|success|50`, rollback grep `0`.
- Coverage evidence: `38/212` accounts updated across the two worker-count-2 sync ticks, meeting the `>=30` accepted lower bound.
- Final state: `SYNC_WORKER_COUNT_V2=2`, `SYNC_BATCH_SIZE_V2=20`, `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`; all other gates unchanged. No rollback executed.

## Sync throughput batch bump closed clean (`SYNC_BATCH_SIZE_V2 10 → 20`)

- Runbook: `docs/2026-05-07-sync-throughput-batch-10-to-20-runbook.md`.
- Runbook committed/pushed first: `7cf326e docs(sync): add batch throughput bump runbook`.
- Env bump executed `2026-05-06T21:22Z` after explicit go: `SYNC_BATCH_SIZE_V2 10 → 20`.
- Hard precondition passed: `SYNC_WORKER_COUNT_V2=1` explicitly present in Convex deployment env, avoiding the code default `2`.
- Pre-bump baseline `2026-05-06T21:19:55Z`: `/version` HTTP 200, `pg_wal=1,593,835,520` bytes, stale `203/212`, `syncBatchWorkerV2|success|21`, failed counters flat.
- First organic batch-20 tick `2026-05-06T22:04:10Z`: `syncDispatch` completed/error null, `syncBatchWorkerV2 21→22`, failed `0`, backend rollback grep `0`, `adminAlerts.notify=0`, `pg_wal` decreased to `1,409,286,144`, direct account-update audit found `19` accounts updated with empty `lastError` / `lastSyncError`.
- Extended observation through `2026-05-07T02:55Z`: `syncBatchWorkerV2 21→28`, failed `0`; backend rollback grep `0`; `adminAlerts.notify=0`; failed counters flat; `/version` HTTP 200; `pg_wal=1,577,058,304` bytes (`-16 MiB` vs baseline); latest tick `02:34Z` updated `19` accounts; total post-bump coverage `134/212` accounts.
- Surrounding crons clean: token refresh `2026-05-07T01:09:36Z` completed/error null; UZ `2026-05-07T02:27:10Z` completed/error null.
- Final state: `SYNC_BATCH_SIZE_V2=20`, `SYNC_WORKER_COUNT_V2=1`, `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`; all other gates unchanged. No rollback executed.

## Phase 8 closed clean (concurrency bump 8 → 16)

- Bump executed `2026-05-06T15:35:06Z`: `APPLICATION_MAX_CONCURRENT_V8_ACTIONS 8 → 16`.
- Strict closure: `2026-05-06T17:47Z = 20:47 MSK`. Final state: `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`.
- V8 isolate confirmed `computed_concurrency=16`, `immediate_slots_for_3=2`.
- KEY canary token refresh `17:09Z`: dispatcher `completed`/`error=null`, `auth.js:tokenRefreshOneV2 success +25`, backend rollback grep `0`, `adminAlerts.notify=0`, `systemLogs` errors `0`, `/version` HTTP 200.
- Post-token UZ tick `17:27Z`: dispatcher `completed`/`error=null`, `uzBudgetBatchWorkerV2 16→22`, failed `0`, rollback grep `0`, `adminAlerts.notify=0`.
- Post-token sync tick `17:34Z`: dispatcher `completed`/`error=null`, `syncBatchWorkerV2 13→16`, failed `0`, rollback grep `0`, `adminAlerts.notify=0`.
- Failed counters flat at strict closure: `adminAlerts=38`, V1 sync=37, V1 UZ=36, `tokenRefreshOneV2=14`, `manualMassCleanup=1`. V2 failed counters `0`.
- `pg_wal` byte-exact: `1,627,389,952 → 1,593,835,520 bytes` (delta `-33 MiB`, normal checkpoint behavior, well under `+50 MB` hard stop).
- Runbook with full execution log + closure block: `docs/2026-05-06-concurrency-bump-8-to-16-runbook.md`.
- Rollback command if needed in future: `npx convex env set APPLICATION_MAX_CONCURRENT_V8_ACTIONS 8`.

## Standby work captured (during Phase 8 watch)

While the bump was watched by a separate agent, the following design/audit work was completed (no prod touch):

- `docs/2026-05-06-getAccountAllAdIds-fix-design.md` — Tier 1 (Option A) and Tier 2 (deferred) explicitly separated; pre-Tier-1 safety gate PASSED for `Вардек мск спб` (ads=1327) and `Интерьер` (ads=1136).
- `docs/2026-05-06-post-phase-8-checklist.md` — full sequencing of post-recovery work, organized by trigger (A: housekeeping, B: separate sessions, C: after weeks of stability, D: last-wave redesigns, E: cleanup + merge).
- `docs/2026-05-06-merge-cleanup-scope.md` — branch-vs-main audit. **Critical finding: direct merge breaks production (25 production crons disabled in branch, 4 producer guards `if (false && ...)` in `vkApi.ts`).** Strategy C (reverse-transform branch first, then merge) recommended. 9-item pre-merge readiness checklist in the doc.

## Next agreed design-only work (unblocked, can run today)

D1 design (`adminAlerts.notify` redesign) was identified as the highest-value next item.

**Substance / problem statement**: see Trigger D1 in `docs/2026-05-06-post-phase-8-checklist.md`. Briefly:

- Current state: handler `adminAlerts.notify` is drain no-op; `DISABLE_ERROR_ALERT_FANOUT=1` blocks `systemLogger.log({level: "error"})` from auto-scheduling notify.
- Original problem: `systemLogger.log error` → `ctx.scheduler.runAfter(0, internal.adminAlerts.notify)` per error log was the amplification loop component of the 2026-05-04/05 incident. Confirmed by tick `09:09Z` cross-correlation: `adminAlerts.notify` schedules in the same milliseconds (±50ms) as `Too many concurrent` errors.
- Required redesign: batched/dedup alert queue, processed by a single low-frequency cron, instead of `runAfter(0)` per error. Possibly bounded retry, dedup window, severity gating.
- Coupled actions when redesign lands: lift `DISABLE_ERROR_ALERT_FANOUT`, enable `SYNC_ESCALATION_ALERTS_ENABLED`, audit remaining 7 explicit `notify` call-sites in `syncMetrics` / `ruleEngine` / `adAccounts` / `billing`.

**Why D1 over D2 first**:

- Hard prerequisite for merge (per `docs/2026-05-06-merge-cleanup-scope.md` constraint #4 and pre-merge readiness checklist).
- Operator-visibility impact: D1 unblocks real Telegram/admin alerts. D2 (`recordRateLimit`) is observability-only.
- Context is freshest on the amplification loop signature right now.

**Why design-only is OK during Phase 8 watch**:

- No code, no deploy. Pure investigation + write design doc.
- Does not compete with bump canary watch (separate agent).
- Output: design doc only; implementation requires its own future session with its own go.

**Effort estimate**: ~1.5h to a written design proposal (similar shape to `docs/2026-05-06-getAccountAllAdIds-fix-design.md` — Scope/Problem/Tiers/Options/Recommendation/Out-of-scope).

**Status**: not started; ready to begin (Phase 8 closed clean `2026-05-06T17:47Z`).

**Where to start when resumed**:

1. Read `docs/2026-05-05-convex-scheduled-jobs-incident-report.md` — Phase 2 V2 verification chronology table (tick `09:09 UTC`) for the documented amplification loop signature.
2. Read `convex/systemLogger.ts` — current `DISABLE_ERROR_ALERT_FANOUT` guard implementation.
3. Grep `adminAlerts.notify` call-sites: `grep -rn "adminAlerts.notify\|adminAlerts\.js:notify" convex/` for the 7 explicit non-systemLogger callers.
4. Survey severity, dedup, batching libraries patterns already in the project (e.g., `adminAlertDedup` referenced in `9f62cfa` for sync escalation).
5. Draft design doc in workspace `docs/` following the same Tier-1-vs-Tier-2 framing pattern.

## Current state

- Phase 2 token refresh is closed after two clean ticks (`13:09 UTC`, `15:09 UTC`).
- Phase 5a UZ manual canary is clean.
- Phase 5b UZ cron canary is clean after two organic ticks (`18:57 UTC`, `19:42 UTC`) at `45 min`. UZ was later reopened for unattended production mode after business go; first production organic tick (`2026-05-06T12:12:10Z`) closed clean and `UZ_BUDGET_V2_ENABLED=1`.
- Phase 6 sync prepare commits are pushed to `origin/emergency/drain-scheduled-jobs`; sync V2, escalation guard, and V2 cron registration are deployed live:
  - `e478dcb` - sync V2 entrypoints + moderation gate.
  - `ed5d5bf` - runtime env reads + explicit V1 cron warning.
  - `a510695` - per-account failure monitoring + removed V1 ready-to-uncomment cron block.
  - `3f92025` - docs guardrails.
  - `9f62cfa` - sync escalation alert guard.
  - `b0258fc` - V2 `sync-metrics` cron registration at `45 min`.
- Phase 6a manual canary ran at `2026-05-06T03:36Z`: sync mechanics clean, but `adminAlerts.js:notify=5`; classified yellow-clean.
- Phase 6a-bis ran at `2026-05-06T04:31Z` after `9f62cfa`: clean by hard criteria (`1` V2 worker success, `0` adminAlerts schedules, `0` V8/transient, `0` per-account failures, flat WAL, heartbeat completed).
- Phase 6b cron code was deployed at `2026-05-06T04:50Z` with `SYNC_METRICS_V2_ENABLED=0`; fail-closed smoke returned `{ skipped: true, reason: "v2_disabled" }`, `syncDispatch` heartbeat was unchanged, and no new V2/admin alert schedules were created.
- Phase 6b pre-open baseline was re-captured at `2026-05-06T05:25:01Z` to `/tmp/sync-canary-baseline.json`: `/version` HTTP 200, `pg_wal=1.5G`, `lastSyncAt stale=212/212`, V2 scheduled jobs only historical `syncBatchWorkerV2|success|2`, failed counters unchanged (`adminAlerts.notify=38`, V1 sync=37, V1 UZ=36, tokenRefreshOneV2=14, manualMassCleanup=1).
- Phase 6b first organic tick:
  - Gate opened: `2026-05-06T05:29:09Z` (`SYNC_METRICS_V2_ENABLED=1`).
  - Tick heartbeat: `syncDispatch` started `2026-05-06T05:34:10.291Z`, finished `2026-05-06T05:34:10.379Z`, status `completed`, `error=null`.
  - `syncMetrics.js:syncBatchWorkerV2`: `success|1` in the window, `0` failed.
  - Backend stdout: `0` `Too many concurrent`, `0` `Transient error`, `0` `syncBatchV2.*Account .* failed`.
  - `adminAlerts.js:notify`: `0` schedules in window.
  - `lastSyncAt stale`: `212/212 -> 203/212` (9 accounts updated).
  - WAL exact sample: `1,627,389,952 -> 1,644,167,168` bytes (`+16 MiB`, below `50 MB` hard stop).
  - Extended stdout scan for `2026-05-06T05:34:00Z..05:36:00Z` found no `syncBatchWorkerV2|syncBatchV2|syncDispatchV2|dispatchSyncBatchesV2|syncMetrics|warn|error|fail|skip|TOKEN|expired` lines; the 9/10 update count is not explained by visible worker errors.
  - Follow-up at `2026-05-06T05:51Z`: `lastSyncAt stale=202/212`. Querying accounts updated since gate-open showed `10` accounts updated by the first tick; the 10th updated at `2026-05-06T05:40:24.582Z`, after the initial post-check. This explains the earlier `9/10` without invoking a hidden failure or V1 ghost path.
  - Mid-window logs after gate-open had `0` rollback-pattern errors; only unrelated WebSocket client disconnect warnings appeared.
- Phase 6b second organic tick closed clean:
  - Tick heartbeat: `syncDispatch` started `2026-05-06T06:19:10.281Z`, finished `2026-05-06T06:19:10.373Z`, status `completed`, `error=null`.
  - `syncMetrics.js:syncBatchWorkerV2`: `success|1` in the `06:18Z..06:32Z` window, `0` failed.
  - Backend stdout: `0` `Too many concurrent`, `0` `Transient error`, `0` `syncBatchV2.*Account .* failed`.
  - `adminAlerts.js:notify`: `0` schedules in window.
  - Accounts updated since `06:18Z`: `9`.
  - WAL exact post-tick: `1,711,276,032` bytes, `102` WAL files. It was unchanged from the `05:51Z` mid-window sample, so no WAL runaway.
  - Failed counters unchanged (`adminAlerts.notify=38`, V1 sync=37, V1 UZ=36, tokenRefreshOneV2=14, manualMassCleanup=1).
- Phase 6b is closed clean after two organic ticks (`05:34Z`, `06:19Z`). After closing the phase, `SYNC_METRICS_V2_ENABLED` was set back to `0` at `2026-05-06T06:37:51Z` to avoid an implicit overlap test with the `07:09Z` token refresh window. The `07:09Z` token refresh tick then passed clean (`89` V2 jobs success, no V8/transient/systemLog errors).
- Sync V2 live mode was reopened at `2026-05-06T08:50Z` with only `SYNC_METRICS_V2_ENABLED 0 -> 1`; all other guardrails stayed closed/conservative.
- First live organic sync tick after reopen closed clean:
  - Tick heartbeat: `syncDispatch` started `2026-05-06T09:19:10.274Z`, finished `2026-05-06T09:19:10.365Z`, status `completed`, `error=null`.
  - `syncMetrics.js:syncBatchWorkerV2`: total success `4 -> 5`, failed stayed `0`.
  - Backend stdout: `0` `Too many concurrent`, `0` `Transient error`, `0` `syncBatchV2.*Account .* failed`.
  - `adminAlerts.js:notify`: `0` schedules in window.
  - Exact `pg_wal`: `1,711,276,032 -> 1,711,276,032` bytes, delta `0`.
  - Token refresh overlap `09:09Z`: dispatcher completed/error null, `systemLogs` errors `0`.
- Second live organic sync tick after reopen closed clean:
  - Tick heartbeat: `syncDispatch` started `2026-05-06T10:04:10.284Z`, finished `2026-05-06T10:04:10.363Z`, status `completed`, `error=null`.
  - `syncMetrics.js:syncBatchWorkerV2`: total success `5 -> 6`, failed stayed `0`.
  - Backend stdout in `10:03Z..10:18Z`: `0` `Too many concurrent`, `0` `Transient error`, `0` `syncBatchV2.*Account .* failed`.
  - `adminAlerts.js:notify`: `0` schedules in window.
  - Failed counters unchanged (`adminAlerts.notify=38`, V1 sync=37, V1 UZ=36, tokenRefreshOneV2=14, manualMassCleanup=1).
  - Exact `pg_wal` sample stayed `1,711,276,032` bytes.
  - `/version`: HTTP 200; `systemLogs` errors in the recent window: `0`.
- Sync V2 is now live in conservative production profile after two clean live organic ticks (`09:19Z`, `10:04Z`). Keep `SYNC_ESCALATION_ALERTS_ENABLED=0` and `SYNC_METRICS_V2_POLL_MODERATION=0` closed; future sync ticks remain organic only.
- UZ V2 unattended production mode was opened after explicit business go:
  - Gate opened: `2026-05-06T11:35Z` (`UZ_BUDGET_V2_ENABLED 0 -> 1`).
  - No manual UZ trigger was run.
  - First organic production tick: `uzBudgetDispatch` started `2026-05-06T12:12:10.525Z`, finished `2026-05-06T12:12:10.674Z`, status `completed`, `error=null`.
  - `ruleEngine.js:uzBudgetBatchWorkerV2`: total success `6 -> 8`, failed stayed `0`.
  - Backend rollback-pattern grep in `12:10Z..12:25Z`: `0` `Too many concurrent`, `0` `Transient error`, `0` `TOKEN_EXPIRED`, `0` `[uzBatchV2#.*] Account .* failed`, `0` `syncBatchV2.*Account .* failed`.
  - `adminAlerts.js:notify`: `0` schedules in window.
  - `systemLogs` error level during the UZ worker window through `12:18Z`: `0`.
  - Exact `pg_wal`: `1,627,389,952 -> 1,627,389,952` bytes, delta `0`.
  - Failed counters unchanged (`adminAlerts.notify=38`, V1 sync=37, V1 UZ=36, tokenRefreshOneV2=14, manualMassCleanup=1, UZ V2 failed=0).
  - `actionLogs` audit for `12:10Z..12:55Z`: `216` `budget_increased|success`, `0` failed/reverted budget actions, across `7` users, `19` accounts, `20` rules, `216` ads.
  - `/version`: HTTP 200.
  - Post-UZ sync tick `12:19:10Z` closed clean by sync hard criteria (`syncBatchWorkerV2 success=9`, failed counters flat, adminAlerts `0`, backend rollback grep `0`).
  - Secondary yellow note: `systemLogs` recorded one later `syncMetrics` error at `2026-05-06T12:20:12Z` (`checkRulesForAccount failed: request timed out`). It occurred after UZ workers had completed and is not treated as a UZ rollback trigger, but it should be watched on later sync ticks.
  - Read-only RCA for that timeout: account `j978z1sbh3ra5ym2hh3wqmb88184cs47` (`Вардек мск спб`) is active, token fresh until `2026-05-07T13:12:04Z`, `lastError=null`, `lastSyncError=null`; same account had `checkRulesForAccount` timeouts on `2026-05-03` and `2026-05-04`. Active rules include `cpl_limit` with `timeWindow=since_launch`; the stack points to `ruleEngine.ts:1759` (`getAccountAllAdIds`), and a direct read-only call to `getAccountAllAdIds` for the account timed out. Follow-up `systemLogs` scope query over current 10-day retention found `2` affected active accounts (`Вардек мск спб` and `Интерьер`), each with `4` timeout records. Treat as heavy historical metrics/rule-evaluation path, not UZ rollback.
  - Second organic UZ production tick: `uzBudgetDispatch` started `2026-05-06T12:57:10.529Z`, finished `2026-05-06T12:57:10.665Z`, status `completed`, `error=null`.
  - `ruleEngine.js:uzBudgetBatchWorkerV2`: total success `8 -> 10`, failed stayed `0`.
  - Backend rollback-pattern grep in `12:55Z..13:35Z`: `0`.
  - `adminAlerts.js:notify`: `0`; `systemLogs` error level: `0`; exact `pg_wal` stayed `1,627,389,952` bytes.
  - Failed counters unchanged; `/version` HTTP 200.
  - `actionLogs` audit for `12:55Z..13:35Z`: `89` `budget_increased|success`, `0` failed/reverted budget actions.
  - Token refresh `13:09Z` dispatcher completed/error null; `systemLogs` errors in the recent token window were `0`, with one known `tokenRecovery` warn for `Милород Челябинск`.
  - Backend custom UZ console lines (`[uzBudgetDispatchV2]`, `[uzBatchV2#N] Done:`) were not visible in `docker logs`; worker completion was verified via `_scheduled_jobs` and actionLogs.
- Current production gates:
  - `SYNC_METRICS_V2_ENABLED=1` (live conservative profile after two clean live organic ticks)
  - `SYNC_ESCALATION_ALERTS_ENABLED=0`
  - `SYNC_METRICS_V2_POLL_MODERATION=0`
  - `SYNC_WORKER_COUNT_V2=2`
  - `SYNC_BATCH_SIZE_V2=20`
  - `DISABLE_ERROR_ALERT_FANOUT=1`
  - `UZ_BUDGET_V2_ENABLED=1`
  - `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16` (Phase 8 closed clean `2026-05-06T17:47Z`)

## Phase 6b current gate

No prod-touching step without explicit `go`.

1. V2 sync cron is deployed:
   `crons.interval("sync-metrics", { minutes: 45 }, internal.syncMetrics.syncDispatchV2)`.
2. V1 sync cron remains absent; do not restore `internal.syncMetrics.syncDispatch`.
3. Current state is `SYNC_METRICS_V2_ENABLED=1`; Phase 6b closed clean, the post-token live reopen is clean after two organic ticks, and sync remains in conservative production profile.
4. Do not manual-trigger sync; future sync runs should be organic cron ticks only.
5. Current production profile after two throughput bumps: `SYNC_WORKER_COUNT_V2=2`, `SYNC_BATCH_SIZE_V2=20`, `SYNC_METRICS_V2_POLL_MODERATION=0`, `SYNC_ESCALATION_ALERTS_ENABLED=0`.
6. Further throughput changes, enabling moderation poll, or reopening escalation alerts are separate decisions.

## Rollback triggers

Any one means stop sync canary, set `SYNC_METRICS_V2_ENABLED=0`, and do not retry before analysis:

- `syncMetrics.js:syncBatchWorkerV2 failed > 0`.
- Any backend stdout line matching `syncBatchV2.*Account .* failed`.
- Any `Too many concurrent` or `Transient error`.
- Any new `adminAlerts.js:notify` schedule in the window.
- `pg_wal` delta > `100 MB` for a `1 worker x 20 accounts` run.

## Notes

- Do not run smoke V2 after `SYNC_METRICS_V2_ENABLED=1`; that is the real canary.
- Sync cron V2 is registered and live with `SYNC_METRICS_V2_ENABLED=1`; keep moderation poll and sync escalation alerts disabled until separate restore decisions.
- `npx convex codegen` is not part of Phase 6a; use deploy only unless explicitly approved.
