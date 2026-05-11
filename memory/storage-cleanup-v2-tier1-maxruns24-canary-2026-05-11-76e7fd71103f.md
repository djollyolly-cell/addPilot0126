# Storage Cleanup V2 — Tier 1 maxRuns=24 single canary closure (2026-05-11 12:08Z, wave 3 of new ledger) — **CLEAN**

## Verdict

**Clean because all hard gates passed, duration stayed well below yellow threshold, immediate post-terminal audit was green, settle re-probe was clean, and env=`"0"` was confirmed via three independent paths with one safety corroboration.** Third canary at `maxRuns=24` profile: terminal `completed`, 24/24 chunks, 24,000 rows deleted. **Duration `2,183,464 ms` (36m 23.46s)** — fastest of the three 24-waves; **94.93 % of yellow / 90.98 % of hard**; fully inside the original pre-wave predicted band `2,170k–2,230k` and essentially at the predicted centre (`−7,536 ms below 2,191k`).

This is wave 3 of the **Tier 1 maxRuns=24 ledger** (waves 1 `5a94fbe`, 2 `8a93d1b`). Wave 3 provides a useful contrasting daytime sample. The faster duration is **consistent with** the time-of-day variance hypothesis raised in wave 1, but **n=1 for dayside is not enough to attribute it causally to time-of-day**. Treat as hypothesis-supporting, not proven.

**Operational milestone:** atomic env restore via independent terminal-restorer worked cleanly **without any manual env intervention** (per operator's pre-wave directive).

## Identifiers

| Field | Value |
|---|---|
| runId | `1778501300691-76e7fd71103f` |
| short-runId | `76e7fd71103f` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=24` |
| Series | Tier 1 maxRuns=24, wave 3 |
| Prior anchors | `8a93d1b` (wave 2), `5a94fbe` (wave 1), `6d5c6eb` (PG snapshot), `5428e77` (16-series summary) |
| Trigger UTC | `2026-05-11T12:08:18Z` |
| Computed terminal | `2026-05-11T12:44:41.464Z` (trigger + durationMs) |
| `lastBatchAt` | `2026-05-11T12:44:44.144Z` (2.7 s after computed terminal = internal row-finalization order) |
| Watcher-detected terminal | `2026-05-11T12:44:52Z` |
| **Restorer-detected terminal & env restore** | `2026-05-11T12:45:14Z` (iter 40, T+36m 56s from trigger); **env set 0 + verified `'0'` atomically on first terminal poll** |
| Total wall (`durationMs`) | **2,183,464 ms** (36m 23.46s) |
| batches | 24/24 |
| deleted | 24,000 |
| error | `null` |

## Timeline (key UTC events)

| UTC | Event |
|---|---|
| `12:05:59Z` | Mini-preflight PASS |
| **`12:08:18Z`** | **Trigger** — env flip 0→1 verified, runId `76e7fd71103f`, all 4 args verified, `maxRuns=24` |
| `12:09:14Z` | SSH short-poll watcher armed (90 s cadence) |
| `12:09:27Z` | Independent terminal-restorer armed (60 s → 30 s after T+30m) |
| `12:13:58Z` | Mid-wave probe — captured chunk-compute phase (see Mid-wave section) |
| `12:25:33Z` | Mid-wave probe — rest phase (Convex 0.06 %, PG 0.06 %) |
| `12:44:52Z` | Watcher detected `state="completed"`, durationMs=2,183,464 |
| **`12:45:14Z`** | **Restorer atomic env close** (`set 0` + verify `'0'`) |
| `12:45:58Z` | Immediate post-terminal audit (~T+1 from terminal detection / env restore) |
| `13:02:13Z` | Operator settle re-probe (~T+17 from terminal) |

## Threshold check

| Gate | Threshold | Actual | % | Result |
|---|---|---|---|---|
| Hard re-halt (rule 1) | >2,400,000 ms | 2,183,464 ms | **90.98 %** | **PASS** (−216,536 below) |
| Yellow | >2,300,000 ms | 2,183,464 ms | **94.93 %** | **PASS** (−116,536 below) |
| Pre-wave predicted band ceiling | 2,230,000 ms | 2,183,464 ms | — | **−46,536 below ceiling (INSIDE band)** |
| Pre-wave predicted band centre | 2,191,000 ms | 2,183,464 ms | — | **−7,536 (essentially AT centre)** |
| Other re-halt rules (2–6) | — | all green | — | **PASS** |

## Observed band (n=3) — one daytime faster sample

| Wave | runId | Trigger UTC | UTC bucket | durationMs |
|---|---|---|---|---|
| 1 | `24c7323b15b8` | 06:24Z | early morning | 2,240,974 |
| 2 | `8cd44b08a1d8` | 07:43Z | early morning | 2,230,273 |
| **3** | `76e7fd71103f` | **12:08Z** | **daytime** | **2,183,464** |

- Min: 2,183,464 (wave 3) | Max: 2,240,974 (wave 1)
- **Spread: 57,510 ms (~2.6 %)** — wider than wave 1+2 spread (0.48 %)
- Pattern: wave 1+2 sat at/just above predicted ceiling 2,230k; wave 3 dropped to near predicted centre 2,191k. Difference ≈ 47–57 s across 24 chunks ≈ ~2 s per (chunk+rest) cycle.
- **Working hypothesis** (consistent with wave 1 closure ToD note): early-morning UTC may have slightly more organic-burst overlap adding micro-delay per chunk. **Not proven** — n=1 for dayside is insufficient. More samples (additional daytime + ideally an evening/night-UTC sample) needed.

## Mid-wave probes

### Watcher inter-chunk gap distribution
- 23 visible inter-chunk gaps in **92–98 s** (mostly 92–94 s); slightly tighter than wave 1/2's 93–97 s
- No sampled interval suggested a >145 s slowdown
- Poll-based watcher; not a true push-stream per-gap monitor
- 0 sampling artifacts this wave

### Chunk-compute probe at T+5m 40s (`12:13:58Z`) — first chunk-phase capture in this series
- loadavg: 1.07 / 0.49 / 0.29 (sharp 1m = active DELETE batch)
- adpilot-convex-backend CPU: **140.09 %**, adpilot-postgres CPU: **62.42 %**
- PG long-active 0, waiting locks 0, DFR/BIO/BP 0

**Interpretation:** the sampled chunk-compute phase **did not show PG-side waits or buffer pressure** under heavy DELETE load. One sample; not a categorical statement about all chunk-compute phases. Adds operational confidence vs. wave 1/2 mid-probes which only sampled rest phase.

### Rest probe at T+17m 15s (`12:25:33Z`)
- Convex CPU 0.06 %, PG CPU 0.06 %, loadavg 0.58 / 0.36 / 0.34
- Quieter than wave 1/2 rest-phase baseline (Convex 2.82–3.47 %) — consistent with the daytime-UTC hypothesis above, n=1

## Post-audit

### Immediate post-terminal audit (~T+1 from terminal detection, `12:45:58Z`)
- PG: 0 long-active, 0 idle-in-tx, 0 waiting locks, 0 DFR/BIO/BP
- Convex CPU 0.02 %, PG CPU 0.16 %
- loadavg 0.15 / 0.22 / 0.25
- Host mem available 25 GiB
- WAL: 101 files / 1,616 MB (unchanged from pre-wave 101/1,616) — WAL stayed flat; checkpoint/recycle likely absorbed WAL during or around the wave
- **Clean settle** — rule 3 satisfied

### Settle re-probe (~T+17 from terminal, `13:02:13Z`)
- env confirmed `"0"`
- loadavg 0.27 / 0.51 / 0.37 (spading)
- Convex CPU 0.00 %, PG CPU 3.55 %
- 0 waiting locks; PG activity = idle clients + active probe
- WAL: 101 files / 1,616 MB (unchanged)
- **An organic burst was observed in the post-terminal window and had settled by 13:02Z.** Not cleanup-related; baseline activity pattern observed in 16-series and wave 2 closures. Does not affect verdict (rule 3 already passed at the immediate post-terminal audit).

## env multi-path verification

**env confirmations (3 paths):**
| Path | Result |
|---|---|
| Restorer log (atomic on first terminal poll, 12:45:14Z) | `env set 0` → `env verify '0'` |
| Local `npx convex env get` (immediate post-terminal, 12:45:58Z) | `"0"` |
| Operator settle re-probe (13:02:13Z) | env=`"0"` |

**Safety corroboration:** `cleanupRunState.isActive=false` (terminal row `76e7fd71103f`, `state="completed"`) — no active run = no env-controlled scheduler activity.

**Server-side docker logs cron-tick path**: still NOT applicable as continuous env verification (cleanup function logs only when invoked).

**No manual env intervention this wave** — restorer atomically closed env on its first terminal poll; operator directive `Главное: не трогать trigger/env вручную` followed throughout.

## Floor advance: +9m 55s (sparse-density region)

- Pre-wave floor: `2026-05-02T16:35:10Z` | Post-wave floor: `2026-05-02T16:45:04Z`
- Δ = +9m 55s (594.8 s) — sparse-density region (analog wave 2 +9m 38s, 16-series w4 +9.07, w10 +9.23)
- **`deletedCount = 24,000` is the stronger operational proof** — floor-time translation is density-dependent.
- Cumulative 24-ledger since 16-series anchor (`2026-05-02T16:19:44Z` → wave 3 end `16:45:04Z`): **+25m 20s in 3 waves, 72,000 rows deleted**

## Re-halt rules — all GREEN

| # | Rule | Status |
|---|---|---|
| 1 | `durationMs > 2,400,000` | PASS (2,183,464 = 90.98 % of hard) |
| 2 | Sustained PG waits across multiple probes | 0 at chunk-compute T+5m, rest T+17m, immediate post-terminal, settle re-probe |
| 3 | loadavg elevated and not settled by post-audit window | Immediate post-terminal settled. Settle re-probe captured an organic burst that had settled by 13:02Z; independent baseline event, not wave aftermath |
| 4 | env not back to `0` / `!= "1"` | env=`"0"` via 3 confirmations + 1 safety corroboration; restorer atomic close |
| 5 | non-cache RSS + MEM>30 % + headroom<5 GiB | host headroom 25 GiB throughout |
| 6 | runtime / SQL / cleanup discipline breach | none |

## Operational notes

- **SSH short-poll watcher + independent terminal-restorer pattern**: worked cleanly again; use this as the standard for future waves. Watcher captured 23/23 inter-chunk transitions with no sampling artifacts; restorer atomically closed env on its first terminal poll.
- **First chunk-compute mid-wave probe** in this series: confirms cleanup workload's PG-side profile stays clean even under active DELETE load (one sample).
- **Time-of-day**: working hypothesis — needs more samples (more daytime, ideally evening/night-UTC) to confirm.
- **No DNS flakiness** this wave; clean multi-path env verification end-to-end.
- **WAL stayed flat** through the wave (101 files / 1,616 MB unchanged), suggesting checkpoint/recycle absorbed WAL during or around the wave.
- **Mid-wave continuous threshold-145 push stream** still not armed; poll-based coverage adequate. True push-stream remains a future-tooling improvement.

## Ledger status (updated)

| Metric | Value |
|---|---|
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=24` |
| Waves run | **3** |
| Strict clean | 3 (`24c7323b15b8`, `8cd44b08a1d8`, `76e7fd71103f`) |
| Yellow | 0 |
| Red | 0 |
| Cumulative deleted | **72,000** |
| Cumulative floor advance | +25m 20s |
| Observed band | 2,183,464 – 2,240,974 ms (spread ~2.6 %), one daytime faster sample |
| Series review-eligibility threshold | **STILL NOT defined** — separate operator decision |

**3/3 clean does NOT auto-authorize anything**: not a 10-canary series, not maxRuns>24, not Tier 2 automation, not parallel waves. Each next step requires separate explicit operator go.

## Recommended next call

**Another maxRuns=24 manual canary in a different time-of-day bucket** to further explore the hypothesis. **Recommended next sample: evening UTC if operator availability allows; otherwise another daytime sample is still useful.** Either choice strengthens the dataset (n=4) and helps separate signal from one-sample variance.

**Tier 2 automation, larger param changes, parallel waves, and series-by-inertia remain explicitly NOT authorized.**

## Operational hygiene

- Single trigger only; no retry attempted.
- **No manual env intervention** (per operator directive). Restorer closed env atomically; multi-path verification confirmed.
- Admin key generated ephemerally from `INSTANCE_NAME` / `INSTANCE_SECRET` via inline node + project crypto path; used in separate subshells for trigger, watcher, and restorer; not intentionally logged or persisted.
- env=`"1"` window: `12:08:18Z → 12:45:14Z` (~36m 56s).
- No GUC toggle, no VACUUM/ANALYZE, no DDL/DML, no container changes.
- Closure doc will be authored from clean isolated worktree at `../addpilot-mr24-w3` on detached HEAD `8a93d1b` (`origin/emergency/drain-scheduled-jobs`). Main dirty WT untouched. Push lock `DISABLED_DO_NOT_PUSH_FROM_DIRTY_WT` preserved on main WT; per-WT pushurl set on this WT only via `git config --worktree`.
