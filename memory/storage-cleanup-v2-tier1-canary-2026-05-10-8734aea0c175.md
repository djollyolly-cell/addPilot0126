# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 12:51Z, maxRuns=16, wave 4)

## Verdict

**Clean.** Fourth consecutive canary at Tier 1 (`maxRuns=16`). Profile reproduced exactly: 16/16 chunks, 16,000 rows deleted, terminal `completed`, env restored to 0. Duration `1,451,830 ms` (24m 11.8s) within tight 4-wave band (1,448,081–1,455,738 ms; spread ~0.5%). No PG/host footprint across pre and post probes.

**Floor advance +9.07 min vs prev** (band so far: 5.10–9.07 min). Recorded as **positive density variance**, not a caveat — `oldestRemainingTimestamp` advances by clock-time spanned by deleted rows, not by row count. The 16K rows landed on a sparser segment of `metricsRealtime`, so floor jumped further per row than in waves 1–3. Good news for backlog reduction; not a degradation signal.

This is **4/10** clean waves required at the new tier before considering Tier 2 (automation) or `maxRuns=24`.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778417464345-8734aea0c175` |
| short-runId | `8734aea0c175` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T12:51:04Z` |
| Last batch UTC | `2026-05-10T13:15:16Z` |
| Terminal detected (Monitor) | `2026-05-10T13:15:48Z` |
| env restored UTC | `2026-05-10T13:15:58Z` (verified `0` ≠ `1`) |
| Total wall (`durationMs`) | `1,451,830 ms` (24m 11.8s) |
| Avg chunk-to-chunk (observed) | ~96 s (rest=90 s + work ~6 s) |
| Implied avg per-chunk work | ~6.4 s (`(1451830 − 15×90000) / 16` = 102.0 s / 16) |
| Cron boundary headroom at terminal | next 17:55 no-go entry = +4h 39m |
| Gap from prior canary terminal | wave 3 terminal 11:15:18Z → wave 4 trigger 12:51:04Z = **+1h 35m 46s** (not back-to-back) |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 12:42:17Z | Preflight (parallel operator + agent) — GREEN, no caveats; cleanest preflight of session |
| 12:50:31Z | Pre-flip runway recheck (4h 34m to 17:25 cutoff) — passed |
| 12:51:02Z | Operator `go run`; agent env flip 0→1 (verified `1`) |
| 12:51:02–12:51:04Z | Trigger `internal.metrics.cleanupOldRealtimeMetricsV2 {1000/10000/90000/16}` |
| 12:51:04Z | Action returned `{status:"scheduled", runId:"1778417464345-8734aea0c175"}` |
| 12:51:10Z | First chunk completed (batchesRun=1, deleted=1000) — verified via `cleanupRunState` |
| 12:51–13:15Z | Wave executing in scheduler chain; Monitor armed for batch progression + terminal |
| 13:15:48Z | Terminal `completed` detected by Monitor; stream exited |
| 13:15:58Z | env flip 1→0 (verified `0`) |
| 13:16:34Z | Post-wave PG host probe (GREEN) |

No abort, no recovery branch, no transient FETCH-ERROR on Monitor poll, no `disabled`/`already-running` trigger response.

## Pre-flight baseline (snapshot at 12:42Z)

| Item | Value |
|---|---|
| env | `0` (idle-safe) |
| Active cleanup row | none (top: prior canary `694c4ce0294f`, completed) |
| `/version` × 3 | 200/200/200, 1.23–1.29s (fastest of session) |
| `track_io_timing` | `off` |
| `shared_buffers` | `128MB` (storm-fix state, unchanged) |
| `pg_wal` | **61 files / 976 MB** (further recycled from 66/1056 after wave 3) |
| Locks waiting | 0 |
| Idle-in-tx | 0 |
| Active wait_events `DataFileRead` / `BufferIO` / `BufferPin*` | 0 / 0 / 0 |
| Long-active queries (>30 s) | 0 |
| `loadavg` | `0.06 / 0.11 / 0.15` (lowest of session) |
| Containers | 3× `healthy` |
| Origin canon | `6b300fd` |
| Cron boundary | latest start `≤ 17:25 UTC` (boundary 18:00 − 35 min); 4h 37m runway at preflight |

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778417464345-8734aea0c175",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1451830,
  "startedAt": 1778417464345,
  "lastBatchAt": 1778418916160,
  "cutoffUsed": 1778244664345,
  "oldestRemainingTimestamp": 1777736375116,
  "error": null
}
```

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T12:51:04Z`.
- `oldestRemainingTimestamp` = `2026-05-02T15:39:35.116Z`.
- Backlog at terminal: ~7d 21h between `oldestRemaining` and `cutoffUsed`.

## Four-wave stability ledger

| Wave | runId (short) | Duration (ms) | Deleted | Floor (UTC) | Floor Δ vs prev |
|---|---|---|---|---|---|
| w1 | `c74ca9b2fe6d` | 1,455,738 | 16,000 | `2026-05-02T15:20:03Z` | — |
| w2 | `d88ff5ef84f3` | 1,452,529 | 16,000 | `2026-05-02T15:25:24Z` | +5.36 min |
| w3 | `694c4ce0294f` | 1,448,081 | 16,000 | `2026-05-02T15:30:30Z` | +5.10 min |
| w4 | `8734aea0c175` | **1,451,830** | 16,000 | `2026-05-02T15:39:35Z` | **+9.07 min** |

**Duration:** spread `1,448,081 – 1,455,738 ms` = 7.66 s = ~0.53% across 4 waves. Tight reproducibility, no drift signal.

**Floor advance:** waves 1–3 in tight 5.10–5.36 min band; wave 4 jumped to 9.07 min. Interpretation: 16K rows deleted in wave 4 spanned a wider clock-time interval than in the prior three waves. This reflects **density variance in `metricsRealtime` along the deletion frontier**, not a wave-side change. Mechanically: the cleanup deletes by oldest-first regardless of timestamp gaps; if the next batch of 16K rows happens to be sparsely distributed, `oldestRemainingTimestamp` advances further per row.

Between wave 3 terminal (11:15:18Z) and wave 4 trigger (12:51:04Z) — `cleanupRunState` row count went 14 → 14 (no organic cron rows added). The +9 min advance is fully attributable to wave 4's deletion, not to inter-wave organic cleanup.

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 (= `maxRuns × batchSize`) | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms (16 × 100 s envelope) | 1,451,830 ms | **PASS** |
| floor advance | ≥ 0, monotonic | +544,334 ms (≈ 9.07 min) | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +4h 39m | **PASS** |

## Post-wave probe (13:16:34Z)

| Metric | Pre-wave (12:42) | Post-wave (13:16) |
|---|---|---|
| loadavg 1m / 5m / 15m | 0.06 / 0.11 / 0.15 | **0.15 / 0.20 / 0.28** |
| Containers | 3× healthy | 3× healthy |
| pg_stat_activity (idle / idle-in-tx) | 5 / 0 | **4 / 0** |
| Long-active >30 s | 0 | 0 |
| DataFileRead / BufferIO / BufferPin (active) | 0 / 0 / 0 | 0 / 0 / 0 |
| pg_locks waiting | 0 | 0 |
| pg_wal | 61 files / 976 MB | **57 files / 912 MB** (Δ −4 files / −64 MB) |

**`pg_wal` movement:** size decreased by 4 segments / 64 MB during the wave window. Same neutral observation as waves 1 and 3 (wave 2 was flat). Count-based metric tracks pre-allocated 16 MB segments; decrements indicate WAL recycle/reuse, not net growth. No attribution claimed; cause space includes WAL recycle / archive / replication slot release.

## Caveats / parked

- **Per-chunk timings** captured at coarse Monitor cadence (45 s) only — sufficient to confirm steady ~96 s chunk-to-chunk pacing. Drilldown via `_scheduled_functions` deferred unless aggregate drift.
- **Original Node poll-loop tooling** from waves 1–2 still parked; waves 3–4 used inline Bash + `curl` + `python3` polling inside Monitor (worked cleanly).
- **Floor at `2026-05-02 15:39`.** Backlog ~7d 21h between floor and `cutoffUsed`. Four waves moved floor +24.6 min in ~5h wall time (wave 1 trigger 08:13 → wave 4 terminal 13:15). Convergence to 48h retention requires Tier 2 automation per `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.

## Gate ledger

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| Clean-waves count at this tier | **4 / 10** |
| Next action | another `maxRuns=16` canary, **not** back-to-back; fresh sanity/PG probe required before flip |
| Tier 2 / `maxRuns=24` gate | **NOT MET** — need ≥ 10 consecutive clean waves at Tier 1 |

## Anchors

- Origin canon at trigger time: `6b300fd` (wave 3 canary closure).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Prior canary closures: `memory/storage-cleanup-v2-tier1-canary-2026-05-10-c74ca9b2fe6d.md`, `memory/storage-cleanup-v2-tier1-canary-2026-05-10-d88ff5ef84f3.md`, `memory/storage-cleanup-v2-tier1-canary-2026-05-10-694c4ce0294f.md`.
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.
