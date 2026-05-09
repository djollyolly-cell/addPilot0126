# Storage Cleanup V2 - BD-3 Closure - 2026-05-09

Status: **dirty** — V2 chain itself completed cleanly (all 8 batches success,
env restored, anchors flat), but **chunk 8 action time = 9.572 s** breached
all three operator hard thresholds: `> 8.5 s` (yellow), `> 8.7 s` (BD-4 hold),
**`> 9.0 s` (dirty)**.

This blocks **BD-4 progression** and stops the bulk-drain phase ladder at
this profile. Any further parameter ramp (especially `batchSize > 1000` or
`restMs < 60_000`) is **forbidden** until the chunk-8 outlier is attributed.

## Why dirty

The operator's BD-3 watch flags (set in this conversation immediately
before BD-3 trigger):

| Threshold | BD-3 observed | Verdict |
|---|---:|---|
| max chunk action time, soft warn | > 8.5 s | 9.572 s | YELLOW |
| max chunk action time, BD-4 hold | > 8.7 s | 9.572 s | **FAIL — BD-4 hold** |
| **any chunk > 9.0 s = dirty** | > 9.0 s | 9.572 s | **DIRTY** |
| durationMs | > 510 s | 475.744 s | PASS |
| V2 failed | > 0 | 0 | PASS |
| heartbeat outside attribution | any | only attribution-rule matches | PASS |
| pg_wal growth | > 25 MiB | 0 b | PASS |
| env not restored | any | restored to 0 | PASS |
| any chunk in non-success state | any | all 8 success | PASS |

Chunk 8 completed successfully with **428 ms headroom** to `timeBudgetMs=10 s`.
The action did not timeout. The chain finished. But the per-chunk hard rule
(`any chunk > 9.0 s = dirty`) was tripped, and that rule exists precisely for
the case where the chain *would* succeed — to stop us from ramping further
under the risk that the next run does timeout.

## Summary

- Profile: `batchSize=1000, timeBudgetMs=10_000, restMs=60_000, maxRuns=8`.
  Changed dimension vs BD-2 repeat: **`restMs` only** (90_000 → 60_000).
- runId: `1778317001080-6bce771f1759`.
- Trigger time: 2026-05-09T08:56:41.080Z (manual via
  `metrics:triggerMassCleanupV2`, after agent env-set 1 at 08:56:35Z, with
  inline BD-0-lite gates passing immediately before).
- Completion: 2026-05-09T09:04:36.794Z. durationMs = 475,744 (7:55.744).
- batchesRun: 8 (== maxRuns), deletedCount: 8,000 (== batchSize × batchesRun).
- env restored: `0` at 09:05:22Z, verified `0` immediately after.

## Operator / Agent Trace

State-changing steps performed by the agent under explicit operator go
(`go BD-3`).

| Time (UTC) | Actor | Action | Result |
|---|---|---|---|
| 08:56:20 | agent | inline BD-0-lite preflight (anchors + heartbeats + scheduled-functions audit) | all gates green |
| **08:56:35** | **agent** | **`npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1`** | success; verified `1` |
| 08:56:39 | agent | `npx convex run metrics:triggerMassCleanupV2 {batchSize:1000, timeBudgetMs:10000, restMs:60000, maxRuns:8}` | `{ runId: "1778317001080-6bce771f1759", status: "scheduled" }` |
| 08:57:28 → 09:05:22 | system | 8 batches, 7 inter-chunk rests of 60 s | terminal: `state=completed, batchesRun=8, deletedCount=8000` |
| 08:57:28 → 09:05:22 | agent | poll `cleanupRunState` every 45 s | progress 1→2→3→4→5→6→7→8; final `isActive=false, durationMs=475,744` |
| **09:05:22** | **agent** | **`npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0`** | success; verified `0` |
| 09:06:14 | agent | post-run `/version` × 3 + SSH anchors + stdout grep + heartbeats + `_scheduled_functions` audit | clean for V2 contract; chunk-8 hard-gate breach surfaced in per-chunk extraction |

## Anchors

| Anchor | Pre (BD-0-lite 08:56:20Z) | Post (09:06:14Z) | Delta | Threshold | Verdict |
|---|---:|---:|---:|---|---|
| `/version` (× 3) | HTTP 200, 1.53 / 1.41 / 1.45 s | HTTP 200, 1.48 / 1.33 / 1.04 s | latency stable | 200 | PASS |
| `pg_wal` (size) | 1,342,177,280 b | 1,342,177,280 b | **0 b (bit-exact)** | warn 25 MiB | PASS |
| `/dev/sda1` usage | 54% (used 161G / 315G, free 142G) | 54%, no change | 0 | informational | PASS |
| DB total size | 143 GB | 143 GB | 0 (rounded) | informational | PASS |
| `cleanupRunState` (this row) | n/a | row, `state=completed, isActive=false` | n/a | terminal | PASS |
| `oldestRemainingTimestamp` | 1,777,734,308,984 (post-BD-2 repeat, 2026-05-02T15:05:08.984Z) | 1,777,734,587,249 (2026-05-02T15:09:47.249Z) | **+278.265 s** source-time | post >= pre | PASS |

`pg_wal` zero growth — same as BD-2 repeat. BD-3 reduced `restMs` 90→60 with
no detectable WAL pressure increase.

## cleanupRunState Final Row

```text
_id                                 r178hsqb9k3jsq561hbkndharn86c85c
_creationTime                       1778317001080.485   (2026-05-09T08:56:41.080Z)
batchSize                           1000
batchesRun                          8
cleanupName                         "metrics-realtime-v2"
cutoffUsed                          1778144201080       (2026-05-07T08:56:41.080Z)
deletedCount                        8000
durationMs                          475744              (7:55.744)
isActive                            false
lastBatchAt                         1778317476794       (2026-05-09T09:04:36.794Z)
maxRuns                             8
oldestRemainingTimestamp            1777734587249       (2026-05-02T15:09:47.249Z)
restMs                              60000
runId                               "1778317001080-6bce771f1759"
startedAt                           1778317001080       (2026-05-09T08:56:41.080Z)
state                               "completed"
timeBudgetMs                        10000
error                               (absent)
```

## Per-chunk action times (from `_scheduled_functions`)

| Chunk | scheduledTime (ms) | completedTime (ms) | action_ms | action_s |
|---:|---:|---:|---:|---:|
| 1 | 1778317001080 | 1778317007801 | 6,721 | 6.721 |
| 2 | 1778317067792 | 1778317075195 | 7,403 | 7.403 |
| 3 | 1778317135186 | 1778317141786 | 6,600 | 6.600 |
| 4 | 1778317201771 | 1778317208666 | 6,895 | 6.896 |
| 5 | 1778317268652 | 1778317275730 | 7,078 | 7.078 |
| 6 | 1778317335719 | 1778317342505 | 6,786 | 6.786 |
| 7 | 1778317402495 | 1778317409229 | 6,734 | 6.735 |
| 8 | 1778317469222 | 1778317478793 | **9,571** | **9.572** |

Statistics:

- min: 6.600 s (chunk 3)
- **max: 9.572 s (chunk 8)** ← exceeded the 9.0 s dirty threshold by 572 ms
- avg (Σ action_ms / 8): 7.224 s (stable vs BD-2 repeat 7.291 s)
- total active: 57.792 s
- 7 chunks (1–7) all under 7.5 s, ranging 6.600–7.403 s — completely
  unremarkable
- chunk 8 is **2.169 s above the next-highest chunk (chunk 2 at 7.403 s)** —
  this is a clear outlier, not a creeping average shift

### Chunk-8 outlier pattern across last three runs

| Run | Profile | max chunk | which chunk | next-highest chunk |
|---|---|---:|---:|---:|
| BD-2 first (`1778313396812`) | `batchSize=1000, restMs=90_000` | 8.290 s | chunk 6 | 8.172 s (chunk 8) |
| BD-2 repeat (`1778315592229`) | `batchSize=1000, restMs=90_000` | 8.497 s | **chunk 8** | 7.981 s (chunk 2) |
| **BD-3 (this run)** | **`batchSize=1000, restMs=60_000`** | **9.572 s** | **chunk 8** | **7.403 s (chunk 2)** |

Two patterns combined:

1. **Chunk-8 progressive drift**: chunk 8 max grew 8.172 → 8.497 → 9.572 s
   across the three runs (+325 ms, then +1.075 s).
2. **Restms reduction amplified the chunk-8 drift**: BD-2 first had chunk 8 at
   8.172 s with `restMs=90`; BD-3 hit 9.572 s with `restMs=60`. The +1.4 s
   step between BD-2 first and BD-3 on **chunk 8 specifically** is far larger
   than chunks 1–7, where the step is mostly within ±300 ms.

The other chunks (1–7) **did not** show the same response to restMs reduction.
Their action time stayed roughly equivalent to or slightly below BD-2 repeat.
Whatever is making chunk 8 outlier is **specific to position 8 in the chain**
(or to whatever scheduler / V8 / lock-contention state has built up by that
point), and it is **sensitive to inter-chunk rest length**.

## Hard Gates

| Gate | Threshold | Observed | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | PASS |
| isActive | `false` | `false` | PASS |
| deletedCount | 8,000 | 8,000 | PASS |
| env after finally | `0` | `0` | PASS |
| `manualMassCleanupV2` | 8 success / 0 failed | 8 / 0 | PASS |
| **max chunk soft warn** | **≤ 8.5 s** | **9.572 s** | **YELLOW** |
| **max chunk BD-4 hold** | **≤ 8.7 s** | **9.572 s** | **FAIL — BD-4 HOLD** |
| **any chunk > 9.0 s = dirty** | **≤ 9.0 s** | **9.572 s (chunk 8)** | **DIRTY** |
| durationMs | ≤ 510,000 ms | 475,744 ms | PASS |
| pg_wal growth | ≤ 25 MiB | 0 b | PASS |
| stdout error patterns | 0 | 0 | PASS |
| heartbeat alarms | only attribution-rule matches | UZ 39 min (≤45 by rule), legacy STUCK | PASS |

V2-contract gates all PASS. Per-chunk hard gate `> 9.0 s = dirty` FAIL.
**Net verdict: dirty.**

## Scheduled Functions

Sourced via `npx convex data _scheduled_functions --limit 200 --format jsonArray`:

| UDF | This runId | Success | Failed | Verdict |
|---|---:|---:|---:|---|
| `metrics.js:manualMassCleanupV2` (this runId) | **8** | **8** | **0** | PASS (chain itself succeeded) |
| `metrics.js:manualMassCleanup` (V1, anywhere) | 0 | n/a | 0 | PASS |

System-wide failure scan (informational): `syncDispatchV2 failed=0`,
`uzBudgetDispatchV2 failed=0`, `manualMassCleanupV2 failed=0`, V1
`manualMassCleanup` total=0 across 200 rows.

The chain success contradicts the `dirty` verdict only at the surface.
The dirty rule is a **leading indicator** for a future timeout under the same
profile or a tighter one — not a record of a current failure.

## Backend Stdout

`docker logs --since 15m adpilot-convex-backend` grep:

| Pattern class | Count | Verdict |
|---|---:|---|
| `[cleanup-v2] end failed` | 0 | PASS |
| `[cleanup-v2] disabled_mid_chain` | 0 | PASS |
| `TOKEN_EXPIRED` / `Too many concurrent` / `Transient error` / `rollback` / `FATAL` / `panic` | 0 | PASS |

## Heartbeat Snapshot (post-run)

```text
uz-budget-increase:  отстаёт (39 мин)
cleanup-realtime:    STUCK (6666 мин)   ← pre-existing legacy V1
```

Attribution per BD-1 rule:

- `uz-budget-increase 39 мин`: cron 45 min, watcher `maxStaleMin=15` →
  expected alarm range 15–45 min. Lag 39 min = within rule. Non-blocker.
- `cleanup-realtime` STUCK: legacy V1 heartbeat name no longer written by
  any active cron. Pre-existing, not regression.
- `sync-metrics`: not flagged. Sync caught up within window.

No new STUCK signals. No alarms outside the attribution rule. **Heartbeat
state is not the dirty signal.**

## Density Note

BD-3 advanced `oldestRemainingTimestamp` by **+278.265 s** while deleting
8,000 rows; local density `≈ 28.7 rows/s` — sparser than recent slices.

| Run | Source-time advance | Rows | Local density |
|---|---:|---:|---:|
| Emergency `maxRuns=8` | +258.864 s | 4,000 | ≈ 15 rows/s |
| Gate B (`maxRuns=5`) | +8.855 s | 2,500 | ≈ 282 rows/s |
| BD-1 (`maxRuns=8`) | +14.863 s | 4,000 | ≈ 269 rows/s |
| BD-2 first (`batchSize=1000`) | +133.567 s | 8,000 | ≈ 60 rows/s |
| BD-2 repeat | +178.974 s | 8,000 | ≈ 45 rows/s |
| **BD-3** | **+278.265 s** | **8,000** | **≈ 28.7 rows/s** |

Density continues to vary widely across slices (15–282 rows/s). The chunk-8
outlier is **not** correlated with density alone — BD-3 is the sparsest
slice we've seen since emergency, yet it had the worst chunk 8.

Cumulative drainage to date: **39,000 rows** out of an estimated multi-million
backlog.

## Decision

**dirty** — per the operator-set hard rule `any chunk > 9.0 s = dirty`,
tripped by chunk 8 at 9.572 s.

The chain itself succeeded. The dirty verdict is a **forward-looking signal**:
do not promote the profile, do not ramp further, do not retry the same
profile without diagnostic work first.

## Investigate Next

Following the dirty-closure template from the bulk-drain plan, this section
must be answered before any further runtime action on this track.

1. **Why chunk 8 specifically?** chunks 1–7 are flat (6.6–7.4 s) and behaved
   consistently from BD-2 first → BD-2 repeat → BD-3. Chunk 8 grew
   8.172 → 8.497 → 9.572 s, a +1.4 s drift over three runs, with the
   biggest step at the `restMs` reduction.
   - Hypothesis A: scheduler / V8 saturation accumulates as the chain
     progresses; shorter rest gives less time for the runtime to release
     cached state from earlier batches. Test: read action source for any
     per-chain in-memory state in `manualMassCleanupV2` /
     `triggerMassCleanupV2` workers.
   - Hypothesis B: slice-density at the chunk-8 boundary is denser than at
     chunks 1–7 (the deletion edge moved forward into a denser slice during
     the run). Test: extract per-chunk `oldestRemainingTimestamp` from the
     row history (if Convex retains it) or recompute from `deletedCount` per
     chunk.
   - Hypothesis C: pg-side maintenance (autovacuum, checkpoint) hits the
     `documents` / `indexes` tables right around the chunk-8 timestamp. Test:
     check `pg_stat_all_tables.last_autovacuum` / `last_autoanalyze` and
     PostgreSQL `pg_stat_bgwriter` `checkpoints_timed` counters across the
     run window.
   - Hypothesis D: V8 concurrency contention with sync (sync runs every 15
     min; BD-3 chunk 8 fired at ~09:04:30 — sync interval boundaries 09:00
     and 09:15). Marginal probability: chunk 8 fired ~4.5 min into a sync
     window, not at the boundary. But the sync workers themselves are bursts;
     check `_scheduled_functions` for `syncBatchWorker`-like entries
     overlapping chunk 8.
2. **Is chunk 8 the timeout slot?** Convex actions with `timeBudgetMs=10_000`
   are bounded at 10 s **plus** queueing latency. Was chunk 8 actually
   running 9.572 s of work, or did it sit in queue for 1+ s before starting?
   `scheduledTime` and `completedTime` in `_scheduled_functions` give us
   action wall time, not pure work time. A separate `manualMassCleanupV2`
   internal log marker (if any) inside the action would distinguish queueing
   from work.
3. **Does the BD-3 profile's `restMs=60_000` recover later?** If we ran a
   second BD-3 with the same profile, would chunk 8 stabilize at ~9.0 s, or
   continue drifting up? Unknown. Per the dirty rule, **we do not test this
   without first making A/B/C/D progress**.
4. **What does the safe profile look like now?** Working assumption:
   `batchSize=1000, restMs=90_000` (BD-2 repeat profile) is still safe — no
   chunk crossed 8.5 s in either of the two BD-2 runs. **Drainage at the
   safe profile is the BD-2 repeat throughput** (8,000 rows / ~11.5 min).

**Proposed minimum next step (non-runtime):**

- Read the implementation of `manualMassCleanupV2` / its inner delete batch
  to confirm there is no per-chain accumulating state.
- Decide which of A/B/C/D to test first based on cost.
- **Do not retrigger BD-3 same-profile or any tighter profile until at
  least one of A/B/C/D returns a verifiable answer.**

A dirty closure forbids further BD-* runs at the same or higher profile
until investigate-next has a written answer.

## What's still allowed (no rule says cleanup track is frozen)

- The BD-2 repeat profile (`batchSize=1000, restMs=90_000, maxRuns=8`) is
  still safe per its own closure. If drainage urgency increases, returning
  to that profile for additional waves remains an option **with explicit
  go**.
- The Phase 6 cron baseline (`batchSize=500, maxRuns=5`) is still certified
  and runs every 6 h under env-gate. Nothing in BD-3 affects Phase 6.
- All four follow-up notes from `memory/storage-cleanup-v2-followups-2026-05-09.md`
  remain valid and unchanged.

## Post-run State

- `METRICS_REALTIME_CLEANUP_V2_ENABLED = 0`, verified.
- `cleanupRunState` active rows: none.
- HEAD/origin: `7d10154`. No deploy or code change by this run.
- Working tree: pre-existing dirty unrelated files (untouched). Only new
  artifact: this closure file.
- Admin key: still in `/tmp/.cnvx_admin_key` (ephemeral, this session
  only; recommend cleanup at session end).

## Reference Pointers For Next Agent

- Bulk-drain + reclaim plan: `memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`
  (commit `e8cee10`).
- BD-2 first-run closure: `memory/storage-cleanup-v2-bd-2-closure-2026-05-09.md`
  (commit `73abede`).
- BD-2 repeat closure: `memory/storage-cleanup-v2-bd-2-repeat-closure-2026-05-09.md`
  (commit `7d10154`).
- BD-1 closure: `memory/storage-cleanup-v2-bd-1-closure-2026-05-09.md`
  (commit `71ceb87`). Contains the alarm-attribution rule used here.
- Cleanup-track follow-ups: `memory/storage-cleanup-v2-followups-2026-05-09.md`
  (commit `a65d43b`).
- Code at run time:
  - HEAD/origin: `7d10154`.
  - V2 entrypoints in `convex/metrics.ts`: `triggerMassCleanupV2` (line 444),
    `manualMassCleanupV2` (line 635).
  - Cron registration: `convex/crons.ts:219` (cleanup), `:127` (UZ V2 every
    45 min), `:37` (sync V2 every 15 min), `:144` (UZ reset every 5 min).
  - Heartbeat config: `convex/healthCheck.ts:66-113`.
- Admin key generation: `memory/convex-deploy.md`.
