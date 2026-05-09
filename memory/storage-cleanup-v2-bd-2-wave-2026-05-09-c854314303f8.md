# Storage Cleanup V2 — BD-2 wave closure (2026-05-09 18:31Z)

## Verdict

**Clean with caveat.** Safe profile (`1000/10000/90000/8`) reproduced for the third consecutive time. 8000 rows deleted, terminal `completed`, env restored to 0, no race with cron boundaries, all hard gates PASS.

Caveat is YELLOW on **pre-wave pg_wal drift**, not on the wave itself: starting pg_wal was 3,355,443,200 b (3,200 MB / 200 files) — 1.92 GiB above the prior BD-2 closure anchor (1,342,177,280 b / 80 files). Slope was 0 b over 126 s of pre-flight sampling; plateau, not runaway. New baseline accepted explicitly with operator agreement before env flip. **Δ from THIS pre-wave anchor = 0 bytes.** The wave itself added zero WAL.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778351513310-c854314303f8` |
| short-runId | `c854314303f8` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=8` |
| Trigger UTC | `2026-05-09T18:31:53Z` |
| Terminal UTC | `2026-05-09T18:43:27Z` |
| env restored UTC | `2026-05-09T18:43:39Z` |
| Total wall (cleanupRunState `durationMs`) | `689,069 ms` (11.485 min) |
| Cron boundary headroom at terminal | next 00:00 UTC = +5h 16m |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 18:13:46Z | Pre-flight start (cron-boundary distance check) |
| 18:18:43–18:19:46Z | First WAL slope sample (60s, Δ=0 b) |
| 18:23:00Z | Initial gate verdict reframed GREEN→GREEN-with-YELLOW (operator) |
| 18:26:28–18:28:34Z | WAL slope recheck × 3 (126s, Δ=0 b) — plateau confirmed |
| 18:31:29Z | Quick sanity recheck (env=0, no active row, /version=200) |
| 18:31:41Z | env flip 0→1 (verified `1`) |
| 18:31:53Z | Trigger `metrics:triggerMassCleanupV2` → `{status:"scheduled", runId:"1778351513310-c854314303f8"}` |
| 18:33:56–18:43:27Z | Poll loop (≥45s cadence), 8 chunks completed |
| 18:43:27Z | Terminal `completed` |
| 18:43:39Z | env flip 1→0 (verified `0`) |
| 18:45:57Z | Post-run audit complete |

No abort, no recovery branch hit. `disabled` and `already-running` trigger responses did not occur.

## Pre-flight baseline (snapshot at 18:13–18:31Z)

| Item | Value |
|---|---|
| env | `0` |
| Active cleanup row | none (top: BD-2 prior `42133ff2ac4d`, isActive=false, completed) |
| `/version` × 3 | `1.407 / 1.268 / 1.575` s, all HTTP 200 |
| `track_io_timing` | `off` (default) |
| `pg_wal` | **`3,355,443,200` bytes (3,200 MB, 200 files)** — accepted as new baseline |
| `pg_wal` slope (3 × 60s) | 0 b/min — flat plateau |
| Locks waiting | 0 |
| Idle-in-tx | 0 |
| Longest active query | 0s |
| `df -h /` | 54%, free 140G |
| 6-pattern stdout gate (15 min) | rollback=0, TOKEN_EXPIRED=0, "Too many concurrent"=0, "[cleanup-v2] end failed"=0, FATAL=0, panic=0 |
| `_scheduled_functions` non-success in newest 500 (11.1h window) | 0 |
| Heartbeats | sync 3.0m / UZ 10.0m / tokenRefresh 72.5m — all within attribution rule. `cleanup-realtime-metrics` STUCK 5d (legacy V1, non-blocker) |
| Cron boundary distance | +13.8 min past 18:00 UTC; +5h 47m to 00:00 UTC |

### YELLOW caveat — WAL drift since prior closure

Prior closure anchor (BD-2 wave `42133ff2ac4d`, terminal 17:27:23Z):
- pg_wal: 1,342,177,280 b (80 files, 1,280 MB)

This pre-flight (18:18Z, ~51 min after prior closure):
- pg_wal: 3,355,443,200 b (200 files, 3,200 MB)
- Δ from prior anchor: **+2,013,265,920 b ≈ +1.92 GiB** over ~51 min

Interpretation: documented `WAL ~25 GB/day` baseline (from `memory/postgres-tuning.md`) implies ~890 MiB per 51 min. Observed +1.92 GiB is ~2.2× that rate. With `max_wal_size=8GB` and `checkpoint_timeout=30min`, pg_wal grows up to ~max_wal_size between checkpoints; current 3.2 GB is 40% of cap. Not a leak (slope 0 b/min for 126 s confirms), but starting plateau is meaningfully higher than the prior closure anchor.

Operator and agent both reframed pre-flight verdict from GREEN to GREEN-with-YELLOW caveat before env flip. Baseline `3,355,443,200 b` was explicitly accepted as the post-wave comparison anchor.

## Per-chunk timing — `_scheduled_functions`-derived

`completedTime − scheduledTime` for each `metrics.js:manualMassCleanupV2` filtered by `args.runId == "1778351513310-c854314303f8"`. All 8 chunks `state=success`.

| chunk | sched UTC | duration | tier |
|---|---|---|---|
| 1 | 18:31:53Z | 8.095 s | clean (close to soft 8.5s) |
| 2 | 18:33:31Z | 7.389 s | clean |
| 3 | 18:35:08Z | 7.988 s | clean |
| 4 | 18:36:46Z | 7.200 s | clean |
| 5 | 18:38:23Z | 7.136 s | clean |
| 6 | 18:40:01Z | 6.820 s | clean |
| 7 | 18:41:37Z | 7.411 s | clean |
| 8 | 18:43:15Z | 8.409 s | clean (includes `markCompletedV2` ~1.3 s; effective delete-loop ~7.1 s) |

min=6.820 s, max=**8.409 s** (chunk 8 with marker), avg=7.556 s, sum=60.447 s.

Per BD-3 hard rule: **≤ 8.5 s soft** (clean) / **≤ 8.7 s** (hold-BD-4) / **> 9.0 s** (dirty). Max = 8.409 s → **clean tier**, no breach.

### Drift vs prior BD-2 wave (`42133ff2ac4d`)

Prior wave (`_scheduled_functions`-derived, including chunk 8 marker): 6.59–7.88 s.
This wave: 6.82–8.41 s.

| chunk | prior (s) | this (s) | Δ (ms) |
|---|---|---|---|
| 1 | 7.07 | 8.095 | +1,025 |
| 2 | 7.19 | 7.389 | +199 |
| 3 | 6.91 | 7.988 | +1,078 |
| 4 | 7.62 | 7.200 | −420 |
| 5 | 7.21 | 7.136 | −74 |
| 6 | 6.66 | 6.820 | +160 |
| 7 | 6.59 | 7.411 | +821 |
| 8 (with marker) | 7.88 | 8.409 | +529 |

Three chunks (1, 3, 7) show +800 ms+ drift; chunks 4–5 actually faster. Average drift +540 ms wave-over-wave. Not a tier breach but worth noting alongside the WAL caveat.

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | PASS |
| isActive | `false` | `false` | PASS |
| deletedCount | 8,000 | 8,000 | PASS |
| env after | `0` | `0` | PASS |
| `manualMassCleanupV2` | 8 success / 0 failed | 8 / 0 | PASS |
| max chunk action time | ≤ 8.5 s soft | 8.409 s (chunk 8 incl. marker) / 8.095 s (chunk 1, max delete-loop) | PASS |
| `durationMs` | ≤ 745,000 ms | 689,069 ms | PASS |
| pg_wal growth (from THIS pre-wave anchor) | ≤ 25 MiB | **0 b** | PASS |
| `df -h /` change | sanity (no GiB-level drop) | unchanged at 140G free | PASS |
| backend stdout errors (15 min covering wave) | 0 | 0 | PASS |
| heartbeat alarms | within attribution rule | within | PASS |

All hard gates PASS.

## Post-wave audit (snapshot at 18:43:39–18:45:57Z)

| Metric | Pre-flight | Post-wave | Δ |
|---|---|---|---|
| env | 0 | 0 | restored |
| `pg_wal` bytes | 3,355,443,200 | 3,355,443,200 | **0** |
| `pg_wal` files | 200 | 200 | 0 |
| `df -h /` free | 140 G | 140 G | 0 (df-rounded) |
| Locks waiting | 0 | 0 | 0 |
| Idle-in-tx | 0 | 0 | 0 |
| Longest active | 0 s | 0 s | 0 |
| `/version` × 3 | 1.41 / 1.27 / 1.58 s | 1.34 / 1.46 / 1.29 s | stable |

Wave deleted 8,000 rows over ~11.5 min and produced **zero net pg_wal growth**. Checkpoints absorbed wave WAL writes without creating new segment files.

## Final `cleanupRunState` row

```json
{
  "_id": "r1720r0b6mv2yv4d030yfnkf4986dwat",
  "runId": "1778351513310-c854314303f8",
  "cleanupName": "metrics-realtime-v2",
  "isActive": false,
  "state": "completed",
  "batchSize": 1000,
  "timeBudgetMs": 10000,
  "restMs": 90000,
  "maxRuns": 8,
  "batchesRun": 8,
  "deletedCount": 8000,
  "durationMs": 689069,
  "startedAt": 1778351513310,
  "lastBatchAt": 1778352202363,
  "cutoffUsed": 1778178713310,
  "oldestRemainingTimestamp": 1777734893381
}
```

No `error` field, no `lastErrorAt`. Clean termination.

## Backlog horizon

| Source | `oldestRemainingTimestamp` | UTC |
|---|---|---|
| Pre-wave (top of baseline = BD-2 prior `42133ff2ac4d`) | `1,777,734,623,965` | `2026-05-02T15:10:23.965Z` |
| Post-wave (this run) | `1,777,734,893,381` | `2026-05-02T15:14:53.381Z` |
| Δ | **+269,416 ms = +4 min 29 sec** of cleanup-frontier advance |

8,000 deletions advanced the oldest-remaining frontier by ~4.5 minutes of source-time. Density in this slice: 8000 rows / 269 s ≈ **30 rows/source-second** — much sparser than the prior BD-2 wave's slice (~222 rows/source-second over a 36-s span). Backlog beneath the 2-day cutoff still ~4.7 days. Source-data density varies by time-of-day; planning a sustained drain still requires either repeated safe waves or a separately-designed BD-X profile after dedicated investigation.

## Cumulative drainage (BD-2-profile waves)

| Date | runId (short) | profile | rows | verdict |
|---|---|---|---:|---|
| 2026-05-09 | BD-2 first | 1000/8/90s | 8,000 | clean with caveat |
| 2026-05-09 | BD-2 repeat | 1000/8/90s | 8,000 | clean with caveat |
| 2026-05-09 | BD-3 (`6bce771f1759`) | 1000/8/**60s** | 8,000 | **dirty** (chunk-8 outlier 9.572s; restMs<90s frozen) |
| 2026-05-09 | BD-2 wave (`42133ff2ac4d`) | 1000/8/90s | 8,000 | clean |
| 2026-05-09 | BD-2 wave (`c854314303f8`, this) | 1000/8/90s | 8,000 | **clean with caveat** |

Cumulative since 2026-05-08: **47,000 rows**.

## Open notes (not in scope of this wave)

1. **YELLOW WAL drift between waves.** ~+1.92 GiB pg_wal accumulation over ~51 min between prior BD-2 closure and this pre-flight. Not a leak (slope 0 b/min); within `max_wal_size=8GB`. But trend means each successive wave starts higher than the last. If next wave starts above ~5 GB pg_wal, hold for a checkpoint cycle (≥30 min) before triggering, or refresh the slope check with a longer sample window.

2. **Per-chunk drift +540 ms avg vs prior BD-2 wave.** No tier breach, but watch on next wave. If max chunk crosses 8.5 s soft threshold, reclassify clean→clean-with-caveat; if 8.7 s, hold further BD-2 waves pending investigation.

3. **`healthCheck.checkCronHeartbeats` config drift** (already documented in prior closure). `convex/healthCheck.ts:79-80,86`: sync threshold 10 min vs cadence 15 min; UZ threshold 15 min vs cadence 45 min. Heartbeats during this wave (sync 11.8 min lag, UZ 33.8 min lag at post-audit) would trip the V1-era thresholds despite being healthy under V2 cadences. Recommend updating thresholds in a separate change.

4. **Stuck `cleanup-realtime-metrics` heartbeat row** — unchanged (5d, legacy V1).

5. **Indexes bloat** — unchanged, 93 GB indexes vs 34 GB heap (~19:1).

6. **stdout routing for `[cleanup-v2]`** — `docker logs --since 15m | grep cleanup` returned empty during this wave too, consistent with prior closure observation. Cross-check via `_scheduled_functions` confirms execution. Self-hosted Convex stdout routing for cleanup-v2 logs remains a separate observability follow-up.

## What this wave does NOT change

- env returned to `0` post-terminal; cron `cleanup-old-realtime-metrics` remains fail-closed.
- No PG settings changed (`track_io_timing` stayed `off/default`; `shared_buffers` unchanged at 128 MB).
- No migration run.
- No `cleanupRunState` row mutated outside this run.
- Main dirty worktree untouched; closure authored from a fresh isolated worktree at `origin/emergency/drain-scheduled-jobs` HEAD `aaff3eb` (per session push lock — main WT pushurl stays `DISABLED_DO_NOT_PUSH_FROM_DIRTY_WT`).

## References

- BD-2 wave runbook: `memory/storage-cleanup-v2-bd-2-wave-runbook-2026-05-09.md` (commit `835b39a`).
- BD-2 prior closure: `memory/storage-cleanup-v2-bd-2-wave-2026-05-09-42133ff2ac4d.md` (commit `aaff3eb`).
- BD-3 dirty closure: `memory/storage-cleanup-v2-bd-3-closure-2026-05-09.md` (commit `358663a`).
- BD-3 investigate note: `memory/storage-cleanup-v2-bd-3-investigate-2026-05-09.md` (commit `2e18962`).
- Convex deploy / admin key: `memory/convex-deploy.md`.
- Postgres tuning state: `memory/postgres-tuning.md`.
