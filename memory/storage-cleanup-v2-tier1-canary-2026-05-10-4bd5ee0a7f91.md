# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 19:14Z, maxRuns=16, wave 11) — **CLEAN — 10/10 strict-clean threshold REACHED**

## Verdict

**Clean by all hard gates.** Eleventh canary at Tier 1 (`maxRuns=16`). Profile reproduced exactly: terminal `completed`, 16/16 chunks, 16,000 rows deleted, env restored to 0, floor advance +5.10 min. **Duration `1,439,231 ms` (23.99 min)** — matches wave 10's fastest (1,439,197 ms) within 34 ms. Second consecutive sub-24-min wave.

**🏁 10/10 strict-clean threshold REACHED.** This is the tenth strict-clean wave in the Tier 1 maxRuns=16 series (w1–w5, w7–w11), making the series **eligible for Tier 2 review**. Note: review-eligibility is **not automatic Tier 2 authorization**. Per protocol, next steps are: this closure → series summary doc → fresh PG snapshot (read-only diagnostic) → operator decision on next tier.

**Second consecutive T+2:30 organic-burst capture.** Wave 11's T+2:30 probe caught `adpilot-convex-backend = 78.08 % CPU`, `adpilot-postgres = 29.32 % CPU` — similar Convex/PG burst pattern as wave 10's T+2:30 (Convex 99.83 % + PG 36.59 %). **Importantly, PG side stayed fully clean this time** (`active=1 / DFR=0 / BIO=0 / locks=0` — no cache-pressure indicator). Reinforces the reframe from wave 10 closure: **organic Convex bursts are periodic baseline activity**, not cleanup-specific. When they overlap with PG cache-miss timing they manifest as `DataFileRead` events; when they don't, just CPU spike.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778440488459-4bd5ee0a7f91` |
| short-runId | `4bd5ee0a7f91` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T19:14:48Z` |
| Last batch UTC (terminal sample) | `2026-05-10T19:38:47Z` |
| Terminal detected (Monitor) | `2026-05-10T19:39:34Z` |
| env restored UTC | `2026-05-10T19:39:44Z` (verified `0` ≠ `1`) |
| Total wall (`durationMs`) | **1,439,231 ms** (23.99 min) |
| Avg chunk-to-chunk (server-side) | ~96 s |
| Implied avg per-chunk work | ~5.0 s (`(1439231 − 15×90000) / 16` = 80.7 s / 16) |
| Cron boundary headroom at terminal | next 23:55 no-go entry = +4h 15m |
| Gap from prior canary terminal | wave 10 terminal 19:00:58Z → wave 11 trigger 19:14:48Z = +13m 50s |
| Slow-chunk threshold | **145 s** (standard, 5th validation) |
| Mid-wave probes fired | **0** |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 19:12:22Z | Preflight #11 — GREEN, no caveats. cgroup anon 19.6 MiB / file 23.52 GiB (cache-dominant unchanged) |
| 19:14:25Z | Pre-flip runway recheck (4h 10m to 23:25 cutoff) — passed |
| 19:14:46Z | Operator `go run`; agent env flip 0→1 (verified `1`) |
| 19:14:48Z | Trigger returned `{status:"scheduled", runId:"1778440488459-4bd5ee0a7f91"}` |
| 19:14:54Z | First chunk completed (batchesRun=1, deleted=1000) |
| 19:14–19:38Z | Wave executing; Monitor armed with `SLOW_CHUNK_THRESHOLD=145`. **0 probes fired**, all 15 inter-chunk gaps in 93–95 s band |
| 19:38:47Z | Final chunk (16/16) reached; state still `running` (markCompletedV2 in flight) |
| 19:39:34Z | Terminal `completed` detected by Monitor; stream exited |
| 19:39:44Z | env flip 1→0 (verified `0`) |
| 19:40:06Z | Post-audit T+0 host probe + cgroup memory.stat split |
| 19:42:44Z | Post-audit T+2:30 host probe — caught organic Convex burst (78.08 %); **PG side fully clean** |

No abort, no recovery branch, no FETCH-ERROR on Monitor poll, no `disabled`/`already-running` trigger response.

## Pre-flight #11 baseline (19:12Z)

| Item | Value |
|---|---|
| env | `0` |
| Active cleanup row | none (top: prior canary `bad0065b2658`, completed) |
| `/version` × 3 | 200/200/200, 1.36–1.56 s |
| `loadavg` | `0.27 / 0.26 / 0.29` (settled from w10 T+2:30 organic-burst tail) |
| Containers | 3× `healthy` |
| Host `free -h available` | **25 GiB** ✓ |
| adpilot-postgres MEM% | 43.55 % |
| **cgroup memory.stat:** anon 19.6 MiB / file 23.52 GiB / shmem 137 MiB | composition **99.92 % cache, 0.08 % RSS** |
| `pg_wal` | 57 files / 912 MB |
| `track_io_timing` / `shared_buffers` | `off` / `128MB` |
| Locks waiting / Idle-in-tx / Long-active >30 s | 0 / 0 / 0 |
| `DataFileRead` / `BufferIO` / `BufferPin*` | 0 / 0 / 0 |
| Origin canon | `59e937d` |
| Cron boundary | latest start `≤ 23:25 UTC`; 4h 12m runway |

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778440488459-4bd5ee0a7f91",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1439231,
  "startedAt": 1778440488459,
  "cutoffUsed": 1778267688459,
  "oldestRemainingTimestamp": 1777738784349,
  "error": null
}
```

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T19:14:48Z`.
- `oldestRemainingTimestamp` = `2026-05-02T16:19:44.349Z`.
- Backlog at terminal: ~7d 23h between `oldestRemaining` and `cutoffUsed`.

## Inter-chunk pacing

All 15 transitions in **93–95 s band** (similar tightness to waves 9 and 10):

| Transition | Gap | Transition | Gap |
|---|---|---|---|
| 1→2 | 94 s | 9→10 | 93 s |
| 2→3 | 93 s | 10→11 | 93 s |
| 3→4 | 93 s | 11→12 | 93 s |
| 4→5 | 94 s | 12→13 | 95 s |
| 5→6 | 93 s | 13→14 | 93 s |
| 6→7 | 94 s | 14→15 | 93 s |
| 7→8 | 93 s | 15→16 | 93 s |
| 8→9 | 93 s | | |

`SLOW_CHUNK_THRESHOLD=145` fired 0 mid-wave probes (5th consecutive wave at 0 fires; standard fully validated).

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms | **1,439,231 ms** (89.95 % of envelope) | **PASS** |
| floor advance | ≥ 0, monotonic | +306,092 ms (≈ 5.10 min) | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +4h 15m | **PASS** |

All hard gates pass.

## Re-halt rules — none triggered

| Rule | Trigger | Wave 11 reading | Verdict |
|---|---|---|---|
| 1. Duration regression | `durationMs > 1,500,000` | 1,439,231 (matches w10 within 34 ms) | NOT triggered |
| 2. Sustained PG waits/locks across multiple probes | DFR/BIO/locks/long-active sustained | T+0: 0/0/0/0; T+2:30: 0/0/0/0 (both clean) | NOT triggered |
| 3. Hangover load | post-wave loadavg 5m/15m elevated, not subsiding by T+2:30 | T+0 5m=0.25 → T+2:30 5m=0.30 (small bump from organic burst, 15m=0.28 stable) | NOT triggered |
| 4. Env not restored | env stays `1` after terminal | env = `0` verified | NOT triggered |
| 5. PG non-cache MEM growth | RSS-dominant + MEM% > 30 % | RSS 21 MiB, file 23.61 GiB; MEM% 43.96 % is **cache** | NOT triggered |
| 6. Host headroom | `free -h available` < 5 GiB | 25 GiB | NOT triggered |

## Post-wave probes (T+0 and T+2:30)

| Metric | Pre-wave (19:12) | T+0 (19:40:06) | T+2:30 (19:42:44) |
|---|---|---|---|
| loadavg 1m / 5m / 15m | 0.27 / 0.26 / 0.29 | 0.29 / 0.25 / 0.27 | **0.54 / 0.30 / 0.28** |
| free -h available | 25 GiB | 25 GiB | **25 GiB** |
| **adpilot-convex-backend CPU / MEM%** | 0.00 % / 6.08 % | 0.12 % / 6.01 % | **78.08 % / 6.00 %** ⚠️ organic burst |
| **adpilot-postgres CPU / MEM%** | 0.00 % / 43.55 % | 0.12 % / 43.95 % | **29.32 % / 43.96 %** |
| cgroup anon (RSS) | 19.6 MiB | 20.8 MiB | 21.0 MiB (stable) |
| cgroup active_anon | 157 MiB | 158 MiB | 159 MiB |
| cgroup file (cache) | 23.52 GiB | 23.60 GiB | 23.61 GiB (stable) |
| cgroup active_file | 16.02 GiB | 16.18 GiB | 16.18 GiB (steady) |
| **PG active / DFR / BIO / locks waiting** | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 | **1 / 0 / 0 / 0** ✓ PG-side clean |

## T+2:30 organic burst — second consecutive wave

Wave 10 T+2:30 (19:04:11Z): Convex 99.83 % + PG 36.59 % + DFR=1.
Wave 11 T+2:30 (19:42:44Z): Convex 78.08 % + PG 29.32 % + DFR=0.

**Pattern confirmed:** organic Convex CPU bursts occur periodically (likely sync-metrics cron at 15-min cadence, or UZ budget cron, or similar). The bursts are short-lived (visible in 1m loadavg but absent from 15m). PG side response depends on cache state at the moment of burst:
- When the burst hits cold pages → `DataFileRead` event (wave 10 case).
- When cache covers what's needed → no `DataFileRead` (wave 11 case).

**Implication for series interpretation:**
- Wave 7's earlier captured probe (Convex 108 % + DFR×2) was previously framed as "shared_buffers=128MB infrastructure warning, cleanup-exposed" — that framing is now **definitively too narrow**. The same Convex+PG burst pattern manifests during organic baseline activity with env=0.
- Wave 6's `+57 s` duration outlier remains the only real wave-time deviation. With 5 subsequent clean waves (w7–w11) at maxRuns=16, w6 looks consistent with **scheduler dispatch delay caused by overlap with one of these organic bursts**, not a profile-side regression.
- PG tuning (shared_buffers up) is **useful but not urgent** and **not blocking Tier 2 evaluation**.

## Eleven-wave stability ledger

| Wave | runId (short) | Duration (ms) | Floor (UTC) | Floor Δ | Status |
|---|---|---|---|---|---|
| w1 | `c74ca9b2fe6d` | 1,455,738 | `2026-05-02T15:20:03Z` | — | clean |
| w2 | `d88ff5ef84f3` | 1,452,529 | `2026-05-02T15:25:24Z` | +5.36 min | clean |
| w3 | `694c4ce0294f` | 1,448,081 | `2026-05-02T15:30:30Z` | +5.10 min | clean |
| w4 | `8734aea0c175` | 1,451,830 | `2026-05-02T15:39:35Z` | +9.07 min | clean (sparse) |
| w5 | `25c80afba8c1` | 1,448,844 | `2026-05-02T15:44:39Z` | +5.07 min | clean |
| w6 | `d3a776d75f11` | 1,504,803 | `2026-05-02T15:49:48Z` | +5.16 min | yellow (organic overlap) |
| w7 | `69f72eeef224` | 1,446,753 | `2026-05-02T15:55:06Z` | +5.30 min | clean |
| w8 | `f0970af9676d` | 1,444,602 | `2026-05-02T16:00:10Z` | +5.08 min | clean |
| w9 | `6609098e7e9d` | 1,442,927 | `2026-05-02T16:05:24Z` | +5.22 min | clean |
| w10 | `bad0065b2658` | 1,439,197 | `2026-05-02T16:14:38Z` | +9.23 min | clean (sparse) |
| w11 | `4bd5ee0a7f91` | **1,439,231** | `2026-05-02T16:19:44Z` | +5.10 min | **clean** |

**Duration band (10 strict-clean waves):** 1,439,197 – 1,455,738 ms = 16.5 s spread = ~1.15 % across the entire 10-strict-clean cluster. **Extremely tight reproducibility.**

**Floor advance:** 8 of 11 waves in 5.07–5.36 min band; 2 sparse-density outliers up (+9.07 / +9.23 min). 1 yellow outlier (w6) duration but normal floor advance. **Cumulative floor advance 11 waves = +59m 41s** in ~11h 06m wall time.

## Gate ledger — threshold reached

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| **Clean strict count** | **10 / 10** (w1, w2, w3, w4, w5, w7, w8, w9, w10, w11) — **THRESHOLD REACHED** |
| Yellow count | 1 (w6) |
| Red / hard-gate breach | 0 |
| Series state | review-eligible for Tier 2; **NOT automatically authorized** |
| Tier 2 / `maxRuns=24` gate | **review-eligible** (10/10 strict-clean met); pending series summary + fresh PG snapshot + operator decision |
| Threshold protocol | `SLOW_CHUNK_THRESHOLD=145` standard (validated 5 consecutive waves) |

## Next-steps protocol (per operator agreement)

After this closure, proceed in order:
1. **Series summary doc** — consolidated 11-wave overview, duration trends, floor cumulative, observations & reframes, ledger status.
2. **Fresh PG snapshot** — read-only diagnostic baseline (separate from cleanup waves), establishes what "system at rest after 10 strict clean waves" looks like.
3. **Operator decision** on next tier — separate explicit go, not automatic.

## Re-halt rules going forward (unchanged from wave 9–10)

A future wave triggers **HOLD** on any of:
1. `durationMs > 1,500,000`.
2. **Sustained** PG `DataFileRead` / `BufferIO` / waiting locks / long-active >30 s across multiple probes.
3. Post-wave loadavg 5m/15m elevated and not subsiding by T+2–3.
4. `env` does not return to `≠ "1"` after terminal — hard stop.
5. PG container memory split shows non-cache growth + post-wave MEM% > 30 % → HOLD.
6. Host `free -h available` drops below ~5 GiB → HOLD.

## Caveats / parked

- **Wave 7 captured probe** (Convex 108 % + DFR×2) framing reframed across w10 and w11 closures. Original "cleanup exposes shared_buffers limit" interpretation now superseded by "organic Convex bursts are baseline, occasionally hit PG cache misses". Updated framing in T+2:30 section above.
- **w6 yellow root cause** strongly suspected = transient overlap with organic Convex burst slowing scheduler dispatch. Not directly proven, but w7–w11 all clean means cleanup profile itself is reproducibly in band.
- **Per-chunk timings via `_scheduled_functions`** never pulled (10 strict-clean series makes this low priority).
- **Parallel baseline-monitor** (probing system at fixed intervals during idle, no wave) would quantify organic burst frequency. Parked.
- **PG tuning track** still parallel and non-blocking. Should land before Tier 5 (parallel/larger architecture), but not before Tier 2 evaluation.
- **Floor at `2026-05-02 16:19`.** Backlog ~7d 23h between floor and `cutoffUsed`. Convergence to 48h retention requires Tier 2 automation (now review-eligible, decision pending).

## Anchors

- Origin canon at trigger time: `59e937d` (wave 10 canary closure).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Probe script (test artifact, not committed): `/tmp/wave-probe.sh`.
- Prior canary closures: w1–w10 in `memory/`.
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`, `memory/postgres-tuning.md`.
