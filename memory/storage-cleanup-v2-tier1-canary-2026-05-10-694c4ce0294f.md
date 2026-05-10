# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 10:50Z, maxRuns=16, wave 3)

## Verdict

**Clean.** Third consecutive canary at Tier 1 (`maxRuns=16`). Profile reproduced exactly: 16/16 chunks, 16,000 rows deleted, terminal `completed`, env restored to 0. Three-wave duration trend monotonically declining (1,455,738 → 1,452,529 → **1,448,081 ms**) — within noise (~0.3–0.5% per wave), no degradation. Floor advance stable in the **5.10–5.36 min/wave** band. No PG/host footprint across pre and post probes.

This is **3/10** clean waves required at the new tier before considering Tier 2 (automation) or `maxRuns=24`. Series accumulating cleanly.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778410223891-694c4ce0294f` |
| short-runId | `694c4ce0294f` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T10:50:23Z` |
| Last batch UTC | `2026-05-10T11:14:31Z` |
| Terminal detected (Monitor) | `2026-05-10T11:15:18Z` |
| env restored UTC | `2026-05-10T11:15:30Z` (verified `0` ≠ `1`) |
| Total wall (`durationMs`) | `1,448,081 ms` (24m 8.1s) |
| Avg chunk-to-chunk (observed) | ~96 s (rest=90 s + work ~6 s) |
| Implied avg per-chunk work | ~6.1 s (`(1448081 − 15×90000) / 16` = 98.1 s / 16) |
| Cron boundary headroom at terminal | next 11:55 no-go entry = +40 m |
| Gap from prior canary terminal | wave 2 terminal 09:43:10Z → wave 3 trigger 10:50:23Z = **+1h 7m 13s** (not back-to-back) |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 10:19:41Z | Operator + agent preflight (parallel verification, GREEN with 1m loadavg=1.14 transient observation) |
| 10:47:11Z | Re-probe: 1m loadavg `0.23` settled, 1 transient `DataFileRead` observed |
| 10:47:43Z | 2 quick PG samples (5 s apart): `DataFileRead=0` cleared — transient confirmed |
| 10:49:34Z | Pre-flip runway recheck (35 min until 11:25 cutoff) — passed |
| 10:50:21Z | Operator `go run`; agent env flip 0→1 (verified `1`) |
| 10:50:21–10:50:23Z | Trigger `internal.metrics.cleanupOldRealtimeMetricsV2 {1000/10000/90000/16}` |
| 10:50:23Z | Action returned `{status:"scheduled", runId:"1778410223891-694c4ce0294f"}` |
| 10:50:30Z | First chunk completed (batchesRun=1, deleted=1000) — verified via `cleanupRunState` |
| 10:50–11:14Z | Wave executing in scheduler chain; Monitor armed for batch progression + terminal |
| 11:03:48Z | Single transient FETCH-ERROR (1/5 threshold) on Monitor poll — recovered next sample |
| 11:14:32Z | Final chunk (16/16) reached; state still `running` (markCompletedV2 in flight) |
| 11:15:18Z | Terminal `completed` detected by Monitor; stream exited |
| 11:15:30Z | env flip 1→0 (verified `0`) |
| 11:16:07Z | Post-wave PG host probe (GREEN) |

No abort, no recovery branch, no `disabled`/`already-running` trigger response.

## Pre-flight baseline

Two preflight passes: initial GREEN with 1m loadavg=1.14 transient noted; re-probe 27 min later confirmed settled (`0.23`) with one transient `DataFileRead` that cleared on the next two consecutive samples.

| Item | Initial preflight (10:19) | Re-probe (10:47) |
|---|---|---|
| env | `0` | `0` |
| Active cleanup row | none | none |
| `/version` × 3 | 200/200/200, 1.36–1.72s | (not re-sampled; no degradation expected) |
| `track_io_timing` | `off` | (unchanged) |
| `shared_buffers` | `128MB` | (unchanged) |
| `pg_wal` | 70 files / 1120 MB | (PG state probe only) |
| Locks waiting | 0 | 0 |
| Idle-in-tx | 0 | 0 |
| `DataFileRead` / `BufferIO` / `BufferPin*` (active) | 0 / 0 / 0 | **1 / 0 / 0** then **0 / 0 / 0** ×2 (transient confirmed) |
| Long-active queries (>30 s) | 0 | 0 |
| `loadavg` | `1.14 / 0.38 / 0.24` | **`0.23 / 0.48 / 0.34`** ✓ settled |
| Containers | 3× `healthy` | 3× `healthy` |
| Origin canon | `f3fba2a` | (unchanged) |
| Cron boundary headroom at trigger (10:50) | latest start `≤ 11:25 UTC` (boundary − 35 min) — passed gate, 35 min runway | — |

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778410223891-694c4ce0294f",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1448081,
  "startedAt": 1778410223891,
  "lastBatchAt": 1778411671961,
  "cutoffUsed": 1778237423891,
  "oldestRemainingTimestamp": 1777735830782,
  "error": null
}
```

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T10:50:23Z`.
- `oldestRemainingTimestamp` = `2026-05-02T15:30:30.782Z`.
- Backlog at terminal: ~7d 19h between `oldestRemaining` and `cutoffUsed`.

## Three-wave stability ledger

| Wave | runId (short) | Profile | Duration (ms) | Deleted | Floor (UTC) | Floor Δ vs prev |
|---|---|---|---|---|---|---|
| w1 | `c74ca9b2fe6d` | `1000/10000/90000/16` | 1,455,738 | 16,000 | `2026-05-02T15:20:03Z` | — |
| w2 | `d88ff5ef84f3` | `1000/10000/90000/16` | 1,452,529 | 16,000 | `2026-05-02T15:25:24Z` | **+5.36 min** |
| w3 | `694c4ce0294f` | `1000/10000/90000/16` | **1,448,081** | 16,000 | `2026-05-02T15:30:30Z` | **+5.10 min** |

Duration trend: w1 → w2 → w3 = **−3,209 → −4,448 ms** per wave-pair. Within noise; possibly mild cache warming, not yet a signal. Floor advance band: `5.10–5.36 min` — tight reproducibility. **No drift in any hard-gate metric across three runs.**

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 (= `maxRuns × batchSize`) | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms (16 × 100 s envelope) | 1,448,081 ms | **PASS** |
| floor advance | ≥ 0, monotonic | +306,000 ms (≈ 5.10 min) | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +40 min | **PASS** |

## Post-wave probe (11:16:07Z)

| Metric | Pre-wave (10:19 / 10:47) | Post-wave (11:16) |
|---|---|---|
| loadavg 1m / 5m / 15m | 1.14 → 0.23 / 0.38 → 0.48 / 0.24 → 0.34 | **0.30 / 0.25 / 0.26** |
| Containers | 3× healthy | 3× healthy |
| pg_stat_activity (idle / idle-in-tx) | 7 / 0 (initial) | **5 / 0** |
| Long-active >30 s | 0 | 0 |
| DataFileRead / BufferIO / BufferPin (active) | 0 / 0 / 0 (after transient cleared) | 0 / 0 / 0 |
| pg_locks waiting | 0 | 0 |
| pg_wal | 70 files / 1120 MB | **66 files / 1056 MB** (Δ −4 files / −64 MB) |

**`pg_wal` movement:** size decreased by 4 segments / 64 MB during the wave window. Same neutral observation as wave 1 (wave 2 was flat) — count-based metric tracks pre-allocated 16 MB segments, decrements indicate WAL recycle/reuse, not net growth. No attribution claimed.

## Caveats / parked

- **Per-chunk timings** captured at coarse resolution from Monitor poll cadence (45 s) only — sufficient to confirm steady chunk-to-chunk pacing (~96 s) but not exact per-chunk durations. Aggregate envelope holds; drilldown via `_scheduled_functions` deferred unless aggregate drift.
- **Local poll-loop tooling** replaced this run with inline Bash + `curl` + `python3` polling inside Monitor. Worked cleanly. Original Node nohup tooling (`/tmp/cleanup-v2-poll.cjs`) still parked from waves 1–2.
- **Floor at `2026-05-02 15:30`.** Backlog ~7d 19h between floor and `cutoffUsed`. Three waves moved floor +15.6 min in ~2h 25m wall time (wave 1 trigger 08:13 → wave 3 terminal 11:14). Convergence to 48h retention requires Tier 2 automation per `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.

## Gate ledger

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| Clean-waves count at this tier | **3 / 10** |
| Next action | another `maxRuns=16` canary, **not** back-to-back; **after no-go window** (12:05 UTC / 15:05 МСК); fresh sanity/PG probe required before flip |
| Tier 2 / `maxRuns=24` gate | **NOT MET** — need ≥ 10 consecutive clean waves at Tier 1 |

## Anchors

- Origin canon at trigger time: `f3fba2a` (wave 2 canary closure).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Prior canary closures: `memory/storage-cleanup-v2-tier1-canary-2026-05-10-c74ca9b2fe6d.md`, `memory/storage-cleanup-v2-tier1-canary-2026-05-10-d88ff5ef84f3.md`.
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.
