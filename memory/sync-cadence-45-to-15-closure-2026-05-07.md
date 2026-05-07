# Sync cadence 45→15 closure

Date closed: 2026-05-07
Status: **closed clean — canary criteria met**
Reference: `docs/2026-05-07-sync-cadence-45-to-15-runbook.md`
Pre-deploy baseline: `memory/sync-cadence-45-to-15-predeploy-baseline-2026-05-07.md`
D2a closure (immediately preceding track): `memory/d2a-closure-2026-05-07.md`

## Summary

`sync-metrics` cron interval changed from `{ minutes: 45 }` to `{ minutes: 15 }` in `convex/crons.ts` (commit `ffdd32b fix(sync): reduce sync metrics cadence to 15 minutes`). UZ budget cron remains unchanged at 45 min by design — runbook and pre-deploy baseline both call this out explicitly. No env, worker count, batch size, or concurrency limit was touched. The change is a behavior commit affecting only cadence frequency, not per-tick magnitude.

## Deploy

- Behavior commit: `ffdd32b fix(sync): reduce sync metrics cadence to 15 minutes` (scope: `convex/crons.ts` only — `{ minutes: 45 }` → `{ minutes: 15 }` plus recovery-comment update)
- Branch HEAD at deploy: `ddb1b5f` (preceded by doc-only `99b15d4` storage clarification on top of `ffdd32b`)
- Deployed: `2026-05-07T10:06Z` via `npx convex deploy --yes` against prod
- `/version` post-deploy: HTTP 200
- Branch: `emergency/drain-scheduled-jobs` (no PR per `feedback_no_pr`)

## Production env profile (unchanged across deploy)

```text
SYNC_METRICS_V2_ENABLED=1
SYNC_WORKER_COUNT_V2=2
SYNC_BATCH_SIZE_V2=20
SYNC_METRICS_V2_NOUT=1
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16
DISABLE_ERROR_ALERT_FANOUT=1
```

Cadence change is purely a frequency change against an already-stable V2 substrate.

## Canary watch — final values at `2026-05-07T11:40Z` / `14:40 Minsk`

| Dimension | Threshold | Observed | Verdict |
|---|---|---|---|
| `/version` HTTP | 200 | 200 | ✅ |
| `pg_wal` delta vs deploy-time anchor `1,543,503,872` | warn > 75 MB · hard-stop ≥ 150 MB per tick | 0 (no delta) | ✅ |
| Backend stdout rollback patterns since `10:06Z` (`Too many concurrent` / `Transient error` / `TOKEN_EXPIRED` / `syncBatchV2.*Account .* failed`) | 0 each | 0 | ✅ |
| `adminAlerts.notify` in watch window | 0 | 0 | ✅ |
| `syncBatchWorkerV2` `kind: "success"` since deploy | growing, 0 new failed | reached 60 success, 0 new failed | ✅ |
| Sync logical cadence | exact 15-min intervals on organic ticks | confirmed, including latest organic tick at `11:34Z` | ✅ |

### `_scheduled_functions` failed counters — stable, no new failures attributable to cadence change

| UDF | Cumulative failed (sample) | New since deploy `10:06Z` |
|---|---|---|
| `adminAlerts.js:notify` | 38 | 0 |
| `ruleEngine.js:uzBudgetBatchWorker` (V1, no-op) | 36 | 0 |
| `syncMetrics.js:syncBatchWorker` (V1, no-op) | 36 | 0 |
| `auth.js:tokenRefreshOneV2` | 14 | 0 |
| `metrics.js:manualMassCleanup` (V1, no-op) | 1 | 0 |

All historical failed counters trace to pre-D2a / drain-mode windows. None advanced during the cadence-change watch window.

### Caveat — `check-sync-tick` heartbeat "out of window"

`check-sync-tick.cjs` may report the latest heartbeat as "out of window" once that heartbeat moves past the queried window. This is script behavior (window-bounded query), not a sync failure. The authoritative cadence verification is `_scheduled_functions` `syncBatchWorkerV2` `kind: "success"` rows at exact 15-min intervals plus organic ticks observed including `11:34Z`.

## What changed in production behavior

- Sync logical ticks per hour: 1.33× → 4× (every 15 min instead of every 45 min).
- Per-tick V8 slot usage unchanged: 2 worker slots per `SYNC_WORKER_COUNT_V2=2`.
- Per-tick batch size unchanged: 20 accounts per `SYNC_BATCH_SIZE_V2=20`.
- V8 slot worst-case overlap math unchanged: token (6) + UZ (6) + sync (2) = 14/16, headroom 2.
- Window of overlap with token refresh / UZ cron is now 4× more frequent — empirically clean during the watch window with 60 worker successes and zero new failures across all V2 paths.

## What did NOT change

- UZ budget cron `uz-budget-increase` remains at 45 min. Runbook lines 24–34 call this out explicitly. Different optimization track; not bundled.
- `vk-throttling-probe` still commented out (D2b/D2c track).
- `cleanupOldRealtimeMetrics` and other disabled cleanup crons untouched. `manualMassCleanupV2` (storage cleanup V2) is a separate runbook — see follow-ups below.
- `recordRateLimit` predicate untouched at D2a state (`statusCode === 429` only, direct mutation, no scheduler transport).
- No env vars set. No worker count or batch size adjustment. No `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` change.

## Rollback (not triggered)

Rollback path remains documented but unused. Trigger conditions per runbook lines 369–378 included:
- `pg_wal` delta ≥ 150 MB per tick
- Recurring `Too many concurrent` correlated with cadence change
- New failed counters on `syncBatchWorkerV2` / `uzBudgetBatchWorkerV2` / `tokenRefreshOneV2` attributable to overlap windows
- `adminAlerts.notify` resurrection (despite `DISABLE_ERROR_ALERT_FANOUT=1`)

None observed. Rollback action would be: revert `ffdd32b` → commit `revert(sync): restore 45 minute sync cadence` → push → deploy after explicit go.

## Follow-ups (parked, NOT bundled with cadence closure)

1. **Storage cleanup V2 / `manualMassCleanupV2`** — separate runbook per `docs/2026-05-07-storage-cleanup-recovery-analysis.md` recommendation. Disabled cleanup crons (`cleanupOldRealtimeMetrics`, `cleanupOldVkApiLimits`, `cleanupOldActionLogs`, etc.) require their own restore plan, gated by triggers, cron-by-cron. Plan draft: `docs/superpowers/plans/2026-05-07-storage-cleanup-v2.md`.
2. **Disabled cleanup crons restoration** — track separately, do NOT bundle with cadence-change closure or with each other. Each cron has distinct triggers, retention policy, and V8 slot impact.
3. **D2b — sampled `X-RateLimit-*` header observation on 200 responses** — deferred per D2a closure; orthogonal to cadence change.
4. **Rule-adjacent cron restore plan** — see `6768e7c docs(crons): plan rule-adjacent cron restores`, `docs/2026-05-06-restore-matrix-uz-runbook.md`, `docs/2026-05-06-post-phase-8-checklist.md`.

## Production state at closure

- Prod deployed Convex revision: `ffdd32b` (frozen since `2026-05-07T10:06Z`).
- Branch `emergency/drain-scheduled-jobs` HEAD: `ddb1b5f` — matches origin; no behavior commits ahead of prod.
- env profile: unchanged from pre-deploy baseline.
- `cronHeartbeats.syncDispatch` running on 15-min cadence with `error: null`.
- `cronHeartbeats.uzBudgetDispatch` continues on 45-min cadence (unchanged).
- `cronHeartbeats.tokenRefreshDispatch` continues on 2h cadence (unchanged).
- No manual sync triggers performed; first canary was the next organic `sync-metrics` tick after deploy, as required by runbook line 309.

Cadence 45→15 closed clean. No further action required on this track.
