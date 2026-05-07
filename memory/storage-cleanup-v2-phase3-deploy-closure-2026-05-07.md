# Storage Cleanup V2 — Phase 3 Deploy Closure

Date: 2026-05-07
Status: **closed clean — code deployed, cleanup inactive**
Track: metricsRealtime cleanup V2

## Summary

Phase 3 deployed the Phase 1 cleanup V2 code to production without activating cleanup behavior.

The deploy made the new `metricsRealtime` cleanup V2 functions and `cleanupRunState` schema available in Convex, but did not enable the env gate, did not restore the cleanup cron, and did not invoke any cleanup trigger.

This closure intentionally stops before Phase 4. Phase 4 canary requires fresh anchors and a separate explicit go.

## Deploy

- Branch: `emergency/drain-scheduled-jobs`
- Branch HEAD at deploy: `5d3aa819f453eef819f1c1d9c831a85749dd9402`
- Code payload: `2410f14 feat(storage-cleanup): add metricsRealtime cleanup V2`
- Runbook payload: `e61d05a docs(storage-cleanup): add phase 4 canary runbook`
- Runbook fix: `5d3aa81 docs(storage-cleanup): apply phase 4 canary runbook review fixes`
- Deploy command: `npx convex deploy --yes` against `http://178.172.235.49:3220`
- Deploy completion: observed clean in-session before `2026-05-07T18:00:51Z`
- Post-deploy `/version`: HTTP 200, about 0.69s from the deploy runner

Deploy output:

```text
Schema validation complete.
Finalizing push...
Added table indexes:
  cleanupRunState.by_cleanupName_isActive
  cleanupRunState.by_runId
Deployed Convex functions to http://178.172.235.49:3220
```

## Code Scope

Behavior commit `2410f14` changed exactly three Convex files:

| File | Purpose |
|---|---|
| `convex/schema.ts` | Adds `cleanupRunState` table and indexes. |
| `convex/metrics.ts` | Adds metricsRealtime cleanup V2 entrypoints and widens `deleteRealtimeBatch` with optional `cutoffMs`. |
| `convex/metrics.test.ts` | Adds Phase 1 V2 safety tests. |

Runbook commits after `2410f14` are doc-only and do not change production behavior.

## What Changed In Production

- New `cleanupRunState` table is available.
- New indexes are available:
  - `cleanupRunState.by_cleanupName_isActive`
  - `cleanupRunState.by_runId`
- New V2 functions are deployed:
  - `internal.metrics.triggerMassCleanupV2`
  - `internal.metrics.getCleanupRunStateV2`
  - `internal.metrics.markRunningV2`
  - `internal.metrics.recordBatchProgressV2`
  - `internal.metrics.scheduleNextChunkV2`
  - `internal.metrics.markCompletedV2`
  - `internal.metrics.markFailedV2`
  - `internal.metrics.manualMassCleanupV2`

## What Did Not Change

- `METRICS_REALTIME_CLEANUP_V2_ENABLED` was not set or changed during Phase 3.
- `cleanup-old-realtime-metrics` cron remains commented out.
- No cleanup trigger was invoked.
- No `metricsRealtime` rows were deleted by Phase 3.
- V1 cleanup surfaces remain unchanged:
  - `manualMassCleanup` remains no-op.
  - `triggerMassCleanup` remains the legacy public mutation and was not invoked.
  - `scheduleMassCleanup` remains V1 path.
  - `cleanupOldRealtimeMetrics` remains tied to the disabled cron path.
- No sync, UZ, token-refresh, or D2a env settings were changed.

## Verification Performed

| Check | Result |
|---|---|
| `HEAD == origin/emergency/drain-scheduled-jobs` | `5d3aa819f453eef819f1c1d9c831a85749dd9402` |
| `convex/` working tree | clean |
| Code payload scope | exactly `convex/schema.ts`, `convex/metrics.ts`, `convex/metrics.test.ts` |
| Runbook fix scope | exactly `memory/storage-cleanup-v2-phase4-canary-runbook-2026-05-07.md` |
| Pre-deploy `/version` | HTTP 200, about 0.77s |
| Post-deploy `/version` | HTTP 200, about 0.69s |
| Deploy output | schema validation complete, functions deployed |

## Runtime Checks Intentionally Deferred

Phase 3 closure does not claim runtime canary readiness. The following checks are deliberately deferred to the Phase 4 pre-step and anchor recapture:

### Pre-Step-1 Sanity (before setting env)

- `npx convex env list | grep CLEANUP`
  - Expected: `METRICS_REALTIME_CLEANUP_V2_ENABLED` absent or not `1`.
- `npx convex run internal.metrics.getCleanupRunStateV2 '{"runId":"verify-only-fake"}'`
  - Expected: `null`, proving the deployed read-only query exists and does not create state.
- `_scheduled_functions` count for `metrics.js:manualMassCleanupV2`
  - Expected: `0` absolute before first canary trigger.

### Phase 4 Step 2 Recapture

- Fresh `pg_wal` anchor.
- Disk usage anchor.
- `metricsRealtime` eligible count and `oldestRemainingTimestamp`.
- Core heartbeats.
- Failed counters.
- Backend stdout rollback-pattern grep.

These checks are time-sensitive and belong immediately before canary, not in the deploy closure.

## Rollback

No rollback was triggered.

If a Phase 3 deploy regression had appeared before canary activation, rollback would be a code revert of the cleanup V2 deploy payload followed by deploy after explicit go. Because cleanup remained env-gated and cron-disabled, no app-level cleanup state needed rollback.

## Next Step

Proceed to Phase 4 only after a separate explicit go.

Phase 4 sequence:

1. Run Pre-Step-1 sanity checks (read-only).
2. Set `METRICS_REALTIME_CLEANUP_V2_ENABLED=1` only after explicit canary go.
3. Recapture anchors in a tight window.
4. Wait for an organic `syncBatchWorkerV2` success.
5. Invoke `internal.metrics.triggerMassCleanupV2` once with canary parameters.
6. Observe exactly one V2 chunk and close or roll back per `memory/storage-cleanup-v2-phase4-canary-runbook-2026-05-07.md`.

Phase 3 is closed clean: cleanup V2 code is deployed and dormant.
