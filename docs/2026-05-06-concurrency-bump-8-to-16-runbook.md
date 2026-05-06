# Convex concurrency bump 8 -> 16 runbook

Date: 2026-05-06
Branch: `emergency/drain-scheduled-jobs`
Scope: post-core-restore headroom increase after the 2026-05-04/05 scheduled jobs incident.

This document is a runbook only. It does not authorize a prod change by itself.
Do not bump `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` without an explicit human go.

## Current context

Core jobs are live in conservative profile:

- `SYNC_METRICS_V2_ENABLED=1`
- `SYNC_WORKER_COUNT_V2=1`
- `SYNC_BATCH_SIZE_V2=10`
- `SYNC_METRICS_V2_POLL_MODERATION=0`
- `SYNC_ESCALATION_ALERTS_ENABLED=0`
- `UZ_BUDGET_V2_ENABLED=1`
- `DISABLE_ERROR_ALERT_FANOUT=1`
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8`

Clean evidence so far:

- Sync live ticks clean: `09:19Z`, `10:04Z`, `10:49Z`, `11:34Z`, `12:19Z`, `13:04Z`.
- UZ live ticks clean: `12:12Z`, `12:57Z`.
- Token refresh `13:09Z` dispatcher completed clean.
- UZ actionLogs audit: `305` successful `budget_increased` VK Ads writes, `0` failed/reverted budget actions across the first two production UZ ticks.

Open watch-point:

- One `systemLogs` error at `2026-05-06T12:20:12Z`: `syncMetrics checkRulesForAccount failed: request timed out`.
- Account: `j978z1sbh3ra5ym2hh3wqmb88184cs47` (`Вардек мск спб`), active, token fresh until `2026-05-07T13:12:04Z`, `lastError=null`, `lastSyncError=null`.
- The same account had `checkRulesForAccount` timeouts before UZ live restore (`2026-05-03` and `2026-05-04`), so this is not clearly caused by UZ.
- Root-cause pointer: `ruleEngine.ts:1759` calls `getAccountAllAdIds`, which collects all `metricsDaily` records for the account when `cpl_limit`/similar rules use `timeWindow="since_launch"`. A direct read-only call to `getAccountAllAdIds` for this account timed out during investigation.
- Separate tracking: `memory/todo-getAccountAllAdIds-pagination.md`.

## Why bump

`8 -> 16` gives V8 action headroom for real overlap windows:

- token refresh workers;
- one sync worker;
- up to two UZ workers;
- user/API actions and system queries.

It is not user-visible by itself, but it changes scheduler pressure and token-refresh fan-out behavior. Treat the first token refresh tick after the bump as a real canary.

Worst-case current-profile overlap at concurrency `16`:

```text
Token refresh: 2 immediate workers x 3 peak slots = 6 slots
Sync:          1 worker x 1 slot                  = 1 slot
UZ steady-state: 2 workers x 2 peak slots         = 4 slots
UZ worst-case:   2 workers x 3 peak slots         = 6 slots
Total worst-case job slots                        = 13 / 16
Reserved headroom for system/user actions         = 3 slots
```

The UZ steady-state case assumes no token refresh chain inside `processUzBudgetForAccount`. The UZ worst-case case assumes `getValidTokenForAccount` refreshes tokens during UZ processing; `dispatchUzBatchesV2` already staggers UZ workers with `slotsPerWorker=3`.

This is the justification for `8 -> 16` under the current conservative profile, but the true worst-case headroom is only `3` slots. If sync worker count, sync batch size, UZ worker count, or token-refresh fan-out changes later, recalculate before using this math.

## Preconditions

All must be true:

- Explicit human go for the bump.
- No deploy/codegen/push as part of this runbook.
- No sync or UZ manual trigger.
- `adminAlerts.notify` remains no-op and `DISABLE_ERROR_ALERT_FANOUT=1`.
- `recordRateLimit` remains disabled/no-op.
- Sync and UZ gates remain unchanged.
- Timeout watch is either clean enough or accepted as known risk:
  - If the timeout watch is closed by no recurrence in two consecutive sync ticks before this bump, this precondition is satisfied.
  - If the watch is still open at bump time, revisit it before bumping.
  - If any timeout repeats before bumping, classify before bumping.
  - If `>=3` timeout lines appear in one sync window, do not bump as a routine step; do RCA first.
- Earliest timing: after the stability window agreed by operators. The previous conservative target was not before `2026-05-06T20:50Z` (`12h` after sync live reopen at `08:50Z`) or the morning of `2026-05-07`, unless emergency headroom is explicitly accepted.
- Accelerated execution `2026-05-06T~15:30Z`: operator decision based on accumulated live evidence (9 clean live sync ticks, 5 clean live UZ ticks with 305 successful `budget_increased` actions and 0 failed/reverted, 3 clean token refresh ticks since live mode, `pg_wal` flat at `1,627,389,952` bytes for 4 hours, only one pre-existing yellow note classified as non-blocking). Tradeoff explicitly accepted because concurrency bump is fully reversible with no user impact.

## Fan-out math

Token refresh V2 uses `slotsPerWorker=3` and `FANOUT_STAGGER_MS=7000`.

Formula:

```text
immediate = floor(APPLICATION_MAX_CONCURRENT_V8_ACTIONS / (slotsPerWorker * 2))
```

Expected at concurrency `8`:

```text
immediate = floor(8 / (3 * 2)) = 1
sample_delays_at_3 = [0, 7000, 14000, 21000, 28000, 35000]
```

Expected at concurrency `16`:

```text
immediate = floor(16 / (3 * 2)) = 2
sample_delays_at_3 = [0, 0, 7000, 7000, 14000, 14000]
```

Risk: this doubles the initial token-refresh worker burst from `1` to `2`. That is the intended headroom use, but the first token refresh tick after bump must be watched.

This runbook is only for `8 -> 16`. A later `16 -> 32` bump requires a separate runbook and canary because the token-refresh immediate burst changes from `2` to `5` workers, and overlap math changes substantially.

## Expected canary timeline

Token refresh runs on the current `2h` cadence:

```text
15:09Z
17:09Z
19:09Z
21:09Z
23:09Z
...
```

Sync and UZ run every `45 min`.

Operational implication:

- If bump happens around `20:30Z`, first token-refresh canary is expected around `21:09Z`.
- If bump happens around `21:00Z`, first token-refresh canary is expected around `21:09Z`.
- If bump happens just after a token tick, wait close to `2h` for the primary canary.

Full bump closure needs enough time to see token refresh plus sync and UZ at the new concurrency. Budget roughly `2h` after bump for the full canary set, plus worker verification time.

## Exit criteria

Classify the bump as closed clean only after all are true:

- First organic token refresh tick after bump is clean.
- Two organic sync ticks after bump are clean.
- One organic UZ tick after bump is clean.
- Failed counters remain on baseline.
- `adminAlerts.js:notify` schedules remain `0`.
- `/version` remains HTTP `200`.
- Timeout watch does not show a concerning pattern:
  - no `>=2` `checkRulesForAccount` timeout lines in one sync window;
  - no same-account repeated timeout pattern after bump;
  - no timeout correlated with V8 slot pressure, `TOKEN_EXPIRED`, or failed counters.

Do not restore more gates until these exit criteria are met, unless operators explicitly accept a new emergency tradeoff.

## Pre-bump read-only baseline

Capture UTC time:

```bash
date -u
```

Verify current env:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get APPLICATION_MAX_CONCURRENT_V8_ACTIONS
```

Expected before bump:

```text
8
```

Verify gates:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_METRICS_V2_ENABLED

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
UZ_BUDGET_V2_ENABLED=1
DISABLE_ERROR_ALERT_FANOUT=1
```

Run current fan-out diagnostic:

```bash
node check-diag-fanout.cjs
```

Expected before bump:

```json
{
  "env_max_concurrent": "8",
  "computed_concurrency": 8,
  "computed_immediate_slots_for_3": 1,
  "fanout_stagger_ms": 7000,
  "sample_delays_at_3": [0, 7000, 14000, 21000, 28000, 35000]
}
```

Capture heartbeats:

```bash
node check-token-refresh-tick.cjs
```

Capture failed counters:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker exec adpilot-postgres psql -U convex -d adpilot_prod -t -A -F'|' -c \"WITH latest AS (SELECT DISTINCT ON (id) id, ts, deleted, convert_from(json_value,'UTF8')::jsonb AS j FROM documents WHERE table_id = decode('7ee519d746cd4bc3221534e5d95c5010','hex') ORDER BY id, ts DESC) SELECT j->>'udfPath' AS udf_path, count(*) AS failed FROM latest WHERE NOT deleted AND j #>> '{state,type}' = 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;\""
```

Expected baseline:

```text
adminAlerts.js:notify = 38
syncMetrics.js:syncBatchWorker = 37
ruleEngine.js:uzBudgetBatchWorker = 36
auth.js:tokenRefreshOneV2 = 14
metrics.js:manualMassCleanup = 1
syncMetrics.js:syncBatchWorkerV2 absent/0
ruleEngine.js:uzBudgetBatchWorkerV2 absent/0
```

Capture `pg_wal` baseline:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal"
```

Use this as the byte baseline for the first token-refresh canary window after the bump.

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
npx convex env set APPLICATION_MAX_CONCURRENT_V8_ACTIONS 16
```

Verify env:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get APPLICATION_MAX_CONCURRENT_V8_ACTIONS
```

Expected:

```text
16
```

Run post-bump diagnostic. `check-diag-fanout.cjs` currently has hardcoded `8` expectations, so either update it before using PASS/FAIL or run `auth:diagFanoutConfig` and compare manually.

Direct command:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex run auth:diagFanoutConfig
```

Expected post-bump diagnostic:

```json
{
  "env_max_concurrent": "16",
  "computed_concurrency": 16,
  "computed_immediate_slots_for_3": 2,
  "fanout_stagger_ms": 7000,
  "sample_delays_at_3": [0, 0, 7000, 7000, 14000, 14000]
}
```

Do not change any other env var in the same step.

## Execution log

Phase 8 bump executed `2026-05-06T15:35:06Z = 18:35:06 MSK`. Operator-decision tradeoff (accelerated from `20:50Z` conservative target) recorded in Preconditions section above.

### Pre-bump baseline (`2026-05-06T15:30:04Z`)

- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` (verified)
- All other gates as expected: `SYNC_METRICS_V2_ENABLED=1`, `UZ_BUDGET_V2_ENABLED=1`, `DISABLE_ERROR_ALERT_FANOUT=1`, `SYNC_ESCALATION_ALERTS_ENABLED=0`, `SYNC_METRICS_V2_POLL_MODERATION=0`, `SYNC_WORKER_COUNT_V2=1`, `SYNC_BATCH_SIZE_V2=10`
- `/version`: HTTP 200, 1.2s
- `pg_wal` byte baseline: `1,627,389,952 bytes`
- Heartbeats all completed/error null:
  - `tokenRefreshDispatch`: `15:09:36.642Z → 15:09:38.319Z` (1.677s)
  - `uzBudgetDispatch`: `15:12:10.519Z → 15:12:10.617Z` (98ms)
  - `syncDispatch`: `15:19:10.313Z → 15:19:10.422Z` (109ms)
- Failed counters at established baseline: `adminAlerts=38`, V1 sync=37, V1 UZ=36, `tokenRefreshOneV2=14`, `manualMassCleanup=1`. V2 failed counters absent (=0).
- V2 success cumulative: `syncBatchWorkerV2=13`, `uzBudgetBatchWorkerV2=16`.

### Bump action result

- `npx convex env set APPLICATION_MAX_CONCURRENT_V8_ACTIONS 16` → `Successfully set APPLICATION_MAX_CONCURRENT_V8_ACTIONS`
- `npx convex env get APPLICATION_MAX_CONCURRENT_V8_ACTIONS` → `16`
- `npx convex run auth:diagFanoutConfig` → V8 isolate confirmed:

  ```json
  {
    "computed_concurrency": 16,
    "computed_immediate_slots_for_3": 2,
    "env_disable_alert_fanout": "1",
    "env_max_concurrent": "16",
    "fanout_stagger_ms": 7000,
    "sample_delays_at_3": [0, 0, 7000, 7000, 14000, 14000]
  }
  ```

- `/version` immediately post-bump: HTTP 200, 1.27s.
- No rollback signals observed in the seconds following the bump.

### Already clean on `concurrency=16`

- **UZ tick `2026-05-06T15:57Z`**: `uzBudgetDispatch` heartbeat completed/error null; `uzBudgetBatchWorkerV2 success=18` (+2 from baseline 16); backend rollback grep `0`; `adminAlerts.notify` schedules in window `0`; `systemLogs` errors `0`; failed counters flat.
- **Sync tick `2026-05-06T16:04Z`**: `syncDispatch` heartbeat completed/error null; `syncBatchWorkerV2 success=14` (+1 from baseline 13); backend rollback grep `0`; `adminAlerts.notify` schedules `0`; failed counters flat.

### Pending canaries (watched by separate agent)

- `~16:42Z` UZ tick on 16
- `~16:49Z` sync tick on 16
- **`17:09Z = 20:09 MSK` token refresh** — KEY canary: first token refresh dispatcher with `immediate=2` worker burst (vs `1` at `concurrency=8`). This is the architectural reason for the bump.
- `~17:27Z` UZ post-token-refresh (overlap aftermath)
- `~17:34Z` sync post-token-refresh
- Strict full closure expected `~17:40-17:45Z = 20:40-20:45 MSK` if all of the above remain clean.

### Phase 8 strict closure (`2026-05-06T17:47Z = 20:47 MSK`)

Bump time: `2026-05-06T15:35:06Z`. Strict closure: `2026-05-06T17:47Z`. Final state: `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`.

KEY canary — token refresh `2026-05-06T17:09Z` (first dispatcher run with `immediate=2` burst):

- `tokenRefreshDispatch` heartbeat: `completed`, `error=null`, `finishedAt=2026-05-06T17:09:38.215Z`.
- `auth.js:tokenRefreshOneV2`: `+25 success` in window, `failed` unchanged at baseline `14`.
- Backend rollback grep in window: `0` `Too many concurrent`, `0` `Transient error`, `0` `TOKEN_EXPIRED` burst.
- `adminAlerts.js:notify` schedules in window: `0`.
- `systemLogs` errors in window: `0` (one known `tokenRecovery` warn for `Милород Челябинск` remains a warn, not a rollback trigger).
- `/version`: HTTP `200`.

Post-token overlap canaries:

- **UZ `2026-05-06T17:27:10Z`**: `uzBudgetDispatch` heartbeat `completed`, `error=null`. `ruleEngine.js:uzBudgetBatchWorkerV2` cumulative `16 → 22`, failed stayed `0`. Backend rollback grep `0`, `adminAlerts.notify=0`.
- **Sync `2026-05-06T17:34:10Z`**: `syncDispatch` heartbeat `completed`, `error=null`. `syncMetrics.js:syncBatchWorkerV2` cumulative `13 → 16`, failed stayed `0`. Backend rollback grep `0`, `adminAlerts.notify=0`.

Failed counters at strict closure (unchanged from pre-bump baseline):

```text
adminAlerts.js:notify          = 38
syncMetrics.js:syncBatchWorker = 37
ruleEngine.js:uzBudgetBatchWorker = 36
auth.js:tokenRefreshOneV2      = 14
metrics.js:manualMassCleanup   = 1
syncMetrics.js:syncBatchWorkerV2  failed = 0
ruleEngine.js:uzBudgetBatchWorkerV2 failed = 0
```

`pg_wal` byte-exact: `1,627,389,952 → 1,593,835,520 bytes` (delta `-33 MiB`, well under `+50 MB` hard stop). The slight decrease is normal Postgres checkpoint behavior — the `immediate=2` token-refresh burst did not produce measurable WAL pressure.

Architectural intent realized: token-refresh dispatcher ran with `immediate=2` worker burst (vs `1` at concurrency=8), which was the reason for the bump. No rollback signal observed. `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16` is the new production norm.

No rollback executed. Do not combine with worker/batch bumps, moderation polling, or `16 → 32` concurrency change — each is a separate runbook.

## First token refresh canary at 16

Monitor the first organic `tokenRefreshDispatch` after bump.

Acceptance criteria:

- `tokenRefreshDispatch` heartbeat completed, `error=null`, in window.
- `auth.js:tokenRefreshOneV2` failed counter remains at baseline `14`.
- Backend stdout in the token window:
  - `0` `Too many concurrent`
  - `0` `Transient error`
  - no unexpected `TOKEN_EXPIRED` burst
- `adminAlerts.js:notify` schedules in window: `0`.
- `systemLogs` error level in window: `0`.
- Known `tokenRecovery` warn for `Милород Челябинск` remains a warn, not an error/rollback trigger.
- `/version` HTTP `200`.
- `pg_wal` delta in the token-refresh tick window is `< 50 MB`.
- Failed counters unchanged.

Suggested checks:

```bash
node check-token-refresh-tick.cjs <window-start-iso> <window-end-iso>
node check-token-refresh-errors.cjs <window-start-iso> <window-end-iso>
```

Backend grep:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker logs adpilot-convex-backend --since '<window-start-iso>' --until '<window-end-iso>' 2>&1 \
   | grep -cE 'Too many concurrent|Transient error|TOKEN_EXPIRED|syncBatchV2.*Account .* failed|\\[uzBatchV2#.*\\] Account .* failed'"
```

## Overlap canary at 16

After the first token refresh at 16, watch the next organic sync and UZ ticks.

Acceptance criteria for sync:

- `syncDispatch` heartbeat completed, `error=null`.
- `syncMetrics.js:syncBatchWorkerV2` success increments by `1`, failed stays `0`.
- Backend rollback grep `0`.
- `adminAlerts.js:notify=0`.
- Failed counters unchanged.
- Timeout watch:
  - one isolated `checkRulesForAccount` timeout is yellow;
  - `>=2` timeout lines in one sync window, same account repeating, or timeout with V8/TOKEN/failed-counter signal requires analysis before further gate changes;
  - `>=3` timeout lines in one sync window is critical pressure.

Acceptance criteria for UZ:

- `uzBudgetDispatch` heartbeat completed, `error=null`.
- `ruleEngine.js:uzBudgetBatchWorkerV2` success increments by expected workers, failed stays `0`.
- `actionLogs` budget actions in the tick window have `status=success`; failed/reverted budget actions `0`.
- Backend rollback grep `0`.
- `adminAlerts.js:notify=0`.
- Failed counters unchanged.

## Rollback

Rollback trigger:

- any `Too many concurrent` or `Transient error`;
- token refresh failed counter grows;
- V2 sync or UZ failed counter grows;
- `adminAlerts.js:notify` schedules appear;
- systemLogs error-level records indicate scheduler/concurrency pressure;
- repeated `checkRulesForAccount` timeout pattern after bump;
- `/version` stops returning HTTP `200`.

Rollback command:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set APPLICATION_MAX_CONCURRENT_V8_ACTIONS 8
```

Verify:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get APPLICATION_MAX_CONCURRENT_V8_ACTIONS
```

Expected:

```text
8
```

Then run `auth:diagFanoutConfig` again and confirm:

```text
computed_concurrency=8
computed_immediate_slots_for_3=1
sample_delays_at_3=[0,7000,14000,21000,28000,35000]
```

## Do not combine

Do not combine this bump with:

- sync worker/batch bump;
- moderation polling;
- UZ reset cron;
- billing/subscription cron restore;
- `recordRateLimit`;
- `adminAlerts.notify` restore;
- code deploy/codegen.

Do not continue from `16 -> 32` under this runbook. That is a separate capacity change with a different token-refresh burst and its own canary.
