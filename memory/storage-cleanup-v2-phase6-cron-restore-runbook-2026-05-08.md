# Storage Cleanup V2 - Phase 6 Cron Restore Runbook - 2026-05-08

Status: draft runbook for restoring the `cleanup-old-realtime-metrics` cron after clean manual V2 cleanup. Doc-only; not executed. Written against doc trail through the Phase 5 `maxRuns=5` controlled closure and Phase 1 code commit `2410f14`.

## Scope

This runbook covers the future code/deploy/observation path to restore organic cron-driven cleanup for `metricsRealtime`.

It does NOT cover:
- Phase 4 canary execution.
- Phase 5 controlled manual runs.
- `metricsDaily` or `vkApiLimits` cleanup.
- PostgreSQL `VACUUM`, `VACUUM FULL`, `pg_repack`, or SQL deletes.
- Enabling hourly cadence.
- Leaving cleanup active indefinitely without an explicit post-tick decision.

This document is not permission to run production actions. Each deploy/env/cron action below needs explicit operator go at execution time.

## Hard Gate: Phase 5 Closed Clean; Phase 6 Still Needs Separate Go

As of `2026-05-08`, two Phase 5 controlled runs have closed clean. The latest clean profile is:

```text
closure_file:         memory/storage-cleanup-v2-controlled-closure-2026-05-08-maxRuns5.md
runId:                1778232969547-20283bb90f21
batchSize:            500
timeBudgetMs:         10000
restMs:               90000
maxRuns:              5
batchesRun:           5
deletedCount:         2500
durationMs:           377196
pg_wal_delta_bytes:   -352321536
oldestRemainingTimestamp: 1777733713861 (2026-05-02T14:55:13.861Z)
```

Therefore the Phase 5 prerequisite is satisfied, but this Phase 6 runbook is still **not executable** until ALL of the following hold:

- At least one Phase 5 controlled-run closure exists with `Status: clean`.
- That closure provides actual values for `batchSize`, `timeBudgetMs`, `restMs`, `maxRuns`, `pg_wal_delta`, `durationMs`, `deletedCount`, `oldestRemainingTimestamp`.
- The values are carried into Phase 6's first cron parameters via `First Cron Params Derivation` below — never invented, never copied from this doc as defaults.
- User gives a separate explicit go for Phase 6 code changes, deploy, and first organic cron observation.

Until that separate Phase 6 go exists, do NOT:

- enable `METRICS_REALTIME_CLEANUP_V2_ENABLED` for cron testing;
- uncomment or rewrite the `cleanup-old-realtime-metrics` cron registration in `convex/crons.ts`;
- pre-deploy any V2 cron entrypoint code (`cleanupOldRealtimeMetricsV2` or rewritten body);
- treat any value below as "pre-approved" for production action.

The runbook itself may still be reviewed, edited, and committed as documentation while production actions remain gated.

## References

- Plan: `docs/superpowers/plans/2026-05-07-storage-cleanup-v2.md` (Phase 6)
- Phase 1 design: `memory/storage-cleanup-v2-phase1-design-2026-05-07.md`
- Phase 2 verification cheat sheet: `memory/storage-cleanup-v2-phase2-verification-cheatsheet-2026-05-07.md`
- Phase 3 deploy closure: `memory/storage-cleanup-v2-phase3-deploy-closure-2026-05-07.md`
- Phase 4 canary runbook: `memory/storage-cleanup-v2-phase4-canary-runbook-2026-05-07.md`
- Phase 4 closure template: `memory/storage-cleanup-v2-canary-closure-template-2026-05-07.md`
- Phase 5 controlled-runs runbook: `memory/storage-cleanup-v2-phase5-controlled-runs-runbook-2026-05-08.md`
- Phase 5 controlled-run closure #1: `memory/storage-cleanup-v2-controlled-closure-2026-05-08.md` (commit `bbac12e`, `maxRuns=3`)
- Phase 5 controlled-run closure #2: `memory/storage-cleanup-v2-controlled-closure-2026-05-08-maxRuns5.md` (`maxRuns=5`, latest clean profile for Phase 6 derivation)
- Code source of truth before Phase 6 implementation: `convex/metrics.ts`, `convex/crons.ts`, `convex/schema.ts`

## Critical Current-State Warning

At commit `2410f14`, the cron path is still V1/dead-path:

```text
cleanup-old-realtime-metrics cron (commented)
  -> internal.metrics.cleanupOldRealtimeMetrics
  -> internal.metrics.scheduleMassCleanup
  -> internal.metrics.manualMassCleanup
  -> no-op return
```

Therefore Phase 6 is NOT "uncomment the cron". Simply uncommenting `convex/crons.ts` would schedule a V1 no-op path and would not delete `metricsRealtime`.

Phase 6 must first switch the cron entrypoint to V2-only scheduling, then enable the cron with conservative args.

## Required Inputs From Earlier Phases

Before Phase 6 implementation starts, collect:

```text
phase4_canary_closure_file:        memory/storage-cleanup-v2-canary-closure-2026-05-08.md
phase4_status:                     clean
phase5_controlled_closure_file:    memory/storage-cleanup-v2-controlled-closure-2026-05-08-maxRuns5.md
phase5_status:                     clean
phase5_runId:                      1778232969547-20283bb90f21
phase5_last_params:                batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=5
phase5_batchesRun:                 5
phase5_deletedCount:               2500
phase5_durationMs:                 377196
phase5_pg_wal_delta_bytes:         -352321536
phase5_oldestRemainingTimestamp:   1777733713861 (2026-05-02T14:55:13.861Z)
phase5_recommended_manual_next:    optional maxRuns=8 controlled run, separate go
phase5_recommended_cron_params:    batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=5, cadence="0 */6 * * *"
phase5_open_blockers:              none
```

If Phase 4 or Phase 5 did not close clean, STOP. Do not restore cron.

Operator choice before Phase 6:

- Conservative manual path: run one more Phase 5 controlled profile (`maxRuns=8`) and close it clean before Phase 6.
- Cron-restore path: proceed to Phase 6 using the clean `maxRuns=5` profile above.

Both paths require a separate explicit go. This document does not choose between them by itself.

## Phase 6 Preconditions

- [ ] `HEAD` and `origin/emergency/drain-scheduled-jobs` reviewed; no unexpected drift.
- [ ] `git status --short memory/storage-cleanup-v2-* convex/` clean before edits.
- [ ] Phase 4 closure exists and is clean.
- [ ] At least one Phase 5 controlled closure exists and is clean.
- [ ] Preferably several Phase 5 controlled closures are clean if storage pressure allows waiting.
- [ ] `cleanupRunState` has no active row for `cleanupName = "metrics-realtime-v2"`.
- [ ] `_scheduled_functions` has no in-flight `metrics.js:manualMassCleanupV2` rows.
- [ ] `_scheduled_functions` has no in-flight `metrics.js:cleanupOldRealtimeMetricsV2` wrapper rows.
- [ ] Core heartbeats (`syncDispatch`, `uzBudgetDispatch`, `tokenRefreshDispatch`) are clean.
- [ ] `METRICS_REALTIME_CLEANUP_V2_ENABLED` is currently `0` or absent.
- [ ] User gave explicit go for a code change in `convex/`.

## Implementation Contract

The Phase 6 code change must satisfy all of these:

- V1 `manualMassCleanup` remains no-op. Verify by grep after the Phase 6 patch; line numbers from pre-Phase-6 code are intentionally not authoritative.
- V1 `triggerMassCleanup` remains out of operational use.
- V1 `manualMassCleanup` body is permanently abandoned at Phase 6. The pre-Phase-6 comment `Restore body after pending queue drains` is superseded; the Phase 6 code patch should replace that stale comment with a permanent-abandoned/no-op note so no future task "restores" V1 by mistake. Any future V1 entry-point removal is a separate cleanup phase, not part of Phase 6.
- New cron work MUST NOT call `internal.metrics.manualMassCleanup`.
- New cron work MUST NOT call `scheduleMassCleanup`.
- Cron entrypoint MUST schedule via `triggerMassCleanupV2` (preferred shape) and MUST NOT call `manualMassCleanupV2` directly. Direct call bypasses `cleanupRunState` insert and the active-row guard.
- Cron-triggered call to `triggerMassCleanupV2` must pass explicit bounded params: `batchSize`, `timeBudgetMs`, `restMs`, `maxRuns`. No defaults; values come from `First Cron Params Derivation` below.
- Organic cron firing proof MUST be based on `_scheduled_functions`, not docker stdout. The first proof layer is a row for `metrics.js:cleanupOldRealtimeMetricsV2` at the expected cron boundary; the second layer is its success/failure state.
- The expected proof chain is: organic cron row for `metrics.js:cleanupOldRealtimeMetricsV2` -> wrapper success -> `cleanupRunState` insert by `triggerMassCleanupV2` -> `metrics.js:manualMassCleanupV2` chain success -> terminal `cleanupRunState` row.
- Default behavior must remain fail-closed when `METRICS_REALTIME_CLEANUP_V2_ENABLED` is not `1`. The env-disabled return path inside `triggerMassCleanupV2` may log `[cleanup-v2] skip reason=disabled`, but that is not cron-context proof and may not route to docker stdout in this self-hosted runtime. The cron wrapper should still emit best-effort observability lines before/after delegation, but `_scheduled_functions` is authoritative.
- The active-row early return in `triggerMassCleanupV2` returns `{ status: "already-running", runId: <existing> }` without inserting a new run. The cron wrapper should log this case best-effort, e.g. `[cleanup-v2] cron tick at <iso>; skipped, run <runId> still active`. A cron tick during an active chain is expected behavior, not a failure.
- If a cron heartbeat is added, it must use V2-specific name `cleanup-realtime-metrics-v2`, never stale V1 name `cleanup-realtime-metrics`. Note: in V2 the active-row check on `cleanupRunState` supersedes the V1 heartbeat-based stuck-run guard. A heartbeat in V2 is optional, used only for observability, never as a guard.
- `cleanup-old-realtime-metrics` cadence starts conservative: every 6 hours. Cadence tightening (1 h or shorter) is a separate gated decision after several clean cron ticks at the 6 h profile.

Acceptable implementation shapes:

```text
Preferred:
  add cleanupOldRealtimeMetricsV2 internalAction
  -> runMutation(internal.metrics.triggerMassCleanupV2, explicit params)
  -> crons.cron("cleanup-old-realtime-metrics", "0 */6 * * *", internal.metrics.cleanupOldRealtimeMetricsV2, explicit params)

Acceptable with stronger review:
  rewrite cleanupOldRealtimeMetrics body to call V2 only
  -> keep cron name
  -> update tests/grep guards to prove no V1 scheduling path remains
```

Do not introduce a drop-in `scheduleMassCleanupV2` unless the implementation deliberately updates the design and grep guards. Current Phase 1 V2 chain helper is `scheduleNextChunkV2`.

## First Cron Params Derivation

All numeric params for the first Phase 6 cron tick are **derived** from the last clean Phase 5 closure. None are pre-specified in this runbook; the placeholders are filled at Phase 6 prep time.

```text
phase5_last_clean_closure_file:    memory/storage-cleanup-v2-controlled-closure-2026-05-08-maxRuns5.md
phase5_batchSize:                  500
phase5_timeBudgetMs:               10000
phase5_restMs:                     90000
phase5_maxRuns:                    5
phase5_batchesRun:                 5
phase5_pg_wal_delta_bytes:         -352321536
phase5_deletedCount:               2500
phase5_durationMs:                 377196
phase5_oldestRemainingTimestamp:   1777733713861 (2026-05-02T14:55:13.861Z)
```

Derivation rules (apply only with values from a clean Phase 5 closure):

```text
first_cron_batchSize     = phase5_batchSize                # do not increase
first_cron_timeBudgetMs  = phase5_timeBudgetMs             # do not increase
first_cron_restMs        = max(phase5_restMs, 60_000)      # do not decrease, floor 60_000 ms
first_cron_maxRuns       = min(phase5_maxRuns, 5)          # cap at 5; never 10 on first cron
first_cron_cadence       = "0 */6 * * *"                   # every 6h, do not tighten
```

Concrete first-cron profile from Phase 5 `maxRuns=5` closure:

```text
first_cron_batchSize     = 500
first_cron_timeBudgetMs  = 10000
first_cron_restMs        = 90000
first_cron_maxRuns       = 5
first_cron_cadence       = "0 */6 * * *"
```

Hard rules:

- `first_cron_maxRuns >= 10` is forbidden. The first cron tick is a small multiplier over Phase 5 manual proof, not a jump to higher throughput.
- If Phase 5 used `maxRuns >= 10` (it should not have, per Phase 5 runbook), cap Phase 6 first cron at `5` and document the cap in the closure.
- If `phase5_pg_wal_delta_bytes` was non-trivial (`phase5_pg_wal_delta_bytes > expected_wal` after baseline-noise adjustment), lower `first_cron_maxRuns` further per the WAL derivation below.
- Cadence stays every 6 hours for the first cron tick. Do NOT tighten cadence (e.g., 1h, 15min) in the same go that enables the cron.
- Hourly or shorter cadence is a separate, post-Phase-6 decision after several clean cron ticks.

### WAL Threshold Derivation

Use the Phase 5 formula. Do not invent thresholds. Do not leave placeholders.

```text
per_chunk_wal = max(phase5_pg_wal_delta_bytes / max(phase5_batchesRun, 1), 1 MB floor)
expected_wal  = per_chunk_wal * first_cron_maxRuns
warn          = max(25 MB, 3 * expected_wal)
hard_stop     = max(150 MB, 10 * expected_wal)
```

If observed pre-tick baseline WAL noise from sync/UZ/token work is larger than `expected_wal`, derive `warn` and `hard_stop` from the measured baseline rate and document the override in the closure memo. Hard-stop is a stop condition, not a target.

Concrete first-cron WAL thresholds from Phase 5 `maxRuns=5` closure:

```text
phase5_pg_wal_delta_bytes = -352321536
phase5_batchesRun         = 5
per_chunk_wal             = max(-352321536 / 5, 1 MB floor) = 1 MB
expected_wal              = 1 MB * 5 = 5 MB
warn                      = max(25 MB, 15 MB) = 25 MB
hard_stop                 = max(150 MB, 50 MB) = 150 MB
```

### Drain-Rate Sizing

```text
deletes_per_tick = first_cron_batchSize * first_cron_maxRuns
ticks_per_day    = 24 / 6 = 4
daily_drain_rows = deletes_per_tick * ticks_per_day
```

This number tells you whether the conservative first-cron profile actually drains backlog or merely proves stability.

Phase 6 first cron is NOT for backlog drainage; it is for proving stable cron-driven cleanup. If `daily_drain_rows` is materially below the current `metricsRealtime` backlog (fresh Phase 5 preflight context: 9,089,514 eligible rows at cutoff `2026-05-06T06:00:09Z`), the operator MUST accept that drainage requires a separate post-Phase-6 escalation pass. Each escalation step (cadence tightening, `batchSize` increase, or `maxRuns` increase) is its own gated decision with its own clean closure.

Record `daily_drain_rows` and the projected days-to-clear in the Phase 6 closure as informational sizing for the next decision.

Concrete first-cron drain sizing from Phase 5 `maxRuns=5` closure:

```text
deletes_per_tick = 500 * 5 = 2,500 rows
ticks_per_day    = 4
daily_drain_rows = 10,000 rows/day
fresh eligible context from Phase 5 preflight = 9,089,514 rows
projected_days_to_clear_at_this_profile ~= 909 days
```

This profile is intentionally a cron-path proof, not a practical backlog-drain profile.

### Post-Phase-6 Ramp Semantics

The first organic cron profile (`batchSize=500`, `maxRuns=5`, every 6 hours) is a
**Gate B proof baseline**, not the long-term production drainage profile. At 2,500
deletes/tick and 10,000 deletes/day, it is expected to be tiny relative to the
~9M eligible backlog and may be below ongoing `metricsRealtime` ingest. That is
acceptable for the first organic tick because the goal is proving the real cron
registration, wrapper UDF, env gate, explicit args, `cleanupRunState`, and V2 chain
under organic scheduling.

Ramp decisions require at least two consecutive clean organic ticks at the current
6-hour cadence (>=12 hours of continuous clean operation) before changing throughput.
The next throughput decisions are separate gated ramps, never bundled with the initial
cron restore:

```text
baseline: maxRuns=5, batchSize=500, cadence=6h
ramp 1:   maxRuns=8, batchSize=500, cadence=6h   # after >=2 consecutive clean baseline ticks
ramp 2:   maxRuns=10, batchSize=500, cadence=6h  # after >=2 consecutive clean maxRuns=8 ticks
ramp 3+:  cadence or batchSize changes           # later, separate decision only
```

Each ramp needs fresh anchors, one changed load dimension at a time, and a closure
memo. Do not let `maxRuns=5` be interpreted as the final storage-drain profile; it is
only the first organic proof profile.

## Required Tests And Source Checks

Run before commit/deploy of Phase 6 code:

```bash
npx tsc --noEmit -p convex/tsconfig.json
npm run test:unit -- convex/metrics.test.ts
```

Add or update focused tests proving:
- Cron entrypoint/wrapper calls `triggerMassCleanupV2`, not `manualMassCleanupV2` or V1.
- Cron params include explicit `batchSize`, `timeBudgetMs`, `restMs`, and `maxRuns`.
- Explicit cron args are passed unchanged from `crons.ts` to the wrapper and from the wrapper to `triggerMassCleanupV2`.
- Env gate off returns disabled/no-op and does not schedule `manualMassCleanupV2`.
- Active `cleanupRunState` row causes an already-running/no-op path, not concurrent cleanup.
- Already-running wrapper behavior does not create a second `cleanupRunState` row and does not schedule another `manualMassCleanupV2` chain.
- V1 `manualMassCleanup` remains no-op.

Grep guards:

```bash
rg "cleanupOldRealtimeMetrics|cleanupOldRealtimeMetricsV2|manualMassCleanup|manualMassCleanupV2|scheduleMassCleanup|scheduleNextChunkV2" convex/metrics.ts convex/crons.ts
```

This first grep is a broad discovery grep. Because `manualMassCleanup` is a substring of `manualMassCleanupV2`, do not use the broad grep alone as a pass/fail V1 guard. Use the targeted `\b` guard below for forbidden V1 references.

Expected after Phase 6 implementation:
- active cron registration points to the V2 cron entrypoint or rewritten V2-only entrypoint;
- cron args contain explicit bounded params including `maxRuns`;
- V2 cron wrapper path references `triggerMassCleanupV2`;
- `manualMassCleanupV2` appears only as the self-scheduled chain worker after `triggerMassCleanupV2` has inserted `cleanupRunState`; it is not called directly by the cron wrapper or cron registration;
- V2 cron path does not reference `scheduleMassCleanup`;
- V2 cron path does not reference `internal.metrics.manualMassCleanup`.

Targeted V1 scheduling guard:

```bash
rg -n "internal\.metrics\.manualMassCleanup\b|internal\.metrics\.scheduleMassCleanup\b" convex/metrics.ts convex/crons.ts
```

Expected:
- legacy V1 functions may still contain their own no-op scheduling references if deliberately left in place;
- active cron code and any V2-named code must have zero hits;
- any hit inside `cleanupOldRealtimeMetricsV2`, active cron registration, or a rewritten active `cleanupOldRealtimeMetrics` body is fail-the-build.

## Deploy Strategy

Use two gates.

### Gate A - Deploy Cron Code Fail-Closed

Deploy Phase 6 code with `METRICS_REALTIME_CLEANUP_V2_ENABLED=0` or absent.

Expected:
- `/version` HTTP 200.
- No immediate cleanup unless cron tick occurs and env is enabled.
- If an organic cron tick occurs while env is 0, it must return disabled/no-op and must not schedule `manualMassCleanupV2`.
- No V1 `manualMassCleanup` growth.
- No schema deletion warning.

Gate A proves the code can deploy without opening cleanup.

### Gate B - First Active Organic Cron Tick

After Gate A is clean and user gives explicit go:

1. Set `METRICS_REALTIME_CLEANUP_V2_ENABLED=1`.
2. Wait for the next organic `cleanup-old-realtime-metrics` cron tick.
3. Do NOT manually call `triggerMassCleanupV2`.
4. Observe one full cron cleanup chain to terminal state.

The first active tick must be organic to prove the real cron registration, args, and V2 path.

Gate B trigger-window discipline:

- Enable env for Gate B only when `/version` latency is stable and core heartbeats are clean.
- Enable `METRICS_REALTIME_CLEANUP_V2_ENABLED=1` close to the expected cron boundary: target 5-10 minutes before the boundary, after fresh pre-tick anchors are captured. Do not enable it hours early while waiting for `0 */6 * * *`.
- Prefer a quiet window after a recent organic `syncBatchWorkerV2` success and before the next expected sync fan-out.
- Avoid known token-refresh fan-out windows. If the next cleanup cron boundary overlaps token refresh or an active UZ/sync fan-out, skip that cron boundary and wait for the next clean one.
- If a pre-tick check shows `/version` repeatedly above the recent baseline (for example, multiple samples >2s when normal samples are ~1.2-1.5s), do not open Gate B for that boundary.
- Do not keep env enabled across multiple cron boundaries unless the user explicitly approves continued cron operation after a clean first tick.

## Pre-Tick Anchors

Capture immediately before enabling env for Gate B:

| Anchor | Value | Threshold | Source |
|---|---|---|---|
| `/version` HTTP and time | 200, latency stable | latency drift not material vs Phase 5 closure | curl |
| disk used | <pct> | absolute free >= 5%, no unexplained drop > 1pp vs Phase 5 closure | `df -h /` |
| disk free | <bytes/GiB> | informational sizing, must accommodate WAL hard_stop ceiling | `df -h /` |
| `pg_wal` | <bytes> | warn / hard_stop per WAL Threshold Derivation above (no placeholders) | `ssh + docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal` |
| `metricsRealtime` total | <n> | informational | read-only query |
| `metricsRealtime` eligible | <n> with explicit cutoff used | exact preferred; structural proof acceptable only if Phase 5 closure used and validated structural proof | read-only query |
| `oldestRemainingTimestamp` | <n> (<ISO>) | `min(timestamp)` across all rows | read-only query on `metricsRealtime` |
| `cleanupRunState` active row | none for `cleanupName="metrics-realtime-v2"` | absolute zero | `by_cleanupName_isActive` |
| wrapper scheduled entries (in-flight) | none for `metrics.js:cleanupOldRealtimeMetricsV2` | absolute zero | `_scheduled_functions` |
| wrapper scheduled entries (last boundary) | <count/state> | informational baseline before Gate B; post-tick proof is authoritative | `_scheduled_functions` |
| V2 scheduled entries (in-flight) | none for `metrics.js:manualMassCleanupV2` | absolute zero | `_scheduled_functions` |
| V1 `manualMassCleanup` failed counter | <n> | baseline; delta during tick must be 0 | `_scheduled_functions` |
| V2 `manualMassCleanupV2` failed counter | 0 | absolute 0 pre and post | `_scheduled_functions` |
| V8 in-flight slots used | <n> / `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` | informational headroom; flag if pre-tick utilisation already > 75% | `_scheduled_functions` in-flight rows |
| core heartbeats | `syncDispatch`, `uzBudgetDispatch`, `tokenRefreshDispatch` | last status `completed`, no error | `cronHeartbeats` |
| backend stdout rollback patterns | 0 | absolute 0 since last closure | `docker logs adpilot-convex-backend` grep |
| wrapper observability (docker stdout, if routed) | <count> tick lines observed | informational only; `_scheduled_functions` wrapper row is authoritative | `docker logs` grep `[cleanup-v2] cron tick` |

## Gate B Observation

Observation window math:

```text
chunkActionMs_estimate = phase5_durationMs / max(phase5_batchesRun, 1)
window_ms              = first_cron_maxRuns * (first_cron_restMs + chunkActionMs_estimate) + 10 * 60_000
```

Hard rule: `window_ms` MUST be smaller than the cron period. For cadence `"0 */6 * * *"` that means `window_ms < 21_600_000` (6 h). If math projects beyond cron period, lower `first_cron_maxRuns` until it fits, then re-derive WAL thresholds and drain rate.

This formula intentionally overestimates the window because `phase5_durationMs / batchesRun`
already includes rest time between chunks and then `first_cron_restMs` is added again.
Keep it as an upper-bound safety calculation for first organic cron proof; do not use it
as precise per-chunk runtime telemetry.

Worked example using Phase 5 `maxRuns=5` closure:

```text
phase5_durationMs = 377196
phase5_batchesRun = 5
chunkActionMs_estimate ~= 75439 ms
first_cron_maxRuns = min(5, 5) = 5
first_cron_restMs = max(90000, 60000) = 90000
window_ms ~= 5 * (90000 + 75439) + 600000 ~= 1,427,195 ms ~= 23.8 min
```

This window is comfortably below the 6 h cron period.

Expected:
- Exactly one organic cron tick starts the V2 cleanup path in the window.
- `_scheduled_functions` contains the organic wrapper row for `metrics.js:cleanupOldRealtimeMetricsV2` at the expected cron boundary, with success unless the wrapper itself failed. This row is the authoritative proof that cron fired the V2 wrapper.
- The wrapper delegates to `triggerMassCleanupV2`, which inserts the `cleanupRunState` row and schedules the `manualMassCleanupV2` chain.
- Best-effort wrapper stdout lines (`[cleanup-v2] cron tick at <iso>; env=1`) may be present, but their absence is not dirty if the wrapper scheduled-function row and downstream state proof are clean.
- `cleanupRunState` row is inserted with expected params.
- `manualMassCleanupV2` entries are scheduled by the chain, not V1.
- `metrics.js:manualMassCleanupV2` chain entries == `cleanupRunState.batchesRun`.
- V2 failed absolute == 0.
- V1 `manualMassCleanup` failed delta == 0.
- `cleanupRunState.state == "completed"`, `isActive == false`, `error == undefined`.
- `batchesRun <= first_cron_maxRuns`.
- `deletedCount > 0` unless no eligible rows remain.
- Eligible count delta matches `deletedCount` after cutoff alignment / boundary adjustment.
- `oldestRemainingTimestamp` does not regress.
- `pg_wal` stays below `warn`; any breach above `hard_stop` triggers Hard Stops.
- No `Too many concurrent`, recurring `Transient error`, `TOKEN_EXPIRED`, or sync account failure pattern.
- sync / UZ / token heartbeats remain clean.

Stdout caveat (carried from Phase 4 closure `8b96807` and Phase 5 runbook):

- If `[cleanup-v2]` wrapper / start / end schedule / end complete markers are absent in `docker logs adpilot-convex-backend` but the wrapper `_scheduled_functions` row, `cleanupRunState`, manual chain rows, env, WAL, and core counters are clean, treat marker absence as the known log-routing caveat, not a dirty signal.
- Authoritative execution proof is `_scheduled_functions` (`metrics.js:cleanupOldRealtimeMetricsV2` plus `metrics.js:manualMassCleanupV2`) and `cleanupRunState`, not docker stdout.

Active-row and env-disabled organic ticks:

- If a cron tick fires while a previous V2 chain is still active, `triggerMassCleanupV2` returns `{ status: "already-running", runId: <existing> }` without inserting a second run. The wrapper scheduled-function row should be success, no new manual chain should be scheduled, and this is expected behavior, not a failure.
- If a cron tick fires while env is set to `0`, `triggerMassCleanupV2` returns `{ status: "disabled" }` and may log `[cleanup-v2] skip reason=disabled`. During Gate B, env should be `1`; a wrapper row with no `cleanupRunState` insert in Gate B indicates env drift or propagation failure and is dirty.

Note: App-level V2 failure is authoritative in `cleanupRunState.state == "failed"` / `error`, even when `_scheduled_functions.kind` is `"success"` because the action catches errors and returns normally.

## Env Final State Decision

After first active cron tick:

```text
default: set METRICS_REALTIME_CLEANUP_V2_ENABLED=0 after closure unless user explicitly approves leaving cron active
```

If user explicitly approves continued cron operation:
- leave env at `1`;
- keep cadence at every 6 hours;
- watch at least the next organic tick summary;
- do not change batch size, maxRuns, or cadence in the same decision.
- record explicitly that continued operation remains on the baseline `maxRuns=5`
  proof profile, not a steady-state backlog-drain profile.

A clean Phase 6 closure does NOT grant any of the following changes — each is a separate, gated decision after observing at least two consecutive clean cron ticks at the current 6-hour profile:

- cadence tightening (e.g., 6h → 1h, 1h → 15min);
- `first_cron_batchSize` increase;
- `first_cron_maxRuns` increase;
- `first_cron_timeBudgetMs` change;
- moving cleanup to V1 path or any other entrypoint variant;
- combining two of the above changes into a single go.

If any dirty signal appears:
- set `METRICS_REALTIME_CLEANUP_V2_ENABLED=0` immediately;
- if a chain is active, wait up to `restMs + 30s` for `disabled_mid_chain`;
- if code path is wrong, revert cron-enable commit and deploy after explicit go.

## Hard Stops

- Active cron path schedules V1 `manualMassCleanup`.
- V2 entries exceed `maxRuns` for the tick.
- `cleanupRunState` stuck in `claimed` or `running`.
- `cleanupRunState.state == "failed"` with non-env-toggle error.
- `pg_wal` exceeds hard threshold.
- V8 concurrency errors.
- sync/UZ/token regression.
- Env cannot be returned to 0 when required.
- Cron fires more frequently than configured.

## Rollback

Runtime rollback:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0
```

Code rollback if cron registration or V2 path is wrong:

```text
git revert <phase6-cron-enable-commit>
git push origin emergency/drain-scheduled-jobs
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex deploy --yes
```

Rollback deploy requires explicit operator go. Do not rewrite git history.

## Closure Memo

Write `memory/storage-cleanup-v2-cron-closure-<actual-date>.md`.

Required structure:

```text
# Storage Cleanup V2 - Cron Restore Closure - <date>

Status: <clean | dirty>
Deploy commit: <sha>
Gate A deploy time: <ISO>
Gate B active tick window: <ISO> -> <ISO>
Cron registration: cleanup-old-realtime-metrics, cadence every 6 hours
Cron entrypoint: <cleanupOldRealtimeMetricsV2 or rewritten cleanupOldRealtimeMetrics>
Cron params: batchSize=<n>, timeBudgetMs=<n>, restMs=<n>, maxRuns=<n>

## Preconditions
- Phase 4 closure clean: <file>
- Phase 5 closure clean: <file>
- Env pre: <0/absent>
- Cron path source check: <summary>

## Gate A - Fail-Closed Deploy
| Check | Result | Source | Verdict |
|---|---|---|---|
| /version | <n> | curl | <PASS/FAIL> |
| env flag | 0/absent | env list | <PASS/FAIL> |
| V1 growth | delta 0 | _scheduled_functions | <PASS/FAIL> |
| manual cleanup chain while env off | 0 `metrics.js:manualMassCleanupV2` rows | _scheduled_functions | <PASS/FAIL> |

## Gate B - First Active Organic Tick
| Anchor | Pre | Post | Delta | Threshold | Verdict | Source |
|---|---|---|---|---|---|---|
| pg_wal | <bytes> | <bytes> | <bytes> | warn=<bytes>, hard=<bytes> | <PASS/WARN/FAIL> | <source> |
| metricsRealtime total | <n> | <n> | <n> | informational | <PASS/WARN> | <source> |
| metricsRealtime eligible | <n> | <n> | <n> | matches deletedCount with cutoff alignment | <PASS/FAIL> | <source> |
| oldestRemainingTimestamp | <n> (<ISO>) | <n> (<ISO>) | <delta> | post >= pre | <PASS/FAIL> | <source> |

## Scheduled Functions
| UDF | Pre failed | Post failed | Delta failed | Total entries | Success | Failed | Verdict |
|---|---|---|---|---|---|---|---|
| metrics.js:cleanupOldRealtimeMetricsV2 | <n> | <n> | 0 | <n> | <n> | 0 | <PASS/FAIL> |
| metrics.js:manualMassCleanupV2 | 0 | 0 | 0 | <n> | <n> | 0 | <PASS/FAIL> |
| metrics.js:manualMassCleanup (V1) | <n> | <n> | 0 | <n/a> | <n/a> | <n/a> | <PASS/FAIL> |

## cleanupRunState Final Row
<paste row fields>

## Backend Stdout
- wrapper tick lines: <n> (`[cleanup-v2] cron tick at <iso>; env=<0|1>` or `skipped, run <runId> still active`) — informational only; `_scheduled_functions` wrapper row is authoritative
- cleanup-v2 start lines: <n> — informational only
- cleanup-v2 end schedule lines: <n> — informational only
- cleanup-v2 end complete lines: <n> — informational only
- cleanup-v2 disabled_mid_chain lines: <n> — informational only; authoritative failure source is `cleanupRunState.error`
- rollback patterns: <n>

If `[cleanup-v2]` wrapper / start / end / schedule / complete markers are absent, cite Phase 4 closure `8b96807` (and any Phase 5 closure precedent) for the known log-routing gap and rely on `_scheduled_functions` + `cleanupRunState` as authoritative execution proof.

## Core Heartbeats
| Heartbeat | Pre | Post | Verdict |
|---|---|---|---|
| syncDispatch | <summary> | <summary> | <PASS/FAIL> |
| uzBudgetDispatch | <summary> | <summary> | <PASS/FAIL> |
| tokenRefreshDispatch | <summary> | <summary> | <PASS/FAIL> |

## Env Final State
- METRICS_REALTIME_CLEANUP_V2_ENABLED: <0 | 1>
- Reason: <explicit continued-cron go or paused after first tick>

## Decision
<clean | dirty>

## Follow-ups
- <items>
```

## Post-Phase-6 Gate

Do not proceed to Phase 7/8 or VACUUM solely because cron deployed.

Next steps need separate go:
- observe several clean cron ticks at the current profile (every 6 h, capped `maxRuns`) before any escalation;
- cadence tightening (6h → 1h, 1h → 15min) is a separate gated decision and MUST NOT be combined with `batchSize` or `maxRuns` increase in the same go;
- `batchSize` or `maxRuns` increase is a separate gated decision and MUST NOT be combined with cadence tightening in the same go;
- plan `metricsDaily` cleanup separately;
- plan `vkApiLimits` cleanup separately;
- only after app-level cleanup reduces live backlog, consider `VACUUM (ANALYZE)`.
