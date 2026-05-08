# Storage Cleanup V2 - Phase 5 Controlled Runs Runbook - 2026-05-08

Status: draft runbook for the first manual controlled cleanup run after a clean Phase 4 canary. Doc-only; not executed. Written against Phase 1 code commit `2410f14`, reviewed against Phase 4 canary closure `8b96807`.

## Scope

This runbook covers ONE manual controlled `metricsRealtime` cleanup trigger with `maxRuns > 1`, after Phase 4 canary has closed clean.

It does NOT cover:
- Phase 4 canary execution or closure.
- Phase 6 cron restore.
- `metricsDaily` or `vkApiLimits` cleanup.
- PostgreSQL `VACUUM`, `VACUUM FULL`, `pg_repack`, or direct SQL deletes.
- Any code change in `convex/`.

Operator rule: one Phase 5 trigger per explicit go. Do not chain multiple manual triggers in the same operator session unless the previous run has a filled closure memo and the user gives a new go.

## References

- Plan: `docs/superpowers/plans/2026-05-07-storage-cleanup-v2.md` (Phase 5 section)
- Phase 4 canary runbook: `memory/storage-cleanup-v2-phase4-canary-runbook-2026-05-07.md`
- Phase 4 canary closure: `memory/storage-cleanup-v2-canary-closure-2026-05-08.md` (commit `8b96807`)
- Phase 4 canary closure template: `memory/storage-cleanup-v2-canary-closure-template-2026-05-07.md`
- Phase 2 verification cheat sheet: `memory/storage-cleanup-v2-phase2-verification-cheatsheet-2026-05-07.md`
- Phase 3 deploy closure: `memory/storage-cleanup-v2-phase3-deploy-closure-2026-05-07.md`
- Phase 1 code source of truth: `convex/metrics.ts`, `convex/schema.ts`, `convex/metrics.test.ts` at commit `2410f14`

## Required Inputs From Phase 4

Before starting, copy these values from `memory/storage-cleanup-v2-canary-closure-<actual-date>.md`.

```text
phase4_status:                 clean
phase4_runId:                  <FILL_IN>
phase4_batchSize:              <n>
phase4_maxRuns:                1
phase4_deletedCount:           <n>
phase4_durationMs:             <n>
phase4_oldestRemainingTimestamp_post: <n> (<ISO>)
phase4_pg_wal_delta_bytes:     <bytes>
phase4_warn_threshold_bytes:   <bytes>
phase4_hard_threshold_bytes:   <bytes>
phase4_v2_success_entries:     1
phase4_v2_failed_entries:      0
phase4_env_after:              METRICS_REALTIME_CLEANUP_V2_ENABLED=0
phase4_core_heartbeats_clean:  yes
phase4_open_blockers:          none
```

If any value is missing, or Phase 4 did not close clean, STOP. Do not run Phase 5.

Actual Phase 4 values from `memory/storage-cleanup-v2-canary-closure-2026-05-08.md`:

```text
phase4_status:                 clean
phase4_runId:                  1778215091302-1a285e0ec02c
phase4_batchSize:              500
phase4_maxRuns:                1
phase4_deletedCount:           500
phase4_durationMs:             3554
phase4_oldestRemainingTimestamp_post: 1777733701988 (2026-05-02T14:55:01.988Z)
phase4_pg_wal_delta_bytes:     0
phase4_warn_threshold_bytes:   5 MB
phase4_hard_threshold_bytes:   50 MB
phase4_v2_success_entries:     1
phase4_v2_failed_entries:      0
phase4_env_after:              METRICS_REALTIME_CLEANUP_V2_ENABLED=0
phase4_core_heartbeats_clean:  yes
phase4_open_blockers:          none
phase4_stdout_markers:         not surfaced in docker stdout; use row/scheduled-functions proof
```

## Preconditions

- [ ] `HEAD` and `origin/emergency/drain-scheduled-jobs` are on the expected doc trail, or current drift was reviewed.
- [ ] `git status --short memory/storage-cleanup-v2-* convex/` is clean.
- [ ] Phase 4 canary closure exists and says `Status: clean`.
- [ ] At least 1-2 organic sync ticks after Phase 4 closure were clean, or the Phase 4 closure explicitly says no buffer is required.
- [ ] `METRICS_REALTIME_CLEANUP_V2_ENABLED` is currently `0` or absent.
- [ ] `cleanup-old-realtime-metrics` cron remains commented in `convex/crons.ts`.
- [ ] No active `cleanupRunState` row exists for `cleanupName = "metrics-realtime-v2"` with `isActive = true`.
- [ ] `_scheduled_functions` has no in-flight `metrics.js:manualMassCleanupV2` rows from a previous run.
- [ ] Core heartbeats are clean: `syncDispatch`, `uzBudgetDispatch`, `tokenRefreshDispatch` completed, no error.

If any precondition fails, STOP and document the blocker.

## Step 1 - Re-verify Deployed Contract

Use the Phase 2 cheat sheet as a source-level check if `convex/` changed. At minimum, re-confirm:

- `triggerMassCleanupV2` args are `{ batchSize, timeBudgetMs, restMs, maxRuns }`.
- `manualMassCleanupV2` reads `METRICS_REALTIME_CLEANUP_V2_ENABLED` at each invocation.
- `scheduleNextChunkV2` schedules `manualMassCleanupV2`, never V1 `manualMassCleanup`.
- `cleanupRunState` has indexes `by_cleanupName_isActive` and `by_runId`.
- Log prefix is exactly `[cleanup-v2]`; note that Phase 4 proved these user logs may not surface in `adpilot-convex-backend` docker stdout in this self-hosted runtime, so stdout markers are useful if present but not authoritative.
- V1 `manualMassCleanup` body is still no-op.
- `cleanup-old-realtime-metrics` cron is still commented.

No deploy, no codegen, no tests are part of this runbook unless separately requested.

## Step 2 - Choose Conservative Parameters

First Phase 5 run should increase only `maxRuns`; keep batch size unchanged from the canary unless the Phase 4 closure explicitly recommends otherwise.

Recommended first controlled trigger:

```text
batchSize:     500
timeBudgetMs:  10000
restMs:        90000
maxRuns:       3
```

Rationale:
- `maxRuns=3` proves the self-scheduling chain beyond one chunk.
- `batchSize=500` avoids changing two load dimensions at once.
- `restMs=90000` keeps the V8 slot released between chunks and reduces overlap risk with sync/UZ/token work.
- Expected maximum deletes: `batchSize * maxRuns = 1500`.
- Phase 4 canary deleted `500` rows in `3,554 ms` with `0` observed `pg_wal` growth, so a 3-chunk run is a conservative multiplier over observed clean behavior.

Do NOT use `maxRuns >= 10` for the first Phase 5 run. Save that for a later controlled run after this one closes clean.
Reason: first Phase 5 is a small multiplier over canary (3-5x `maxRuns`), not a jump to cron-like throughput.

## Step 3 - Recapture Anchors

Capture fresh pre-run anchors. Do not reuse Phase 4 values except for sizing.

| Anchor | Required value | Source |
|---|---|---|
| `/version` HTTP and time | 200 and stable latency | `curl` |
| disk free | free space and delta vs Phase 4 | `df -h /` |
| `pg_wal` | byte count before run | `du -sb .../pg_wal` |
| `metricsRealtime` total | preferred count, or stale contextual count with explicit caveat | read-only dashboard/query |
| `metricsRealtime` eligible | preferred count and cutoff used, or structural proof mode for this first small controlled run | read-only dashboard/query / `cleanupRunState` |
| `oldestRemainingTimestamp` | `min(timestamp)` across all `metricsRealtime` rows | read-only dashboard/query |
| core heartbeats | sync/UZ/token status | `cronHeartbeats` |
| failed counters | V2, V1, sync/UZ/token/adminAlerts | `_scheduled_functions` |
| backend stdout | rollback patterns since last closure | `docker logs` |

Cutoff note: if eligible pre-count uses approximate `now - 172_800_000`, record the exact cutoff timestamp used. The final closure must compare against `cleanupRunState.cutoffUsed` with the boundary adjustment described in the Phase 4 closure template.

Eligible-count strategy:
- Preferred: run a fresh exact eligible count if the operator can afford the long scan.
- Acceptable for the first Phase 5 run only (`batchSize=500`, `maxRuns=3`, max `1500` rows): use structural proof if a fresh exact count is too expensive. Structural proof requires exact `deletedCount`, immutable `cutoffUsed`, V2 success entries equal `batchesRun`, no extra V2 entries, and `oldestRemainingTimestamp >= pre`.
- Not acceptable for larger later controlled runs: refresh eligible/backlog sizing before increasing either `batchSize` or `maxRuns` beyond this first controlled profile.

## Step 4 - Derive WAL Thresholds

Use Phase 4 observed WAL footprint and current baseline noise. Worked example only:

```text
per_chunk_wal = max(phase4_pg_wal_delta_bytes, 1 MB floor)
expected_wal  = per_chunk_wal * maxRuns
warn          = max(25 MB, 3 * expected_wal)
hard_stop     = max(150 MB, 10 * expected_wal)
```

If baseline WAL noise from normal sync/UZ/token work is already larger than expected cleanup WAL, derive thresholds from baseline rate and record the reasoning.

Hard-stop threshold is a stop condition, not a target.

For the first Phase 5 run using actual Phase 4 values:

```text
phase4_pg_wal_delta_bytes = 0
per_chunk_wal             = 1 MB floor
expected_wal              = 3 MB
warn                      = max(25 MB, 9 MB)  = 25 MB
hard_stop                 = max(150 MB, 30 MB) = 150 MB
```

If the fresh pre-run WAL mini-pair shows baseline noise above this expected signal, use the measured baseline rate instead and document the override in the closure.

## Step 5 - Pick the Trigger Window

Do not trigger off wall clock alone.

- Wait for an observed organic `syncBatchWorkerV2` success.
- Trigger within a quiet window after that success, before the next expected sync tick when feasible.
- Avoid known token refresh fan-out windows.
- If UZ/token/sync have any fresh failure, STOP. Core-cron regression overrides cleanup.

## Step 6 - Enable Env Flag

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1
```

Verify:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED
```

Expected: `1`. Avoid full `env list` in normal reporting because it prints unrelated secrets.

## Step 7 - Trigger One Controlled Run

Use the approved parameters from Step 2.

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex run internal.metrics.triggerMassCleanupV2 \
  '{"batchSize": 500, "timeBudgetMs": 10000, "restMs": 90000, "maxRuns": 3}'
```

Expected success:

```json
{ "runId": "<epoch-ms>-<12hex>", "status": "scheduled" }
```

Non-success handling:
- `{ "status": "disabled" }` - env not active or not propagated. Do not retry blindly; re-check Step 6.
- `{ "status": "already-running", "runId": "<existing>" }` - active row exists. STOP and investigate `cleanupRunState`; do not trigger another run.

Save `runId`.

## Step 8 - Observe Until Terminal State

Observation window: at least `maxRuns * restMs + 5 minutes`, unless the row reaches terminal state earlier and all checks are green.

Expected for the recommended first run:
- `_scheduled_functions`: total V2 entries equals `batchesRun`, success equals `batchesRun`, failed equals 0.
- `batchesRun <= maxRuns`.
- If backlog remains, expected `batchesRun == maxRuns`; final log has `decision=complete` because maxRuns limit stopped the chain.
- If backlog empties early, `batchesRun < maxRuns` is acceptable only when `hasMore=false` and row is completed.
- stdout: one `[cleanup-v2] start` per chunk and one `[cleanup-v2] end` per chunk if this runtime surfaces user `console.log` to docker stdout.
- stdout: `decision=schedule` for intermediate chunks and `decision=complete` for final clean chunk if markers surface.
- stdout: zero `[cleanup-v2] runId=... skip reason=disabled_mid_chain` lines for clean. Any hit is expected only if the operator intentionally killed the chain by turning env off mid-flight, or if env drifted unexpectedly; either case is dirty/abort evidence.
- If `[cleanup-v2]` markers are absent but `cleanupRunState`, `_scheduled_functions`, WAL, env, and core counters are clean, treat stdout marker absence as the known Phase 4 log-routing caveat, not as a dirty signal.
- `cleanupRunState`: `state="completed"`, `isActive=false`, `error=undefined`, `deletedCount > 0`.
- No V1 `manualMassCleanup` failed-counter growth.
- No core heartbeat regression.
- `pg_wal` delta stays below warn; hard-stop breach stops the runbook.

## Step 9 - Disable Env Flag

Always return env to deploy-safe after this controlled run, clean or dirty.

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0
```

Verify env list shows `0`.

Use `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` for verification and report only the single value.

If a chain is still active, the next scheduled `manualMassCleanupV2` invocation should read env=0 and close the row with `state="failed"` and `error="disabled_mid_chain"`. Wait up to `restMs + 30s`. If it does not close, STOP and escalate; do not patch production state manually from an ad hoc script.

## Step 10 - Decision

Clean criteria, all required:

- `_scheduled_functions`: V2 total entries == `cleanupRunState.batchesRun`, V2 failed absolute == 0 (pre==0, post==0), V1 failed delta == 0.
- `cleanupRunState`: completed, inactive, `batchesRun <= maxRuns`, `deletedCount > 0`, `error` undefined.
- Eligible count delta matches `deletedCount` after cutoff alignment/boundary adjustment.
- `oldestRemainingTimestamp` did not regress.
- `pg_wal` delta is below warn threshold.
- Backend stdout has no rollback patterns. `[cleanup-v2]` marker absence alone is not dirty if authoritative row / scheduled-function proof is clean.
- Core heartbeats remain clean.
- Env flag is back to 0.

Note: App-level V2 failure is authoritative in `cleanupRunState.state == "failed"` / `error`, even when `_scheduled_functions.kind` is `"success"` because the action caught and returned normally.

Dirty if any of the above fails.

Hard stops:
- sync/UZ/token regression.
- `Too many concurrent`, recurring `Transient error`, or `TOKEN_EXPIRED` correlated with the run.
- V1 `manualMassCleanup` growth.
- V2 entries exceed `maxRuns`.
- `cleanupRunState` stuck in `claimed` or `running`.
- `pg_wal` exceeds hard-stop threshold.
- Env flag cannot be returned to 0.

## Step 11 - Closure Memo

Write `memory/storage-cleanup-v2-controlled-closure-<actual-date>.md`.

Required sections:

```text
# Storage Cleanup V2 - Controlled Run Closure - <date>

Status: <clean | dirty>
Trigger time: <ISO>
runId: <runId>
Params: batchSize=<n>, timeBudgetMs=<n>, restMs=<n>, maxRuns=<n>

## Preconditions
- Phase 4 closure: <file>, status clean
- Env pre: <0/absent>
- Cron status: cleanup-old-realtime-metrics still commented
- Core heartbeats pre: <summary>

## Anchors
| Anchor | Pre | Post | Delta | Threshold | Verdict | Source |
|---|---|---|---|---|---|---|
| /version | <n> | <n> | <delta> | 200 | <PASS/FAIL> | <source> |
| disk free | <value> | <value> | <delta> | no unexplained drop | <PASS/WARN/FAIL> | <source> |
| pg_wal | <bytes> | <bytes> | <bytes> | warn=<bytes>, hard=<bytes> | <PASS/WARN/FAIL> | <source> |
| metricsRealtime total | <n> | <n> | <n> | informational | <PASS/WARN> | <source> |
| metricsRealtime eligible | <n> | <n> | <n> | matches deletedCount after cutoff alignment and boundary-M adjustment | <PASS/FAIL> | <source> |
| oldestRemainingTimestamp | <n> (<ISO>) | <n> (<ISO>) | <delta> | post >= pre | <PASS/FAIL> | <source> |

Eligible delta cutoff alignment:
- `cleanupRunState.cutoffUsed`: <n> (<ISO>)
- `pre_cutoff_used`: <n> (<ISO>)
- `boundary_M_estimate`: <n> rows in `[pre_cutoff_used, cleanupRunState.cutoffUsed)`
- Strict expected if cutoffs match: `|eligible_delta| == deletedCount`
- Approximate expected otherwise: `|eligible_delta| ~= deletedCount +/- boundary_M_estimate`
- Verdict: <PASS/FAIL>

## Scheduled Functions
| UDF | Pre failed | Post failed | Delta failed | Total entries | Success | Failed | Verdict |
|---|---|---|---|---|---|---|---|
| metrics.js:manualMassCleanupV2 | 0 | 0 | 0 | <n> | <n> | 0 | <PASS/FAIL> |
| metrics.js:manualMassCleanup (V1) | <n> | <n> | 0 | <n/a> | <n/a> | <n/a> | <PASS/FAIL> |

Notes:
- V2 failed is absolute zero, not only delta zero.
- V1 evidence is failed-counter delta zero; total/success counts are not used for the V1 no-op residue path.

## cleanupRunState Final Row
<paste row fields: cleanupName, runId, state, isActive, startedAt, lastBatchAt,
batchesRun, maxRuns, cutoffUsed, deletedCount, oldestRemainingTimestamp,
durationMs, error, batchSize, timeBudgetMs, restMs>

## Backend Stdout
- start lines: <n> (may be 0 if user logs still do not route to docker stdout)
- end schedule lines: <n> (may be 0 if user logs still do not route to docker stdout)
- end complete lines: <n> (may be 0 if user logs still do not route to docker stdout)
- end failed lines: <n>
- disabled_mid_chain skip lines: <n> (expected 0 for clean; >0 only if env was intentionally toggled off mid-chain or drifted)
- rollback patterns: <n>

If `[cleanup-v2]` markers are absent, cite Phase 4 closure `8b96807` as precedent and rely on `cleanupRunState` + `_scheduled_functions` for authoritative execution proof.

## Core Heartbeats
| Heartbeat | Pre | Post | Verdict |
|---|---|---|---|
| syncDispatch | <summary> | <summary> | <PASS/FAIL> |
| uzBudgetDispatch | <summary> | <summary> | <PASS/FAIL> |
| tokenRefreshDispatch | <summary> | <summary> | <PASS/FAIL> |

## Decision
<clean | dirty>

## Post-run State
- METRICS_REALTIME_CLEANUP_V2_ENABLED: 0
- cleanup-old-realtime-metrics cron: still commented
- Phase 5 next-run recommendation: <params or blocked>
- Phase 6 readiness: <not ready | candidate after more clean controlled runs>

## Follow-ups
- <items>
```

## Phase 6 Gate

Do not enable cron after a single controlled run by default.

Phase 6 can be discussed only after:
- Phase 4 canary closure is clean.
- At least one Phase 5 controlled closure is clean.
- Preferably several controlled runs show stable WAL, no V1 growth, and no core-cron regression.
- Operator explicitly approves a code change to `convex/crons.ts`.

Until then, `cleanup-old-realtime-metrics` remains commented.
