# Storage Cleanup V2 — Tier 1 maxRuns=24 single canary closure (2026-05-11 07:43Z, wave 2 of new ledger) — **CLEAN**

## Verdict

**Clean because all hard gates passed, duration stayed below yellow threshold, T+~3 post-audit was green, and env was confirmed `"0"` via three independent paths.** Second canary at `maxRuns=24` profile: reproduction tight, terminal `completed`, 24/24 chunks, 24,000 rows deleted. **Duration `2,230,273 ms` (37m 10.27s) — faster than wave 1 by 10,701 ms (0.48 %)**; **96.97 % of yellow / 92.93 % of hard**; essentially **AT the pre-wave predicted band ceiling (+273 ms above)**.

This is wave 2 of the **Tier 1 maxRuns=24 ledger** opened by wave 1 closure `5a94fbe`. With n=2 samples, an observed band begins to form: `2,230,273–2,240,974 ms`, spread 0.48 %. Tight reproducibility, but **2 samples remain insufficient** to fix the band statistically.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778485409048-8cd44b08a1d8` |
| short-runId | `8cd44b08a1d8` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=24` |
| Series | Tier 1 maxRuns=24, wave 2 |
| Prior anchors | `5a94fbe` (wave 1 closure), `6d5c6eb` (PG snapshot), `5428e77` (16-series summary), `95e1300` (w11) |
| Trigger UTC | `2026-05-11T07:43:27Z` |
| `lastBatchAt` / computed terminal | `2026-05-11T08:20:39Z` (lastBatchAt `1778487639299` = 08:20:39.299Z; trigger + durationMs = 08:20:39.321Z; 22 ms gap = internal row-finalization order) |
| Watcher-detected terminal | `2026-05-11T08:21:36Z` (~57 s lag; final watcher poll caught the transition) |
| **Restorer-detected terminal & env restore** | first poll of independent terminal-restorer process; env set 0 + verified `0` ≠ `1` before any subsequent manual check |
| Manual env re-verify | `2026-05-11T08:22:26Z` — confirmed `0` (idempotent with restorer's earlier set) |
| Total wall (`durationMs`) | **2,230,273 ms** (37m 10.27s) |
| batches | 24/24 |
| deleted | 24,000 |
| error | `null` |

## Timeline (key UTC events)

| UTC | T+ | Event |
|---|---|---|
| `07:39Z` | — | Mini-preflight #2 PASS (Convex 0.07 % / PG 0.07 %, loadavg 0.04/0.15/0.18) |
| **`07:43:27Z`** | **T+0** | **Trigger** — env flip 0→1 verified, runId `8cd44b08a1d8`, `state="running"`, `isActive=true`, `maxRuns=24` |
| `07:44:27Z` | T+1m | SSH short-poll watcher using Convex admin `list_snapshot` armed from start (background); iter 1 captured |
| `07:46:00Z – 08:15:49Z` | T+2m – T+32m | Watcher captured per-chunk progression: 21 inter-chunk gaps in 93–97 s band (consistent with 16-series ~94 s) |
| `08:17:32Z` | T+34m | Watcher iter 22: `batchesRun 21→23` with 103 s window — sampling artifact (poll cadence briefly slower than chunk cadence), not anomaly |
| `08:19:25Z` | T+35m 58s | Independent terminal-restorer process started (background, separate from watcher); poll cadence 60 s baseline, 30 s after T+30m |
| **`08:20:39Z`** | **T+37m 12s** | Terminal `state="completed"`, `isActive=false`, `durationMs=2,230,273` per cleanupRunState |
| `~08:20:40Z+` | ~T+37m 13s | Restorer first poll completed (npx call return time, not log-timestamp); detected `state="completed"`; **env set 0 + verified `0`** |
| `08:21:36Z` | T+37m 9s (approx) | Logger-watcher detected terminal at its next poll cycle (had been polling at 90 s cadence) |
| `08:22:26Z` | T+39m | Manual env re-verify (redundant; DNS-flake in initial local CLI check briefly returned `'1'` — see Operational notes); set & verify `0` |
| `08:22:58Z` | T+~3 from terminal | Post-audit T+~3 |
| `08:27:11Z` | T+~6.5 from terminal | Post-audit T+~5 (captured organic Convex burst — see T+5 section) |

## Threshold check

| Gate | Threshold | Actual | % | Result |
|---|---|---|---|---|
| Hard re-halt (rule 1) | >2,400,000 ms | 2,230,273 ms | **92.93 %** | **PASS** (−169,727 below) |
| Yellow | >2,300,000 ms | 2,230,273 ms | **96.97 %** | **PASS** (−69,727 below) |
| Pre-wave predicted band ceiling | 2,230,000 ms | 2,230,273 ms | — | **+273 ms above** (essentially at ceiling) |
| vs wave 1 baseline | 2,240,974 ms | 2,230,273 ms | — | **−10,701 ms (faster)** |
| Other re-halt rules (2–6) | — | all green | — | **PASS** |

## Observed band (n=2)

| Wave | runId | durationMs | UTC trigger | Floor end |
|---|---|---|---|---|
| 1 | `24c7323b15b8` | 2,240,974 | 2026-05-11T06:24:44Z | 2026-05-02T16:25:32Z |
| 2 | `8cd44b08a1d8` | **2,230,273** | 2026-05-11T07:43:27Z | 2026-05-02T16:35:10Z |

- Min: `2,230,273` (wave 2)
- Max: `2,240,974` (wave 1)
- **Spread: 10,701 ms = 0.48 %** — very tight (16-series cluster was 1.15 % across 10 samples)
- Both samples below yellow threshold; both essentially at predicted ceiling

**2 samples still insufficient** to fix band statistically — 1–2 more canaries would strengthen the observed band before any next-tier decision.

## Mid-wave per-chunk gap distribution

From SSH short-poll watcher using Convex admin `list_snapshot` (90 s poll cadence, retry on empty):

- iters 1–21 (T+1m – T+32m): inter-chunk gaps `93–97 s`, consistent with 16-series ~94 s baseline
- iter 22 (T+34m): `batchesRun 21→23` with 103 s window — watcher poll cadence briefly slower than chunk cadence, sampled across 2 transitions; not anomaly
- iter 23 (terminal at watcher next-cycle, T+~37m): terminal correctly detected
- **No observed sampled interval suggested a >145 s slowdown; poll-based watcher is not a true push-stream per-gap monitor.** Continuous push-stream variant remains a future-tooling improvement.

## Post-audit

### T+~3 (`08:22:58Z`)
- PG waits: 0 long-active, 0 idle-in-tx, 0 waiting locks, 0 DFR/BIO/BP
- WAL: **145 files / 2,320 MB** (Δ vs pre-wave 164/2624: `−19 files / −304 MB`; checkpoint drained further)
- Host: loadavg 0.10 / 0.35 / 0.36, mem available 25 GiB
- adpilot-postgres CPU 0.06 %, adpilot-convex-backend CPU 0.06 %
- **Clean settle** — rule 3 satisfied at T+~3

### T+~5 (`08:27:11Z`)
- **Organic Convex CPU burst captured: adpilot-convex-backend = 50.54 %**
- **PG-side remained clean: PG CPU 6.05 %, 0 waiting locks, 0 DFR/BIO/BP**
- env confirmed `"0"` via local CLI (DNS recovered); cleanupRunState confirms 0 active runs
- WAL stable: 145 files / 2,320 MB (unchanged vs T+~3)
- loadavg still settled: 0.25 / 0.31 / 0.34
- **Not cleanup-related.** Wave terminated at 08:20:39Z; env=0 since restorer's first poll (~08:20:40Z+). The CPU burst at 08:27:11Z is the documented organic baseline pattern (matches 16-series w7/w10/w11 T+2:30 captures and wave 1 mini-preflight #1 06:15Z). PG-side fully quiet confirms it's not touching cold pages this time.
- **Does NOT affect wave 2 verdict.** Rule 3 (post-wave settle) was passed at T+~3; T+~5 captured a subsequent independent organic event, not wave aftermath.

## env multi-path verification

| Path | Result | Note |
|---|---|---|
| Local `npx convex env get` (initial, 08:21:26Z) | briefly returned `'1'` after WebSocket DNS errors with reconnect retries | local DNS flake; possibly returned stale value before restorer's set landed, or before final reconnect succeeded |
| Restorer log (`/tmp/wave2-restorer.log`) | `env set 0` → `env verify '0'` on first terminal poll | independent process, separate CLI instance |
| Manual env re-set (08:22:26Z) | set → `'0'`, verified | redundant (idempotent with restorer's set), DNS clean by then |
| Local `npx convex env get` (T+~5, 08:27:11Z) | `"0"` | DNS clean |
| `cleanupRunState.isActive` | `false`, latest row `8cd44b08a1d8` `state="completed"` | indirect: no active run means no env-controlled scheduler activity |
| Server-side docker logs `[cleanup-v2] cron tick` | **N/A** | cleanup function logs only when invoked; not invoked while env=0; not a viable verification path |

**3 independent confirmations** of env=`"0"` (restorer log + redundant manual set + local CLI after DNS clean). **No material window observed** where env stayed `"1"` after terminal — restorer set env=0 on first terminal poll, which by row-finalization timing was very close to the terminal itself.

## Floor advance: +9m 38s (sparse-density region)

- Pre-wave floor: `2026-05-02T16:25:32Z` (matches wave 1 closure)
- Post-wave floor: `2026-05-02T16:35:10Z`
- **Δ = +9m 38s (578 s)** — sparse-density region (analogous to 16-series w4 +9.07 min, w10 +9.23 min)
- Wave 1: +5m 48s (normal-density) | Wave 2: +9m 38s (sparse)
- Cumulative since 16-series anchor (`2026-05-02T16:19:44Z`): **+15m 26s in 2 waves, 48,000 rows deleted**

**`deletedCount = 24,000` is the stronger operational proof** — floor-time translation is density-dependent and varies wave-to-wave.

## Re-halt rules — all GREEN

| # | Rule | Status |
|---|---|---|
| 1 | `durationMs > 2,400,000` | PASS (2,230,273) |
| 2 | Sustained PG waits across multiple probes | 0 at T+~3 AND 0 at T+~5 (despite Convex CPU burst at T+~5, PG-side fully quiet) |
| 3 | loadavg elevated and not settled by post-audit window | T+~3 settled (rule 3 passed). T+~5 organic burst is independent baseline event, not post-wave aftermath |
| 4 | env not back to `0` / `!= "1"` | env=`"0"` verified via 3 independent paths |
| 5 | non-cache RSS + MEM>30 % + headroom<5 GiB | host headroom 25 GiB throughout |
| 6 | runtime / SQL / cleanup discipline breach | none |

## Operational notes

### SSH short-poll watcher using Convex admin `list_snapshot` (deployed from start) ✓
- Started ~1 min after trigger
- 90 s poll cadence, retry-on-empty
- Captured per-chunk progression cleanly across 21 visible inter-chunk transitions
- One sampling artifact at iter 22 (batches 21→23 in single poll window) — known limitation of poll-based monitoring vs continuous stream
- Detected terminal correctly at its next poll cycle after row finalization

### Independent terminal-restorer process ✓
- Started at T+35m 58s as separate background process (independent of logger-watcher)
- 60 s baseline cadence → 30 s once T+30m reached
- First poll detected `state="completed"`; immediately set env=0 + verified `'0'`
- Closed env discipline window atomically — **no material window observed where env stayed `"1"` after terminal**

### Local DNS flakiness during initial env-verify
- Local `npx convex env get` at 08:21:26Z encountered `WebSocket getaddrinfo ENOTFOUND` with reconnect retries
- After ~12 s of retries, returned `'1'` (possibly stale, possibly racing the restorer's set)
- Restorer log shows env was set to `0` and verified `'0'` independently
- Manual re-set at 08:22:26Z (DNS clean) confirmed `'0'` (idempotent)
- **Lesson:** for safety-critical env state, multi-path verification (CLI + restorer + indirect-via-cleanupRunState) is essential; do not rely on single local CLI path

### Watcher log-timestamps reflect start-of-iter, not call-completion
- Background-process timestamp `08:19:25Z` for restorer's first iter is when iter STARTED, not when the `npx` call returned
- Actual restorer env-set call completed near `08:20:40Z+`
- Slightly misleading in raw log; functional correctness unaffected

### Server-side env path via docker logs — NOT applicable
- Intent: pull latest `[cleanup-v2] cron tick at X; env=N` line from `docker logs adpilot-convex-backend`
- Reality: cleanup function logs **only when invoked**; while env=0 and no manual trigger, no log lines appear
- **Conclusion:** this is not a viable continuous server-side env verification path. To get such a path would require either a separate periodic ping function or a dedicated Convex admin HTTP endpoint for env reads.

### Mid-wave continuous threshold-145 push stream — NOT armed (same as wave 1)
- Sampled coverage via CLI short-poll watcher (all gaps were 93–97 s); no observed interval suggested a >145 s slowdown
- True push-stream variant would require additional tooling

## Ledger status (updated)

| Metric | Value |
|---|---|
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=24` |
| Waves run | 2 |
| Strict clean | 2 (wave 1 `24c7323b15b8`, wave 2 `8cd44b08a1d8`) |
| Yellow | 0 |
| Red | 0 |
| Cumulative deleted | 48,000 |
| Cumulative floor advance | +15m 26s (from end-of-16-series anchor `2026-05-02T16:19:44Z`) |
| Observed band | 2,230,273 – 2,240,974 ms (spread 0.48 %) |
| Series review-eligibility threshold | **STILL NOT defined** — separate operator decision (analogous to 10/10 for 16-series, TBD for 24-series) |

**2/2 clean does NOT auto-authorize anything:** not a 10-canary series, not maxRuns=N>24, not Tier 2 automation, not parallel waves. Each next step requires separate explicit operator go. Eligibility ≠ authorization.

## Recommended next call

**Another `maxRuns=24` manual canary** to bring observed band to n=3 — at that point the band has minimal statistical meaning and time-of-day variance can begin to be assessed.

Alternative: **hold and observe**.

**Tier 2 automation, larger param changes, and parallel waves remain explicitly NOT authorized.**

## Operational hygiene during this wave

- Single trigger only. No retry attempted.
- Admin key generated ephemerally from `INSTANCE_NAME` / `INSTANCE_SECRET` via inline node + project crypto path; used in separate subshells for trigger, watcher, and restorer; not intentionally logged or persisted.
- env=`"1"` window: `07:43:27Z → ~08:20:40Z+` (~37m 13s, from env flip to restorer's first terminal poll). env=`"0"` confirmed via 3 paths before T+~3 audit.
- No GUC toggle, no VACUUM/ANALYZE, no DDL/DML, no container changes.
- Closure doc will be authored from clean isolated worktree at `../addpilot-mr24-w2` on detached HEAD `5a94fbe` (`origin/emergency/drain-scheduled-jobs`). Main dirty WT untouched. Push lock `DISABLED_DO_NOT_PUSH_FROM_DIRTY_WT` preserved on main WT; per-WT pushurl set on snapshot WT only via `git config --worktree`.
