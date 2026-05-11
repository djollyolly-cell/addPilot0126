---
name: storage-cleanup-v2-tier1-maxruns24-canary-2026-05-11-605b8ed53962
description: Tier 1 maxRuns=24 wave 4 closure CLEAN — new fastest in series, evening ToD bucket added, restorer tooling SPOF identified as hard gate for wave 5
type: project
---

# Storage Cleanup V2 — Tier 1 maxRuns=24 Canary Wave 4 CLOSURE (CLEAN)

**Status:** CLEAN. **4/4 strict clean** in maxRuns=24 series.
**Verdict:** Wave executed inside pre-wave predicted band, set new observed-fastest, tooling SPOF identified as hard gate for wave 5.

---

## Wave Vitals

| Field | Value |
|---|---|
| runId | `1778525039989-605b8ed53962` |
| shortRunId | `605b8ed53962` |
| Profile | `batchSize=1000`, `timeBudgetMs=10000`, `restMs=90000`, `maxRuns=24` |
| Trigger UTC | `2026-05-11T18:43:59.989Z` |
| Terminal UTC | `2026-05-11T19:20:12.357Z` |
| lastBatchAt | `2026-05-11T19:20:12.343Z` |
| Computed terminal | `startedAt + durationMs = 2026-05-11T19:20:12.357Z` (~14ms row-finalization gap) |
| Duration | `2,172,368 ms` = `36m 12.37s` |
| Batches | `24 / 24` |
| Rows deleted | `24,000` |
| Errors | `0` |
| Final state | `completed`, `isActive=false` |
| Floor end (oldestRemainingTimestamp) | `1777740889783` → `2026-05-02T16:54:49.783Z` |
| Floor advance vs wave 3 | `+9m 44.947s` |
| env post-wave | `0` (manually restored, verified) |

---

## Pre-Wave Predicted Band vs Actual

| Threshold | Value | Wave 4 result |
|---|---|---|
| Pre-wave predicted band (canon) | `2,170,000 – 2,230,000 ms` | **INSIDE band, +2,368 ms above floor** |
| Yellow threshold | `> 2,300,000 ms` | headroom `127,632 ms` |
| Hard re-halt | `> 2,400,000 ms` | headroom `227,632 ms` |
| SLOW_CHUNK_THRESHOLD | `145s` per inter-chunk gap | sampled progression below threshold (poll-based, not push-stream — see Mid-Wave) |

Wave 4 landed essentially on the lower edge of the canon predicted band. The pre-wave forecast was accurate.

In the **observed-from-actuals** series (descriptive statistic, not the canon band), wave 4 set a **new fastest**: `−11,096 ms vs wave 3` (prior fastest).

---

## Per-Wave Comparison (24-series, n=4)

| Wave | Trigger UTC | ToD bucket | Duration ms | Duration | Δ vs canon floor | vs prior fastest |
|---|---|---|---|---|---|---|
| 1 | `06:24:44Z` | early morning | `2,240,974` | `37m 20.97s` | `+70,974` | baseline |
| 2 | `07:43:27Z` | early morning | `2,230,273` | `37m 10.27s` | `+60,273` | `−10,701` |
| 3 | `12:08:18Z` | daytime | `2,183,464` | `36m 23.46s` | `+13,464` | `−46,809` |
| **4** | **`18:43:59Z`** | **evening** | **`2,172,368`** | **`36m 12.37s`** | **`+2,368`** | **`−11,096`** |

**Observed band evolution:**
- n=3 (post-w3): `2,183,464 – 2,240,974 ms`, spread `2.6%`
- n=4 (post-w4): `2,172,368 – 2,240,974 ms`, spread `3.16%` (natural expansion with new low)

---

## Time-of-Day Pattern — Consistent / Weak Support, Not Proof

Two clusters visible:
- **Early-morning bucket (w1, w2):** both `~37m 10–20s`, intra-cluster Δ `~10s`
- **Daytime/evening bucket (w3, w4):** both `~36m 12–23s`, intra-cluster Δ `~11s`
- **Inter-cluster gap:** `~47s` (medium → fast)

This is consistent with the ToD variance hypothesis raised in wave 3 closure, but `n=4` with effectively 3 distinct ToD buckets (w1+w2 share the early-morning bucket) is **not proof**. To establish ToD as a causal factor, need:
- `n ≥ 6` with `≥ 2 samples per bucket`
- Ideally additional samples in early-morning (confirm slow cluster) and evening (confirm fast cluster)

Until then: **consistent pattern, weak support, not proven.**

---

## Floor Advance Analysis

| Wave | Floor end | Per-wave advance |
|---|---|---|
| anchor (post-16-series) | `2026-05-02T16:19:44Z` | — |
| w1 | `2026-05-02T16:25:32Z` | `+5m 48s` |
| w2 | `2026-05-02T16:35:10Z` | `+9m 38s` |
| w3 | `2026-05-02T16:45:04Z` | `+9m 54s` |
| w4 | `2026-05-02T16:54:49.783Z` | `+9m 44.947s` |

**Cumulative from anchor:** `+35m 05.8s` (24-series only).
**Cumulative rows deleted:** `96,000`.

**Density observation:**

w1 floor advance `+5m 48s`, while w2–w4 cluster near `+9m 40s`; floor advance remains density-dependent. Smaller w1 advance with same row count (24,000) corresponds to a denser region (more rows per unit time on the time-axis). w2–w4 region has more uniform ingest density. Floor advance is not predictable from prior waves alone.

---

## Mid-Wave Progress Markers

| Time | Event |
|---|---|
| T+0 | Trigger `18:43:59Z` |
| T+~5 | 2/24 batches, 2,000 deleted (early ramp) |
| T+~17 | Rest-phase probe: Convex `0.02%`, PG `0.23%`, waits/locks/DFR/BIO `0`, WAL `63 / 1008 MB` |
| mid-wave | Sampled watcher progression stayed well below the `145s` concern threshold; poll-based watcher is not a true push-stream per-gap monitor |
| progression | 11 → 12 → 13 → 15 → 16 → 17 → 19 → 24 |
| Terminal | `19:20:12.357Z` |

Per-gap monitor was poll-based, not push-stream; SLOW_CHUNK_THRESHOLD fires would only be detectable mid-poll-interval. No fires observed at sample boundaries.

---

## Post-Terminal Audits

| Probe | Time UTC | Convex CPU | PG CPU | loadavg | waits/locks/DFR/BIO | WAL |
|---|---|---|---|---|---|---|
| T+~2 | `~19:22Z` | `0.13%` | `0.03%` | `0.15 / 0.35 / 0.33` | `0` | `63 / 1008 MB` |
| T+~6 | `~19:26Z` | `0.08%` | `0.02%` | `0.13 / 0.26 / 0.29` | `0` | `63 / 1008 MB` (unchanged) |

All clean. WAL stable across both probes.

---

## Re-Halt Rules (6 canon) — All GREEN

All 6 canon re-halt rules verified GREEN. Rule 1 (duration ceiling) scaled to `>2,400,000 ms` for 24-series. Wave 4 evidence per category:

| Canon rule | Wave 4 evidence |
|---|---|
| Duration | `2,172,368 ms` — well below `2,400,000 ms` ceiling, headroom `227,632 ms` |
| PG waits | `0` waiting locks / DFR / BIO / BufferPin across mid-wave T+~17 + post-terminal T+~2 + T+~6 |
| Loadavg settle | `0.15 / 0.35 / 0.33` (T+~2) → `0.13 / 0.26 / 0.29` (T+~6); both well within settle bounds |
| Env restore | `env=0` verified post-terminal (manual restore — see Tooling Issue) |
| Memory / headroom | WAL stable `63 / 1008 MB` across both audits, no growth; host headroom unchanged |
| Discipline | `cleanupRunState` clean — target row terminal `completed/isActive=false`, no orphan/active rows, no pollution from other run |

---

## Aborted Attempt (One-Liner, Not Separate Ledger Entry)

> First attempt aborted at `2026-05-11T~18:23Z`: trigger `fetch failed` (TypeError: fetch failed), no cleanupRunState row created, env restored `1→0` immediately, verified `0`, ledger unchanged.
> Connectivity recovered before retry: local `/version ×3` and server-side `/version ×3` returned `unknown` (reachable), Convex admin reads worked. Interpreted as transient local CLI/WS/connectivity issue; no backend-fault evidence observed.
> Retry triggered successfully at `18:43:59.989Z`.

Aborted attempt does **not** count in ledger (no row created, no rows deleted). The maxRuns=24 series remains 4/4 strict clean.

---

## Tooling Issue (Operational SPOF)

**Watcher** detected terminal normally — no issue.

**Restorer** observed terminal row and printed it to console, but **did not fire `env=0` restoration**. Cause: shell exit-code capture from command substitution behaved differently than expected (root cause requires deeper analysis as part of fix design).

**Operator action:** manually restored env `1→0` immediately upon seeing terminal output, verified `0`, cleared remaining polling loops.

**Why this is SPOF, not cosmetic:**
Without operator attention at terminal moment, env would have remained `1`. The organic `cleanup-old-realtime-metrics` cron (profile `batchSize=500, maxRuns=5`) would then have fired on its schedule, mixing attribution with the manual canary profile. Detection would still be possible via cleanupRunState rows, but it would corrupt the 24-series dataset and require manual reconstruction.

This is the first observed failure of the restorer in the 24-series. The pattern was previously documented as "atomically worked" (waves 1, 2, 3 of 24-series). This invalidates the assumption that the current bound-restorer shell pattern is reliable enough for unattended use — hardening required before continued use.

---

## Wave 5 Prerequisite (HARD GATE)

> **Wave 5 BLOCKED until restorer tooling fix shipped and verified.**

Not "nice to have", not "next iteration" — formal pre-condition. Not downgrade-able without explicit operator decision.

**Fix options (composable):**

1. **Minimum:** Explicit parsed-fields comparison, no `$?` from command substitution.
   Replace any `if [ $? -eq 0 ]` patterns with explicit `if [ "$state" = "completed" ]` style checks reading the field directly.

2. **Alternative:** Simpler foreground restorer with explicit terminal-state branch — replaces existing implementation rather than patching.

3. **Defence-in-depth (recommended):** Heartbeat — every `~30s` log `"restorer alive, last_observed_state=X"`. Gives a visible pulse so operators can detect a silent restorer.

4. **Failsafe (recommended), with guarded conditions:**

   ```
   At expectedDuration + buffer (e.g. +10min):

   case A: target runId state == "completed" OR "failed"
     → safe to force env=0 (terminal observed, no risk of killing live wave)
     → log "failsafe: terminal observed, env force-zeroed"

   case B: target runId state == "active" OR unknown after N read attempts
     → DO NOT force env=0 (wave may legitimately overrun prediction)
     → halt automation, alert operator: "wave overran predicted duration, manual review"
     → env stays as-is until operator decision

   env force-zero only under explicit guarded condition (case A).
   ```

   Failsafe must read state first; never auto-zero on timeout alone.

**Minimum required:** (1). **Recommended deployment:** (1) + (3) + (4).

Verification before wave 5:
- Tooling fix code reviewed
- Dry-run / unit-test against simulated terminal row + simulated active row
- At least one production-equivalent rehearsal (e.g. against a no-op trigger or test cleanupRunState row)

---

## Series Status

**24-series ledger:**

| Metric | Value |
|---|---|
| Strict clean | `4 / 4` |
| Yellow | `0` |
| Red | `0` |
| Cumulative rows deleted | `96,000` |
| Cumulative floor advance from anchor | `+35m 05.8s` |
| ToD coverage | 3 buckets (early-morning ×2, daytime ×1, evening ×1) |
| Observed duration band | `2,172,368 – 2,240,974 ms` (spread `3.16%`) |

**Per memory canon: 4/4 clean does NOT auto-authorize anything.** Tier 1 maxRuns=16 required 10/10 strict clean to become Tier 2 review-eligible (and that did not auto-authorize Tier 2 either). Same principle applies here.

---

## NOT Authorized (Frozen)

These remain frozen until separate explicit operator decision, regardless of 24-series progression:

- `restMs < 90000`
- `batchSize > 1000`
- `timeBudgetMs` changes
- `maxRuns > 24`
- Tier 2 / automation
- Parallel waves
- "Series by inertia" (i.e. skipping explicit `go` on each wave)

---

## Recommended Next

1. **Restorer tooling fix** — design + implementation + verification (mandatory before wave 5).
2. **Wave 5 ToD selection** — operator decides:
   - Another **early-morning** sample → confirm slow cluster
   - Another **evening or daytime** sample → confirm fast cluster
   - Either path strengthens the ToD hypothesis dataset toward `n=6` with ≥2 per bucket.
3. **Window:** apply standard runway and no-go window rules; no time pressure.

---

## Repo / Memory

- Closure committed via clean isolated worktree from canon `3276831` (wave 3 closure parent). Main WT untouched; push from non-dirty WT only.
- Conversation-level MEMORY.md pointer added separately (local-only — MEMORY.md is not tracked in repo).
- Commit/push step is doc-only; no additional runtime/env/SQL/cleanup actions during documentation closure.
