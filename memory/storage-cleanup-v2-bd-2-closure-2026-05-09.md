# Storage Cleanup V2 - BD-2 Closure - 2026-05-09

Status: **clean with caveat** - `batchSize=1000` completed successfully and
env was restored to `0`. The caveat is throughput headroom: average action time
rose to ~7.22s per chunk against `timeBudgetMs=10s`, so the next safe move is
to repeat this same profile once before any BD-3 rest/cadence change.

This closes BD-2 from
`memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`.

## Summary

- Profile: `batchSize=1000, timeBudgetMs=10_000, restMs=90_000, maxRuns=8`.
- Changed dimension vs BD-1: `batchSize` only (`500 -> 1000`).
- runId: `1778313396812-f2ebc0566fba`.
- Trigger time: 2026-05-09T07:56:36.812Z.
- Completion: 2026-05-09T08:08:04.542Z.
- durationMs: 687,745 (11:27.745).
- batchesRun: 8 (== maxRuns).
- deletedCount: 8,000 (== batchSize x batchesRun).
- env restored: `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`, verified after terminal row.

## Preconditions

Previous closures referenced:

- Emergency `maxRuns=8`: `memory/storage-cleanup-v2-emergency-maxRuns8-closure-2026-05-09.md`
  (commit `4e886fe`).
- Phase 6 Gate B: `memory/storage-cleanup-v2-phase6-gate-b-closure-2026-05-09.md`
  (commit `1074adf`).
- BD-1 repeat `maxRuns=8`: `memory/storage-cleanup-v2-bd-1-closure-2026-05-09.md`
  (commit `71ceb87`).
- Cleanup follow-up notes: commit `a65d43b`.

At trigger time:

- HEAD == origin == `a65d43b`.
- No deploy or code change by this run.
- No active `cleanupRunState` row.
- `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`.

## Operator / Agent Trace

State-changing runtime steps were performed only after explicit operator go.

| Time (UTC) | Actor | Action | Result |
|---|---|---|---|
| 07:51:20 | agent | BD-0-lite preflight: `/version`, env, `cleanupRunState`, SSH anchors, health, logs | pass with known pre-existing heartbeat/token caveats |
| ~07:56 | agent | `npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1` | success; env verified `1` |
| 07:56:36 | agent | `npx convex run internal.metrics.triggerMassCleanupV2 {"batchSize":1000,"timeBudgetMs":10000,"restMs":90000,"maxRuns":8}` | `{ runId: "1778313396812-f2ebc0566fba", status: "scheduled" }` |
| 07:58:15 | agent | poll `cleanupRunState` | running, `batchesRun=1`, `deletedCount=1000` |
| 08:01:45 | agent | poll `cleanupRunState` | running, `batchesRun=4`, `deletedCount=4000` |
| 08:08:04 | system | final batch completed | terminal row written |
| ~08:08 | agent | env set back to `0` | success; env verified `0` |
| post-run | agent | `/version`, disk/WAL/DB, logs, health, `_scheduled_functions` | anchors below |

## Anchors

| Anchor | Pre | Post | Delta | Threshold | Verdict |
|---|---:|---:|---:|---|---|
| `/version` (x3) | HTTP 200, 1.737 / 1.404 / 1.463 s | HTTP 200, 2.000 / 1.349 / 1.913 s | stable | HTTP 200 | PASS |
| `pg_wal` | 1,342,177,280 b | 1,342,177,280 b | 0 | warn +25 MiB / hard +150 MiB | PASS |
| `/dev/sda1` usage | 54%, used 161G / 315G, free 142G | 54%, used 161G / 315G, free 142G | 0 | informational | PASS |
| DB total size | 153,435,374,051 b (143 GB) | 153,435,406,819 b (143 GB) | +32,768 b | informational | PASS |
| `cleanupRunState` | no active row | terminal row, `isActive=false` | n/a | terminal | PASS |
| `oldestRemainingTimestamp` | 1,777,733,996,443 | 1,777,734,130,010 | +133,567 ms | post >= pre | PASS |
| env | `0` | `0` | restored | must be `0` after run | PASS |

The DB-size byte delta is 32 KiB and does not change the 143 GB rounded value.
Physical disk reclaim remains a separate PostgreSQL track.

## cleanupRunState Final Row

```text
_id                                 r173z8recy7byp021cr1b8x5w586cerv
_creationTime                       1778313396811.9697   (2026-05-09T07:56:36.812Z)
batchSize                           1000
batchesRun                          8
cleanupName                         "metrics-realtime-v2"
cutoffUsed                          1778140596812       (2026-05-07T07:56:36.812Z)
deletedCount                        8000
durationMs                          687745              (11:27.745)
isActive                            false
lastBatchAt                         1778314084542       (2026-05-09T08:08:04.542Z)
maxRuns                             8
oldestRemainingTimestamp            1777734130010       (2026-05-02T15:02:10.010Z)
restMs                              90000
runId                               "1778313396812-f2ebc0566fba"
startedAt                           1778313396812       (2026-05-09T07:56:36.812Z)
state                               "completed"
timeBudgetMs                        10000
error                               (absent)
```

### Per-chunk math

- 7 inter-chunk rests x 90,000 ms = 630,000 ms.
- Average action time: `(687,745 - 630,000) / 8 = 7,218.125 ms`.
- Headroom vs `timeBudgetMs=10,000`: ~2.78s average, ~28%.

This passes BD-2, but the jump from BD-1 is real:

| Run | Profile | Duration | Per-chunk action avg |
|---|---|---:|---:|
| BD-1 | `batchSize=500, maxRuns=8` | 658,064 ms | 3,508.0 ms |
| **BD-2** | **`batchSize=1000, maxRuns=8`** | **687,745 ms** | **7,218.1 ms** |

Verdict: `batchSize=1000` is acceptable, but do **not** increase batch size
again until the same profile has repeated cleanly and per-chunk timing remains
comfortably under budget.

### Per-chunk action times (from `_scheduled_functions`)

Each chunk's `action_ms = completedTime - scheduledTime` for the 8 V2 entries
matching this `runId`:

| Chunk | scheduledTime (ms) | completedTime (ms) | action_ms | action_s |
|---:|---:|---:|---:|---:|
| 1 | 1778313396812 | 1778313403298 | 6,486 | 6.487 |
| 2 | 1778313493288 | 1778313500630 | 7,342 | 7.343 |
| 3 | 1778313590621 | 1778313597954 | 7,333 | 7.333 |
| 4 | 1778313687943 | 1778313694836 | 6,893 | 6.894 |
| 5 | 1778313784829 | 1778313792578 | 7,749 | 7.750 |
| 6 | 1778313882571 | 1778313890860 | **8,289** | **8.290** |
| 7 | 1778313980852 | 1778313987624 | 6,772 | 6.772 |
| 8 | 1778314077616 | 1778314085788 | 8,172 | 8.172 |

Statistics:

- min: 6.487 s
- **max: 8.290 s (chunk 6)**
- avg (Σ action_ms / 8): 7.380 s
- total active: 59.041 s
- max-chunk headroom vs `timeBudgetMs=10s`: **1.710 s (17.1% reserve)**

The avg from this method (7.380 s) is ~160 ms per chunk higher than the
duration-based avg (7.218 s) reported above. The delta reflects scheduling /
queueing latency between `restMs` end and the next action's actual start —
small but worth noting.

`max=8.290 s` is **below the 8.5 s soft warning** raised in the BD-1
follow-up review, but only by 210 ms. Treat as a yellow signal: the same
profile under slightly different slice density (denser packing, lock
contention, V8 saturation) could push max past 8.5 s without changing the
profile inputs.

### Watch flags for BD-2 repeat

Apply these as hard-stop signals before promoting BD-3:

| Signal | Threshold | Action |
|---|---|---|
| max chunk action time | > 8.5 s | hold BD-3; document in repeat closure as "near-budget" |
| `durationMs` | > 745,000 ms (~12:25) | hold BD-3; investigate variance source |
| V2 failed entries | > 0 | dirty closure, hold BD-3 |
| heartbeat alarm not matching attribution rule | any | dirty / investigate before further runs |
| `pg_wal` growth | > 25 MiB above pre-run baseline | post-run audit before BD-3 decision |
| heartbeat STUCK (other than legacy `cleanup-realtime`) | any | dirty |

Recommended pre-flight gate values (BD-0-lite):

- `/version` × 3 = HTTP 200, latency stable.
- env `METRICS_REALTIME_CLEANUP_V2_ENABLED = 0`.
- no active `cleanupRunState` row.
- `pg_wal` ≤ post-BD-2 baseline + 25 MiB (i.e. ≤ 1,367 MiB ≈ 1,432,820,224 b).
- `_scheduled_functions`: 0 V2 failed since BD-2.
- backend stdout last 15 min: 0 rollback / 0 TOKEN_EXPIRED / 0 concurrent / 0 cleanup-end-failed.
- heartbeat alarms classified using the BD-1 alarm-attribution rule.

If repeat BD-2 lands clean **and** max chunk stays ≤ 8.5 s **and** total
durationMs stays ≤ ~745 s, BD-3 (`restMs 90 → 60`) is unblocked. BD-3 changes
only the inter-chunk rest, **not** action time, so it does not consume
additional per-chunk budget — but it does shorten cycle time, which matters
for the eventual BD-4 cron decision.

### Eligible delta cutoff alignment

- `cleanupRunState.cutoffUsed`: 1,778,140,596,812.
- `startedAt - cutoffUsed = 172,800,000 ms` (exactly 48h).
- Structural proof: `deletedCount=8000 == batchSize x batchesRun`.
- No fresh exact eligible-count scan was run; structural proof is sufficient
  for this controlled BD-2 run.

## Scheduled Functions

Sourced from `npx convex data _scheduled_functions --limit 120 --format jsonArray`.

| UDF | This runId | Success | Failed | Verdict |
|---|---:|---:|---:|---|
| `metrics.js:manualMassCleanupV2` | 8 distinct rows | 8 | 0 | PASS |
| `metrics.js:manualMassCleanup` (V1) | 0 observed in sample | n/a | 0 | PASS |

All 8 V2 rows reference `runId: "1778313396812-f2ebc0566fba"` and have
`state.kind="success"`.

## Backend Stdout

Verified via `docker logs --since 30m adpilot-convex-backend` grep:

| Pattern class | Count | Verdict |
|---|---:|---|
| `TOKEN_EXPIRED` | 0 | PASS |
| `Too many concurrent` | 0 | PASS |
| `Transient error` | 0 | PASS |
| `rollback` | 0 | PASS |
| `[cleanup-v2] end failed` | 0 | PASS |
| `FATAL` / `panic` / `V8` | 0 | PASS |

Cleanup stdout markers remain informational only; authoritative proof is
`cleanupRunState` + `_scheduled_functions`.

## Health Snapshot

Post-run health checks:

```text
checkCronHeartbeats:
  uz-budget-increase: отстаёт (31 мин)
  cleanup-realtime: STUCK (6613 мин)

checkCronSyncResults:
  sync: 19/202 синхронизированы
  abandoned: 2

checkTokenHealth:
  Анжелика Медведева: VK Ads токен истёк 858ч назад
  Карина Есина: VK Ads истекает через 7ч
  Артём Беляев: VK Ads истекает через 7ч
  Анжелика Медведева: нет refresh token
```

Attribution:

- `cleanup-realtime: STUCK` is the pre-existing legacy V1 heartbeat gap.
- `uz-budget-increase` fits the known 45-minute cron vs 15-minute watcher
  mismatch documented in BD-1 and follow-up notes.
- Sync and token warnings are pre-existing and not caused by BD-2.
- No new cleanup-specific runtime errors were observed.

## Density Note

BD-2 advanced `oldestRemainingTimestamp` by **+133.567 s** while deleting
8,000 rows, local density `~59.9 rows/source-second`.

Comparison:

| Run | Source-time advance | Rows deleted | Local density |
|---|---:|---:|---:|
| Emergency maxRuns=8 | +258.864 s | 4,000 | ~15 rows/s |
| Gate B | +8.855 s | 2,500 | ~282 rows/s |
| BD-1 | +14.863 s | 4,000 | ~269 rows/s |
| **BD-2** | **+133.567 s** | **8,000** | **~60 rows/s** |

Density remains non-linear across backlog slices. Do not use a single slice
to forecast total drain time.

## Decision

**clean with caveat** - BD-2 passed:

- `state=completed`, `isActive=false`, `error` absent.
- `batchesRun=8`, `deletedCount=8000`.
- `manualMassCleanupV2`: 8 success, 0 failed.
- Env restored to `0`.
- `/version` healthy.
- `pg_wal`, disk, and DB size effectively flat.
- Logs clean of rollback / concurrency / fatal / cleanup-failed patterns.
- Heartbeat/token findings are pre-existing or watcher-cadence artifacts.

Caveat:

- Average action time rose to ~7.22s per chunk. That is under budget, but no
  longer low. The next step must be a same-profile repeat, not another
  parameter jump.

## Next Recommendation

Do **not** move directly to BD-3 yet.

Recommended next controlled run:

```text
BD-2 repeat
batchSize=1000
timeBudgetMs=10000
restMs=90000
maxRuns=8
```

Proceed only after a fresh BD-0-lite preflight:

- `/version` x3 HTTP 200.
- env `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`.
- no active `cleanupRunState`.
- `pg_wal`, disk, DB size stable.
- no new V2 failed rows.
- heartbeat alarms classified using the BD-1 alarm-attribution rule.

If BD-2 repeat is clean and per-chunk action time remains below budget, BD-3
can consider reducing `restMs` while keeping `batchSize=1000` fixed.

## Post-run State

- `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`, verified.
- Active cleanup rows: none.
- Phase 6 cron remains active but fail-closed by env.
- HEAD == origin == `a65d43b`; no deploy/code change by this run.
- Working tree had pre-existing unrelated dirty/untracked files; they were not
  touched by the runtime run.
