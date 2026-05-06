# Phase 6 sync canary status

Date: 2026-05-06
Branch: `emergency/drain-scheduled-jobs`
Current local/remote HEAD: `9f62cfa`

## Current state

- Phase 2 token refresh is closed after two clean ticks (`13:09 UTC`, `15:09 UTC`).
- Phase 5a UZ manual canary is clean.
- Phase 5b UZ cron canary is clean after two organic ticks (`18:57 UTC`, `19:42 UTC`) at `45 min`; `UZ_BUDGET_V2_ENABLED=0`.
- Phase 6 sync prepare commits are pushed to `origin/emergency/drain-scheduled-jobs`; sync V2 and escalation guard are deployed live:
  - `e478dcb` - sync V2 entrypoints + moderation gate.
  - `ed5d5bf` - runtime env reads + explicit V1 cron warning.
  - `a510695` - per-account failure monitoring + removed V1 ready-to-uncomment cron block.
  - `3f92025` - docs guardrails.
  - `9f62cfa` - sync escalation alert guard.
- Phase 6a manual canary ran at `2026-05-06T03:36Z`: sync mechanics clean, but `adminAlerts.js:notify=5`; classified yellow-clean.
- Phase 6a-bis ran at `2026-05-06T04:31Z` after `9f62cfa`: clean by hard criteria (`1` V2 worker success, `0` adminAlerts schedules, `0` V8/transient, `0` per-account failures, flat WAL, heartbeat completed).
- Current production gates:
  - `SYNC_METRICS_V2_ENABLED=0`
  - `SYNC_ESCALATION_ALERTS_ENABLED=0`
  - `SYNC_METRICS_V2_POLL_MODERATION=0`
  - `SYNC_WORKER_COUNT_V2=1`
  - `SYNC_BATCH_SIZE_V2=10`
  - `DISABLE_ERROR_ALERT_FANOUT=1`
  - `UZ_BUDGET_V2_ENABLED=0`

## Phase 6b candidate

No prod-touching step without explicit `go`.

1. Prepare commit to uncomment only V2 sync cron in `convex/crons.ts`:
   `crons.interval("sync-metrics", { minutes: 45 }, internal.syncMetrics.syncDispatchV2)`.
2. Keep V1 sync cron absent; do not restore `internal.syncMetrics.syncDispatch`.
3. Deploy with `SYNC_METRICS_V2_ENABLED=0` and `SYNC_ESCALATION_ALERTS_ENABLED=0`.
4. Verify `/version`, fail-closed smoke, heartbeat unchanged.
5. Open `SYNC_METRICS_V2_ENABLED=1` in a monitored window and wait for organic cron tick; do not manual-trigger Phase 6b.
6. Monitor first organic tick with the same hard criteria as Phase 6a-bis.

## Rollback triggers

Any one means stop sync canary, set `SYNC_METRICS_V2_ENABLED=0`, and do not retry before analysis:

- `syncMetrics.js:syncBatchWorkerV2 failed > 0`.
- Any backend stdout line matching `syncBatchV2.*Account .* failed`.
- Any `Too many concurrent` or `Transient error`.
- Any new `adminAlerts.js:notify` schedule in the window.
- `pg_wal` delta > `50 MB` for the first `1 worker x 10 accounts` run.

## Notes

- Do not run smoke V2 after `SYNC_METRICS_V2_ENABLED=1`; that is the real canary.
- Sync cron remains commented out. Phase 6b cron is a separate decision after manual canary.
- `npx convex codegen` is not part of Phase 6a; use deploy only unless explicitly approved.
