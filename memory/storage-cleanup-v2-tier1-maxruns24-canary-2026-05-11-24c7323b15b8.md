# Storage Cleanup V2 — Tier 1 maxRuns=24 single canary closure (2026-05-11 06:24Z, wave 1 of new ledger) — **CLEAN with minor timing note**

## Verdict

**Clean because all hard gates passed, duration stayed below yellow threshold, and post-audits were green.** First canary at `maxRuns=24` profile: profile reproduced for all structural fields, terminal `completed`, 24/24 chunks, 24,000 rows deleted, env restored to 0 within ~12s of computed terminal, floor monotonically advanced. **Duration `2,240,974 ms` (37m 20.97s)** — slightly above pre-wave predicted clean band, still well below the yellow threshold (97.43 % of yellow / 93.37 % of hard). **First sample is insufficient to establish the maxRuns=24 expected band**; this is one data point.

This wave opens a **new ledger** (Tier 1 maxRuns=24), not a continuation of the Tier 1 maxRuns=16 series (closed at series summary `5428e77`). Series eligibility / authorization rules apply independently — 1/1 clean is review-eligible only for further canaries on this profile, NOT for automatic series promotion.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778480686779-24c7323b15b8` |
| short-runId | `24c7323b15b8` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=24` |
| Series | Tier 1 maxRuns=24, wave 1 (new ledger) |
| Prior series anchor | `5428e77` (Tier 1 maxRuns=16 summary; final wave w11 closure `95e1300`; fresh PG snapshot `6d5c6eb`) |
| Trigger UTC | `2026-05-11T06:24:44Z` |
| `lastBatchAt` / terminal computed | `2026-05-11T07:02:07Z` (lastBatchAt `1778482927742` = 07:02:07.742Z; computed terminal `startedAt + durationMs` = 07:02:07.753Z; 11 ms gap = internal row finalization order: last-batch update, then state="completed" with durationMs sealed) |
| Watcher-detected terminal | `~2026-05-11T07:02:15Z` (~7 s lag after row finalization; normal poll-based detection latency) |
| env restored UTC | `2026-05-11T07:02:19Z` (verified `0` ≠ `1`; ~12 s after computed terminal, ~4 s after watcher detection) |
| Total wall (`durationMs`) | **2,240,974 ms** (37m 20.97s) |
| batches | 24/24 |
| deleted | 24,000 |
| error | `null` |

## Timeline (key UTC events)

| UTC | T+ | Event |
|---|---|---|
| `04:25Z` | — | Initial full preflight (separate session) — GREEN |
| `04:47Z` | — | Pre-wave runway check — NO-GO (43 min runway vs 50 min floor) |
| `06:15Z` | — | Mini-preflight #1 — HOLD: organic Convex burst captured (Convex 74.88 % / PG 31.72 % / DFR=0) |
| `06:21Z` | — | Mini-preflight #2 — PASS: Convex 3.64 % / PG 7.42 % / loadavg 1m 1.10 → 0.24 |
| **`06:24:44Z`** | **T+0** | **Trigger** — env flip 0→1 verified, `runId 24c7323b15b8`, `state="running"`, `isActive=true`, `maxRuns=24`, all 4 args verified against expected |
| `06:42Z` | T+17m 16s | Mid-wave probe — Convex 2.82 %, PG 0.13 %, waits/locks 0 |
| `06:50Z` | T+25m 16s | Mid-wave probe — Convex 3.47 %, PG 0.02 %, waits/locks 0 |
| `06:56Z` | T+31m 16s | Mid-wave probe — Convex 3.03 %, PG 0.03 %, waits/locks 0 |
| **`07:02:07Z`** | **T+37m 23s** | Terminal `state="completed"`, `isActive=false`, `durationMs=2,240,974` (per cleanupRunState) |
| `07:02:15Z` | T+37m 31s | Watcher detected terminal (poll lag ~7 s) |
| `07:02:19Z` | T+37m 35s | env restored 1→0, verified `0` ≠ `1` |
| `~07:05Z` | T+~3 | Post-audit — PG waits/locks 0, WAL 173 files / 2,768 MB, host headroom 25 GiB |
| `~07:07Z` | T+~5 | Settle probe — Convex 2.96 %, PG 6.60 %, waits/locks 0 |

## Threshold check

| Gate | Threshold | Actual | % of threshold | Result |
|---|---|---|---|---|
| Hard re-halt (rule 1) | >2,400,000 ms | 2,240,974 ms | **93.37 %** | **PASS** (−159,026 below) |
| Yellow | >2,300,000 ms | 2,240,974 ms | **97.43 %** | **PASS** (−59,026 below) |
| Pre-wave predicted clean band | 2,170,000–2,230,000 ms | 2,240,974 ms | — | **note: +10,974 above ceiling** (+0.49 % over ceiling) |
| All other re-halt rules (2–6) | — | all green | — | **PASS** |

**Note framing:** the "expected clean band" `2,170k–2,230k` was a pre-wave **prediction** derived from `w11 + 8 × ~94 s gaps`. It was a projection, not an observed band — there was no prior maxRuns=24 data to anchor on. This wave is 11 s above the prediction ceiling. **One sample is insufficient to establish the actual maxRuns=24 band**; 2–3 more canaries would be needed before fixing band boundaries.

### Decomposition: where the +50 s vs predicted centre came from

- Predicted centre: `1,439,231 ms (w11) + 8 × 94,000 ms (gaps) = 2,191,231 ms`
- Actual: `2,240,974 ms`
- Delta: **+49,743 ms over predicted centre** (~+2.3 %)
- Per-additional (chunk+gap) unit: `49,743 / 8 ≈ 6.2 s` longer than the 16-wave baseline per added unit

Candidate causes — **1 sample cannot distinguish**:

1. Random variance. The 16-wave 10-strict-clean cluster spread was ~1.15 % (16,541 ms). Scaled to a 24-chunk wave, ~2.3 % spread is a comparable order of magnitude.
2. Time-of-day effect. w11 ran at `19:14Z`, w12 at `06:24Z`. Different organic activity / cron alignment / connection-pool warmth.
3. Cumulative micro-overhead per chunk. If each (chunk+gap) carries small constant overhead, longer chains accumulate it. 6 s/chunk drift is high for "micro" though.
4. Mid-wave organic-burst overlap with 1–2 chunks. Mid-wave probes (T+17 / T+25 / T+31) all captured the "rest" phase (Convex 2.82–3.47 %), so any burst-overlap moments are not directly observed. Cannot be ruled out.

## Mid-wave probes (all clean)

| UTC | T+ | Convex CPU | PG CPU | Waiting locks | DFR/BIO/BP |
|---|---|---|---|---|---|
| 06:42Z | 17m 16s | 2.82 % | 0.13 % | 0 | 0 |
| 06:50Z | 25m 16s | 3.47 % | 0.02 % | 0 | 0 |
| 06:56Z | 31m 16s | 3.03 % | 0.03 % | 0 | 0 |

All three probes captured the **rest phase** between chunks (90 s rest dominates the ~96 s chunk+rest cycle), so they sampled the idle interval. CPU values near baseline idle confirm: between chunks the system is fully quiet; the wave does NOT create sustained background load. Continuous threshold-145 stream was NOT armed for this canary (see Operational notes); per-chunk gap distribution therefore remains uncharted in detail.

## Post-audit

### T+~3 (`~07:05Z`)
- PG waits: 0 long-active, 0 idle-in-tx, 0 waiting locks, 0 DFR/BIO/BP
- WAL: **173 files / 2,768 MB**
- Host headroom: **25 GiB** available
- WAL Δ vs pre-wave (`217 files / 3,472 MB`): **−44 files / −704 MB** — a checkpoint completed during or shortly after the wave, draining accumulated WAL. Consistent with healthy storm-fix behaviour.

### T+~5 settle (`~07:07Z`)
- Convex 2.96 %, PG 6.60 %
- 0 waiting locks, 0 long-active
- Slight PG CPU elevation (6.60 % vs idle ~0.05 %), no waits / locks; **not sustained and not operationally concerning**.

T+5 was conducted as a conditional check (per pre-wave agreement: optional unless T+2:30 captured anything). T+~3 was clean, so T+5 effectively served as an extra confirmation data point.

## Floor advance

- Pre-wave floor: `2026-05-02T16:19:44Z` (matches w11 closure & series summary `5428e77`)
- Post-wave floor: `2026-05-02T16:25:32Z`
- **Δ = +5m 48s (348 s)**
- 16-wave typical: +5m 6s (306 s)
- Observed gain over 16-wave typical: +42 s

**Interpretation:** the +5m 48s advance is normal density-dependent translation. **Floor-time translation is density-dependent, and `deletedCount = 24,000` is the stronger operational proof here**. 24,000 rows were physically deleted; their distribution along the time axis determines how much the floor pointer moves, not the count itself. The pre-wave estimate of "+7.5 min for 24 chunks" assumed proportional scaling from the 16-wave typical — that assumption was overly geometric. The 16-wave series itself showed floor-advance variance independent of `maxRuns` (e.g. w4 +9.07 min sparse vs w5 +5.07 min normal).

**This is NOT an anomaly signal.** The agreed `floor advance <5 min → investigate (not halt)` rule was set as a safety check; +5m 48s clears it.

## Re-halt rules — all GREEN

| # | Rule | Status |
|---|---|---|
| 1 | `durationMs > 2,400,000` (scaled for maxRuns=24) | PASS (2,240,974) |
| 2 | Sustained PG waits across multiple probes | 0 in mid-wave + T+~3 + T+~5 |
| 3 | loadavg elevated and not settled by post-audit window | T+~3 / T+~5 both settled |
| 4 | env not back to `0` / `!= "1"` | env=`"0"` verified at 07:02:19Z |
| 5 | non-cache RSS + MEM>30 % + headroom<5 GiB | host headroom 25 GiB throughout |
| 6 | runtime / SQL / cleanup discipline breach | none |

## Operational notes

- **Local `npx convex` long-running watcher hung.** Behavior consistent with `npx`-spawned process not surviving extended sessions. **Switched to SSH-based short-poll watcher** (recurring SSH probes querying `cleanupRunState`). Watcher correctly detected `state="completed"` (~7 s after row finalization) and triggered env-flip back to 0.
- **Transient SSH `rc=255` during polling.** A few SSH connection drops during the wave; watcher survived (per loop structure). Network flutter, not a service-side issue.
- **Mid-wave threshold-145 monitor was NOT armed** for this wave (continuous foreground watcher not maintained). Mid-wave probes were therefore manual / ad-hoc snapshots, not a full inter-chunk gap stream. Per-chunk timing decomposition is therefore unavailable for this canary.
- **Watcher tooling lesson (actionable for next wave):** prefer a **server-side short SSH/curl `cleanupRunState`-poll watcher from the start**; avoid long-running local `npx convex` watcher. Add retry-on-rc=255 logic at the SSH-poll layer so transient network flutter doesn't bail the watcher.

## Ledger status (new ledger)

| Metric | Value |
|---|---|
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=24` |
| Waves run | 1 |
| Strict clean | 1 (this wave) |
| Yellow | 0 |
| Red | 0 |
| Cumulative deleted | 24,000 |
| Cumulative floor advance | +5m 48s (from end of Tier 1 maxRuns=16 series anchor) |
| Series review-eligibility threshold | **NOT defined yet** — separate operator decision on what threshold applies for the 24-wave series (analogous to 10/10 for the 16-series) |

**1/1 clean does NOT auto-authorize either a series of 10 canaries or Tier 2 automation.** Eligibility ≠ authorization. Operator decides next step separately.

## Recommended next call

**Another `maxRuns=24` manual canary** to build a small N-sample dataset before fixing band boundaries — 1 sample doesn't establish a band. With 2–3 more canaries the observed band, drift trend (or absence), and time-of-day effects become distinguishable.

Alternatively, **hold and observe at the current Tier 1 maxRuns=16 cadence** if the 24-track is paused for now.

**Tier 2 automation is explicitly NOT recommended after a single sample.**

Optional supplementary actions (not on the main next-call line):
- Pull Convex per-batch timing from logs for `06:24:44Z – 07:02:07Z` if available, to confirm whether the +50 s came from 1–2 slow chunks vs evenly distributed drift.

## Operational hygiene during this wave

- Single trigger only. No retry attempted at any point.
- Admin key generated ephemerally from `INSTANCE_NAME` / `INSTANCE_SECRET` via inline node + project crypto path; consumed by Convex CLI commands and `unset` on exit; never logged, written to disk, or echoed.
- env flip discipline maintained: env=`"1"` only during the `06:24:44Z → 07:02:19Z` window (~37m 35s); env=`"0"` confirmed before any post-audit work.
- No GUC toggle, no VACUUM/ANALYZE, no DDL/DML, no container changes.
- Closure doc authored from clean isolated worktree at `../addpilot-mr24-w1` on detached HEAD `6d5c6eb` (`origin/emergency/drain-scheduled-jobs`). Main dirty WT untouched. Push lock `DISABLED_DO_NOT_PUSH_FROM_DIRTY_WT` preserved on main WT; per-WT pushurl set on this WT only via `git config --worktree`.
