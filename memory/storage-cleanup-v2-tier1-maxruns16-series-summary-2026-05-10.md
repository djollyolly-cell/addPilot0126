# Storage Cleanup V2 — Tier 1 maxRuns=16 series summary (2026-05-10) — **10/10 strict-clean threshold REACHED**

## Verdict

**Tier 1 series complete with 10/10 strict-clean threshold reached.** Eleven canary waves on profile `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` across ~11h 06m wall time on 2026-05-10 produced **10 strict-clean / 1 yellow / 0 red**. Profile is **review-eligible for Tier 2**, NOT automatically authorized — Tier 2 decision requires fresh PG snapshot + separate explicit operator go.

This summary fixes the series ledger as the operational canon. After this doc lands, work proceeds to: fresh PG snapshot (read-only diagnostic) → operator decision gate on next tier.

## Series identity

| Field | Value |
|---|---|
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Rows per wave (target) | 16,000 (16 chunks × 1,000) |
| Rows actually deleted | 16,000 per wave × 11 waves = **176,000 total** |
| Series date | 2026-05-10 |
| First trigger UTC | `2026-05-10T08:13:21Z` (w1) |
| Last terminal UTC | `2026-05-10T19:39:34Z` (w11) |
| Series wall time | ~11h 06m |
| Origin canon HEAD | `95e1300` (w11 closure) |
| Series doc this file replaces as canon | — (first series summary) |

## Final ledger

| Metric | Count |
|---|---|
| Total waves | 11 |
| Strict clean | **10** (w1, w2, w3, w4, w5, w7, w8, w9, w10, w11) |
| Yellow | 1 (w6) |
| Red | 0 |
| Hard re-halt rules triggered | 0 |
| Mid-wave probes fired (post-threshold-145 standard, w8–w11) | 0 |
| env-flip discipline violations | 0 |
| Floor regressions | 0 (monotonic) |

**10/10 strict-clean threshold REACHED** = first eligibility gate for Tier 2 review per operator agreement. Eligibility ≠ authorization.

## Per-wave table

| Wave | runId (short) | durationMs | Floor end (UTC) | Floor delta | Verdict | Notes |
|---|---|---|---|---|---|---|
| w1 | `c74ca9b2fe6d` | 1,455,738 | `2026-05-02T15:20:03Z` | — | clean | series start |
| w2 | `d88ff5ef84f3` | 1,452,529 | `2026-05-02T15:25:24Z` | +5.36 min | clean | |
| w3 | `694c4ce0294f` | 1,448,081 | `2026-05-02T15:30:30Z` | +5.10 min | clean | |
| w4 | `8734aea0c175` | 1,451,830 | `2026-05-02T15:39:35Z` | +9.07 min | clean | sparse-density floor jump |
| w5 | `25c80afba8c1` | 1,448,844 | `2026-05-02T15:44:39Z` | +5.07 min | clean | |
| w6 | `d3a776d75f11` | **1,504,803** | `2026-05-02T15:49:48Z` | +5.16 min | **yellow** | +57s outlier; strongly suspected (not proven) organic-burst dispatch overlap; normal floor advance |
| w7 | `69f72eeef224` | 1,446,753 | `2026-05-02T15:55:06Z` | +5.30 min | clean | last wave under threshold=110; 6 mid-wave probe fires (1 real + 5 polling-cadence artifact); led to threshold raise |
| w8 | `f0970af9676d` | 1,444,602 | `2026-05-02T16:00:10Z` | +5.08 min | clean | first wave under threshold=145 (0 fires) |
| w9 | `6609098e7e9d` | 1,442,927 | `2026-05-02T16:05:24Z` | +5.22 min | clean | |
| w10 | `bad0065b2658` | 1,439,197 | `2026-05-02T16:14:38Z` | +9.23 min | clean | sparse-density floor jump; series-min duration |
| w11 | `4bd5ee0a7f91` | 1,439,231 | `2026-05-02T16:19:44Z` | +5.10 min | clean | within 34 ms of w10 |

Floor end = post-wave `cleanupRunState.oldestRemainingTimestamp`. All deltas are `floor(N) − floor(N−1)`.

## Reproducibility metrics

| Metric | Value |
|---|---|
| Duration min | 1,439,197 ms (w10) |
| Duration max (excl. w6) | 1,455,738 ms (w1) |
| Duration max (incl. w6) | 1,504,803 ms (w6) |
| Spread, 10 strict-clean cluster | 16,541 ms ≈ **1.15 %** |
| Spread, full 11 waves incl. w6 | 65,606 ms ≈ 4.36 % |
| Inter-chunk gap band, w8–w11 | 93–95 s (15/15 transitions per wave) |
| Sub-24-min waves | 2 (w10, w11, both ~1,439.2k ms) |

Duration variance is dominated by w6's +57s outlier. Excluding w6, the cluster is exceptionally tight: ~1.15 % spread across 10 waves.

## Cumulative floor effect

| Metric | Value |
|---|---|
| Floor at end of w1 | `2026-05-02T15:20:03Z` |
| Floor at end of w11 | `2026-05-02T16:19:44Z` |
| Cumulative advance (end-w1 → end-w11) | **+59m 41s** in ~11h 06m wall |
| Floor advance per wave (median) | ~5.10 min |
| Sparse-region floor jumps | 2 (w4 +9.07 min, w10 +9.23 min) |
| Rows deleted | 176,000 |

**Backlog remaining (as of end of w11):** floor at `2026-05-02T16:19:44Z`, cutoffUsed ~7d 23h ahead. Convergence to 48h retention requires Tier 2 automation cadence — design refs in `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.

## Standards codified by this series

### SLOW_CHUNK_THRESHOLD = 145 s

- **Origin:** introduced after wave 7 polling-cadence-artifact analysis. The prior threshold (110 s) caused 6 mid-wave probe fires in w7 (1 real + 5 polling-cadence aliasing artifacts from Monitor cadence ≈ 45 s vs server chunk pacing ≈ 96 s).
- **Validated:** w8–w11 inclusive (4 consecutive waves at 0 fires). Per-doc internal counters in w9–w11 closures use slightly different counting conventions ("validated 3× now" in w9, "5th consecutive" in w11) — fact-level reality is **4 consecutive 0-fire waves under the new standard**.
- **Status:** standard for all future Tier 1 / Tier 2 waves on this profile. Re-evaluate only if Monitor cadence changes or chunk-timing baseline shifts (e.g., after PG tuning).

### env-flip discipline

- `METRICS_REALTIME_CLEANUP_V2_ENABLED` set to `1` only during the trigger → terminal window.
- After terminal detected: env restored to `0` within ≤30 s, verified `!= "1"` before any post-audit work.
- Series result: 0 discipline violations across 11 waves.

### Post-audit cadence

- T+0 probe at terminal: containers, loadavg, light PG views (pg_stat_activity, pg_locks, pg_wait_events).
- T+2:30 probe (mandatory regardless of mid-wave fires): same set.
- Heavy probes on `documents` / `indexes` (COUNT / MIN / MAX / GROUP BY) remain BANNED per PG-readonly policy.

### Re-halt rules (stable standard)

| # | Rule | Status in series |
|---|---|---|
| 1 | `durationMs > 1,500,000` | hit once (w6, 1,504,803) → yellow flag, not stop |
| 2 | Sustained PG waits (DFR / BIO / locks / long-active) across multiple probes | 0 sustained |
| 3 | Post-wave loadavg 5m/15m elevated and not settled by T+2:30 | 0 |
| 4 | env not returning to `0` / `!=1` | 0 |
| 5 | PG non-cache RSS growth + MEM >30 % + host headroom <5 GiB | 0 (see PG memory note below) |
| 6 | runtime / SQL / cleanup discipline breach | 0 |

w6's duration of 1,504,803 ms tripped rule 1 once (defined as "duration > 1,500,000 ms"). It was flagged yellow rather than red because all other gates remained clean and floor advance was normal. w7's return to band invalidated the "duration regression" hypothesis from w6.

## Observability reframes (softened from prior closures)

These reframes consolidate language across w7–w11 closures. Each is phrased to avoid overclaiming.

### Organic Convex CPU bursts — baseline activity, not cleanup-specific

- T+2:30 probes in w10 and w11 captured `adpilot-convex-backend` CPU bursts (99.83 % in w10, 78.08 % in w11) with PG container active simultaneously.
- The same pattern is observable with `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`, suggesting periodic organic activity (likely sync-metrics cron at 15-min cadence or similar background work).
- Whether the burst produces a visible `DataFileRead` event depends on whether the burst's working set is hot in cache: w10 burst hit cold pages → `DFR=1`; w11 burst stayed cache-resident → `DFR=0`.
- **Implication:** wave 7's earlier framing as "shared_buffers=128 MB infrastructure warning, cleanup-exposed" was **too narrow**. The same pattern appears in organic baseline.

### Wave 6 yellow — strongly suspected, not proven

- w6's +57s duration outlier is the only real wave-time deviation in the series.
- Best-supported hypothesis (per w7–w11 closures): organic-burst dispatch overlap caused scheduler delay during one or more chunk transitions.
- This hypothesis is **strongly suspected but not proven**. No single probe captured the causal chain at w6's actual time.
- Operational consequence for next tier: w6 alone is not a stop-signal for Tier 2 review; with w7–w11 all clean and tight, the dominant interpretation is "isolated organic-overlap incident", but the door is left open for a different explanation if a similar outlier recurs.

### PG memory follow-up — useful, not urgent, not blocking

- Wave 8 first noted `adpilot-postgres` docker stats MEM% jumping from ~2.83 % to ~42 %. Wave 9 confirmed the same baseline.
- Best-supported interpretation: cgroup/page-cache attribution, not RSS growth. Host headroom remained ≥ 25 GiB available across all probes (well above the 5 GiB rule-5 threshold).
- Docker MEM% alone is not treated as a blocker unless non-cache RSS grows AND host headroom drops.
- PG tuning (e.g., `shared_buffers` 128 MB → 2–3 GB target per `memory/postgres-tuning.md`) remains valuable but is NOT blocking Tier 2 review.

## Tier 2 status & next gates

| Gate | Status |
|---|---|
| 10/10 strict-clean waves at maxRuns=16 | ✅ MET (this series) |
| Fresh PG snapshot (read-only diagnostic) | ⏳ PENDING (separate go) |
| Operator decision on next tier | ⏳ PENDING (after PG snapshot) |
| Tier 2 authorization | **NOT AUTHORIZED** — eligibility ≠ authorization |

**Frozen until separate explicit decision** (carried forward unchanged from `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`):

- `restMs < 90000`
- `batchSize > 1000`
- `maxRuns > 16`
- Tier 2 automation
- Parallel waves

**Next sanctioned step:** fresh PG snapshot (read-only) → operator decision gate. PG raw probes on `documents` / `indexes` remain BANNED until shared_buffers ≥ 1 GB and documents heap hit ≥ 50 %.

## No-go windows (unchanged standard)

UTC boundaries to avoid (±5 min): `00:00`, `02:00`, `05:30`, `06:00`, `12:00`, `18:00`. For `maxRuns=16` profile, latest safe trigger = boundary − 35 min.

## Closure doc pointers

| Wave | Commit | Closure doc |
|---|---|---|
| w1 | `3b37a81` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-c74ca9b2fe6d.md` |
| w2 | `f3fba2a` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-d88ff5ef84f3.md` |
| w3 | `6b300fd` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-694c4ce0294f.md` |
| w4 | `f97e213` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-8734aea0c175.md` |
| w5 | `b6c9f4d` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-25c80afba8c1.md` |
| w6 | `b6a5cc3` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-d3a776d75f11.md` |
| w7 | `bc72f5e` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-69f72eeef224.md` |
| w8 | `b41f88e` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-f0970af9676d.md` |
| w9 | `f1ed19b` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-6609098e7e9d.md` |
| w10 | `59e937d` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-bad0065b2658.md` |
| w11 | `95e1300` | `memory/storage-cleanup-v2-tier1-canary-2026-05-10-4bd5ee0a7f91.md` |

## Supporting references

- `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md` — frozen profile rationale, drain plan, no-go windows
- `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md` — Tier 1 → Tier 2 progression design
- `memory/postgres-tuning.md` — PG tuning TODO (shared_buffers, work_mem, effective_cache_size)
- `memory/pg-readonly-diagnostic-2026-05-09.md` — pre-series PG baseline (Hypothesis C structural support)
- `memory/pg-readonly-diagnostic-2026-05-09b.md` — post-BD-2 read-only snapshot, host memory clarifications

---

**Authored from clean worktree** at `../addpilot-series-summary` (detached HEAD `95e1300`). Main dirty WT untouched. Push lock `DISABLED_DO_NOT_PUSH_FROM_DIRTY_WT` preserved on main WT; per-WT pushurl set on summary WT only.
