# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 16:32Z, maxRuns=16, wave 9) — **CLEAN**

## Verdict

**Clean by all hard gates.** Ninth canary at Tier 1 (`maxRuns=16`). Profile reproduced exactly: terminal `completed`, 16/16 chunks, 16,000 rows deleted, env restored to 0, floor advance +5.22 min. **Duration `1,442,927 ms` (24.05 min) — new fastest of the 9-wave series**, 1.7 s faster than the prior fastest (w8 = 1,444,602 ms).

**Cleanest pacing of the series.** All 15 inter-chunk gaps observed at `93–94 s` — narrowest band yet. `SLOW_CHUNK_THRESHOLD=145` fired **0 mid-wave probes** (validated again, this is now the standard).

**Wave 8 PG-memory follow-up resolved.** cgroup `memory.stat` taken at preflight, T+0, and T+2:30 confirms the 42 % MEM% reading is **page cache, not RSS**:
- `anon` (true RSS): 8.5 MiB → 21.6 MiB (T+0) → 15.5 MiB (T+2:30) — 99.9 % below the cache mass.
- `file` (page cache): 23.74 GiB → 23.68 GiB → 23.69 GiB — stable warm cache.
- Host `available` memory unchanged at 25 GiB throughout the wave window.
- Re-halt rule 5 (PG non-cache RSS growth + MEM% > 30 %) **NOT triggered** — split is cache-dominant by 99.93 %.
- Re-halt rule 6 (host headroom < 5 GiB) **NOT triggered** — 25 GiB available.

**Series-state ledger: 8 / 10 strict clean** at Tier 1 maxRuns=16 (waves 1–5, w7, w8, w9), plus **1 yellow** (w6). 2 more strict-clean waves needed before Tier 2 / `maxRuns=24` evaluation.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778430737371-6609098e7e9d` |
| short-runId | `6609098e7e9d` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T16:32:17Z` |
| Last batch UTC (terminal sample) | `2026-05-10T16:56:22Z` |
| Terminal detected (Monitor) | `2026-05-10T16:56:22Z` |
| env restored UTC | `2026-05-10T16:56:35Z` (verified `0` ≠ `1`) |
| Total wall (`durationMs`) | **1,442,927 ms** (24m 2.9s) — **new fastest of series** |
| Avg chunk-to-chunk (server-side) | ~96 s (rest=90 s + work ~6 s) |
| Implied avg per-chunk work | ~5.2 s (`(1442927 − 15×90000) / 16` = 82.9 s / 16) |
| Cron boundary headroom at terminal | next 17:55 no-go entry = +59 m |
| Gap from prior canary terminal | wave 8 terminal 16:14:09Z → wave 9 trigger 16:32:17Z = +18m 8s |
| Slow-chunk threshold | **145 s** (standard) |
| Mid-wave probes fired | **0** |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 16:27:17Z | Preflight #9 with PG MEM follow-up — full cgroup memory.stat split, host `free -h`, 1× docker stats sample (cgroupv2 confirmed) |
| 16:31:50Z | Pre-flip runway recheck (53 m to 17:25 cutoff) — passed |
| 16:32:13Z | Operator `go run`; agent env flip 0→1 (verified `1`) |
| 16:32:17Z | Trigger returned `{status:"scheduled", runId:"1778430737371-6609098e7e9d"}` |
| 16:32:23Z | First chunk completed (batchesRun=1, deleted=1000) |
| 16:32–16:56Z | Wave executing; Monitor armed with `SLOW_CHUNK_THRESHOLD=145`. **0 probes fired across all 15 inter-chunk transitions**, all gaps tight in 93–94 s band. |
| 16:56:22Z | Terminal `completed` detected by Monitor; stream exited |
| 16:56:35Z | env flip 1→0 (verified `0`) |
| 16:57:01Z | Post-audit T+0 host probe + cgroup memory.stat split |
| 16:59:40Z | Post-audit T+2:30 host probe + cgroup memory.stat split (mandatory) |

No abort, no recovery branch, no FETCH-ERROR on Monitor poll, no `disabled`/`already-running` trigger response.

## Pre-flight #9 baseline (16:27Z) — with PG MEM follow-up

| Item | Value |
|---|---|
| env | `0` |
| Active cleanup row | none (top: prior canary `f0970af9676d`, completed) |
| `/version` × 3 | 200/200/200, 1.33–1.41 s |
| `loadavg` | `0.05 / 0.12 / 0.20` (low) |
| Containers | 3× `healthy` |
| **Host `free -h available`** | **25 GiB** ✓ (>> 5 GiB threshold) |
| **adpilot-postgres MEM%** | **42.09 %** (~16.48 GiB) — same as wave 8 post-state |
| **cgroup memory.stat (preflight):** | |
| anon | 8,912,896 B = **8.5 MiB** (true RSS) |
| active_anon | 153,305,088 B = 146 MiB |
| shmem | 144,121,856 B = 137 MiB (≈ shared_buffers + small overhead) |
| file (total cache) | 25,489,248,256 B = **23.74 GiB** |
| active_file | 16,584,372,224 B = 15.45 GiB |
| inactive_file | 8,760,750,080 B = 8.16 GiB |
| **Composition verdict** | **99.93 % cache, 0.07 % RSS — page cache hypothesis confirmed** |
| swap used / total | 812 MiB / 2.0 GiB (small, not concerning) |
| `pg_wal` | 57 files / 912 MB |
| `track_io_timing` / `shared_buffers` | `off` / `128MB` |
| Locks waiting / Idle-in-tx / Long-active >30 s | 0 / 0 / 0 |
| `DataFileRead` / `BufferIO` / `BufferPin*` | 0 / 0 / 0 |
| Origin canon | `b41f88e` |
| Cron boundary | latest start `≤ 17:25 UTC`; 57 m runway at preflight |

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778430737371-6609098e7e9d",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1442927,
  "startedAt": 1778430737371,
  "cutoffUsed": 1778257937371,
  "oldestRemainingTimestamp": 1777737924212,
  "error": null
}
```

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T16:32:17Z`.
- `oldestRemainingTimestamp` = `2026-05-02T16:05:24.212Z`.
- Backlog at terminal: ~7d 23h between `oldestRemaining` and `cutoffUsed`.

## Inter-chunk pacing — cleanest of the series

| Chunk transition | Observed gap |
|---|---|
| 1→2 | 93 s |
| 2→3 | 93 s |
| 3→4 | 94 s |
| 4→5 | 93 s |
| 5→6 | 93 s |
| 6→7 | 94 s |
| 7→8 | 93 s |
| 8→9 | 93 s |
| 9→10 | 93 s |
| 10→11 | 94 s |
| 11→12 | 93 s |
| 12→13 | 93 s |
| 13→14 | 93 s |
| 14→15 | 93 s |
| 15→16 | 93 s |

All 15 transitions in `93–94 s`. **No polling-artifact "long" 140 s observations** this run (vs wave 8: 14 normal + 1 polling-long; vs wave 7: alternating long/short pattern). This means actual server-side chunk pacing perfectly aligned with Monitor 45 s polling phase such that every transition was caught at +2 polling cycles. Phase alignment is incidental, not a meaningful difference.

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms | **1,442,927 ms** (90.2 % of envelope) | **PASS** |
| floor advance | ≥ 0, monotonic | +313,316 ms (≈ 5.22 min) | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +59 min | **PASS** |

All hard gates pass.

## Re-halt rules — none triggered

| Rule | Trigger | Wave 9 reading | Verdict |
|---|---|---|---|
| 1. Duration regression | `durationMs > 1,500,000` | 1,442,927 (fastest of series) | NOT triggered |
| 2. Sustained PG waits/locks | DFR/BIO/locks/long-active across multiple probes | 0 across all probes | NOT triggered |
| 3. Hangover load | post-wave loadavg 5m/15m elevated, not subsiding by T+2:30 | 0.27 / 0.31 at T+2:30 (declining) | NOT triggered |
| 4. Env not restored | env stays `1` after terminal | env = `0` verified | NOT triggered |
| 5. PG non-cache MEM growth | RSS-dominant memory + MEM% > 30 % | RSS = 15.5 MiB; cache = 23.69 GiB; MEM% 42.62 % is **cache** | NOT triggered |
| 6. Host headroom | `free -h available` < 5 GiB | 25 GiB | NOT triggered |

## Post-wave probes (T+0 and T+2:30)

| Metric | Pre-wave (16:27) | T+0 (16:57:01) | T+2:30 (16:59:40) |
|---|---|---|---|
| loadavg 1m / 5m / 15m | 0.05 / 0.12 / 0.20 | 0.66 / 0.39 / 0.35 | **0.13 / 0.27 / 0.31** |
| free -h available | 25 GiB | 25 GiB | **25 GiB** |
| adpilot-postgres CPU / MEM% | 0.01 % / 42.09 % | 0.00 % / 42.63 % | 0.19 % / 42.62 % |
| adpilot-convex-backend CPU / MEM% | 0.07 % / 5.91 % | 3.02 % / 5.99 % | 0.02 % / 5.94 % |
| **cgroup anon** (RSS) | 8.5 MiB | 21.6 MiB | **15.5 MiB** (settled, -6 MiB) |
| cgroup active_anon | 146 MiB | 159 MiB | 153 MiB |
| cgroup shmem | 137 MiB | 137 MiB | 137 MiB (unchanged) |
| **cgroup file** (total cache) | 23.74 GiB | 23.68 GiB | **23.69 GiB** (flat) |
| cgroup active_file | 15.45 GiB | 15.66 GiB | 15.66 GiB |
| cgroup inactive_file | 8.16 GiB | 7.88 GiB | 7.89 GiB |
| PG active / DFR / BIO / locks waiting | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |

**Hangover-free.** 1m loadavg `0.66 → 0.13` over 2:30 minutes. PG anon RSS released 6 MiB after wave (work memory). Page cache stable warm. Host headroom unchanged at 25 GiB.

## Nine-wave stability ledger

| Wave | runId (short) | Duration (ms) | Floor (UTC) | Floor Δ | Status |
|---|---|---|---|---|---|
| w1 | `c74ca9b2fe6d` | 1,455,738 | `2026-05-02T15:20:03Z` | — | clean |
| w2 | `d88ff5ef84f3` | 1,452,529 | `2026-05-02T15:25:24Z` | +5.36 min | clean |
| w3 | `694c4ce0294f` | 1,448,081 | `2026-05-02T15:30:30Z` | +5.10 min | clean |
| w4 | `8734aea0c175` | 1,451,830 | `2026-05-02T15:39:35Z` | +9.07 min | clean (sparse) |
| w5 | `25c80afba8c1` | 1,448,844 | `2026-05-02T15:44:39Z` | +5.07 min | clean |
| w6 | `d3a776d75f11` | 1,504,803 | `2026-05-02T15:49:48Z` | +5.16 min | yellow |
| w7 | `69f72eeef224` | 1,446,753 | `2026-05-02T15:55:06Z` | +5.30 min | clean (+infra warning) |
| w8 | `f0970af9676d` | 1,444,602 | `2026-05-02T16:00:10Z` | +5.08 min | clean |
| w9 | `6609098e7e9d` | **1,442,927** | `2026-05-02T16:05:24Z` | +5.22 min | **clean (new fastest)** |

**Duration trend (last 3 waves):** 1,446,753 → 1,444,602 → 1,442,927 = **−1.85 s, −1.68 s** over consecutive runs. Possible warm-cache effect (page cache 23.7 GiB persistent → fewer fresh-read latencies) or noise within ±2 s. Not yet a definitive signal; observe whether the trend continues into waves 10/11.

**Floor advance:** 8 of 9 waves in 5.07–5.36 min band; w4 outlier (+9.07 min, sparse density). w9 in band. **Cumulative floor advance 9 waves = +45m 21s** in ~8h 32m wall time (w1 trigger 08:13Z → w9 terminal 16:56Z).

## Gate ledger

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| Clean strict count | **8 / 10** (w1, w2, w3, w4, w5, w7, w8, w9) |
| Yellow count | 1 (w6) |
| Red / hard-gate breach | 0 |
| Series state | continue with armed observability |
| Tier 2 / `maxRuns=24` gate | **NOT MET** — need 2 more strict-clean waves |
| Threshold protocol | `SLOW_CHUNK_THRESHOLD=145` standard (validated 3× now) |

## Re-halt rules going forward (unchanged from wave 8)

A future wave triggers **HOLD** on any of:

1. `durationMs > 1,500,000` → real duration regression.
2. **Sustained** PG `DataFileRead` / `BufferIO` / waiting locks / long-active >30 s across multiple probes.
3. Post-wave loadavg 5m/15m elevated and not subsiding by T+2–3.
4. `env` does not return to `≠ "1"` after terminal — hard stop.
5. PG container memory split shows **non-cache** growth (RSS / anon dominant) AND post-wave MEM% > 30 % → HOLD, investigate.
6. Host `free -h available` drops below ~5 GiB → HOLD regardless.

## Caveats / parked

- **Per-chunk timings via `_scheduled_functions`** still not pulled. Wave 9's clean profile makes this less urgent.
- **w6 yellow root cause** still not identified. Wave 7, 8, 9 all clean → w6 looks increasingly like a one-time transient. If a similar +50 s outlier reappears, drilldown becomes mandatory.
- **PG container MEM%** stays at ~42 % (page cache). Confirmed mechanism, no action needed unless host `free -h available` drops below threshold or split shifts to RSS-dominant.
- **Floor at `2026-05-02 16:05`.** Backlog ~7d 23h between floor and `cutoffUsed`. Nine waves moved floor +45 min in ~8h 32m wall time. Convergence to 48h retention requires Tier 2 automation (still gated by 10/10 strict clean — 2 to go).

## Anchors

- Origin canon at trigger time: `b41f88e` (wave 8 canary closure).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Probe script (test artifact, not committed): `/tmp/wave-probe.sh`.
- Prior canary closures: w1–w8 in `memory/`.
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`, `memory/postgres-tuning.md`.
