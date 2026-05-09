# Storage Cleanup V2 - Bulk Drain And Physical Reclaim Plan - 2026-05-09

Status: **draft spec / runbook**. No runtime action executed by this document.

This plan starts after the clean `maxRuns=8` emergency closure:

- Closure: `memory/storage-cleanup-v2-emergency-maxRuns8-closure-2026-05-09.md`
- Commit: `4e886fe docs(storage-cleanup): close emergency maxRuns=8 cleanup run`
- Latest clean run: `runId=1778299225930-4f57ec67d364`
- Params: `batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=8`
- Result: `batchesRun=8`, `deletedCount=4000`, `durationMs=656268`, `pg_wal_delta=0`,
  env restored to `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`

## Executive Decision

The current Storage Cleanup V2 chain is proven safe through an 8-chunk run, but it is
not sized for backlog drainage.

The next work must split into two independent tracks:

1. **Logical bulk drain**: delete old `metricsRealtime` Convex documents through the
   V2 application path, with larger throughput but still bounded by app-level guards.
2. **Physical Postgres reclaim**: after logical backlog is materially lower, reclaim or
   reuse PostgreSQL storage with `VACUUM`, `pg_repack`, `VACUUM FULL`, or reindexing.

These tracks are related but not interchangeable. Deleting Convex rows reduces logical
backlog and future pressure. It does not guarantee immediate GB returned to the OS.

## Hard Guardrails

- Do not run any command from this document without explicit operator go.
- Do not set `METRICS_REALTIME_CLEANUP_V2_ENABLED=1` without explicit go.
- Do not manually call `triggerMassCleanupV2` without explicit go.
- Do not deploy while the working tree is dirty unless the deploy scope is explicitly
  reviewed. `npx convex deploy` deploys the working tree, not just committed files.
- Do not direct-SQL delete from Convex storage tables (`documents`, `indexes`,
  `_scheduled_jobs`, or related tables). That can break Convex MVCC and index invariants.
- Native SQL / range-delete from Convex storage is **out of scope** of this plan. Treat
  as research-only; not authorized unless a separate future doc proves Convex storage
  invariants (MVCC, index consistency, retention/audit, backup/restore) are preserved.
- Do not combine more than one load dimension in one ramp. Change only one of:
  `batchSize`, `maxRuns`, `restMs`, or cadence.
- Always restore `METRICS_REALTIME_CLEANUP_V2_ENABLED=0` in a finally-style step after
  any controlled cleanup unless there is a separate explicit go for continued cron.
- Docker stdout cleanup markers are informational only. Authoritative proof remains
  `cleanupRunState` plus `_scheduled_functions`.

## Current Facts

### Production storage anchors

Latest known post-run anchors from the maxRuns=8 closure:

```text
disk:       /dev/sda1 315G total, 161G used, 142G free, 54%
DB size:    143 GB
pg_wal:     1,493,172,224 bytes
/version:   HTTP 200
cleanup env: METRICS_REALTIME_CLEANUP_V2_ENABLED=0
active cleanupRunState: none
```

These numbers mean the server was not in immediate disk exhaustion at the time of the
closure, but the historical growth rate still requires a real drain and reclaim plan.

### Backlog signals

Known count anchors:

```text
2026-05-07 storage report:
  metricsRealtime live Convex rows: 9,629,187
  documents rows for metricsRealtime in PG: 24,859,204
  indexes rows for metricsRealtime: ~50,173,940

2026-05-08 Phase 5 preflight:
  metricsRealtime eligible: 9,089,514 at cutoff 2026-05-06T06:00:09Z

2026-05-09 maxRuns=8 emergency run:
  deletedCount: 4,000
  oldestRemainingTimestamp advanced: +4m 18.864s
```

Interpretation:

- The V2 chain can safely delete old `metricsRealtime` rows.
- Current bounded profiles delete thousands of rows per run, while the backlog is in the
  millions.
- `oldestRemainingTimestamp` still points to 2026-05-02, while the 48h retention cutoff
  during the emergency run was 2026-05-07. There are multiple days of old source-time
  still below the retention boundary.

## Why Current Profiles Are Too Small

Observed profile:

```text
batchSize=500
maxRuns=8
restMs=90000
timeBudgetMs=10000
deleted per run = 4,000
duration = 656,268 ms ~= 10.94 min
```

If run continuously by an operator, the upper-bound throughput is about:

```text
4,000 rows / 10.94 min ~= 21,900 rows/hour ~= 525,000 rows/day
```

That is better than the cron proof profile, but it still needs many days for a
multi-million-row backlog and requires constant operator supervision.

The Phase 6 cron proof profile is much smaller:

```text
batchSize=500
maxRuns=5
cadence=0 */6 * * *
2,500 rows/tick * 4 ticks/day = 10,000 rows/day
```

That profile is only an organic cron proof. It is not a drainage profile.

## Bulk Drain Strategy

### Goal

Bring `metricsRealtime` back near its intended 48h retention envelope without breaking
Convex invariants or starving sync/UZ/token jobs.

Operational target:

```text
Phase target: oldestRemainingTimestamp reaches within 48h retention cutoff.
Practical target: oldestRemainingTimestamp advances by hours per day, not minutes per run.
Safety target: no V2 failures, no V1 path growth, no WAL spike, no heartbeat regression.
```

### Non-goals

- Do not clean `metricsDaily` in the same runtime phase.
- Do not clean `vkApiLimits` in the same runtime phase.
- Do not shrink PostgreSQL files in the same go.
- Do not change Convex `DOCUMENT_RETENTION_DELAY` in the same go.
- Do not use direct SQL deletes.

### Phase BD-0 - Baseline Only

Before any bulk-drain runtime go, capture fresh anchors:

```text
/version x3
METRICS_REALTIME_CLEANUP_V2_ENABLED
cleanupRunState latest rows and active-row absence
_scheduled_functions in-flight rows for cleanupOldRealtimeMetricsV2 and manualMassCleanupV2
pg_wal size
df -h /
pg_database_size('adpilot_prod')
oldestRemainingTimestamp fresh if possible
core heartbeats: syncDispatch, uzBudgetDispatch, tokenRefreshDispatch
token health
rollback patterns in backend logs
```

Exact eligible count is useful but not mandatory before each small controlled run. For a
bulk-drain phase change, prefer one fresh exact count or a documented SQL/page-count
baseline, because the goal is no longer only safety proof.

### Phase BD-1 - Repeat Clean maxRuns=8 Once

Purpose: establish repeatability after the emergency run and prove no one-off luck.

Profile:

```text
batchSize=500
timeBudgetMs=10000
restMs=90000
maxRuns=8
expected delete: <= 4,000
expected duration: ~11 min
```

Pass gates:

- `cleanupRunState.state=completed`
- `isActive=false`
- `error` absent
- `batchesRun=8`
- `deletedCount > 0`
- `_scheduled_functions`: 8 distinct `manualMassCleanupV2` success, 0 failed
- V1 `manualMassCleanup` delta 0
- `pg_wal` below 25 MB warn / 150 MB hard threshold, adjusted for current baseline
- `/version` still HTTP 200
- core heartbeats no new regression
- env restored to 0

If BD-1 is dirty, stop and write a closure. Do not ramp.

### Phase BD-2 - Increase batchSize Only

Purpose: increase actual rows per chunk while leaving chain length and rest unchanged.

Candidate profile:

```text
batchSize=1000
timeBudgetMs=10000
restMs=90000
maxRuns=8
expected delete: <= 8,000
expected duration: ~11-13 min
changed dimension: batchSize only
```

Why this first:

- `maxRuns=8` already proved the 8-link chain.
- Increasing `batchSize` attacks the actual throughput bottleneck.
- Keeping `restMs=90000` preserves the known quiet spacing between chunks.

Pass gates:

- Same as BD-1, but expected `deletedCount <= 8000`.
- Per-chunk action time must remain comfortably below `timeBudgetMs=10000`.
- If any chunk starts approaching the time budget, do not increase batch again.

If clean, repeat the same profile once before moving to BD-3.

### Phase BD-3 - Decrease restMs Only

Purpose: increase hourly drain rate by reducing idle time after the larger batch is
proven.

Candidate profile:

```text
batchSize=1000
timeBudgetMs=10000
restMs=60000
maxRuns=8
expected delete: <= 8,000
expected duration: ~8-9 min
changed dimension: restMs only
```

Pass gates:

- No WAL spike.
- No V8 concurrency errors.
- No sync/UZ/token heartbeat regression.
- No active-row overlap if repeated or cron-driven.

If clean, this profile can drain on the order of:

```text
8,000 rows / ~8.5 min ~= 56,000 rows/hour ~= 1.3M rows/day if continuously scheduled
```

That is finally in the range where a multi-million-row backlog can be drained in days
rather than months, assuming density and ingest stay within the observed envelope.

### Phase BD-4 - Scheduling Model

After BD-3 is clean, choose exactly one scheduling model.

Option A: supervised manual waves

```text
operator gives go per wave
env 1 -> trigger -> wait terminal -> env 0 -> verify -> closure
```

Pros: safest attribution.  
Cons: slow human loop.

Option B: temporary drain cron / organic repeated profile

```text
keep cleanup-old-realtime-metrics on V2 wrapper
use env gate
cadence chosen so profile duration < cadence
active-row guard handles overlap by no-op
```

**Deploy boundary**: BD-4 Option B requires a code change to the cron arguments at
`convex/crons.ts:219` (current cron profile is `batchSize=500, timeBudgetMs=10_000,
restMs=90_000, maxRuns=5`) plus a `npx convex deploy`. Treat as a separate phase
boundary; approval for Option A (supervised manual waves) does not authorize Option B.
Deploy must be reviewed against the working tree state — `npx convex deploy` deploys
the working tree, not just committed files.

Initial candidate only after BD-3 clean:

```text
batchSize=1000
timeBudgetMs=10000
restMs=60000
maxRuns=8
cadence=15 min
expected scheduled drain ~= 32,000 rows/hour ~= 768,000 rows/day
```

**Chain-duration gate** (must hold before enabling BD-4 Option B):

- Observed BD-3 **full chain duration** must consistently land below `0.6 × intended
  cadence` across the previous controlled runs (e.g. < 9 min total chain for
  cadence=15 min). This protects cycle slack — the active-row guard prevents double
  execution, but a chain that approaches the cadence will drift and accumulate
  end-to-end latency cycle over cycle.
- Per-chunk action time is a **separate** gate: each chunk must remain comfortably
  below `timeBudgetMs` (10s). Per-chunk variance and chain-duration variance are
  independent; check both.
- If observed BD-3 chain duration regularly exceeds 0.6 × cadence, do **not** enable
  BD-4 Option B. Either lengthen cadence or stay on Option A.

**UZ reset overlap** (must verify before enabling BD-4 Option B):

- UZ budget reset cron runs every 5 minutes (see `convex/uzBudgetCron.ts`). A 15-min
  cleanup cadence intersects roughly every third UZ tick.
- The cleanup chain holds an active V2 worker for the full chain duration; UZ reset
  is short-lived but can spike V8 concurrency at the boundary.
- Before enabling BD-4 Option B: observe an env=0 wrapper tick at the intended
  cadence offset (the wrapper logs the disabled-env path and exits without
  triggering the chain) and inspect `_scheduled_functions` for any concurrent
  UZ-tick V8 saturation in that window. Do **not** manually invoke the wrapper
  without explicit go — the wrapper is **not** a true dry-run; if env is `1` it
  will start a real chain.
- If observed concurrency contention or V8 saturation appears, shift the cleanup
  cron offset so it lands between UZ ticks (UZ runs at minutes `0,5,10,…,55`).
  Use an explicit minute list, e.g. `2,17,32,47 * * * *` (every 15 min, offset by
  2 min). Equivalent step-form: `2-59/15 * * * *`. Do **not** write `2 */15 * * *`
  — that means "minute 2 of hour 0 and 15", not "every 15 min offset by 2".
  Do not raise `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` for this.

**Active-row guard definition**:

- Source: `triggerMassCleanupV2` (in `convex/metrics.ts`), invoked by the wrapper
  `cleanupOldRealtimeMetricsV2`. The active-row check lives in the trigger, not in
  the wrapper. The wrapper only enforces the env gate; once env=1, it calls the
  trigger, and the trigger is what consults `cleanupRunState`.
- Behaviour: before scheduling a new chain, the trigger checks `cleanupRunState`
  for any row with `isActive=true`. If present, the trigger returns a no-op result
  and writes **no** new state. No partial chain is created, no `deletedCount` is
  incremented, no `_scheduled_functions` entry is queued for follow-up batches.
- Implication for BD-4 Option B: if a previous chain stalls past its expected
  window, the next cron tick is silently absorbed by the guard. The operator must
  monitor `cleanupRunState` for stuck `isActive=true` rows; the cron alone will
  not surface them.

Do not jump straight to 5 min cadence. Do not combine cadence tightening with a new
batch or maxRuns increase.

Option C: dedicated bulk-drain entrypoint

Only if the V2 chain's rest/action model is insufficient. This is a code-design phase,
not a parameter change. It needs:

- new runbook;
- new tests;
- separate deployment;
- explicit active-row guard;
- WAL-aware pacing;
- closure template;
- rollback plan.

### Phase BD-5 - Stop Conditions

Stop bulk drain immediately and set env to 0 if any of these occur:

- `cleanupRunState.state=failed`
- `cleanupRunState` stuck active beyond expected window + `restMs + 30s`
- V2 `_scheduled_functions` failed count > 0
- V1 `manualMassCleanup` scheduled or failed delta > 0
- `pg_wal` exceeds the hard threshold
- `/version` starts returning non-200 or repeated latency outliers
- sync/UZ/token heartbeats regress from pre-run baseline
- V8 concurrency errors appear
- env cannot be returned to 0

Write a dirty closure before attempting any further drain.

## Physical Reclaim Strategy

### Core Principle

Logical cleanup and physical storage reclaim are separate.

Deleting Convex documents:

- reduces live logical backlog;
- can stop or slow growth;
- creates dead tuples and reusable internal free space after vacuum;
- does not necessarily shrink `pg_database_size` or OS disk usage immediately.

Returning GB to the OS requires relation rewrite or online repack.

### PR-0 - Do Not Reclaim Too Early

Do not run `VACUUM FULL` or `pg_repack` before logical cleanup has materially reduced the
target live set. Rewriting a still-bloated-but-still-live `indexes` table wastes the
maintenance window and may need to be repeated.

Minimum before physical shrink:

```text
metricsRealtime oldestRemainingTimestamp is near retention cutoff
or metricsRealtime live count is materially lower than the 2026-05-07 9.63M baseline
and no active bulk-drain chain is running
and /version is stable
and core heartbeats are clean
```

### PR-1 - Online VACUUM ANALYZE

Purpose: update stats and make dead tuples reusable inside PostgreSQL files.

Effect:

- online;
- does not return file space to OS;
- can reduce future file growth;
- updates stale stats, especially important for `indexes`;
- can create IO pressure, so avoid active cleanup windows.

Candidate commands for a future explicit go:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker exec adpilot-postgres psql -U convex -d adpilot_prod -c "
VACUUM (ANALYZE, VERBOSE) documents;
VACUUM (ANALYZE, VERBOSE) indexes;
"'
```

Run only after checking active DB queries and current storage anchors.

Pass gates:

- `/version` remains HTTP 200.
- No long blocking query pile-up.
- `pg_stat_user_tables.last_vacuum` or `last_autovacuum` updates.
- no disk/WAL surprise beyond available headroom.

### PR-2 - Measure Reclaim Potential

Before choosing `pg_repack` or `VACUUM FULL`, capture:

```sql
SELECT pg_size_pretty(pg_database_size('adpilot_prod')), pg_database_size('adpilot_prod');

SELECT relname,
       pg_size_pretty(pg_total_relation_size(relid)) AS total,
       pg_size_pretty(pg_relation_size(relid)) AS heap,
       n_live_tup,
       n_dead_tup,
       last_vacuum,
       last_autovacuum,
       last_analyze,
       last_autoanalyze
FROM pg_stat_user_tables
WHERE relname IN ('documents','indexes')
ORDER BY pg_total_relation_size(relid) DESC;
```

If `pgstattuple` is installed, use it for better bloat estimates. If not installed, do
not install extensions during an incident without a separate go.

### PR-3 - Prefer pg_repack If Available

Purpose: rewrite bloated relations with minimal lock time.

Pre-check (run all three; need all three to authorize PR-3):

```bash
# 1) Is the binary present in the Postgres container?
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker exec adpilot-postgres which pg_repack'

# 2) What binary version is installed?
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker exec adpilot-postgres pg_repack --version'

# 3) What is the running Postgres server version, and is the extension loaded?
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker exec adpilot-postgres psql -U convex -d adpilot_prod -c "
SHOW server_version;
SELECT extname, extversion FROM pg_extension WHERE extname = '\''pg_repack'\'';
"'
```

All three must succeed. The binary version (step 2) and the extension version
(step 3) **must match** — `pg_repack` requires the client binary and the
server-side extension to be on the same major version. The server version (step 3)
plus binary major version determines which `pg_repack` line is compatible.

Compatibility rule:

- `pg_repack` must be major-version-compatible with the running Postgres
  (PG 16.x ↔ `pg_repack >= 1.5`). Mismatch = silent corruption risk.
- If the extension is missing, **do not install during an incident** — extension
  install is a separate go and a separate runbook (requires server-side package
  install + `CREATE EXTENSION`).
- If the extension is installed but version is below `1.5` on PG 16, treat as
  unavailable for this plan; fall back to `VACUUM FULL` in a maintenance window
  (PR-4) or to `REINDEX CONCURRENTLY` (PR-5) for index-dominated bloat.

If `pg_repack` is installed at a compatible version and free space is sufficient:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker exec adpilot-postgres pg_repack -U convex -d adpilot_prod -t documents'

ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker exec adpilot-postgres pg_repack -U convex -d adpilot_prod -t indexes'
```

Order:

1. `documents`
2. `indexes`

Reason: `documents` is smaller and proves the maintenance path before touching the
larger `indexes` relation.

Headroom rule:

```text
free_disk_bytes >= target_relation_total_size * 1.3 + pg_wal_hard_stop + 20GB safety
```

For the **2026-05-07 snapshot** (stale — see re-snapshot rule below):

```text
documents total ~= 50GB  -> 142GB free was comfortable on 2026-05-07
indexes total   ~= 93GB  -> 142GB free was possible but tight on 2026-05-07
```

**Re-snapshot rule** (mandatory before any PR-3 step):

- The 2026-05-07 figures above are **stale** for any decision after that date.
  `documents`, `indexes`, free disk, and `pg_database_size` all drift daily.
- Before any PR-3 go (for either `documents` **or** `indexes`), re-run the PR-2
  snapshot query in this session and use the fresh numbers in the headroom rule.
- Do **not** act on the 2026-05-07 anchor alone — neither for `documents` nor for
  `indexes`. The 2026-05-07 numbers are kept here as a historical reference, not
  as input to a runtime decision.
- Document the fresh PR-2 snapshot in the PR-3 closure, alongside the headroom
  computation that authorized the run.

Do not run `pg_repack indexes` if free space has fallen materially below the
fresh PR-2 anchor used to authorize the step.

#### While `pg_repack` runs

`pg_repack` on a 50–93 GB relation can run for hours. Active monitoring is required —
this is an online operation, but it generates significant WAL and competes for IO.

- **Active queries / locks** (every ~1 min):
  ```sql
  SELECT pid, state, wait_event_type, wait_event,
         now() - xact_start AS xact_age, query
  FROM pg_stat_activity
  WHERE state != 'idle' AND backend_type = 'client backend'
  ORDER BY xact_age DESC NULLS LAST;
  ```
  Watch for: long-blocking client backends, lock waits beyond a few minutes,
  pile-up of identical queries.
- **`/version` health** (every ~30 s): expect HTTP 200, latency stable. Repeated
  non-200 or latency outliers ≥ 3× baseline = abort signal.
- **`pg_wal` size** (every ~2 min): `pg_repack` shovels WAL during the rewrite.
  Expect growth, but cap by hard threshold (current `pg_wal` baseline ~1.5 GB —
  hard stop if `pg_wal > baseline + 5 GB` without obvious progress).
- **Disk free**: must not drop below `target_relation_total_size * 1.3 + 20 GB`
  during the operation (running out mid-rewrite leaves the relation in a recoverable
  but messy state).
- **Convex backend**: V8 concurrency baseline and memory should not regress.
  `_scheduled_functions` failed delta = 0 across the window.
- **Heartbeats**: `syncDispatch`, `uzBudgetDispatch`, `tokenRefreshDispatch` must
  not flip to STUCK during the operation.

If any of the above regresses materially, abort `pg_repack` with `SIGINT` (graceful)
or `SIGTERM` (less graceful — leaves trigger/temp table cleanup to `pg_repack
--check` / next manual run). Do not `kill -9` the `pg_repack` process. After abort,
re-baseline and decide between retry, fall-back to PR-4 maintenance window, or
defer.

### PR-4 - VACUUM FULL Only In Maintenance Window

Use only if `pg_repack` is unavailable or fails and the operator accepts downtime.

Risks:

- `ACCESS EXCLUSIVE` lock on the table;
- Convex backend can hang or timeout;
- `/version` and frontend may be impacted;
- needs extra disk for rewrite;
- must be scheduled in a low-traffic window.

Candidate SQL for a future explicit go:

```sql
VACUUM FULL documents;
VACUUM FULL indexes;
```

Do not run this from an interactive production session without:

- user-facing maintenance decision;
- fresh disk headroom check;
- rollback/communication plan;
- active query check;
- known maximum acceptable downtime.

### PR-5 - REINDEX CONCURRENTLY

Use when index bloat remains high after logical cleanup and vacuum, or when relation
size is dominated by indexes and `pg_repack` is unavailable.

Candidate order from the 2026-05-04/07 reports:

```text
documents_pkey
documents_by_table_and_id
documents_by_table_ts_and_id
indexes_pkey
indexes_by_index_id_key_prefix_key_sha256
```

Run one index at a time, with fresh disk/WAL anchors between each. `REINDEX CONCURRENTLY`
is lower-lock than plain `REINDEX`, but it still consumes disk and IO.

## Recommended Sequence From Here

### Next doc/runtime decision

Recommended next work item:

```text
BD-0 baseline -> BD-1 repeat maxRuns=8 -> closure
```

This is the smallest runtime continuation and gives a second clean maxRuns=8 point.
It still will not materially drain the backlog.

If the operator wants actual drainage today, the more useful next phase is:

```text
BD-0 baseline -> BD-2 batchSize=1000 controlled run -> closure
```

This crosses a parameter boundary and needs explicit go, but it is the first profile
that starts to move toward practical drain rates.

### Physical reclaim should wait

Do not start `pg_repack` / `VACUUM FULL` before logical cleanup meaningfully reduces the
`metricsRealtime` live/index footprint. If disk pressure becomes immediate, the safer
emergency physical action is usually:

```text
VACUUM (ANALYZE, VERBOSE) documents;
VACUUM (ANALYZE, VERBOSE) indexes;
```

That stabilizes/reuses space but does not shrink files. It is not a substitute for
logical drain.

## Closure Template For Bulk Drain Runs

For each BD runtime run, write:

```text
memory/storage-cleanup-v2-bulk-drain-closure-<date>-<profile>.md
```

Minimum fields:

```text
Status: clean/dirty
Profile: batchSize=<n>, timeBudgetMs=<n>, restMs=<n>, maxRuns=<n>, cadence/manual=<...>
runId: <id>
startedAt: <ISO>
durationMs: <n>
batchesRun: <n>
deletedCount: <n>
oldestRemainingTimestamp pre/post
cutoffUsed
pg_wal pre/post/delta
disk pre/post
DB size pre/post
_scheduled_functions V2 distinct/success/failed
V1 manualMassCleanup delta
cleanupRunState final row
core heartbeats pre/post
env final state
decision
next allowed ramp
```

The closure must state whether the run is:

- safety proof only;
- meaningful drain;
- physical reclaim preparation;
- **dirty** (the run failed any pass gate or hit any stop condition from BD-5).

If the run is **dirty**, the closure must include a dedicated `Investigate next:`
section listing concrete checks and data points to acquire before any further runtime
action. Minimum content for `Investigate next:`:

- which gate / stop condition failed and the exact observed value;
- `cleanupRunState` final row (or absence) and any active-row state;
- `_scheduled_functions` rows over the run window (V2 success/failed, V1 entries);
- `pg_wal` / disk / DB size deltas attributable to the run;
- backend logs grep for rollback / `[cleanup-v2] end failed` / TOKEN_EXPIRED /
  V8 concurrency error patterns;
- core heartbeats state at run end;
- env final state (must be `0`; if not, that is itself a follow-up);
- proposed minimum next step (always non-runtime first: re-baseline, code read,
  diagnostic-only — no automatic re-trigger after a dirty run).

A dirty closure forbids further BD-* runs at the same or higher profile until the
investigate-next items have a written answer.

## Open Questions

- What target drain window is acceptable: 24h, 3 days, 7 days, or "stabilize only"?
- Is a temporary 15-minute cleanup cadence acceptable if active-row guard prevents
  overlap?
- Should `metricsDaily` cleanup be restored/tuned before or after `metricsRealtime`
  bulk drain?
- Should `vkApiLimits` cleanup be tuned in parallel, given its smaller but chronic
  backlog?
- Is `pg_repack` installed and usable inside the current Postgres container?
- What maintenance window is acceptable if `VACUUM FULL` becomes necessary?
- Should `metricsRealtime` be partitioned by day (or by retention bucket) to enable
  `DROP PARTITION` as a future drain mechanism? Tracked as follow-up; not in scope of
  this plan, separate design doc required.

## Current Recommended Answer To "What Next?"

If the user asks for the safest next step:

```text
Run BD-0 baseline only, then choose BD-1 or BD-2.
```

If the user asks for real drainage:

```text
Go BD-2 controlled run: batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=8.
```

If the user asks for physical disk shrink:

```text
First finish logical drain or at least materially lower metricsRealtime; then run
PR-1 VACUUM ANALYZE; then evaluate pg_repack vs VACUUM FULL with fresh headroom.
```

None of those actions is authorized by this document alone.
