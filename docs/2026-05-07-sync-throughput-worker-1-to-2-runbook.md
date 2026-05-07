# Sync throughput bump runbook: `SYNC_WORKER_COUNT_V2` 1 -> 2

Date: 2026-05-07
Branch: `emergency/drain-scheduled-jobs`
Scope: second sync-throughput increase after batch `10 -> 20` closed clean.
Status: runbook only -- does not authorize prod changes by itself.

## Why this runbook exists

Batch `10 -> 20` closed clean and improved production coverage without increasing sync worker parallelism. The next throughput lever is `SYNC_WORKER_COUNT_V2 1 -> 2`.

This is a different risk class from batch size:

- batch `20` increased work inside one long-lived sync worker;
- worker `2` runs two sync workers concurrently;
- each worker receives roughly `10` accounts when `SYNC_BATCH_SIZE_V2=20`;
- total selected accounts per tick stays `20`, but V8 slot pressure and concurrent write pressure increase.

Do not combine this with:

- batch `20 -> 30`;
- cron cadence change;
- moderation polling;
- sync escalation alerts;
- D1/D2 implementation;
- any code deploy/codegen.

## Current production profile expected before bump

- `SYNC_METRICS_V2_ENABLED=1`
- `SYNC_WORKER_COUNT_V2=1`
- `SYNC_BATCH_SIZE_V2=20`
- `SYNC_METRICS_V2_POLL_MODERATION=0`
- `SYNC_ESCALATION_ALERTS_ENABLED=0`
- `UZ_BUDGET_V2_ENABLED=1`
- `DISABLE_ERROR_ALERT_FANOUT=1`
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`

Code constraints:

- Worker count is clamped at `2`:

```ts
function getSyncWorkerCountV2(): number {
  return Math.min(
    2,
    Math.max(1, Number(process.env.SYNC_WORKER_COUNT_V2) || 2)
  );
}
```

- Batch size is clamped at `20`:

```ts
function getSyncBatchSizeV2(): number {
  return Math.min(
    20,
    Math.max(1, Number(process.env.SYNC_BATCH_SIZE_V2) || 20)
  );
}
```

Therefore this runbook's actual runtime shape is:

```text
batch_size=20
worker_count=2
chunk_size=ceil(20 / 2)=10
```

Expected dispatcher/worker logs:

```text
[syncDispatchV2] Selected 20/... eligible accounts (top-100 cap from listSyncableAccounts)
[syncDispatchV2] Dispatched 2 V2 batch workers for 20 accounts (worker_count=2, batch_size=20)
[syncBatchV2#0] Done: X0 synced, Y0 errors out of 10
[syncBatchV2#1] Done: X1 synced, Y1 errors out of 10
```

## Strategy

Change exactly one env var:

- `SYNC_WORKER_COUNT_V2=1 -> 2`

Keep everything else unchanged:

- `SYNC_BATCH_SIZE_V2=20`
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`
- `SYNC_METRICS_V2_POLL_MODERATION=0`
- `SYNC_ESCALATION_ALERTS_ENABLED=0`
- `UZ_BUDGET_V2_ENABLED=1`
- `DISABLE_ERROR_ALERT_FANOUT=1`

No manual sync trigger. The first canary must be the next organic sync cron tick.

## Risk model

Primary risks:

1. **V8 headroom thinner than batch-only.** Sync now uses two long-lived worker slots.
2. **Parallel write pressure.** Same selected account count (`20`) but writes can happen concurrently.
3. **Overlap sensitivity.** Token refresh and UZ share the same V8 action pool.
4. **Hidden per-account failures.** Worker scheduled-job success is not sufficient; `syncBatchV2.*Account .* failed` in backend stdout is a hard failure.
5. **Uneven chunks.** If one worker hits a heavy/hung account, the other worker may finish clean; aggregate scheduled-job success can hide poor effective coverage in one chunk.

Worst-case current-profile overlap at `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`:

```text
Token refresh: 2 immediate workers x 3 peak slots = 6 slots
UZ worst-case: 2 workers x 3 peak slots           = 6 slots
Sync:          2 workers x 1 base slot            = 2 slots
Total worst-case job slots                        = 14 / 16
Reserved headroom                                 = 2 slots
```

This is still inside the Phase 8 concurrency ceiling, but it has less headroom than batch-only (`13/16`). Treat any V8/transient signal during overlap as serious.

## Preconditions

All must be true:

- Explicit human go for this bump.
- Batch `10 -> 20` closure is recorded clean in `docs/2026-05-07-sync-throughput-batch-10-to-20-runbook.md`.
- No code deploy, codegen, push, cron change, or manual sync trigger as part of the env bump.
- `SYNC_BATCH_SIZE_V2=20`.
- `SYNC_WORKER_COUNT_V2=1`.
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`.
- `SYNC_METRICS_V2_POLL_MODERATION=0`.
- `SYNC_ESCALATION_ALERTS_ENABLED=0`.
- `DISABLE_ERROR_ALERT_FANOUT=1`.
- `recordRateLimit` remains disabled/no-op.
- Latest sync, UZ, and token refresh heartbeats are completed/error null.
- No unresolved rollback signal in backend stdout since the batch-20 closure.

## Pre-bump read-only baseline

Capture time:

```bash
date -u
```

Verify env:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_WORKER_COUNT_V2

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_BATCH_SIZE_V2

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get APPLICATION_MAX_CONCURRENT_V8_ACTIONS
```

Expected:

```text
SYNC_WORKER_COUNT_V2=1
SYNC_BATCH_SIZE_V2=20
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16
```

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

Capture byte-exact WAL:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal"
```

Capture heartbeats:

```bash
node check-token-refresh-tick.cjs
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

Only after explicit go and clean preflight:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set SYNC_WORKER_COUNT_V2 2
```

Verify:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_WORKER_COUNT_V2
```

Expected:

```text
2
```

Do not change `SYNC_BATCH_SIZE_V2`.

## Post-tick verification

Wait for the next organic sync tick. Use a window from one minute before dispatcher start to at least `15 min` after it.

Example:

```bash
node check-sync-tick.cjs 2026-05-07T03:18:00Z 2026-05-07T03:35:00Z
```

Hard criteria for the first worker-count-2 tick:

- `syncDispatch` heartbeat completed/error null, in window.
- `syncBatchWorkerV2` success increments by `2`; failed stays `0`.
- Backend stdout:
  - `0 Too many concurrent`
  - `0 Transient error`
  - `0 TOKEN_EXPIRED` in sync worker context
  - `0 syncBatchV2.*Account .* failed`
- Dispatcher log shows `worker_count=2, batch_size=20`.
- Two worker done logs exist:
  - `[syncBatchV2#0] Done: X0 synced, 0 errors out of 10`
  - `[syncBatchV2#1] Done: X1 synced, 0 errors out of 10`
- Aggregate `X0 + X1 >= 18` on the first tick.
- `adminAlerts.js:notify` schedules in window: `0`.
- Failed counters remain flat.
- `/version` remains HTTP `200`.
- `pg_wal` delta:
  - warning if `> 75 MB`;
  - hard stop if `>= 150 MB`.

Interpretation:

- If one worker is clean and the other exits early, classify as effectiveness warning, not automatic service rollback.
- If either worker reports `errors > 0`, not clean.
- If `worker_count=1` appears, runtime did not pick up the env change; do not close.

## Closure criteria

Classify `SYNC_WORKER_COUNT_V2 1 -> 2` as closed clean only after:

- two organic sync ticks at worker count `2` are clean by hard criteria;
- at least one UZ tick inside or adjacent to the observation window is clean;
- if a token refresh tick lands inside the observation window, it is clean:
  - heartbeat completed/error null;
  - no retry storm;
  - no V8/transient lines;
  - token refresh failed counters flat;
- `syncBatchWorkerV2` success increases by `4` across the two sync ticks;
- no failed counter growth;
- no admin alert schedules;
- no WAL hard-stop delta;
- post-bump account-update audit shows roughly `35-40` accounts updated across two ticks, with accepted lower bound `>=30`.

Expected closure time:

- `~90 min` if two sync ticks arrive on cadence and no token refresh overlap lands.
- `2-3h` if token refresh overlap needs to be included.

## Rollback

Rollback trigger:

- any `Too many concurrent` or `Transient error` in the sync/token/UZ overlap window;
- any `syncBatchV2.*Account .* failed`;
- `syncBatchWorkerV2` failed counter grows;
- `adminAlerts.notify` schedules appear;
- `pg_wal` delta `>=150 MB` in one worker-count-2 tick;
- aggregate updated accounts `<15` on a tick with no obvious external outage;
- `/version` not HTTP `200` or backend health degrades.

Rollback action:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set SYNC_WORKER_COUNT_V2 1
```

Rollback is not closed until:

1. `npx convex env get SYNC_WORKER_COUNT_V2` returns `1`.
2. The next organic sync tick logs `worker_count=1, batch_size=20`.
3. The next worker done log is `out of 20`.
4. That tick is clean by standard Phase 6 criteria.

## What this runbook does not do

- Does not change `SYNC_BATCH_SIZE_V2`.
- Does not set batch `30`.
- Does not change cron cadence.
- Does not enable moderation polling.
- Does not enable sync escalation alerts.
- Does not restore `adminAlerts.notify`.
- Does not restore `recordRateLimit`.
- Does not run manual sync.
- Does not deploy/codegen/push as part of the env bump.

## Next candidates after this runbook

If worker `2` closes clean but coverage is still insufficient:

1. Code change to raise batch clamp `20 -> 30`, with deploy and separate canary.
2. Cron cadence reduction from `45 min` to `30 min`, only after WAL and overlap data stay clean.
3. Cron cadence `5 min` remains last-resort; it resembles the pre-incident pressure profile and needs a separate design.

