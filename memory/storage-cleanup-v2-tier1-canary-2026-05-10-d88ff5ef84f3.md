# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 09:18Z, maxRuns=16, wave 2)

## Verdict

**Clean.** Second consecutive canary at Tier 1 (`maxRuns=16`). Profile reproduced exactly: 16/16 chunks, 16,000 rows deleted, terminal `completed`, env restored to 0. Wave 1 vs wave 2 stability is **near-identical** — duration delta `−3,209 ms` (~0.2% faster), floor advance delta `+11 s` (5m21s vs 5m10s). No PG/host footprint across pre and post probes.

This is **2/10** clean waves required at the new tier before considering Tier 2 (automation) or `maxRuns=24`. Series accumulating cleanly.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778404738105-d88ff5ef84f3` |
| short-runId | `d88ff5ef84f3` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T09:18:58Z` |
| Last batch UTC | `2026-05-10T09:43:10Z` |
| env restored UTC | post-terminal (verified `0` ≠ `1`) |
| Total wall (`durationMs`) | `1,452,529 ms` (24m 12.5s) |
| Avg chunk-to-chunk | ~90.8 s (rest=90 s + ~0.8 s controller overhead) |
| Implied avg per-chunk work | ~6.4 s (`(1452529 − 15×90000) / 16` = 102.5 s / 16) |
| Cron boundary headroom at terminal | next 12:00 UTC = +2h 17m |
| Gap from prior canary terminal | wave 1 terminal 08:37:36Z → wave 2 trigger 09:18:58Z = **+41m 22s** (not back-to-back) |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 09:08:44Z | Operator preflight start |
| 09:10:02Z | Agent independent preflight verification — GREEN match |
| 09:18:58Z | Trigger `internal.metrics.cleanupOldRealtimeMetricsV2 {batchSize:1000,timeBudgetMs:10000,restMs:90000,maxRuns:16}` (operator) |
| 09:18–09:43Z | Wave executing in scheduler chain |
| 09:43:10Z | Terminal `completed` (batchesRun=16/16, deleted=16,000) |
| 09:43–09:54Z | env flip 1→0 (verified `0`), post-audit, PG re-probe |
| 09:54:36Z | Agent independent post-wave verification — GREEN match (exact numeric agreement on row + PG state) |

No abort, no recovery branch, no `disabled`/`already-running` trigger response.

## Pre-flight baseline (snapshot at 09:08–09:10Z)

| Item | Value |
|---|---|
| env | `0` (idle-safe) |
| Active cleanup row | none (top: prior canary `c74ca9b2fe6d`, completed) |
| `/version` × 3 | 200/200/200, 1.39–1.75s (within instance baseline 1.2–1.75s) |
| `track_io_timing` | `off` (default) |
| `shared_buffers` | `128MB` (storm-fix state, unchanged) |
| `pg_wal` | **72 files / 1,152 MB** (unchanged from wave 1 post-audit) |
| Locks waiting | 0 |
| Idle-in-tx | 0 |
| Active wait_events `DataFileRead` / `BufferIO` / `BufferPin*` | 0 / 0 / 0 |
| Long-active queries (>30s) | 0 |
| `loadavg` | `0.19 / 0.23 / 0.24` |
| Containers | 3× `healthy` |
| Origin canon | `3b37a81` (wave 1 closure committed) |
| Cron boundary headroom at trigger | next 11:55 no-go entry = +2h 36m; latest safe start `≤ 11:25` (boundary − 35 min) — **passed gate** |

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778404738105-d88ff5ef84f3",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1452529,
  "startedAt": 1778404738105,
  "lastBatchAt": 1778406190613,
  "cutoffUsed": 1778231938105,
  "oldestRemainingTimestamp": 1777735524822,
  "error": null
}
```

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T09:18:58Z`.
- `oldestRemainingTimestamp` = `2026-05-02T15:25:24.822Z`.
- Backlog at terminal: ~7d 18h between `oldestRemaining` and `cutoffUsed`.

## Wave 1 → Wave 2 stability comparison

| Metric | Wave 1 (`c74ca9b2fe6d`) | Wave 2 (`d88ff5ef84f3`) | Δ |
|---|---|---|---|
| Profile | `1000/10000/90000/16` | `1000/10000/90000/16` | identical |
| Duration | 1,455,738 ms | 1,452,529 ms | **−3,209 ms** (~0.2% faster) |
| Deleted | 16,000 | 16,000 | exact |
| Floor advance | +5m 10s (310,076 ms) | +5m 21s (321,365 ms) | +11s |
| pg_wal change during wave | −4 files / −64 MB | 0 / 0 (unchanged) | — |
| Hard-gate breaches | 0 | 0 | — |

Variance well within noise. No drift at this profile after 2 waves.

## Floor advance

Prior wave (`c74ca9b2fe6d`):
- `oldestRemainingTimestamp` = `1,777,735,203,457` ms = `2026-05-02T15:20:03Z`

This wave (`d88ff5ef84f3`):
- `oldestRemainingTimestamp` = `1,777,735,524,822` ms = `2026-05-02T15:25:24Z`

**Δ = +321,365 ms ≈ +5m 21s** floor advance.

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 (= `maxRuns × batchSize`) | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms (16 × 100s envelope) | 1,452,529 ms | **PASS** |
| floor advance | ≥ 0, monotonic | +321,365 ms | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +2h 17m | **PASS** |

## Post-wave probe (~09:54–09:56Z)

| Metric | Pre-wave | Post-wave (operator-reported) | Post-wave (agent re-verified) |
|---|---|---|---|
| loadavg 1m / 5m / 15m | 0.19 / 0.23 / 0.24 | 0.10 / 0.22 / 0.26 | **0.07 / 0.10 / 0.18** |
| Containers | 3× healthy | 3× healthy | 3× healthy |
| pg_stat_activity (idle / idle-in-tx / long-active>30s) | 4 / 0 / 0 | 0 / 0 reported | **idle:4 / 0 / 0** |
| DataFileRead / BufferIO / BufferPin (active) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| pg_locks waiting | 0 | (implied 0) | 0 |
| pg_wal | 72 files / 1152 MB | 72 / 1152 MB unchanged | **72 / 1152 MB unchanged** |

**`pg_wal` movement:** 0 across the wave (preflight 72/1152 → post-wave 72/1152). Same neutral observation as wave 1 — count-based metric (`pg_ls_waldir()`) tracks pre-allocated 16 MB segments, not bytes-within-segment. Wave did not add net WAL segments.

## Caveats / parked

- **Per-chunk timings not captured from backend logs.** Backend stdout grep for `[cleanup-v2]` did not return per-chunk lines this run. Aggregate envelope holds; implied avg per-chunk work ~6.4 s (well under `timeBudgetMs=10000`). If a future wave shows aggregate drift or hard-gate near-miss, drilldown via `_scheduled_functions` system table.
- **Local poll-loop tooling** still wrote zero lines (same Node nohup + non-ASCII cwd suspect from wave 1). Parked, not blocking. Primary monitoring path through direct `cleanupRunState` reads continues to work.
- **Floor still at `2026-05-02 15:25`.** Backlog ~7d 18h between floor and `cutoffUsed`. Two waves at +5 min/wave each = +10 min in ~71 min wall time; convergence to 48h retention requires Tier 2 automation per `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.

## Gate ledger

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| Clean-waves count at this tier | **2 / 10** |
| Next action | another `maxRuns=16` canary, **not** back-to-back (require fresh sanity/PG probe before next) |
| Tier 2 / `maxRuns=24` gate | **NOT MET** — need ≥ 10 consecutive clean waves at Tier 1 |

## Anchors

- Origin canon at trigger time: `3b37a81` (wave 1 canary closure).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Prior canary closure: `memory/storage-cleanup-v2-tier1-canary-2026-05-10-c74ca9b2fe6d.md`.
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.
