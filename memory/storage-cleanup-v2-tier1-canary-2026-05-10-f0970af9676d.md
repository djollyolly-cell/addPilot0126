# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 15:49Z, maxRuns=16, wave 8) — **CLEAN with PG-memory follow-up**

## Verdict

**Clean by all hard gates.** Eighth canary at Tier 1 (`maxRuns=16`). Profile reproduced exactly: terminal `completed`, 16/16 chunks, 16,000 rows deleted, env restored to 0, floor advance +5.08 min. **Duration `1,444,602 ms` (24.08 min) — new fastest of the 8-wave series**, 2.15 s faster than the prior fastest (w7 = 1,446,753 ms).

**Threshold 145 s validated.** Wave 8 used the corrected slow-chunk detector (`SLOW_CHUNK_THRESHOLD=145`) introduced after wave 7's polling-cadence-artifact analysis. Result: **zero mid-wave probes fired**, zero false positives, zero missed real issues (no DataFileRead/BufferIO bursts; no duration regression). Ratio of effort: replaces wave 7's 6 fires (1 real + 5 polling artifact) with 0 fires for the same actual quality of behaviour. **Promoting `145` to standard threshold for future waves.**

**Soft observation (non-blocking, requires follow-up):** `adpilot-postgres` docker container memory rose from ~2.83 % (≈ 1.1 GiB) at preflight to ~42 % (≈ 16.4 GiB of 39.15 GiB host RAM) post-wave, and remained at 42.00 % through T+2:30 (no decay over the audit window). **Most likely cgroup/page-cache attribution** (docker stats `MemUsage` typically includes file cache for files mapped into the container's namespace), not necessarily PG resident-set growth. **Needs follow-up confirmation** via longer-interval `docker stats` and, if needed, `cgroup memory.stat` RSS-vs-cache split before wave 9. Not a re-halt-rule trigger; falls outside hard gates.

This is **7/10 strict clean** at Tier 1 maxRuns=16 (waves 1–5, w7, w8) plus **1 yellow** (w6). Series continues; armed observability stays on; PG tuning remains a parallel non-blocking track.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778428180293-f0970af9676d` |
| short-runId | `f0970af9676d` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T15:49:40Z` |
| Last batch UTC (terminal sample) | `2026-05-10T16:14:09Z` |
| Terminal detected (Monitor) | `2026-05-10T16:14:09Z` |
| env restored UTC | `2026-05-10T16:14:19Z` (verified `0` ≠ `1`) |
| Total wall (`durationMs`) | **1,444,602 ms** (24m 4.6s) — **new fastest of series** |
| Avg chunk-to-chunk (server-side, derived) | ~96 s |
| Implied avg per-chunk work | ~5.3 s (`(1444602 − 15×90000) / 16` = 84.6 s / 16) |
| Cron boundary headroom at terminal | next 17:55 no-go entry = +1h 41m |
| Gap from prior canary terminal | wave 7 terminal 15:30:31Z → wave 8 trigger 15:49:40Z = +19m 9s |
| Slow-chunk threshold used | **145 s** (raised from 110 s after wave 7 polling-artifact analysis) |
| Mid-wave probes fired | **0** (vs wave 7: 6 fires, 5 artifact + 1 real) |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 15:45:54Z | Preflight (parallel + pre-wave-N additions: docker stats, top, host crons) — GREEN with small note (convex-backend 2.85 % / postgres 6.54 %, both below 20 % threshold) |
| 15:49:17Z | Pre-flip runway recheck (1h 35m to 17:25 cutoff) — passed |
| 15:49:38Z | Operator `go run + threshold 145`; agent env flip 0→1 (verified `1`) |
| 15:49:40Z | Trigger returned `{status:"scheduled", runId:"1778428180293-f0970af9676d"}` |
| 15:49:46Z | First chunk completed (batchesRun=1, deleted=1000) |
| 15:49–16:14Z | Wave executing; Monitor armed with `SLOW_CHUNK_THRESHOLD=145`. **0 probes fired across all 15 inter-chunk transitions.** Observed gap distribution: most ~93–94 s, one 79 s (after a fetch-error retry), one 140 s — none exceeded 145 s. |
| 15:55:47Z | 1× FETCH-ERROR on Monitor poll (1/5 threshold; recovered next sample) |
| 16:14:09Z | Terminal `completed` detected by Monitor; stream exited |
| 16:14:19Z | env flip 1→0 (verified `0`) |
| 16:14:40Z | Post-audit T+0 dedicated PG/host probe |
| 16:17:18Z | Post-audit T+2:30 PG/host probe (mandatory regardless of mid-wave fires) |

No abort, no recovery branch, no `disabled`/`already-running` trigger response. Single transient FETCH-ERROR on Monitor poll (recovered).

## Pre-flight baseline (15:45Z)

| Item | Value |
|---|---|
| env | `0` |
| Active cleanup row | none |
| `/version` × 3 | 200/200/200, 1.30–1.53 s |
| `loadavg` | `0.10 / 0.14 / 0.24` |
| Containers | 3× `healthy`; **adpilot-convex-backend 2.85 %, adpilot-postgres 6.54 %** (slightly active vs typical ~0.05 % idle but well below 20 % threshold; sync-metrics tick / background work, not anomalous); all others <0.5 % |
| **adpilot-postgres MEM** | **2.83 %** (~1.1 GiB) — baseline reference |
| Top processes | nothing >10 % (kworker sample artifact aside) |
| `pg_wal` | 57 files / 912 MB |
| `track_io_timing` | `off` |
| `shared_buffers` | `128MB` |
| Locks waiting / Idle-in-tx / Long-active >30 s | 0 / 0 / 0 |
| `DataFileRead` / `BufferIO` / `BufferPin*` | 0 / 0 / 0 |
| Origin canon | `bc72f5e` |
| Cron boundary | latest start `≤ 17:25 UTC`; 1h 39m runway at preflight |

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778428180293-f0970af9676d",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1444602,
  "startedAt": 1778428180293,
  "cutoffUsed": 1778255380293,
  "oldestRemainingTimestamp": 1777737610896,
  "error": null
}
```

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T15:49:40Z`.
- `oldestRemainingTimestamp` = `2026-05-02T16:00:10.896Z`.
- Backlog at terminal: ~7d 23h between `oldestRemaining` and `cutoffUsed`.

## Threshold=145 validation

**Hypothesis (from wave 7 closure):** observed Monitor gaps alias polling cadence — server-side chunk-to-chunk = ~96 s, Monitor cadence = 45 s, ratio 96/45 ≈ 2.13 → observed gaps oscillate ~90 s/~135 s as a polling artifact, regardless of actual pacing. Threshold 110 s catches mostly artifacts (5/6 fires in wave 7); threshold 145 s should suppress the artifact band and only fire on real >50 s anomalies.

**Wave 8 result:** observed gaps in 15 inter-chunk transitions:
- 14× normal: 79–94 s (mostly 93 s ± noise)
- 1× polling-artifact "long": **140 s** (chunk 8→9), **below 145 s threshold** → no probe fire
- 0× real anomalies

**Outcome: 0 fires.** Validates hypothesis. Threshold=145 is correctly calibrated to:
- ✅ ignore polling-artifact long-tail (~135 s)
- ✅ would still fire on a real wave-6-style outlier (which had +57 s actual delay vs band → server-side gap ~150 s+ → observed gap ~190 s+)

**Codified protocol for future waves:** `SLOW_CHUNK_THRESHOLD=145` is now standard. Re-evaluate only if Monitor cadence changes or chunk timing baseline shifts (e.g., after PG tuning).

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 (= `maxRuns × batchSize`) | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms (16 × 100 s envelope) | **1,444,602 ms** (90.3 % of envelope) | **PASS** |
| floor advance | ≥ 0, monotonic | +304,503 ms (≈ 5.08 min) | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +1h 41m | **PASS** |

All hard gates pass.

## Re-halt rules — none triggered

| Rule | Trigger | Wave 8 reading | Verdict |
|---|---|---|---|
| Duration regression | `durationMs > 1,500,000` | 1,444,602 ms (fastest of series) | **NOT triggered** |
| Sustained PG waits/locks | DFR/BIO/locks/long-active across multiple probes | 0 across all probes | **NOT triggered** |
| Hangover load | post-wave loadavg 5m/15m elevated, not subsiding by T+2:30 | 0.13 / 0.25 at T+2:30 (declining) | **NOT triggered** |
| Env not restored | env stays `1` after terminal | env = `0` verified | **NOT triggered** |

## Post-wave dual probe (T+0 and T+2:30)

| Metric | Pre-wave (15:45) | T+0 (16:14:40) | T+2:30 (16:17:18) |
|---|---|---|---|
| loadavg 1m / 5m / 15m | 0.10 / 0.14 / 0.24 | 0.04 / 0.17 / 0.29 | **0.04 / 0.13 / 0.25** |
| Containers | 3× healthy | 3× healthy | 3× healthy |
| adpilot-convex-backend CPU / MEM | 2.85 % / 6.01 % | 3.98 % / 6.00 % | 3.01 % / 5.96 % |
| **adpilot-postgres CPU / MEM** | 6.54 % / **2.83 %** | 12.62 % / **42.03 %** | 8.85 % / **42.00 %** |
| PG active / DFR / BIO / locks waiting | 1 / 0 / 0 / 0 | 1 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |

Loadavg fully recovered by T+2:30. CPU declining. **PG container MEM% rose ~14× during the wave window and held stable through T+2:30.**

## Soft observation — `adpilot-postgres` MEM jump

**Reading:** PG container memory rose from ~2.83 % (≈ 1.1 GiB) at preflight to ~42 % (≈ 16.4 GiB of 39.15 GiB host RAM) post-wave, and remained at 42.00 % through T+2:30 (no decay over the 2.5-min audit window).

**Most likely interpretation:** **cgroup / page-cache attribution.** `docker stats` `MemUsage` for a postgres container typically includes the kernel page cache for files mapped/accessed by processes inside that container's cgroup. With `shared_buffers=128MB`, PG relies heavily on the OS page cache for warm data. Wave 8 read substantial volumes of `metricsRealtime` rows + index pages; the OS cached those pages, and the cache persists (it's only evicted under memory pressure, which the host doesn't have — host has ~25.9 GiB free at last `top` reading).

**This interpretation, if correct, is BENEFICIAL:**
- Warm cache reduces future `DataFileRead` pressure → fewer cache-miss bursts in subsequent waves
- Wave 9 may show even cleaner mid-wave probes
- It does not consume RAM that other containers need (host has substantial headroom)

**But it is NOT confirmed.** Alternative interpretations:
- PG worker process RSS grew (e.g., `work_mem` allocations persisting in long-lived backends)
- A specific PG mechanism (e.g., per-backend stats accumulating) is using memory
- Some `docker stats` accounting boundary changed between waves

**Why this wasn't seen in waves 1–7:** unclear. Pre-wave-8 reading at 15:45Z was 2.83 %; post-wave-8 at 16:14Z was 42.03 %. Wave 7 post-audit at 15:31:25Z showed 2.66 %. So the jump happened during wave 8's window. But wave 8 did not visibly differ from wave 7 in cleanup workload. The MEM growth might also have been *pending* from earlier activity and only crystallized into the docker-stats sample at T+0.

**Follow-up before wave 9 (mandatory):**

1. **`docker stats` over a longer interval** (e.g., 5–10 samples at 30 s spacing during a quiet idle period). Confirm whether the 42 % is stable, growing, or decaying naturally.
2. **`cgroup memory.stat` RSS-vs-cache split** (e.g., `docker exec adpilot-postgres cat /sys/fs/cgroup/memory.stat` or equivalent on cgroupv2: `cat /sys/fs/cgroup/.../memory.stat`). The split between `rss` (or `anon`), `cache`, `inactive_file`, `active_file` will tell us definitively whether this is PG resident memory or kernel page cache.
3. **Host headroom check** at preflight time — `free -h` or `top` `MiB Mem available`. Make sure 16+ GiB attributed to PG container does not put host into swap pressure.
4. **Decision rule for wave 9:**
   - If split shows it is **mostly cache** → soft observation, log it in wave 9 closure, continue.
   - If split shows it is **PG RSS / anon** (not cache) → **HOLD wave 9**, investigate PG memory (work_mem misconfig, leak, runaway backend, etc.).
   - If host headroom drops below ~5 GiB free → HOLD regardless, prevent OOM risk.

This observation does **not** trigger the existing re-halt rules (no DFR / BIO / locks; durationMs in band; loadavg low; env restored). It is a **new soft signal class** added to the observability set.

## Eight-wave stability ledger

| Wave | runId (short) | Duration (ms) | Floor (UTC) | Floor Δ | Status |
|---|---|---|---|---|---|
| w1 | `c74ca9b2fe6d` | 1,455,738 | `2026-05-02T15:20:03Z` | — | clean |
| w2 | `d88ff5ef84f3` | 1,452,529 | `2026-05-02T15:25:24Z` | +5.36 min | clean |
| w3 | `694c4ce0294f` | 1,448,081 | `2026-05-02T15:30:30Z` | +5.10 min | clean |
| w4 | `8734aea0c175` | 1,451,830 | `2026-05-02T15:39:35Z` | +9.07 min | clean (sparse density) |
| w5 | `25c80afba8c1` | 1,448,844 | `2026-05-02T15:44:39Z` | +5.07 min | clean |
| w6 | `d3a776d75f11` | 1,504,803 | `2026-05-02T15:49:48Z` | +5.16 min | yellow (+57 s outlier) |
| w7 | `69f72eeef224` | 1,446,753 | `2026-05-02T15:55:06Z` | +5.30 min | clean (+infra warning) |
| w8 | `f0970af9676d` | **1,444,602** | `2026-05-02T16:00:10Z` | +5.08 min | **clean (new fastest)** |

**Duration:** 8-wave range 1,444,602–1,504,803 ms (spread 60.2 s = ~4 %). Tight cluster at 1,444–1,456k = 7 waves; w6 alone outside band. **w8 set new low**, slightly below w7 — ongoing micro-trend of slight speedup or noise within ~3 s envelope. Not a signal yet.

**Floor advance:** 7 of 8 waves in 5.07–5.36 min band; w4 outlier (+9.07 min, sparse density). w8 in band. **Cumulative floor advance 8 waves = +40.13 min** in ~7h 51m wall time (w1 trigger 08:13Z → w8 terminal 16:14Z).

## Gate ledger

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| Clean strict count | **7 / 10** (w1, w2, w3, w4, w5, w7, w8) |
| Yellow count | 1 (w6) |
| Red / hard-gate breach | 0 |
| Series state | continue with armed observability + PG MEM follow-up |
| Tier 2 / `maxRuns=24` gate | **NOT MET** — need ≥ 10 strict clean waves |
| Threshold protocol | `SLOW_CHUNK_THRESHOLD=145` standard; `110` deprecated |

## Re-halt rules going forward (unchanged from wave 7)

A future wave triggers **HOLD** on any of:

1. `durationMs > 1,500,000` → real duration regression.
2. **Sustained** PG `DataFileRead` / `BufferIO` / waiting locks / long-active>30 s across multiple probes (not just one transient).
3. Post-wave loadavg 5m/15m elevated and not subsiding by T+2–3.
4. `env` does not return to `≠ "1"` after terminal — hard stop.

**Plus** — added by this closure as part of the PG MEM follow-up:

5. **PG container memory split shows non-cache growth** (RSS / anon dominant in `cgroup memory.stat`) AND post-wave `adpilot-postgres` MEM% > 30 % → HOLD, investigate.
6. **Host headroom** (`free -h` available) drops below ~5 GiB → HOLD regardless of cause.

## Caveats / parked

- **Per-chunk timings via `_scheduled_functions`** still not pulled. Wave 8's clean profile makes this less urgent, but useful when next anomaly investigation is needed.
- **Probe script adds load** (~1–2 s SSH + docker stats + psql). Negligible; only fires on slow-chunk detection (which is now well-calibrated).
- **w6 yellow root cause** still not identified. With wave 7 + 8 both clean, w6 looks more like a one-time transient (autovacuum, checkpoint, network blip, etc.). If a similar +50 s outlier reappears, drilldown becomes mandatory.
- **PG MEM jump** is the new top item to investigate before wave 9 (see soft-observation section above).
- **Floor at `2026-05-02 16:00`.** Backlog ~7d 23h between floor and `cutoffUsed`. Eight waves moved floor +40 min in ~7h 51m wall time. Convergence to 48h retention requires Tier 2 automation (still gated by 10/10 strict clean).

## Anchors

- Origin canon at trigger time: `bc72f5e` (wave 7 canary closure).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Probe script (test artifact, not committed): `/tmp/wave-probe.sh`.
- Prior canary closures: `c74ca9b2fe6d`, `d88ff5ef84f3`, `694c4ce0294f`, `8734aea0c175`, `25c80afba8c1`, `d3a776d75f11`, `69f72eeef224` (in `memory/`).
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`, `memory/postgres-tuning.md`.
