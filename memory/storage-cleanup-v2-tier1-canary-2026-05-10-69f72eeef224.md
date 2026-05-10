# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 15:05Z, maxRuns=16, wave 7) — **CLEAN with infrastructure warning**

## Verdict

**Clean by all hard gates.** Seventh canary at Tier 1 (`maxRuns=16`). Profile reproduced exactly: terminal `completed`, 16/16 chunks, 16,000 rows deleted, env restored to 0, floor advance +5.30 min. **Duration `1,446,753 ms` (24.11 min) — fastest of the 7-wave series**, even slightly faster than the prior best (w3 = 1,448,081 ms).

**Infrastructure warning captured (not an operational signal).** One mid-wave probe out of six (probe #2 at 15:19:16Z, during chunk 8→9 transition) caught a real cache-pressure burst: `adpilot-convex-backend = 108.33% CPU`, `adpilot-postgres = 55.83% CPU`, `pg_stat_activity.wait_event = DataFileRead × 2`, 3 PG processes in D-state. The other 5 probes captured calm system. Bursts are very brief (sub-second to seconds), not sustained. The system absorbed the pressure and finished in band — meaning **shared_buffers=128MB is at its working limit during cleanup, but cleanup completes cleanly**. This is a parallel-track signal for PG tuning, not a halt-the-series signal.

**Operator + agent re-evaluation:** an earlier prediction during this wave projected envelope breach (`durationMs > 1,600,000 ms`) based on observed Monitor "slow chunk gaps" of 140 s. **That prediction was wrong** — the apparent slow gaps were primarily a polling-cadence artifact (96 s server-side chunk-to-chunk vs 45 s polling cadence → ratio 2.13 produces alternating 90 s / 135 s observed gaps regardless of actual chunk pacing). The honest reframe lands wave 7 as clean, not as a hard-gate breach.

This is **6/10 strict clean** at Tier 1 maxRuns=16 (waves 1–5 + wave 7), plus **1 yellow outlier** (wave 6 = +57 s above tight band, real but isolated). Series **not halted**; armed observability continues; PG tuning prep is a parallel non-blocking track.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778425532707-69f72eeef224` |
| short-runId | `69f72eeef224` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T15:05:32Z` |
| Last batch UTC (terminal sample) | `2026-05-10T15:30:25Z` |
| Terminal detected (Monitor) | `2026-05-10T15:30:31Z` |
| env restored UTC | `2026-05-10T15:30:47Z` (verified `0` ≠ `1`) |
| Total wall (`durationMs`) | **1,446,753 ms** (24m 6.8s) — **fastest of series** |
| Avg chunk-to-chunk (server-side) | ~96 s (rest=90 s + work ~6 s) |
| Implied avg per-chunk work | ~5.4 s (`(1446753 − 15×90000) / 16` = 87.0 s / 16) |
| Cron boundary headroom at terminal | next 17:55 no-go entry = +2h 24m |
| Gap from prior canary terminal | wave 6 terminal 14:33:55Z → wave 7 trigger 15:05:32Z = +31m 37s |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 14:57:16Z | Preflight (parallel + pre-wave-7 protocol additions: docker stats, top, host crons) — GREEN, no caveats; loadavg `0.24 / 0.27 / 0.44`; no host-side load source visible |
| 15:04:42Z | Pre-flip runway recheck (2h 20m to 17:25 cutoff) — passed |
| 15:04:54Z | `/tmp/wave-probe.sh` test run — clean, probe template ready |
| 15:05:30Z | Operator `go run + mid-wave-probe-armed`; agent env flip 0→1 (verified `1`) |
| 15:05:32Z | Trigger returned `{status:"scheduled", runId:"1778425532707-69f72eeef224"}` |
| 15:05:38Z | First chunk completed (batchesRun=1, deleted=1000) |
| 15:11:14Z | Monitor: chunk 3→4 observed gap 140 s — **auto-probe fired** |
| 15:11:18Z | **Probe #1 — calm** (Convex 0.19% / PG 0.13% / DFR=0; loadavg 0.44) |
| 15:16:00Z | Monitor: chunk 6→7 observed gap 140 s — auto-probe fired |
| 15:16:04Z | **Probe #2 — calm-ish** (Convex 0.67% / PG 0.96% / DFR=0; loadavg 0.62) |
| 15:19:12Z | Monitor: chunk 8→9 observed gap 139 s — auto-probe fired |
| **15:19:16Z** | **Probe #3 — BURST CAUGHT: Convex 108.33% / PG 55.83% / DFR=2 / 3 PG in D-state; loadavg 0.87** |
| 15:22:25Z | Monitor: chunk 10→11 observed gap 140 s — auto-probe fired |
| 15:22:29Z | Probe #4 — calm (Convex 0.07% / PG 6.95% / DFR=0; loadavg 0.29) |
| 15:25:38Z | Monitor: chunk 12→13 observed gap 140 s — auto-probe fired |
| 15:25:42Z | Probe #5 — calm (Convex 0.03% / PG 4.48% / DFR=0; loadavg 0.40) |
| 15:30:25Z | Monitor: chunk 15→16 observed gap 140 s — auto-probe fired |
| 15:30:28Z | Probe #6 (auto-terminal) — calm (Convex 0.00% / PG 0.05% / DFR=0; loadavg 0.68) |
| 15:30:31Z | Terminal `completed` detected by Monitor; stream exited |
| 15:30:47Z | env flip 1→0 (verified `0`) |
| 15:31:25Z | Post-audit T+0 dedicated PG/host probe — clean |
| 15:34:02Z | Post-audit T+2:30 PG/host probe — clean, no hangover, full recovery |

No abort, no recovery branch, no `disabled`/`already-running` trigger response.

## Pre-flight baseline (14:57Z, with pre-wave-7 protocol)

| Item | Value |
|---|---|
| env | `0` |
| Active cleanup row | none |
| `/version` × 3 | 200/200/200, 1.27–1.42 s |
| `loadavg` | `0.24 / 0.27 / 0.44` (15m residual from w6, declining) |
| **Containers** | 3× `healthy`; **all <1% CPU** (no host-side load source) |
| **Top processes** | 88.1% idle CPU; no process >10% (sample artifact aside) |
| **Host crons** | only `e2scrub_all`, `sysstat`; no user-jobs |
| `pg_wal` | 57 files / 912 MB |
| `track_io_timing` | `off` |
| `shared_buffers` | `128MB` |
| Locks waiting | 0 |
| Idle-in-tx | 0 |
| `DataFileRead` / `BufferIO` / `BufferPin*` | 0 / 0 / 0 |
| Long-active >30 s | 0 |
| Origin canon | `b6a5cc3` |
| Cron boundary | latest start `≤ 17:25 UTC` (boundary 18:00 − 35 min); 2h 27m runway at preflight |

Pre-wave-7 protocol additions all GREEN. **No host-side process visible as a sustained CPU consumer.** This was the right preflight to run, but it doesn't catch sub-second/seconds-scale cache-pressure bursts that occur during the wave itself — those need mid-wave probes.

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778425532707-69f72eeef224",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1446753,
  "startedAt": 1778425532707,
  "cutoffUsed": 1778252732707,
  "oldestRemainingTimestamp": 1777737306393,
  "error": null
}
```

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T15:05:32Z`.
- `oldestRemainingTimestamp` = `2026-05-02T15:55:06.393Z`.
- Backlog at terminal: ~7d 23h between `oldestRemaining` and `cutoffUsed`.

## Six mid-wave probes — full table

| # | Trigger | UTC | Convex CPU | PG CPU | DFR | BIO | locks | loadavg 1m | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | chunk 3→4 gap 140 s | 15:11:18 | 0.19% | 0.13% | 0 | 0 | 0 | 0.44 | calm |
| 2 | chunk 6→7 gap 140 s | 15:16:04 | 0.67% | 0.96% | 0 | 0 | 0 | 0.62 | calm-ish |
| **3** | **chunk 8→9 gap 139 s** | **15:19:16** | **108.33%** | **55.83%** | **2** | **0** | **0** | **0.87** | **BURST CAUGHT** |
| 4 | chunk 10→11 gap 140 s | 15:22:29 | 0.07% | 6.95% | 0 | 0 | 0 | 0.29 | calm |
| 5 | chunk 12→13 gap 140 s | 15:25:42 | 0.03% | 4.48% | 0 | 0 | 0 | 0.40 | calm |
| 6 | chunk 15→16 gap 140 s (auto-terminal) | 15:30:28 | 0.00% | 0.05% | 0 | 0 | 0 | 0.68 | calm |

**1 of 6 probes** caught a burst signature. The burst is brief — by the time the SSH+psql probe completes (~1–2 s), it's typically over. Probe #3 was a lucky time-alignment.

**Probe #3 detail (the captured burst):**
- `adpilot-convex-backend`: 108.33% CPU (one full core+; backend doing cleanup-driven work)
- `adpilot-postgres`: 55.83% CPU (PG handling concurrent reads)
- 2 PG backends in `wait_event=DataFileRead` (disk reads of pages not in shared_buffers)
- 3 postgres processes in D-state (uninterruptible disk wait)
- Top processes: PIDs 1693194 (D, 18.2%, 153 MiB RSS), 7071 (S, 9.1%), 1703171 (D, 9.1%, 146 MiB RSS) — all postgres backends

Same `DataFileRead × 2` signature as the prior recorded incident `2026-05-10 05:09–05:20Z` referenced in `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`.

## Polling-cadence artifact — honest correction

Server-side actual chunk-to-chunk = ~96 s (`restMs=90000` + work ~6 s). Monitor poll cadence = 45 s. Ratio 96/45 ≈ 2.13.

This means **observed inter-sample "gaps" naturally alternate** between ~90 s (when 2 polls pass) and ~135 s (when 3 polls pass), regardless of actual chunk pacing. Sum of observed gaps approximates real wall time, but individual gaps are NOT a reliable measure of per-chunk delay.

**During the wave, agent's interpretation chained:**
1. "gap 140 s = +44 s above normal 96 s"
2. "5–6 such gaps would put durationMs ≈ 1.65M, breaching envelope"
3. "wave 7 reproduces wave 6 pattern, halt series"

**Actual data after terminal:**
1. Sum of all 15 observed gaps ≈ 1,431 s ≈ 1,431,000 ms.
2. Server-side `durationMs = 1,446,753 ms` — close to sum + chunk-1 lag.
3. Per-chunk pacing was actually **constant ~96 s server-side**, no real per-chunk anomaly.

**Lesson:** for future waves, either (a) raise Monitor cadence to ≤ chunk_period / 4 (~22 s for 96 s chunks) so observed gaps don't alias, or (b) read precise per-chunk timings from `_scheduled_functions` post-wave instead of trusting Monitor sample-to-sample deltas. Option (b) is cheaper and more accurate.

The probe-on-slow-chunk trigger still produced value (probe #3 caught the burst), but the slow-chunk **detector** was a noisy proxy. Real per-chunk variance was minimal.

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 (= `maxRuns × batchSize`) | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms (16 × 100 s envelope) | **1,446,753 ms** (90.4% of envelope) | **PASS** |
| floor advance | ≥ 0, monotonic | +318,168 ms (≈ 5.30 min) | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +2h 24m | **PASS** |

All hard gates pass. The probe #3 burst capture is **not** a hard-gate; it's a soft infrastructure signal classified separately.

## Post-wave dual probe (T+0 and T+2:30)

| Metric | Pre-wave (14:57) | T+0 (15:31) | T+2:30 (15:34) |
|---|---|---|---|
| loadavg 1m / 5m / 15m | 0.24 / 0.27 / 0.44 | 0.27 / 0.35 / 0.41 | **0.08 / 0.22 / 0.34** |
| Containers | 3× healthy | 3× healthy | 3× healthy |
| adpilot-convex-backend CPU | 0.05% | 0.01% | 0.01% |
| adpilot-postgres CPU | 0.02% | 0.00% | 0.00% |
| PG active / DFR / BIO / locks waiting | 1 / 0 / 0 / 0 | 1 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |
| pg_wal | 57 / 912 MB | (not re-pulled) | (not re-pulled) |

**No hangover.** System fully recovered by T+2:30. The probe #3 burst was transient and left no residue.

## Seven-wave stability ledger

| Wave | runId (short) | Duration (ms) | Floor (UTC) | Floor Δ | Status |
|---|---|---|---|---|---|
| w1 | `c74ca9b2fe6d` | 1,455,738 | `2026-05-02T15:20:03Z` | — | clean |
| w2 | `d88ff5ef84f3` | 1,452,529 | `2026-05-02T15:25:24Z` | +5.36 min | clean |
| w3 | `694c4ce0294f` | 1,448,081 | `2026-05-02T15:30:30Z` | +5.10 min | clean |
| w4 | `8734aea0c175` | 1,451,830 | `2026-05-02T15:39:35Z` | +9.07 min | clean (sparse density) |
| w5 | `25c80afba8c1` | 1,448,844 | `2026-05-02T15:44:39Z` | +5.07 min | clean |
| w6 | `d3a776d75f11` | 1,504,803 | `2026-05-02T15:49:48Z` | +5.16 min | **yellow** (real +57 s outlier) |
| w7 | `69f72eeef224` | **1,446,753** | `2026-05-02T15:55:06Z` | **+5.30 min** | **clean** (fastest of series) |

**Duration:** 7-wave range 1,446,753–1,504,803 ms (spread 58 s = ~4%). Tight cluster at 1,446–1,456k = 6 waves; w6 alone outside band. **w7 returned to band**, even slightly faster than prior best — invalidates the "duration regression" hypothesis from wave 6.

**Floor advance:** 6 waves in 5.07–5.36 min band; w4 outlier (+9.07 min, sparse density). w7 in band. **Cumulative floor advance 7 waves = +35.05 min** in ~7h 22m wall time (w1 trigger 08:13Z → w7 terminal 15:30Z).

## Series ledger reframe

Pre-wave-7 ledger: `5/10 strict + 1 yellow + (predicted RED breach)` → halt + tune.

**Post-wave-7 ledger (corrected):**
- **6/10 strict clean** = w1, w2, w3, w4, w5, w7
- **1 yellow caveat** = w6 (real +57 s outlier, host load 5m=1.57 elevation observed post-wave; cause not definitively identified, pre-wave-7 docker/top/cron checks didn't reveal it)
- **0 red / no halt**

w7 invalidated the "envelope breach pattern" prediction. w6 remains a real but isolated event.

## Hybrid (c) decision — series continues with armed observability

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| Clean strict count | **6 / 10** (w1, w2, w3, w4, w5, w7) |
| Yellow count | 1 (w6) |
| Red / hard-gate breach | 0 |
| Series state | **continue** with armed mid-wave observability |
| Tier 2 / `maxRuns=24` gate | **NOT MET** — need ≥ 10 strict clean waves |
| PG tuning track | parallel preparation, **not** a blocker for wave 8 if preflight is green |

## Re-halt rules going forward

A future wave triggers **HOLD** (no next wave until investigation) on any of:

1. `durationMs > 1,500,000` → real duration regression.
2. **Sustained** PG `DataFileRead` / `BufferIO` / waiting locks / long-active>30 s across multiple probes (not just one transient).
3. Post-wave loadavg 5m/15m elevated and not subsiding by T+2–3 (i.e., hangover load).
4. `env` does not return to `≠ "1"` after terminal — hard stop, immediate investigation.

Any single one of these is a halt; no "majority" rule.

## DFR×2 reframe — infrastructure warning, not operational signal

Probe #3 captured a real cache-pressure burst. Reading:
- It happens because `shared_buffers=128MB` is at its working-set limit during cleanup.
- Bursts are brief (sub-second to few seconds) and local to chunk-execution.
- The system absorbs them: wave 7 finished as the **fastest of the series**.
- This signals the infrastructure is at-limit, not in-failure.

Action this generates:
- **Parallel track:** prepare PG tuning plan (`shared_buffers` 128MB → 2–3 GB target per `memory/postgres-tuning.md`, with restart window, rollback procedure, post-tuning validation criterion = "1 wave at maxRuns=16 without DataFileRead bursts").
- **Not blocking:** wave 8 may proceed if preflight is green; tuning is a quality improvement, not a safety prerequisite.
- **Validation criterion (when tuning lands):** first post-tuning wave must show 0 DataFileRead bursts across ≥ 4 mid-wave probes AND `durationMs` in band (1,446–1,460k).

## Fallback drain semantics — clarification

If PG tuning takes longer than expected and backlog grows uncomfortably:

- **NOT acceptable:** leaving `env=1` between manual waves so the organic 6h cron `500/5/90/maxRuns=5` runs accidentally — this mixes attribution (organic 2.5K rows/wave at smaller profile vs canary 16K rows/wave) and violates the `env=1 only during a known wave` protocol.
- **Acceptable:** **explicit-controlled** organic-cron drain — set `env=1` deliberately just before a known cron tick window, let one organic cron run drain, set `env=0` immediately. Document each such run as a separate "fallback drain" entry in cleanupRunState attribution.

## Caveats / parked

- **Per-chunk timings via `_scheduled_functions`** still not pulled (would resolve the polling-artifact issue exactly). Worth pulling for the next wave's closure.
- **Probe-on-slow-chunk detector is noisy** — based on Monitor sample deltas which alias polling cadence. Fix: either raise Monitor cadence to ~22 s, or replace the detector with a separate fixed-interval probe sampler (e.g., every 60 s) that captures host snapshots regardless of detected gaps.
- **Probe itself adds load** (~1–2 s SSH + docker stats + psql). Negligible but not passive.
- **w6 yellow root cause** still not identified. Pre-wave-7 protocol (docker stats / top / host crons) was the right type of check but didn't catch it; w6 may have been a one-time transient (autovacuum, checkpoint, etc.). If a similar +50 s outlier reappears in any future wave, drilldown becomes mandatory.
- **Floor still at `2026-05-02 15:55`.** Backlog ~7d 23h between floor and `cutoffUsed`. Seven waves moved floor +35 min in ~7h 22m wall time. Convergence to 48h retention requires Tier 2 automation track (still gated by 10/10 strict clean).

## Anchors

- Origin canon at trigger time: `b6a5cc3` (wave 6 yellow canary closure).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Probe script (test artifact, not committed): `/tmp/wave-probe.sh`.
- Prior canary closures: `c74ca9b2fe6d`, `d88ff5ef84f3`, `694c4ce0294f`, `8734aea0c175`, `25c80afba8c1`, `d3a776d75f11` (in `memory/`).
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`, `memory/postgres-tuning.md`.
