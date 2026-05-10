# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 14:08Z, maxRuns=16, wave 6) — **YELLOW**

## Verdict

**Clean-with-yellow-caveat.** Sixth canary at Tier 1 (`maxRuns=16`). All hard gates PASS — terminal `completed`, 16/16 chunks, 16,000 rows deleted, env restored to 0, PG side fully clean, WAL flat, floor advance normal (+5.16 min). **However:** `durationMs = 1,504,803 ms` is **+56.7 s outside the prior tight 5-wave duration band** (1,448,081–1,455,738 ms; ~0.53% spread). Cause is **not** wave/PG-side: post-wave host loadavg `5m=1.57` (vs prior post-wave 5m readings 0.20–0.28 = 5–7× higher) — strong signal that **non-cleanup host load competed for resources during the wave window**, delaying scheduler dispatches by ~44 s on chunk 11→12 and ~32 s on chunk 5→6.

Ledger decision (operator + agent): **count as 6/10**, mark as `clean-with-yellow-caveat`. Reasoning:
- All hard gates passed (state, deleted, env, durationMs ≤ envelope, floor monotonic, boundary headroom).
- Cleanup profile itself produced correct outputs.
- Observed slowdown is host-side, not cleanup-side; PG is clean (0 DataFileRead / BufferIO / locks-waiting / long-active).
- A reset to 5/10 would conflate external host load with cleanup-profile drift, which the evidence does not support.

**Watchpoint:** if any subsequent wave shows `durationMs > 1,500,000` **or** post-wave `5m loadavg > 1.0` → **HOLD** before next wave, investigate host load (`docker stats`, `top`, host crons) before resuming the series.

This is **6/10** clean(-ish) waves at the new tier. Tier 2 / `maxRuns=24` gate **NOT MET**; the yellow marker means `maxRuns=24` is firmly out of scope until series resumes clean.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778422126207-d3a776d75f11` |
| short-runId | `d3a776d75f11` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T14:08:46Z` |
| Last batch UTC | `2026-05-10T14:33:55Z` (Monitor sample at terminal) |
| Terminal detected (Monitor) | `2026-05-10T14:33:55Z` |
| env restored UTC | `2026-05-10T14:34:05Z` (verified `0` ≠ `1`) |
| Total wall (`durationMs`) | **1,504,803 ms** (25m 4.8s) ⚠️ outside band |
| Avg chunk-to-chunk (observed) | ~99 s aggregate; with 2 outliers ~125 s and ~140 s |
| Cron boundary headroom at terminal | next 17:55 no-go entry = +3h 21m |
| Gap from prior canary terminal | wave 5 terminal 13:59:33Z → wave 6 trigger 14:08:46Z = +9m 13s (not back-to-back, fresh probe done) |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 14:06:31Z | Preflight (parallel operator + agent) — GREEN, no caveats; loadavg `0.12 / 0.18 / 0.25` |
| 14:08:19Z | Pre-flip runway recheck (3h 16m to 17:25 cutoff) — passed |
| 14:08:43Z | Operator `go run`; agent env flip 0→1 (verified `1`) |
| 14:08:46Z | Trigger returned `{status:"scheduled", runId:"1778422126207-d3a776d75f11"}` |
| 14:08:53Z | First chunk completed (batchesRun=1, deleted=1000) |
| 14:16:21Z | **1× FETCH-ERROR on Monitor poll** (1/5 threshold; Convex/network transient) |
| 14:17:39Z | Chunk 6 sample — gap 5→6 = ~125 s (vs normal ~93 s, +32 s anomaly) |
| 14:25:24Z | Chunk 11 sample (last "normal-pace" sample) |
| 14:27:44Z | **Chunk 12 sample — gap 11→12 = ~140 s** (vs normal ~93 s, +44 s anomaly) |
| 14:29:17Z | Chunk 13 — pace returned to normal (~93 s) |
| 14:33:55Z | Terminal `completed` detected by Monitor; stream exited |
| 14:34:05Z | env flip 1→0 (verified `0`) |
| 14:34:43Z | Post-wave PG host probe — PG clean, but **loadavg 5m=1.57** (5–7× elevation) |

## Pre-flight baseline (14:06Z)

| Item | Value |
|---|---|
| env | `0` |
| Active cleanup row | none (top: prior canary `25c80afba8c1`, completed) |
| `/version` × 3 | 200/200/200, 1.20–1.68s |
| `loadavg` | **`0.12 / 0.18 / 0.25`** (host idle) |
| Containers | 3× `healthy` |
| `pg_wal` | 57 files / 912 MB |
| Locks waiting | 0 |
| Idle-in-tx | 0 |
| `DataFileRead` / `BufferIO` / `BufferPin*` (active) | 0 / 0 / 0 |
| Long-active >30 s | 0 |
| Origin canon | `b6c9f4d` |
| Cron boundary | latest start `≤ 17:25 UTC`; 3h 18m runway |

Preflight was GREEN. **No host-side load was visible at preflight time** — the elevation appeared during the wave window itself (14:08–14:34). This makes the cause harder to attribute without a contemporaneous `docker stats` / `top` snapshot.

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778422126207-d3a776d75f11",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1504803,
  "startedAt": 1778422126207,
  "lastBatchAt": null,
  "cutoffUsed": 1778248126207,
  "oldestRemainingTimestamp": 1777736988532,
  "error": null
}
```

(Monitor reported batch=16 at 14:33:55Z; precise `lastBatchAt` not pulled — covered by terminal time.)

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T14:08:46Z`.
- `oldestRemainingTimestamp` = `2026-05-02T15:49:48Z`.
- Backlog at terminal: ~7d 22h between `oldestRemaining` and `cutoffUsed`.

## Six-wave stability ledger

| Wave | runId (short) | Duration (ms) | Floor (UTC) | Floor Δ | Tier-1 status |
|---|---|---|---|---|---|
| w1 | `c74ca9b2fe6d` | 1,455,738 | `2026-05-02T15:20:03Z` | — | clean |
| w2 | `d88ff5ef84f3` | 1,452,529 | `2026-05-02T15:25:24Z` | +5.36 min | clean |
| w3 | `694c4ce0294f` | 1,448,081 | `2026-05-02T15:30:30Z` | +5.10 min | clean |
| w4 | `8734aea0c175` | 1,451,830 | `2026-05-02T15:39:35Z` | +9.07 min | clean (sparse density) |
| w5 | `25c80afba8c1` | 1,448,844 | `2026-05-02T15:44:39Z` | +5.07 min | clean |
| w6 | `d3a776d75f11` | **1,504,803** | `2026-05-02T15:49:48Z` | +5.16 min | **clean-with-yellow** |

**Duration trend:**
- w1–w5 band: 1,448,081–1,455,738 ms (spread 7.66 s = 0.53%) — extremely tight.
- w6: 1,504,803 ms = **+56.7 s above band, +3.9% above median**. First wave to break the tight band in 6 runs.

**Floor advance:** w6 = +5.16 min, fully inside the normal 5-min density band — the slowdown did **not** affect deletion correctness or volume.

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 (= `maxRuns × batchSize`) | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms (16 × 100 s envelope) | 1,504,803 ms | **PASS** (94% of envelope) |
| floor advance | ≥ 0, monotonic | +309,307 ms (≈ 5.16 min) | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +3h 21m | **PASS** |

All hard gates pass. The yellow marker is **soft / series-stability**, not hard-gate.

## Soft signal — host load anomaly

| Metric | Pre-wave (14:06) | Post-wave (14:34) | Wave-1–5 post avg | Wave 6 vs avg |
|---|---|---|---|---|
| loadavg 1m | 0.12 | 0.80 | ~0.16 | **+5×** |
| loadavg 5m | 0.18 | **1.57** | ~0.24 | **+6.5×** |
| loadavg 15m | 0.25 | 1.18 | ~0.27 | **+4.4×** |

**Interpretation:**
- 15m=1.18 indicates sustained elevation across the wave window (~14:19–14:34Z).
- 1m at probe time (0.80) is already declining — peak load was during the wave.
- **PG side is clean throughout**: no `DataFileRead`, no `BufferIO`, no `BufferPin*`, no waiting locks, no long-active queries, idle-in-tx=0.
- Therefore the host load is **not driven by cleanup**. Most plausible: another container or external process competed for CPU, making the Convex scheduler / runtime occasionally slower to dispatch the next chunk.

Two observed delay points correlate with the load:
- chunk 5→6 gap +32 s (around 14:16–14:17Z) — also coincides with the `FETCH-ERROR` on Monitor poll (transient).
- chunk 11→12 gap +44 s (around 14:25–14:27Z).
- Sum = +76 s, vs total duration anomaly of +56.7 s → consistent ballpark accounting.

**Not investigated this wave:** which specific container or process held the CPU. Snapshot of `docker stats` / `top` was not taken contemporaneously. Added to pre-wave-7 checklist.

## Post-wave probe (14:34:43Z)

| Metric | Pre-wave | Post-wave |
|---|---|---|
| loadavg 1m / 5m / 15m | 0.12 / 0.18 / 0.25 | **0.80 / 1.57 / 1.18** ⚠️ |
| Containers | 3× healthy | 3× healthy |
| pg_stat_activity (idle / idle-in-tx) | 5 / 0 | 6 / 0 |
| Long-active >30 s | 0 | 0 |
| DataFileRead / BufferIO / BufferPin (active) | 0 / 0 / 0 | 0 / 0 / 0 |
| pg_locks waiting | 0 | 0 |
| pg_wal | 57 files / 912 MB | 57 files / 912 MB (flat) |

`pg_wal` flat across wave (same as wave 2, 5). Wave did not add net WAL.

## Pre-wave-7 protocol changes (operator + agent agreed)

In addition to the standard preflight:

1. **`docker stats` snapshot** — CPU% / MEM% across all containers; flag if any non-Convex container >20% CPU.
2. **`top -b -n 1 | head -20`** — top processes by CPU; flag any non-PG/non-Convex process consuming >10%.
3. **Quick host-cron check** — anything scheduled at the wave window slot? (Less likely on weekends, but cheap to verify.)

**Watchpoint (kill-switch for the series):**
- If wave 7 also shows `durationMs > 1,500,000` **OR** post-wave `5m loadavg > 1.0` → **HOLD**. Do not start wave 8. Investigate host load before resuming.
- If the indicator returns to normal (durationMs back in 1,448–1,456k band, post-wave 5m loadavg < 0.5) → continue series.

## Caveats / parked

- **Per-chunk timings** at coarse Monitor cadence (45 s); good enough to identify the two delay points but not for finer-grained attribution.
- **No contemporaneous `docker stats` / `top` snapshot** during this wave's anomalies — added to pre-wave-7 checklist.
- **Original Node poll-loop tooling** from waves 1–2 still parked.
- **Floor at `2026-05-02 15:49`.** Backlog ~7d 22h between floor and `cutoffUsed`. Six waves moved floor +29.7 min in ~6h 22m wall time. Convergence to 48h retention requires Tier 2 automation (still not in scope).

## Gate ledger

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| Clean-waves count at this tier | **6 / 10** (w6 = clean-with-yellow-caveat) |
| Clean-waves "strict" count (w1–w5 only) | 5 / 10 strict |
| Next action | Pre-wave-7 includes host-load checks; standard fresh preflight + `docker stats` + `top` |
| Tier 2 / `maxRuns=24` gate | **NOT MET** — both numerical (need ≥10) and quality (yellow open) |

## Anchors

- Origin canon at trigger time: `b6c9f4d` (wave 5 canary closure).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Prior canary closures: `c74ca9b2fe6d`, `d88ff5ef84f3`, `694c4ce0294f`, `8734aea0c175`, `25c80afba8c1` (in `memory/`).
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.
