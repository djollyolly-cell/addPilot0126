# Storage Cleanup V2 - BD-2 Repeat Closure - 2026-05-09

Status: **clean with caveat** — all hard gates passed, but the peak per-chunk
action time was **8.497 s** vs the 8.5 s gate — passing by 3 ms only. BD-3 is
formally unblocked; the razor margin is documented as a caveat for any
parameter change beyond BD-3.

This closes the BD-2 repeat from the bulk-drain phase ladder per
`memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`.

## Caveat

> Max-chunk action time 8.497 s passed the 8.5 s hard gate by 3 ms.
> Compared to the first BD-2 run (max 8.290 s), the peak grew **+207 ms**
> while avg dropped slightly (−89 ms). Variance across the eight chunks
> widened (range 6.727–8.497 s vs first BD-2 6.487–8.290 s). BD-3
> (`restMs 90 → 60`) does **not** add per-chunk pressure, so the gate
> remains satisfied for the BD-3 transition. **Any future parameter
> change that does add per-chunk pressure (batchSize > 1000) must
> consider the +207 ms drift on max** before being scheduled.

## Summary

- Profile: `batchSize=1000, timeBudgetMs=10_000, restMs=90_000, maxRuns=8`
  (unchanged from BD-2; this is the repeatability proof on the same profile).
- runId: `1778315592229-0ece8cbe741f`.
- Trigger time: 2026-05-09T08:33:12.229Z (manual via
  `metrics:triggerMassCleanupV2`, after agent env-set 1 at 08:33:05Z).
- Completion: 2026-05-09T08:44:38.760Z. durationMs = 686,545 (11:26.545).
- batchesRun: 8 (== maxRuns), deletedCount: 8,000 (== batchSize × batchesRun).
- env restored: `0` at 2026-05-09T08:44:45Z, verified `0` immediately after.
- Repeatability vs first BD-2 (`1778313396812-f2ebc0566fba`, durationMs
  687,745): **ΔdurationMs = −1,200 ms (−0.17%)**. Total chain duration is
  effectively identical.

## Preconditions

Previous closures referenced:

- BD-2 first run: `memory/storage-cleanup-v2-bd-2-closure-2026-05-09.md`
  (commit `73abede`).
- BD-1 (`maxRuns=8` repeatability proof): `memory/storage-cleanup-v2-bd-1-closure-2026-05-09.md`
  (commit `71ceb87`).
- Cleanup-track follow-ups (heartbeat watcher mismatches, launchd late-fire,
  etc.): `memory/storage-cleanup-v2-followups-2026-05-09.md` (commit `a65d43b`).

At trigger time (BD-0-lite snapshot, agent-verified 08:29:42Z):

- HEAD == origin == `73abede`.
- `/version` × 3: HTTP 200, 1.39 / 1.52 / 1.43 s.
- `METRICS_REALTIME_CLEANUP_V2_ENABLED = 0`.
- No active `cleanupRunState` row (top 3 historical rows all `isActive=false`).
- `pg_wal` = 1,342,177,280 b (= post-BD-2 baseline, 0 growth).
- disk 54%, free 142G; DB 143 GB; all flat.
- `_scheduled_functions`: 0 V2 failed / 0 inProgress; 0 V1 entries.
- backend stdout last 15 min: 0 rollback / 0 TOKEN_EXPIRED / 0 concurrent /
  0 cleanup-end-failed / 0 FATAL / 0 panic.
- Heartbeat alarms classified via the BD-1 attribution rule: only
  `sync-metrics` 11 min lag (1 min beyond 10-min threshold, ≤6 by rule —
  non-blocker) and pre-existing legacy `cleanup-realtime` STUCK
  (non-blocker). `uz-budget-increase` not flagged (UZ fired within 15 min
  of the snapshot).

All BD-0-lite gates passed.

## Operator / Agent Trace

State-changing steps performed by the agent under explicit operator go
(`go BD-2 repeat`).

| Time (UTC) | Actor | Action | Result |
|---|---|---|---|
| 08:29:42 | agent | BD-0-lite preflight (anchors + heartbeats + scheduled-functions audit) | all gates green; ready |
| **08:33:05** | **agent** | **`npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1`** | success; verified `1` |
| 08:33:10 | agent | `npx convex run metrics:triggerMassCleanupV2 {batchSize:1000, timeBudgetMs:10000, restMs:90000, maxRuns:8}` | `{ runId: "1778315592229-0ece8cbe741f", status: "scheduled" }` |
| 08:34:21 → 08:44:45 | system | 8 batches, 7 inter-chunk rests of 90 s | terminal: `state=completed, batchesRun=8, deletedCount=8000` |
| 08:34:21 → 08:44:45 | agent | poll `cleanupRunState` every 60 s | progress 1→2→3→4→5→6→7→8; final `isActive=false, durationMs=686,545` |
| **08:44:45** | **agent** | **`npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0`** | success; verified `0` |
| 08:46:01 | agent | post-run `/version` × 3 + SSH anchors + stdout + heartbeats + scheduled-functions audit | clean (see Anchors and Hard Gates) |

## Anchors

| Anchor | Pre (BD-0-lite) | Post (08:46:01Z) | Delta | Threshold | Verdict |
|---|---:|---:|---:|---|---|
| `/version` (× 3) | HTTP 200, 1.39 / 1.52 / 1.43 s | HTTP 200, 1.36 / 1.15 / 1.16 s | latency stable, slight improvement | 200 | PASS |
| `pg_wal` (size) | 1,342,177,280 b | 1,342,177,280 b | **0 b (bit-exact)** | warn 25 MiB / hard 150 MiB | PASS |
| `/dev/sda1` usage | 54% (used 161G / 315G, free 142G) | 54%, no change | 0 | informational | PASS |
| DB total size | 143 GB | 143 GB | 0 (rounded) | informational | PASS |
| `cleanupRunState` (this run row) | n/a (no active row pre-trigger) | row written, `state=completed, isActive=false` | n/a | row terminal | PASS |
| `oldestRemainingTimestamp` | 1,777,734,130,010 (post-BD-2, 2026-05-02T15:02:10.010Z) | 1,777,734,308,984 (2026-05-02T15:05:08.984Z) | **+178,974 ms (+178.974 s)** source-time | post >= pre | PASS |
| `metricsRealtime` eligible | not re-counted | not re-counted | structural: `deletedCount=8000 == batchSize × batchesRun` | matches | PASS structural |

`pg_wal` bit-exact zero growth. Stronger than typical (BD-1 saw recycle
−16 MiB; BD-2 saw +0 to recycle of segments). Consistent with workload.

### Eligible delta cutoff alignment

- `cleanupRunState.cutoffUsed`: 1,778,142,792,229 (2026-05-07T08:33:12.229Z).
- `startedAt − cutoffUsed = 172,800,000 ms` (exactly 48h).
- Structural proof: `deletedCount=8000 == batchSize × batchesRun`. PASS.

## cleanupRunState Final Row

```text
_id                                 r17e91dppg69dr5sqb3ey2j4gn86c55z
_creationTime                       1778315592229.6729   (2026-05-09T08:33:12.229Z)
batchSize                           1000
batchesRun                          8
cleanupName                         "metrics-realtime-v2"
cutoffUsed                          1778142792229       (2026-05-07T08:33:12.229Z)
deletedCount                        8000
durationMs                          686545              (11:26.545)
isActive                            false
lastBatchAt                         1778316278760       (2026-05-09T08:44:38.760Z)
maxRuns                             8
oldestRemainingTimestamp            1777734308984       (2026-05-02T15:05:08.984Z)
restMs                              90000
runId                               "1778315592229-0ece8cbe741f"
startedAt                           1778315592229       (2026-05-09T08:33:12.229Z)
state                               "completed"
timeBudgetMs                        10000
error                               (absent)
```

## Per-chunk action times (from `_scheduled_functions`)

| Chunk | scheduledTime (ms) | completedTime (ms) | action_ms | action_s |
|---:|---:|---:|---:|---:|
| 1 | 1778315592229 | 1778315599082 | 6,853 | 6.853 |
| 2 | 1778315689073 | 1778315697053 | 7,980 | 7.981 |
| 3 | 1778315787047 | 1778315794045 | 6,998 | 6.998 |
| 4 | 1778315884037 | 1778315890933 | 6,896 | 6.896 |
| 5 | 1778315980923 | 1778315988048 | 7,125 | 7.125 |
| 6 | 1778316078038 | 1778316084765 | 6,727 | 6.727 |
| 7 | 1778316174757 | 1778316182005 | 7,248 | 7.248 |
| 8 | 1778316271993 | 1778316280490 | **8,497** | **8.497** |

Statistics:

- min: 6.727 s (chunk 6)
- **max: 8.497 s (chunk 8)** ← peak
- avg (Σ action_ms / 8): 7.291 s
- total active: 58.326 s
- max-chunk headroom vs `timeBudgetMs=10s`: **1.503 s (15.0% reserve)**

### Comparison: first BD-2 vs repeat

| Metric | BD-2 (`1778313396812`) | BD-2 repeat (`1778315592229`) | Δ |
|---|---:|---:|---:|
| durationMs | 687,745 | 686,545 | −1,200 ms (−0.17%) |
| min chunk | 6.487 s | 6.727 s | +240 ms |
| **max chunk** | **8.290 s** | **8.497 s** | **+207 ms** |
| avg chunk (sched-based) | 7.380 s | 7.291 s | −89 ms |
| range (max − min) | 1.803 s | 1.770 s | −33 ms |
| total active | 59.041 s | 58.326 s | −715 ms |

The chain timings are extremely stable (durationMs Δ −0.17%) — the profile
is repeatable. The variance lives in the **maximum** chunk: peak grew by
+207 ms while the rest of the distribution stayed level. This is the only
quantitative signal worth tracking forward.

## Hard Gates

Per the operator's BD-3 graduation requirement (max ≤ 8.5 s AND
durationMs ≤ 745 s) and broader BD-2 watch flags:

| Gate | Threshold | Observed | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | PASS |
| isActive | `false` | `false` | PASS |
| deletedCount | 8,000 | 8,000 | PASS |
| env after finally | `0` | `0` | PASS |
| `manualMassCleanupV2` | 8 success / 0 failed | **8 success / 0 failed** | PASS |
| **max chunk action time** | **≤ 8.5 s** | **8.497 s** | **PASS (3 ms margin)** |
| **durationMs** | **≤ 745,000 ms** | **686,545 ms** | **PASS (58.5 s margin)** |
| `pg_wal` growth | ≤ 25 MiB | 0 b (bit-exact) | PASS |
| stdout error patterns | 0 | 0 | PASS |
| heartbeat alarms | only attribution-rule matches | sync 12 min (≤16 by rule), UZ 19 min (≤45 by rule), legacy cleanup-realtime STUCK | PASS |

All gates passed. **BD-3 unblocked.**

## Scheduled Functions

Sourced via `npx convex data _scheduled_functions --limit 200 --format jsonArray`:

| UDF | This runId | Success | Failed | Verdict |
|---|---:|---:|---:|---|
| `metrics.js:manualMassCleanupV2` (this runId) | **8** | **8** | **0** | **PASS** |
| `metrics.js:manualMassCleanup` (V1, anywhere) | 0 | n/a | 0 | PASS by construction |

System-wide failure scan (informational): `syncDispatchV2 failed=0`,
`uzBudgetDispatchV2 failed=0`, `manualMassCleanupV2 failed=0`, V1
`manualMassCleanup` total=0 across the 200-row dump.

## Backend Stdout

Verified via `docker logs --since 15m adpilot-convex-backend` grep:

| Pattern class | Count | Verdict |
|---|---:|---|
| `[cleanup-v2] start` | 0 | INFORMATIONAL (Phase 4 caveat — marker absence is known log-routing) |
| `[cleanup-v2] end schedule` | 0 | INFORMATIONAL |
| `[cleanup-v2] end complete` | 0 | INFORMATIONAL |
| `[cleanup-v2] end failed` | 0 | PASS |
| `[cleanup-v2] disabled_mid_chain` | 0 | PASS (env held at `1` throughout the chain) |
| `TOKEN_EXPIRED` / `Too many concurrent` / `Transient error` / `rollback` / `FATAL` / `panic` | 0 | PASS |

## Heartbeat Snapshot (post-run)

```text
sync-metrics:        отстаёт (12 мин)
uz-budget-increase:  отстаёт (19 мин)
cleanup-realtime:    STUCK (6646 мин)   ← pre-existing legacy V1
```

Attribution per `memory/storage-cleanup-v2-bd-1-closure-2026-05-09.md`:

- `sync-metrics 12 мин`: cron 15 min, watcher `maxStaleMin=10` → expected
  alarm range 10–16 min. Lag 12 min = **2 min beyond threshold**. Within
  rule (≤6 min). **Non-blocker.**
- `uz-budget-increase 19 мин`: cron 45 min, watcher `maxStaleMin=15` →
  expected alarm range 15–45 min. Lag 19 min = **4 min beyond threshold**.
  Within rule (≤30 min). **Non-blocker.**
- `cleanup-realtime` STUCK: legacy V1 heartbeat name no longer written by
  any active cron. Pre-existing, **not regression**.

No new STUCK signals. No alarms outside the attribution rule.

## Density Note

BD-2 repeat advanced `oldestRemainingTimestamp` by **+178.974 s** while
deleting 8,000 rows; local density `≈ 44.7 rows/s`.

Comparison across the cleanup history:

| Run | Source-time advance | Rows deleted | Local density |
|---|---:|---:|---:|
| Emergency `maxRuns=8` (oldest edge) | +258.864 s | 4,000 | ≈ 15 rows/s |
| Gate B (`maxRuns=5`) | +8.855 s | 2,500 | ≈ 282 rows/s |
| BD-1 (`maxRuns=8`) | +14.863 s | 4,000 | ≈ 269 rows/s |
| BD-2 (`batchSize=1000`) | +133.567 s | 8,000 | ≈ 60 rows/s |
| **BD-2 repeat (`batchSize=1000`)** | **+178.974 s** | **8,000** | **≈ 45 rows/s** |

The drainage edge keeps moving forward; density remains non-uniform
across slices. Cumulative drainage to date ≈ **31,000 rows** out of an
estimated multi-million-row backlog. Drainage rate at the current ladder
position is **slow by intent** — BD-2 is repeatability proof, not
throughput ramp.

## Decision

**clean with caveat** — all hard gates and watch flags passed. BD-3 is
formally unblocked.

Caveat: max-chunk grew by +207 ms vs the first BD-2 run, passing the
8.5 s gate by 3 ms only. The pattern is consistent with slice-density
variance + per-chunk `delete()` cost increasing slightly as the deletion
edge moves into denser slices of `metricsRealtime`. BD-3 (`restMs 90 → 60`)
does **not** add per-chunk action-time pressure, so this caveat does not
gate BD-3. It **does** gate any future `batchSize > 1000` proposal.

## Post-run State

- `METRICS_REALTIME_CLEANUP_V2_ENABLED = 0`, verified after run.
- `cleanup-old-realtime-metrics` cron: ACTIVE at `convex/crons.ts:219` with
  cron profile `{batchSize:500, timeBudgetMs:10_000, restMs:90_000, maxRuns:5}`.
  Fail-closed by env. Phase 6 certification (Gate A + Gate B) remains valid.
- `cleanupRunState` active rows: none.
- HEAD/origin: `73abede`. No deploy or code change by this run.
- Working tree: pre-existing dirty unrelated files (untouched). Only new
  artifact: this closure file.
- Admin key: still in `/tmp/.cnvx_admin_key` (ephemeral, this session
  only; to be cleaned up at session end).

## BD-3 Readiness

After this closure is committed, BD-3 is unblocked, subject to a fresh
**BD-0-lite pre-flight** before the trigger:

- Same gate set as BD-2 repeat pre-flight.
- Apply the BD-1 alarm attribution rule for heartbeats.
- pg_wal threshold: ≤ post-BD-2-repeat baseline + 25 MiB
  (i.e. ≤ 1,367 MiB ≈ 1,432,820,224 b).

**BD-3 profile** (per the bulk-drain plan):

```
batchSize=1000
timeBudgetMs=10000
restMs=60000          ← changed dimension only
maxRuns=8
expected delete:      ≤ 8000 rows
expected duration:    ~8.5 min  (8 × ~7.3 s active + 7 × 60 s rest = 478.4 s)
```

Changed dimension: `restMs` only. `batchSize`, `maxRuns`, `timeBudgetMs`
held at BD-2 values.

### BD-3 watch flags (per the bulk-drain plan + this run's data)

| Signal | Threshold | Action |
|---|---|---|
| max chunk action time | > 8.7 s (= 8.5 + observed +207 ms drift) | hold BD-4; investigate |
| durationMs | > 530,000 ms | investigate variance source |
| V2 failed entries | > 0 | dirty closure |
| heartbeat alarm not matching attribution rule | any | dirty / investigate |
| `pg_wal` growth | > 25 MiB above pre-run baseline | post-run audit |
| heartbeat STUCK (other than legacy `cleanup-realtime`) | any | dirty |
| `[cleanup-v2] disabled_mid_chain` | > 0 | dirty (env should hold throughout chain) |

The 8.7 s soft warning on max chunk for BD-3 reflects the observed +207 ms
drift; if BD-3 shows max ≤ 8.5 s, the drift hypothesis is local; if it
trends further up, batchSize=1000 may be approaching its sustainable
ceiling and any further parameter ramp must factor that in.

### After BD-3 clean

If BD-3 passes hard gates, BD-4 (scheduling decision: cron-driven drain
or supervised manual waves) is on the table per the bulk-drain plan.
**BD-4 Option B (cron-driven) is a deploy boundary** and will need a
separate spec/plan + deploy + canary. Operator-supervised manual waves
(Option A) remain available without code change.

## Reference Pointers For Next Agent

- Bulk-drain + reclaim plan: `memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`
  (commit `e8cee10`).
- BD-2 first-run closure: `memory/storage-cleanup-v2-bd-2-closure-2026-05-09.md`
  (commit `73abede`).
- BD-1 closure: `memory/storage-cleanup-v2-bd-1-closure-2026-05-09.md`
  (commit `71ceb87`).
- Cleanup-track follow-ups: `memory/storage-cleanup-v2-followups-2026-05-09.md`
  (commit `a65d43b`).
- Phase 6 Gate B closure: `memory/storage-cleanup-v2-phase6-gate-b-closure-2026-05-09.md`
  (commit `1074adf`).
- Code at run time:
  - HEAD/origin: `73abede`.
  - V2 entrypoints in `convex/metrics.ts`: `triggerMassCleanupV2` (line 444),
    `getCleanupRunStateV2` (488), `cleanupOldRealtimeMetricsV2` (612),
    `manualMassCleanupV2` (635).
  - V1 path is a no-op in current code; not reachable from any active cron.
  - Cron registration: `convex/crons.ts:219` (cleanup), `:127` (UZ V2 every
    45 min), `:37` (sync V2 every 15 min), `:144` (UZ reset every 5 min).
  - Heartbeat config: `convex/healthCheck.ts:66-113`.
- Admin key generation: `memory/convex-deploy.md`.
