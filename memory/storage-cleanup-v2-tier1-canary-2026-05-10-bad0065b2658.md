# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 18:36Z, maxRuns=16, wave 10) — **CLEAN**

## Verdict

**Clean by all hard gates.** Tenth canary at Tier 1 (`maxRuns=16`). Profile reproduced exactly: terminal `completed`, 16/16 chunks, 16,000 rows deleted, env restored to 0, floor advance **+9.23 min** (sparse-density region, like wave 4). **Duration `1,439,197 ms` (23.99 min) — new fastest of the 10-wave series**, first wave under the 24-min mark, 3.73 s faster than the prior fastest (w9 = 1,442,927 ms).

**Notable secondary finding (not a halt-trigger).** T+2:30 post-audit probe captured a burst of organic activity *unrelated to the wave*: `adpilot-convex-backend = 99.83% CPU`, `adpilot-postgres = 36.59% CPU`, `pg_stat_activity` showed `active=2`, `wait_event=DataFileRead × 1`. This occurred 3 minutes *after* env was restored to 0. Cause is most plausibly a baseline scheduled activity (sync-metrics tick, UZ budget cron, or similar). **This reframes wave 7's earlier captured burst (probe #3: Convex 108% + DFR×2) as a baseline organic pattern, not a cleanup-specific signal.** It also reinforces the interpretation that wave 6's `+57 s` outlier was likely a transient overlap with concurrent organic activity, not a cleanup-profile regression.

**Re-halt rule 2 examination (since DFR appeared):** rule wording is "**sustained** DFR/BIO/locks/long-active **across multiple probes** (not just one transient)". T+0 reading was clean (`0/0/0/0`); T+2:30 reading was `active=2 / DFR=1 / BIO=0 / lockw=0`. **Single transient at one probe, not sustained.** Rule **NOT triggered.**

**Series-state ledger: 9 / 10 strict clean** at Tier 1 maxRuns=16 (waves 1–5, w7, w8, w9, w10), plus **1 yellow** (w6). **Wave 11 is the last needed to reach 10/10 strict-clean** and clear the first Tier 2 / `maxRuns=24` review-eligibility threshold.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778438213486-bad0065b2658` |
| short-runId | `bad0065b2658` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T18:36:53Z` |
| Last batch UTC (terminal sample) | `2026-05-10T19:00:58Z` |
| Terminal detected (Monitor) | `2026-05-10T19:00:58Z` |
| env restored UTC | `2026-05-10T19:01:10Z` (verified `0` ≠ `1`) |
| Total wall (`durationMs`) | **1,439,197 ms** (23.99 min) — **first sub-24-min wave** |
| Avg chunk-to-chunk (server-side) | ~96 s (rest=90 s + work ~6 s) |
| Implied avg per-chunk work | ~5.0 s (`(1439197 − 15×90000) / 16` = 80.7 s / 16) |
| Cron boundary headroom at terminal | next 23:55 no-go entry = +4h 54m |
| Gap from prior canary terminal | wave 9 terminal 16:56:22Z → wave 10 trigger 18:36:53Z = +1h 40m 31s |
| Slow-chunk threshold | **145 s** (standard) |
| Mid-wave probes fired | **0** |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 18:31:16Z | Preflight #10 (post-18:00 boundary) — GREEN. Cutoff for next boundary 00:00 is 23:25 UTC; runway 4h 54m. cgroup memory.stat: anon 19.2 MiB, file 23.72 GiB (cache-dominant unchanged) |
| 18:36:29Z | Pre-flip runway recheck — passed |
| 18:36:50Z | Operator `go run`; agent env flip 0→1 (verified `1`) |
| 18:36:53Z | Trigger returned `{status:"scheduled", runId:"1778438213486-bad0065b2658"}` |
| 18:36:59Z | First chunk completed (batchesRun=1, deleted=1000) |
| 18:37–19:00Z | Wave executing; Monitor armed with `SLOW_CHUNK_THRESHOLD=145`. **0 probes fired**, all 15 inter-chunk gaps in 93–95 s band |
| 19:00:58Z | Terminal `completed` detected by Monitor; stream exited |
| 19:01:10Z | env flip 1→0 (verified `0`) |
| 19:01:33Z | Post-audit T+0 host probe + cgroup memory.stat split — clean |
| **19:04:11Z** | **Post-audit T+2:30 host probe captured organic burst (Convex 99.83 % / PG 36.59 % / DFR=1) — unrelated to wave (env=0 for 3 min); single transient, not sustained** |

No abort, no recovery branch, no FETCH-ERROR on Monitor poll, no `disabled`/`already-running` trigger response.

## Pre-flight #10 baseline (18:31Z)

| Item | Value |
|---|---|
| env | `0` |
| Active cleanup row | none (top: prior canary `6609098e7e9d`, completed) |
| `/version` × 3 | 200/200/200, 1.41–2.21 s (1st cold-ish, then OK) |
| `loadavg` | `0.04 / 0.09 / 0.18` (lowest preflight of session) |
| Containers | 3× `healthy` |
| Host `free -h available` | **25 GiB** ✓ (>> 5 GiB threshold) |
| adpilot-postgres MEM% | 43.04 % (~16.85 GiB) |
| **cgroup memory.stat (preflight):** | |
| anon | 20,164,608 B = **19.2 MiB** (true RSS) |
| active_anon | 164,560,896 B = 157 MiB |
| shmem | 144,121,856 B = 137 MiB |
| file (total cache) | 25,465,802,752 B = **23.72 GiB** |
| active_file | 16,986,546,176 B = 15.82 GiB |
| inactive_file | 8,335,134,720 B = 7.76 GiB |
| Composition | **99.92 % cache, 0.08 % RSS** — page cache pattern persistent |
| `pg_wal` | 57 files / 912 MB |
| `track_io_timing` / `shared_buffers` | `off` / `128MB` |
| Locks waiting / Idle-in-tx / Long-active >30 s | 0 / 0 / 0 |
| `DataFileRead` / `BufferIO` / `BufferPin*` | 0 / 0 / 0 |
| Origin canon | `f1ed19b` |
| Cron boundary | latest start `≤ 23:25 UTC` (next boundary 00:00 − 35 min); 4h 54m runway |

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778438213486-bad0065b2658",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1439197,
  "startedAt": 1778438213486,
  "cutoffUsed": 1778265413486,
  "oldestRemainingTimestamp": 1777738478257,
  "error": null
}
```

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T18:36:53Z`.
- `oldestRemainingTimestamp` = `2026-05-02T16:14:38Z`.
- Backlog at terminal: ~7d 22h between `oldestRemaining` and `cutoffUsed`.

## Inter-chunk pacing

All 15 transitions in `93–95 s` band (similar tightness to wave 9):

| Transition | Gap | Transition | Gap |
|---|---|---|---|
| 1→2 | 94 s | 9→10 | 93 s |
| 2→3 | 93 s | 10→11 | 94 s |
| 3→4 | 94 s | 11→12 | 93 s |
| 4→5 | 93 s | 12→13 | 94 s |
| 5→6 | 95 s | 13→14 | 93 s |
| 6→7 | 94 s | 14→15 | 93 s |
| 7→8 | 94 s | 15→16 | 93 s |
| 8→9 | 94 s | | |

`SLOW_CHUNK_THRESHOLD=145` fired 0 mid-wave probes (4th consecutive validation).

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms | **1,439,197 ms** (89.9 % of envelope) | **PASS** |
| floor advance | ≥ 0, monotonic | +554,045 ms (≈ 9.23 min) | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +4h 54m | **PASS** |

All hard gates pass.

## Re-halt rules — none triggered

| Rule | Trigger | Wave 10 reading | Verdict |
|---|---|---|---|
| 1. Duration regression | `durationMs > 1,500,000` | 1,439,197 (fastest of series) | NOT triggered |
| 2. Sustained PG waits/locks **across multiple probes** | DFR/BIO/locks/long-active sustained | T+0: 0/0/0/0 (clean); **T+2:30: DFR=1 (single transient, NOT sustained)** | NOT triggered |
| 3. Hangover load | post-wave loadavg 5m/15m elevated, not subsiding by T+2:30 | T+0 5m=0.71 → T+2:30 5m=0.47 (declining) | NOT triggered |
| 4. Env not restored | env stays `1` after terminal | env = `0` verified | NOT triggered |
| 5. PG non-cache MEM growth | RSS-dominant + MEM% > 30 % | RSS 18.5 MiB, file 23.55 GiB; MEM% 43.49 % is **cache** | NOT triggered |
| 6. Host headroom | `free -h available` < 5 GiB | 25 GiB | NOT triggered |

## Post-wave probes (T+0 and T+2:30)

| Metric | Pre-wave (18:31) | T+0 (19:01:33) | T+2:30 (19:04:11) |
|---|---|---|---|
| loadavg 1m / 5m / 15m | 0.04 / 0.09 / 0.18 | 0.66 / 0.71 / 0.43 | **0.30 / 0.47 / 0.37** (declining) |
| free -h available | 25 GiB | 25 GiB | **25 GiB** |
| **adpilot-convex-backend CPU / MEM%** | 0.07 % / 5.91 % | 0.18 % / 6.02 % | **99.83 % / 6.03 %** ⚠️ organic burst |
| **adpilot-postgres CPU / MEM%** | 0.06 % / 43.04 % | 0.05 % / 43.48 % | **36.59 % / 43.49 %** |
| cgroup anon (RSS) | 19.2 MiB | 23.0 MiB | **18.5 MiB** (settled) |
| cgroup active_anon | 157 MiB | 161 MiB | 156 MiB |
| cgroup file (cache) | 23.72 GiB | 23.67 GiB | 23.55 GiB |
| cgroup active_file | 15.82 GiB | 15.99 GiB | 16.00 GiB (steady) |
| **PG active / DFR / BIO / locks waiting** | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 | **2 / 1 / 0 / 0** ⚠️ |

## T+2:30 organic burst — interpretation and reframe

At T+2:30 (19:04:11Z, 3 minutes *after* env was set back to 0), probe captured:
- `adpilot-convex-backend` = 99.83 % CPU (one full core)
- `adpilot-postgres` = 36.59 % CPU
- `pg_stat_activity`: `active=2`, `wait_event=DataFileRead × 1`

**Critical context: env was 0 throughout this burst.** No cleanup action could have been running. The burst must be from another scheduled function or organic activity. Most plausible candidates: sync-metrics cron (15-min cadence), UZ budget cron, token refresh, or other scheduled internal action.

**This is a significant reframe of the wave 7 capture (probe #3):** that snapshot captured `Convex 108 % + PG 55.83 % + DFR×2`, observed *during* a wave. We previously interpreted this as cleanup-induced cache-pressure. Wave 10's T+2:30 observation shows an essentially identical pattern *with the wave fully terminal and env=0*. Therefore:

- **Both bursts are most plausibly the same baseline organic pattern**, not cleanup-specific.
- The Convex backend and PG do periodically light up at full-core CPU during normal operation.
- Wave 7's probe #3 capture happened to align timing-wise with a chunk transition, making it look cleanup-related.
- Wave 6's `+57 s` duration outlier likely overlapped with one of these organic bursts, slowing scheduler dispatching by exactly the observed amount.

**Status of "shared_buffers=128MB infrastructure warning" framing from wave 7 closure:**
- Still partly correct: the `DataFileRead` events are real, and shared_buffers=128MB *is* small.
- But the framing "*cleanup workload exposes the limit*" is now less defensible. Organic baseline triggers similar bursts.
- **Updated framing for the closure record:** the system has periodic baseline DataFileRead-pressure bursts driven by scheduled organic activity. Cleanup waves don't materially change this pattern; they don't trigger persistent cache thrashing. Page cache (23.5–23.7 GiB) absorbs reads cleanly afterward.

**Action implications:**
- PG tuning (shared_buffers up) is still useful, but **not urgent**. The bursts are tolerated; the system completes work in band.
- It's **not blocking Tier 2 evaluation** when 10/10 strict clean is reached.
- Future wave probes should not over-attribute organic-baseline bursts to cleanup. Probe-on-slow-chunk is still useful, but probe-during-quiet is the missing comparison: a parallel baseline-monitor capturing the *organic* pattern (without cleanup) would establish a clean comparison.

## Ten-wave stability ledger

| Wave | runId (short) | Duration (ms) | Floor (UTC) | Floor Δ | Status |
|---|---|---|---|---|---|
| w1 | `c74ca9b2fe6d` | 1,455,738 | `2026-05-02T15:20:03Z` | — | clean |
| w2 | `d88ff5ef84f3` | 1,452,529 | `2026-05-02T15:25:24Z` | +5.36 min | clean |
| w3 | `694c4ce0294f` | 1,448,081 | `2026-05-02T15:30:30Z` | +5.10 min | clean |
| w4 | `8734aea0c175` | 1,451,830 | `2026-05-02T15:39:35Z` | +9.07 min | clean (sparse) |
| w5 | `25c80afba8c1` | 1,448,844 | `2026-05-02T15:44:39Z` | +5.07 min | clean |
| w6 | `d3a776d75f11` | 1,504,803 | `2026-05-02T15:49:48Z` | +5.16 min | yellow (transient overlap) |
| w7 | `69f72eeef224` | 1,446,753 | `2026-05-02T15:55:06Z` | +5.30 min | clean |
| w8 | `f0970af9676d` | 1,444,602 | `2026-05-02T16:00:10Z` | +5.08 min | clean |
| w9 | `6609098e7e9d` | 1,442,927 | `2026-05-02T16:05:24Z` | +5.22 min | clean |
| w10 | `bad0065b2658` | **1,439,197** | `2026-05-02T16:14:38Z` | **+9.23 min** (sparse) | **clean (new fastest)** |

**Duration trend (last 4 waves):** 1,446,753 → 1,444,602 → 1,442,927 → 1,439,197 = **−7.56 s cumulative over 4 waves**. Possibly warm-cache effect (page cache 23.5–23.7 GiB persistent), possibly noise within ±4 s. Trend is small; not a definitive signal yet.

**Floor advance:** 2 of 10 waves in sparse-density region (+9 min) — w4 and w10. Other 8 waves in 5.07–5.36 min band. **Cumulative floor advance 10 waves = +54m 35s** in ~10h 47m wall time.

## Gate ledger

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| Clean strict count | **9 / 10** (w1, w2, w3, w4, w5, w7, w8, w9, w10) |
| Yellow count | 1 (w6) |
| Red / hard-gate breach | 0 |
| Series state | continue with armed observability |
| Tier 2 / `maxRuns=24` gate | **NOT MET — 1 strict-clean wave remaining to threshold** |
| Threshold protocol | `SLOW_CHUNK_THRESHOLD=145` standard (validated 4 consecutive waves now) |

**Wave 11 is the last needed to reach 10/10 strict-clean** and clear the *first* Tier 2 / `maxRuns=24` review-eligibility threshold. Note: clearing 10/10 makes Tier 2 *eligible for review*, not automatically authorized — separate operator decision required.

## Re-halt rules going forward (unchanged from wave 9)

A future wave triggers **HOLD** on any of:

1. `durationMs > 1,500,000`.
2. **Sustained** PG `DataFileRead` / `BufferIO` / waiting locks / long-active >30 s **across multiple probes** (not just one transient).
3. Post-wave loadavg 5m/15m elevated and not subsiding by T+2–3.
4. `env` does not return to `≠ "1"` after terminal — hard stop.
5. PG container memory split shows non-cache growth (RSS / anon dominant) AND post-wave MEM% > 30 % → HOLD.
6. Host `free -h available` drops below ~5 GiB → HOLD.

## Caveats / parked

- **Wave 7 probe #3 framing reframed.** The "shared_buffers=128MB infrastructure warning" interpretation is partly correct but over-attributed; organic baseline triggers similar bursts. Updated framing in the T+2:30 section above.
- **w6 yellow root cause** now strongly suspected to be transient overlap with concurrent organic activity (sync-metrics or similar cron). Evidence: w7–w10 all clean despite occasional probe captures showing the same Convex+PG burst pattern in non-wave time.
- **Per-chunk timings via `_scheduled_functions`** still not pulled. Series stable, low priority.
- **Optional improvement (parked):** parallel baseline-monitor probing the system at fixed intervals during a known idle period (no wave running) would establish the *organic* burst frequency for comparison. This would let us quantify "is wave 6 outlier rate higher than baseline?" — currently inferred but not measured.
- **Floor at `2026-05-02 16:14`.** Backlog ~7d 22h between floor and `cutoffUsed`. Ten waves moved floor +54m 35s in ~10h 47m wall time. Convergence to 48h retention requires Tier 2 automation (gated by upcoming 10/10 strict clean + Tier 2 authorization decision).

## Anchors

- Origin canon at trigger time: `f1ed19b` (wave 9 canary closure).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Probe script (test artifact, not committed): `/tmp/wave-probe.sh`.
- Prior canary closures: w1–w9 in `memory/`.
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`, `memory/postgres-tuning.md`.
