# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 13:34Z, maxRuns=16, wave 5)

## Verdict

**Clean.** Fifth consecutive canary at Tier 1 (`maxRuns=16`). Profile reproduced exactly: 16/16 chunks, 16,000 rows deleted, terminal `completed`, env restored to 0. Duration `1,448,844 ms` (24m 8.8s). No PG/host footprint across pre and post probes.

**Floor advance returned to the 5-min band: +5.07 min vs w4** (after w4's +9.07 min density-variance excursion). Confirms wave 4's interpretation: the wide jump was sparse-segment density, not a wave-side change. The 5-wave floor advance distribution is now clearly bimodal-ish (`5.07, 5.10, 5.36, 5.07` for waves 2/3/5/post-w4 + outlier `9.07` for wave 4 hitting a sparse window). Wave 5 confirms reversion-to-band.

This is **5/10** clean waves required at the new tier — **halfway through the gate**. Series stable.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778420087973-25c80afba8c1` |
| short-runId | `25c80afba8c1` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T13:34:47Z` |
| Last batch UTC | `2026-05-10T13:58:56Z` |
| Terminal detected (Monitor) | `2026-05-10T13:59:33Z` |
| env restored UTC | `2026-05-10T13:59:43Z` (verified `0` ≠ `1`) |
| Total wall (`durationMs`) | `1,448,844 ms` (24m 8.8s) |
| Avg chunk-to-chunk (observed) | ~96 s (rest=90 s + work ~6 s) |
| Implied avg per-chunk work | ~6.2 s (`(1448844 − 15×90000) / 16` = 99.3 s / 16) |
| Cron boundary headroom at terminal | next 17:55 no-go entry = +3h 55m |
| Gap from prior canary terminal | wave 4 terminal 13:15:48Z → wave 5 trigger 13:34:47Z = **+18m 59s** (not back-to-back) |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 13:33:12Z | Preflight (parallel operator + agent) — GREEN, no caveats |
| 13:34:21Z | Pre-flip runway recheck (3h 50m to 17:25 cutoff) — passed |
| 13:34:45Z | Operator `go run`; agent env flip 0→1 (verified `1`) |
| 13:34:47Z | Trigger returned `{status:"scheduled", runId:"1778420087973-25c80afba8c1"}` |
| 13:34:54Z | First chunk completed (batchesRun=1, deleted=1000) |
| 13:34–13:58Z | Wave executing; Monitor armed |
| 13:59:33Z | Terminal `completed` detected by Monitor; stream exited |
| 13:59:43Z | env flip 1→0 (verified `0`) |
| 14:00:18Z | Post-wave PG host probe (GREEN) |

No abort, no recovery branch, no transient FETCH-ERROR on Monitor poll, no `disabled`/`already-running` trigger response.

## Pre-flight baseline (snapshot at 13:33Z)

| Item | Value |
|---|---|
| env | `0` (idle-safe) |
| Active cleanup row | none (top: prior canary `8734aea0c175`, completed) |
| `/version` × 3 | 200/200/200, 1.22–1.92s (first attempt 1.92s = likely cold isolate, then warm) |
| `track_io_timing` | `off` |
| `shared_buffers` | `128MB` (storm-fix state, unchanged) |
| `pg_wal` | **57 files / 912 MB** (unchanged from wave 4 post-state) |
| Locks waiting | 0 |
| Idle-in-tx | 0 |
| Active wait_events `DataFileRead` / `BufferIO` / `BufferPin*` | 0 / 0 / 0 |
| Long-active queries (>30 s) | 0 |
| `loadavg` | `0.06 / 0.16 / 0.22` |
| Containers | 3× `healthy` |
| Origin canon | `f97e213` |
| Cron boundary | latest start `≤ 17:25 UTC`; 3h 51m runway at preflight |

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778420087973-25c80afba8c1",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1448844,
  "startedAt": 1778420087973,
  "lastBatchAt": 1778421536805,
  "cutoffUsed": 1778247287973,
  "oldestRemainingTimestamp": 1777736679225,
  "error": null
}
```

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T13:34:47Z`.
- `oldestRemainingTimestamp` = `2026-05-02T15:44:39.225Z`.
- Backlog at terminal: ~7d 22h between `oldestRemaining` and `cutoffUsed`.

## Five-wave stability ledger

| Wave | runId (short) | Duration (ms) | Deleted | Floor (UTC) | Floor Δ vs prev |
|---|---|---|---|---|---|
| w1 | `c74ca9b2fe6d` | 1,455,738 | 16,000 | `2026-05-02T15:20:03Z` | — |
| w2 | `d88ff5ef84f3` | 1,452,529 | 16,000 | `2026-05-02T15:25:24Z` | +5.36 min |
| w3 | `694c4ce0294f` | 1,448,081 | 16,000 | `2026-05-02T15:30:30Z` | +5.10 min |
| w4 | `8734aea0c175` | 1,451,830 | 16,000 | `2026-05-02T15:39:35Z` | +9.07 min (sparse) |
| w5 | `25c80afba8c1` | **1,448,844** | 16,000 | `2026-05-02T15:44:39Z` | **+5.07 min** |

**Duration:** spread `1,448,081–1,455,738 ms` = 7.66 s = ~0.53% across 5 waves. Tight, no drift.

**Floor advance:** four waves in tight `5.07–5.36 min` band; one outlier (w4: 9.07 min) attributable to density variance at deletion frontier. Cumulative `+24m 36s` floor advance across 5 waves over 5h 47m wall time.

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 (= `maxRuns × batchSize`) | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms (16 × 100 s envelope) | 1,448,844 ms | **PASS** |
| floor advance | ≥ 0, monotonic | +304,109 ms (≈ 5.07 min) | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +3h 55m | **PASS** |

## Post-wave probe (14:00:18Z)

| Metric | Pre-wave (13:33) | Post-wave (14:00) |
|---|---|---|
| loadavg 1m / 5m / 15m | 0.06 / 0.16 / 0.22 | **0.14 / 0.28 / 0.32** |
| Containers | 3× healthy | 3× healthy |
| pg_stat_activity (idle / idle-in-tx) | 5 / 0 | 5 / 0 |
| Long-active >30 s | 0 | 0 |
| DataFileRead / BufferIO / BufferPin (active) | 0 / 0 / 0 | 0 / 0 / 0 |
| pg_locks waiting | 0 | 0 |
| pg_wal | 57 files / 912 MB | **57 files / 912 MB** (unchanged) |

**`pg_wal` movement:** flat across the wave window. Same observation as wave 2 (waves 1, 3, 4 each saw −4 segment / −64 MB recycle). Pattern suggests WAL recycle is not strictly per-wave but driven by checkpoint timing or accumulated activity. Neutral observation; wave 5 did not add net WAL.

## Caveats / parked

- **Per-chunk timings** captured at coarse Monitor cadence (45 s) only. Aggregate envelope holds; drilldown via `_scheduled_functions` deferred unless aggregate drift.
- **Original Node poll-loop tooling** from waves 1–2 still parked; waves 3–5 used inline Bash + `curl` + `python3` polling inside Monitor (worked cleanly).
- **Floor at `2026-05-02 15:44`.** Backlog ~7d 22h between floor and `cutoffUsed`. Five waves moved floor +24.6 min in ~5h 47m wall time. Convergence to 48h retention requires Tier 2 automation per `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.

## Gate ledger

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| Clean-waves count at this tier | **5 / 10** (halfway) |
| Next action | another `maxRuns=16` canary, **not** back-to-back; fresh sanity/PG probe required before flip |
| Tier 2 / `maxRuns=24` gate | **NOT MET** — need ≥ 10 consecutive clean waves at Tier 1 |

## Anchors

- Origin canon at trigger time: `f97e213` (wave 4 canary closure).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Prior canary closures: `c74ca9b2fe6d`, `d88ff5ef84f3`, `694c4ce0294f`, `8734aea0c175` (in `memory/`).
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.
