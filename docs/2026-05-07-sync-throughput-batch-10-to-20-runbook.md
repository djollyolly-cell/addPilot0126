# Sync throughput bump runbook: `SYNC_BATCH_SIZE_V2` 10 -> 20

Date: 2026-05-07
Branch: `emergency/drain-scheduled-jobs`
Scope: first sync-throughput increase after Phase 8 and B1 (`getAccountAllAdIds`) closure.
Status: runbook only -- does not authorize prod changes by itself.

## Why this runbook exists

B1 fixed the heavy-account timeout path at function level, but organic E2E verification was deferred because the conservative Phase 6 sync profile is too slow:

- `SYNC_WORKER_COUNT_V2=1`
- `SYNC_BATCH_SIZE_V2=10`
- `sync-metrics` cron every `45 min`
- observed coverage around B1 watcher: `9 / 212` active accounts in a short post-deploy window
- two B1 target accounts had not received an organic sync tick for `8.5h` / `10h`

That is not a B1 defect. It is system-wide sync throughput throttling. The next operational objective is to improve account coverage while keeping the recovered scheduler stable.

`listSyncableAccounts` has a top-100 cap by oldest `lastSyncAt`. With 212+ active accounts, full rotation depends on how fast accounts cycle in and out of that top-100 set, not on simple `totalAccounts / batchSize` arithmetic. This runbook therefore watches stale-count deltas and worker logs instead of assuming linear full-pass timing.

## Important code constraint

The original operator candidate was `SYNC_BATCH_SIZE_V2 10 -> 30`, but the deployed code clamps the value to `20`:

```ts
function getSyncBatchSizeV2(): number {
  return Math.min(
    20,
    Math.max(1, Number(process.env.SYNC_BATCH_SIZE_V2) || 20)
  );
}
```

Therefore:

- setting `SYNC_BATCH_SIZE_V2=30` today would silently behave as `20`;
- the first env-only throughput bump is **10 -> 20**;
- `20 -> 30` requires a code change to raise the clamp and must be a separate runbook/deploy.

Do not set `30` in this runbook. Set `20` so the operator record matches actual runtime behavior.

## Current production profile expected before bump

This section is an expectation, not proof. `SYNC_WORKER_COUNT_V2` has a code default of `2` if the env var is unset:

```ts
function getSyncWorkerCountV2(): number {
  return Math.min(
    2,
    Math.max(1, Number(process.env.SYNC_WORKER_COUNT_V2) || 2)
  );
}
```

Therefore the pre-bump baseline must explicitly verify that Convex deployment env contains `SYNC_WORKER_COUNT_V2=1`. If the env var is missing/unset, the runtime default is `2`, which changes the V8 math and expected dispatcher logs. Do not proceed with this runbook under an implicit worker-count default.

- `SYNC_METRICS_V2_ENABLED=1`
- `SYNC_WORKER_COUNT_V2=1`
- `SYNC_BATCH_SIZE_V2=10`
- `SYNC_METRICS_V2_POLL_MODERATION=0`
- `SYNC_ESCALATION_ALERTS_ENABLED=0`
- `UZ_BUDGET_V2_ENABLED=1`
- `DISABLE_ERROR_ALERT_FANOUT=1`
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`

Code:

- V2 sync cron registered:
  `crons.interval("sync-metrics", { minutes: 45 }, internal.syncMetrics.syncDispatchV2)`
- V1 sync cron remains removed. Do not restore V1.
- `syncBatchWorkerV2` catches per-account errors and can still finish as a scheduled job success. Backend stdout per-account failure grep is mandatory.
- `syncBatchWorkerV2` has `SYNC_WORKER_TIMEOUT_MS_V2 = 570_000` (`9.5 min`). With batch `20`, a worker may hit this guard before processing all selected accounts if several accounts are heavy. Treat this as an effectiveness failure, not necessarily an immediate service rollback.
- V1 sync had `BATCH_ACCOUNT_TIMEOUT_MS = 560_000` as a per-account guard. V2 does not have an equivalent per-account timeout guard in `syncBatchWorkerV2`; it only checks total worker elapsed time between accounts. This matters for batch-size calibration.

## Strategy

This is a **batch-only** bump:

- Change exactly one env var: `SYNC_BATCH_SIZE_V2=10 -> 20`.
- Keep `SYNC_WORKER_COUNT_V2=1`.
- Keep concurrency `16`.
- Keep moderation polling off.
- Keep escalation alerts off.
- Keep UZ and token settings unchanged.
- No manual sync trigger.

Why batch first:

- It can roughly double sync coverage per organic tick.
- It does not increase sync worker parallelism.
- It does not create a second long-lived sync worker competing for V8 slots.
- It is reversible with one env var.

Worker-count `1 -> 2` remains the next candidate only if batch `20` is clean but still insufficient.

## Risk model

Primary risks:

1. **Longer single worker runtime.** Batch `20` can run closer to the `9.5 min` worker timeout.
2. **WAL/write pressure.** Twice the account count can mean more sync writes in one tick.
3. **Hidden per-account failures.** Worker scheduled-job success is not enough; per-account errors are logged inside worker stdout.
4. **Overlap pressure.** Sync can overlap with UZ workers and token refresh. With worker count still `1`, V8 slot pressure should remain lower than a worker-count bump.

Expected V8 overlap at current profile:

```text
Token refresh: 2 immediate workers x 3 peak slots = 6 slots
UZ worst-case: 2 workers x 3 peak slots           = 6 slots
Sync:          1 worker x 1 base slot             = 1 slot
Total worst-case job slots                        = 13 / 16
Reserved headroom                                 = 3 slots
```

This is the same worst-case slot count as Phase 8 because sync worker count remains `1`. Batch size changes runtime duration and write volume, not sync worker parallelism.

If pre-bump verification shows `SYNC_WORKER_COUNT_V2` is unset/defaulting to `2`, the overlap math becomes:

```text
Token refresh: 2 immediate workers x 3 peak slots = 6 slots
UZ worst-case: 2 workers x 3 peak slots           = 6 slots
Sync:          2 workers x 1 base slot            = 2 slots
Total worst-case job slots                        = 14 / 16
Reserved headroom                                 = 2 slots
```

That is a different runbook. Stop and either explicitly set `SYNC_WORKER_COUNT_V2=1` as its own guarded action, or rewrite this runbook for worker-count `2` before changing batch size.

Additional effectiveness risk:

- A single hung account (network stall, VK API stall, slow nested action) can consume the entire worker budget before the loop reaches the next account. With batch `20`, throughput collapse from one hung account is more impactful than at batch `10`.
- The worker timeout check runs between accounts, not inside `syncSingleAccount`.

## Preconditions

All must be true before the env change:

- Explicit human go for this bump.
- B1 is accepted as function-level closed with organic E2E deferred due to throughput (`memory/b1-closure-2026-05-06.md`).
- No code deploy, codegen, push, or cron registration change as part of this runbook.
- No manual sync trigger.
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`.
- `SYNC_WORKER_COUNT_V2=1` explicitly present in Convex deployment env. Unset/default `2` blocks this runbook.
- `SYNC_BATCH_SIZE_V2=10`.
- `SYNC_METRICS_V2_POLL_MODERATION=0`.
- `SYNC_ESCALATION_ALERTS_ENABLED=0`.
- `DISABLE_ERROR_ALERT_FANOUT=1`.
- `recordRateLimit` remains disabled/no-op.
- Latest sync/UZ/token heartbeats are not in `running` stale state.
- No unresolved systemic rollback signal: no recent burst of `Too many concurrent`, `Transient error`, or sync V2 failed counters.

## Pre-bump read-only baseline

Capture current UTC time:

```bash
date -u
```

Verify env:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_BATCH_SIZE_V2

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_WORKER_COUNT_V2

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get APPLICATION_MAX_CONCURRENT_V8_ACTIONS
```

Expected:

```text
SYNC_BATCH_SIZE_V2=10
SYNC_WORKER_COUNT_V2=1
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16
```

Hard worker-count gate:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_WORKER_COUNT_V2
```

Expected output must be exactly:

```text
1
```

If output is empty, missing, errors as "not found", or differs from `1`, stop. Do not treat the code default as safe. Options:

1. Set `SYNC_WORKER_COUNT_V2=1` first as a separate guarded env action, then wait for/verify one organic sync tick at `worker_count=1`, `batch_size=10`.
2. Rewrite this runbook for actual worker-count `2` with updated V8 math, expected logs, and acceptance criteria.

Verify surrounding gates:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_METRICS_V2_ENABLED

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_METRICS_V2_POLL_MODERATION

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_ESCALATION_ALERTS_ENABLED

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get UZ_BUDGET_V2_ENABLED

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get DISABLE_ERROR_ALERT_FANOUT
```

Expected:

```text
SYNC_METRICS_V2_ENABLED=1
SYNC_METRICS_V2_POLL_MODERATION=0
SYNC_ESCALATION_ALERTS_ENABLED=0
UZ_BUDGET_V2_ENABLED=1
DISABLE_ERROR_ALERT_FANOUT=1
```

Capture sync baseline:

```bash
node check-sync-tick.cjs baseline
```

This writes `/tmp/sync-canary-baseline.json` with:

- `/version`
- `pg_wal`
- V2 scheduled jobs state
- failed counters
- `lastSyncAt` stale count

Capture byte-exact `pg_wal` baseline:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal"
```

Capture latest heartbeats:

```bash
node check-token-refresh-tick.cjs
node check-uz-tick.cjs <recent-window-start-ISO> <now-ISO>
```

Check `/version`:

```bash
curl --resolve convex.aipilot.by:443:178.172.235.49 \
  -sS -w '\nHTTP %{http_code} time %{time_total}s' \
  --max-time 10 \
  https://convex.aipilot.by/version
```

Expected: HTTP `200`.

## Bump action

Only after explicit go:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set SYNC_BATCH_SIZE_V2 20
```

Verify:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_BATCH_SIZE_V2
```

Expected:

```text
20
```

Do not change `SYNC_WORKER_COUNT_V2`.

## Expected next sync tick

Sync cron interval is `45 min`. The first organic sync tick after env set is the canary.

Do not run a manual trigger to accelerate this. The whole point is to test organic production behavior at the new env value.

Expected dispatcher log on the first real tick:

```text
[syncDispatchV2] Selected 20/... eligible accounts (top-100 cap from listSyncableAccounts)
[syncDispatchV2] Dispatched 1 V2 batch workers for 20 accounts (worker_count=1, batch_size=20)
[syncBatchV2#0] Done: X synced, 0 errors out of 20
```

If the dispatcher logs `worker_count=2`, stop classification. The wrong runbook is being executed.

Clean effectiveness expectation:

- `X` should be close to `20`.
- `X < 15` means the batch size is probably too high for the current account mix or worker timeout budget. This is not automatically a service rollback, but it means the bump did not deliver enough useful throughput and should not be closed as successful without analysis.
- Any `errors > 0` is not clean.
- Any `Worker timeout after ...` line is an effectiveness warning. If it repeats on the second tick, roll back to `10` or choose a worker-count runbook instead.
- In `[syncBatchV2#0] Done: X synced, Y errors out of 20`:
  - `X` = successfully synced accounts.
  - `Y` = accounts that were reached and failed.
  - `20 - X - Y` = untouched accounts the worker never reached before exiting, usually because the worker timeout guard fired between accounts.
  - `X + Y = 20` means the worker processed the full batch.
  - `X + Y < 20` is an effectiveness warning, not automatic rollback. Investigate whether a heavy/hung account consumed the worker budget.

## Post-tick verification

Use a window from roughly one minute before the dispatcher heartbeat to at least `15 min` after it. For example:

```bash
node check-sync-tick.cjs 2026-05-07T10:00:00Z 2026-05-07T10:20:00Z
```

Hard acceptance criteria for the first tick:

- `syncDispatch` heartbeat: `completed`, `error=null`, in window.
- `syncBatchWorkerV2` success increments by `1`; failed stays `0`.
- Backend stdout:
  - `0 Too many concurrent`
  - `0 Transient error`
  - `0 TOKEN_EXPIRED` in sync worker context
  - `0 syncBatchV2.*Account .* failed`
- Worker done log exists:
  - `[syncBatchV2#0] Done: X synced, 0 errors out of 20`
  - `X >= 15` for first-tick acceptable effectiveness
- `adminAlerts.js:notify` schedules in window: `0`.
- Failed counters remain flat.
- `pg_wal` delta:
  - warning if `> 50 MB`;
  - hard stop if `>= 100 MB` for one batch-20 sync tick.
- `/version` remains HTTP `200`.

B1 follow-up signal, if either affected account appears in the selected batch:

- no new `checkRulesForAccount failed: request timed out` for:
  - `j978z1sbh3ra5ym2hh3wqmb88184cs47`
  - `j974v8cpc3zg8tk07maqs39ejh842fz2`
- any new `actionLogs` from their `cpl_limit since_launch` rules are expected side effects of normal automation, not B1 failure.

Do not treat absence of B1 target accounts in the first batch as a failed bump. The dispatcher chooses oldest eligible accounts from its top-100 list.

## Closure criteria

Classify `SYNC_BATCH_SIZE_V2 10 -> 20` as closed clean only after:

- two organic sync ticks at batch `20` are clean by hard criteria;
- no repeated worker timeout/effectiveness warning;
- stale-count drops by at least `25` accounts after two clean sync ticks, unless baseline had fewer than `25` stale accounts left;
  - expected: batch `20`, worker `1`, 45-min cadence should sync roughly `30-40` stale accounts in `~90 min` under normal effectiveness;
  - accepted lower bound: `>=25` net stale-count reduction after two ticks;
  - if the reduction is lower but both worker logs show `X >= 15`, classify as inconclusive and inspect top-100 rotation before rolling back;
- failed counters remain flat;
- no rollback grep hits in backend stdout;
- no admin alert schedules;
- no pg_wal hard-stop delta;
- surrounding UZ and token refresh ticks during the observation window remain clean.

Expected closure time: `~90 min` after env set if two sync ticks arrive on cadence and no token/UZ overlap concern appears.

If a token refresh tick lands inside the observation window, include it in the closure evidence:

- `tokenRefreshDispatch` heartbeat completed with `error=null`;
- no retry storm in backend stdout;
- no `Too many concurrent` / `Transient error` lines in the token window;
- no growth in token refresh failed counters;
- `auth.js:tokenRefreshOneV2` success increments by the expected worker count for that tick.

Token refresh and sync share the V8 slot pool. An unhealthy token tick during the batch-20 observation window is a soft rollback indicator even if sync itself appears clean.

## Rollback

Rollback trigger:

- any `Too many concurrent` or `Transient error` recurrence in the sync window;
- any `syncBatchV2.*Account .* failed` line;
- `syncBatchWorkerV2` failed counter grows;
- `adminAlerts.notify` schedules appear;
- `pg_wal` delta `>= 100 MB` in one batch-20 sync tick;
- worker timeout repeats on two consecutive ticks and useful throughput is below `15` accounts/tick;
- `/version` not HTTP `200` or backend health degrades.

Rollback action:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set SYNC_BATCH_SIZE_V2 10
```

Verify rollback:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_BATCH_SIZE_V2
```

Expected:

```text
10
```

Rollback is not closed until both env and runtime are verified:

1. `npx convex env get SYNC_BATCH_SIZE_V2` returns `10`.
2. The next organic sync tick logs `worker_count=1, batch_size=10`.
3. The next worker done log is `out of 10`.
4. That next tick is clean by standard Phase 6 criteria.

## What this runbook does not do

- Does not set `SYNC_BATCH_SIZE_V2=30` because current code clamps to `20`.
- Does not change `SYNC_WORKER_COUNT_V2`.
- Does not enable moderation polling.
- Does not enable sync escalation alerts.
- Does not restore `adminAlerts.notify`.
- Does not restore `recordRateLimit`.
- Does not change cron cadence.
- Does not run manual sync.
- Does not deploy/codegen/push.

## Execution log

Executed on `2026-05-06T21:22Z` (`2026-05-07T00:22 MSK`) after explicit go.

Pre-bump baseline:

- Runbook committed/pushed first: `7cf326e docs(sync): add batch throughput bump runbook`.
- Hard env gate passed:
  - `SYNC_BATCH_SIZE_V2=10`
  - `SYNC_WORKER_COUNT_V2=1`
  - `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`
  - `SYNC_METRICS_V2_ENABLED=1`
  - `SYNC_METRICS_V2_POLL_MODERATION=0`
  - `SYNC_ESCALATION_ALERTS_ENABLED=0`
  - `UZ_BUDGET_V2_ENABLED=1`
  - `DISABLE_ERROR_ALERT_FANOUT=1`
- `node check-sync-tick.cjs baseline` captured `2026-05-06T21:19:55Z`:
  - `/version`: HTTP `200`
  - `pg_wal`: `1,593,835,520` bytes
  - `lastSyncAt stale (>20min)`: `203/212`
  - `syncMetrics.js:syncBatchWorkerV2|success|21`
  - failed counters baseline: `adminAlerts.js:notify=38`, V1 sync `37`, V1 UZ `36`, `auth.js:tokenRefreshOneV2=14`, `metrics.js:manualMassCleanup=1`
- Token heartbeat before bump: `tokenRefreshDispatch` `2026-05-06T21:09:36Z`, completed/error null.
- UZ heartbeat before bump: `uzBudgetDispatch` `2026-05-06T21:12:10Z`, completed/error null.

Action:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set SYNC_BATCH_SIZE_V2 20
```

Verification:

- `npx convex env get SYNC_BATCH_SIZE_V2` returned `20`.

First organic batch-20 sync tick:

- Window: `2026-05-06T22:03:00Z..22:20:00Z`.
- `syncDispatch` heartbeat: `2026-05-06T22:04:10Z`, completed/error null.
- `syncMetrics.js:syncBatchWorkerV2` success `21→22`, failed stayed `0`.
- Backend stdout rollback grep: `0`.
- Per-account sync failures: `0`.
- `adminAlerts.js:notify` schedules: `0`.
- Failed counters flat.
- `/version`: HTTP `200`.
- `pg_wal`: `1,593,835,520 → 1,409,286,144` bytes (decrease from checkpoint behavior, no WAL growth).
- Direct account-update audit for the tick: `19` accounts updated in `22:03Z..22:20Z`, all with empty `lastError` / `lastSyncError`.

Extended observation:

- Observation window: `2026-05-06T21:20:00Z..2026-05-07T02:55:00Z`.
- Latest sync heartbeat at check time: `2026-05-07T02:34:10Z`, completed/error null.
- `syncMetrics.js:syncBatchWorkerV2` success `21→28`, failed stayed `0`.
- Backend stdout rollback grep across full observation: `0`.
- `adminAlerts.js:notify` schedules: `0`.
- Failed counters flat.
- `/version`: HTTP `200`.
- `pg_wal`: `1,593,835,520 → 1,577,058,304` bytes (delta `-16 MiB`, no WAL growth).
- Latest tick account-update audit (`02:33Z..02:50Z`): `19` accounts updated, all with empty `lastError` / `lastSyncError`.
- Total account coverage since bump (`21:20Z..02:55Z`): `134/212` accounts had `lastSyncAt` in the post-bump window.
- Token refresh inside observation: `tokenRefreshDispatch` `2026-05-07T01:09:36Z`, completed/error null.
- UZ inside observation: latest `uzBudgetDispatch` `2026-05-07T02:27:10Z`, completed/error null; `ruleEngine.js:uzBudgetBatchWorkerV2|success|46`, no failed growth.

Closure:

`SYNC_BATCH_SIZE_V2 10→20` closed clean after extended observation. Final state:

- `SYNC_BATCH_SIZE_V2=20`
- `SYNC_WORKER_COUNT_V2=1`
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`
- all other gates unchanged

No rollback executed.

## Next candidates after this runbook

If batch `20` closes clean but coverage is still too slow:

1. `SYNC_WORKER_COUNT_V2 1 -> 2` runbook.
   - More parallelism, more V8 slot risk.
   - Needs overlap math with token refresh and UZ.
2. Code change to raise batch clamp `20 -> 30`.
   - Requires deploy and separate canary.
   - Should only happen if one worker can process batch `20` without timeout warnings.
3. Cron cadence change remains last.
   - 45 min was chosen to prevent worker overlap and WAL pressure.
   - Do not shorten cadence before worker/batch evidence is stable.
