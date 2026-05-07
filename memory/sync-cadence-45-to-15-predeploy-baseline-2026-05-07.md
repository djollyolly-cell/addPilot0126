# Sync cadence 45→15 pre-deploy baseline (frozen)

Date captured: 2026-05-07T09:17–09:19Z (Convex-side captured here; SSH/stdout side is operator-collected, see "Pending server-side anchors" below).
Branch: `emergency/drain-scheduled-jobs`.
Branch HEAD at capture: `99b15d4 docs(storage): clarify branch-vs-prod sync cadence in cleanup analysis`.
Prod deployed Convex revision at capture: `a5ff381` (D2a), unchanged since 2026-05-07T05:35Z.
Reference: `docs/2026-05-07-sync-cadence-45-to-15-runbook.md` (frozen at `60cf712` + `4c9d0f1`).
Behavior change to be deployed: `ffdd32b fix(sync): reduce sync metrics cadence to 15 minutes` — committed, **NOT deployed**.

This memory exists to give the future cadence-change deploy session a single point of entry: known state before the cadence-change deploy decision (code edit `ffdd32b` is already committed and pushed; only deploy is pending). Distinct from D2a closure memo (`memory/d2a-closure-2026-05-07.md`) which is a different track.

## Frozen baseline values (Convex-side)

| # | Item | Value | Method |
|---|---|---|---|
| 1 | Branch HEAD == origin | `99b15d4` | `git rev-parse HEAD` == `git rev-parse origin/emergency/drain-scheduled-jobs` |
| 2 | Prod deployed Convex revision | `a5ff381` (D2a) | last `npx convex deploy` was 2026-05-07T05:35Z; no deploys since |
| 3 | `ffdd32b` scope | only `convex/crons.ts`, 8 insertions / 5 deletions: `{ minutes: 45 }` → `{ minutes: 15 }` + recovery-comment update | `git show ffdd32b --stat` and `git show ffdd32b -- convex/crons.ts` |
| 4 | Uncommitted changes in `convex/` | none | `git status --short convex/` (empty) |
| 5 | `/version` | HTTP 200, 0.80s | `curl -s http://178.172.235.49:3220/version` |
| 6 | env profile (read-only prod-touching observability) | matches runbook expected exactly | `npx convex env list` |
| 7 | `_scheduled_functions` pending/inProgress (latest 8000 sample) | `0 / 0` | filter `"kind":"pending"` and `"kind":"inProgress"` |
| 8 | `_scheduled_functions` failed since D2a deploy | `0` | filter `_creationTime > 1778132100000` AND `"kind":"failed"` |
| 9 | `_scheduled_functions` historical failed (latest 8000 sample) | `96` total: 37 `adminAlerts.js:notify` + 22 `syncMetrics.js:syncBatchWorker` (V1, no-op) + 22 `ruleEngine.js:uzBudgetBatchWorker` (V1, no-op) + 14 `auth.js:tokenRefreshOneV2` (all pre-D2a, latest fail 2026-05-05T01:09Z) + 1 `metrics.js:manualMassCleanup` (V1, no-op) | filter `"kind":"failed"`, group by UDF |
| 10 | `vkApiLimits.recordRateLimit` post-D2a scheduled-job creations | `0` | filter `udf_path = "vkApiLimits.js:recordRateLimit"` AND `_creationTime > 1778132100000` — confirms D2a's no-scheduler-transport invariant holds |
| 11 | `vkApiLimits` post-D2a row count | `11` rows | `npx convex data vkApiLimits --order desc --limit 200`, filter `capturedAt > 1778132100000` |
| 12 | `vkApiLimits` post-D2a statusCode breakdown | `11 × 429, 0 × 200` ✅ | predicate honored |
| 13 | `vkApiLimits` post-D2a account distribution | 4 distinct heavy accounts: `j97a1nkp...` ×7, `j97adsr...` ×2, `j97fztf...` ×1, `j97f3qmb...` ×1 | per-account count |
| 14 | Sync ticks observed since D2a deploy (`syncBatchWorkerV2` `kind:"success"`, threshold `_creationTime > 1778132100000`) | 5 logical ticks: 06:19Z, 07:04Z, 07:49Z, 08:34Z, 09:19Z (the 05:34Z tick fired 50 seconds before D2a deploy and is not counted) | exact 45-min intervals confirmed |
| 15 | UZ ticks since D2a deploy (`uzBudgetBatchWorkerV2` `kind:"success"`) | 5 logical ticks at 06:12Z, 06:57Z, 07:42Z, 08:27Z, 09:12Z (current 45m cadence; 05:27Z tick was pre-deploy and not counted) | exact 45-min intervals confirmed |
| 16 | Token refresh ticks since D2a deploy (`tokenRefreshOneV2` `kind:"success"`) | 2 logical ticks: 07:09Z, 09:09Z (2h cadence; 05:09Z tick was 26 min pre-deploy and not counted) | all clean post-D2a; 14 historical failures all pre-D2a from 2026-05-05 era |
| 17 | `cronHeartbeats.syncDispatch` | `completed`, started 2026-05-07T09:19:10Z (0.2 min ago), error `null` | `node check-token-refresh-tick.cjs` |
| 18 | `cronHeartbeats.uzBudgetDispatch` | `completed`, started 2026-05-07T09:12:10Z (7.2 min ago), error `null` | same |
| 19 | `cronHeartbeats.tokenRefreshDispatch` | `completed`, started 2026-05-07T09:09:36Z (9.7 min ago), error `null` | same |
| 20 | `cronHeartbeats.syncAll` and `cronHeartbeats.checkUzBudgetRules` | last fired 2026-04-26 (V1, irrelevant) | V1 paths held no-op; not used |
| 21 | `adminAlerts.notify` post-D2a | 2 success, 0 failed | scheduled but no-op-gated under `DISABLE_ERROR_ALERT_FANOUT=1` |

### env profile at capture (read-only prod query)

```text
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16
DISABLE_ERROR_ALERT_FANOUT=1
SYNC_BATCH_SIZE_V2=20
SYNC_ESCALATION_ALERTS_ENABLED=0
SYNC_METRICS_V2_ENABLED=1
SYNC_METRICS_V2_POLL_MODERATION=0
SYNC_WORKER_COUNT_V2=2
UZ_BUDGET_V2_ENABLED=1
```

Matches `docs/2026-05-07-sync-cadence-45-to-15-runbook.md` "Current production profile" expected values exactly (lines 38–47).

### Current sync cadence verification

`convex/crons.ts` at prod `a5ff381`:

```ts
crons.interval(
  "sync-metrics",
  { minutes: 45 },
  internal.syncMetrics.syncDispatchV2,
);
```

Last 6 sync logical ticks (descending):
- `1778145430000` ≈ 2026-05-07T09:19:10Z
- `1778142850916` = 2026-05-07T08:34:10Z (Δ ≈ 45 min)
- `1778140150369` = 2026-05-07T07:49:10Z (Δ ≈ 45 min)
- `1778137450405` = 2026-05-07T07:04:10Z (Δ ≈ 45 min)
- `1778134750342` = 2026-05-07T06:19:10Z (Δ ≈ 45 min)
- `1778132050343` = 2026-05-07T05:34:10Z (Δ ≈ 45 min)

Exact 45-min intervals — current cadence confirmed at the value the runbook says we are about to change.

## Pending server-side anchors (refresh immediately before deploy go)

These anchors live on the production server (Postgres container + backend stdout) and should be refreshed in a tight window immediately before deploy go, not at the same moment as the Convex-side capture above. The Convex-side baseline is stable for hours; pg_wal and stdout are time-sensitive and need to reflect the state right at deploy.

1. **`pg_wal` byte-exact baseline**: `ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 "docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal"`. Last anchor at D2a closure: `1,543,503,872` bytes (2026-05-07T08:35Z, recorded in `memory/d2a-closure-2026-05-07.md`). Refresh the anchor right before deploy go and use the fresh value as the per-tick delta baseline post-deploy.
2. **`node check-sync-tick.cjs baseline`**: produces `/tmp/sync-canary-baseline.json` with full sync canary baseline (pg_wal, V2 `_scheduled_jobs` counts, failed counters, `/version`, `lastSyncAt` stale count). Run right before deploy go; required by runbook canary loop. This script uses SSH internally to capture pg_wal alongside Convex-side state in one snapshot.
3. **Backend stdout grep since D2a closure** (08:35Z) through pre-deploy moment: refined patterns:
   - `Too many concurrent` count
   - `Transient error` count
   - `TOKEN_EXPIRED` in sync worker context
   - `syncBatchV2.*Account .* failed` count
   - **Refined real HTTP 429 count** — capture as **contextual signal**, NOT strict counter (caveat from `memory/d2a-closure-2026-05-07.md`: stdout 429-counter is not authoritative in this runtime; authoritative source for 429 events is `vkApiLimits` table itself with statusCode filter).

## Why these specific values matter for cadence 45→15

- **`SYNC_WORKER_COUNT_V2=2` and `SYNC_BATCH_SIZE_V2=20`** are the post-throughput-bump values. Per-tick V8 slot usage is 2; this stays unchanged at 15-min cadence (runbook lines 116–124). What changes is the frequency of overlap windows, not magnitude per tick.
- **`DISABLE_ERROR_ALERT_FANOUT=1`** is the safety net behind no `adminAlerts.notify` resurrection during canary. Verified: 2 post-D2a success entries are no-op-gated under this flag, no failed.
- **0 failed since D2a deploy** is the strongest pre-deploy signal: V2 path has not produced a single failure in the latest sample window. Cadence change starts from a clean V2 substrate, not from a flapping/transient state.
- **0 post-D2a `recordRateLimit` scheduled jobs** confirms the D2a no-scheduler-transport invariant holds. Cadence change adds 3× more sync ticks per hour, so 3× more potential 429-detection opportunities. With the direct-mutation path, that translates to 3× more potential `vkApiLimits` direct-insert calls but ZERO scheduled-job pressure.
- **All cronHeartbeats `completed` with `error: null`** satisfies runbook precondition line 148: "Latest sync, UZ, and token refresh heartbeats are completed/error null."
- **vkApiLimits 11 rows, all 429**: confirms predicate honored, baseline value for post-deploy attribution. Under 15-min cadence the run-rate could rise to ~3× (11 × 3 ≈ 33/3h) if the same heavy accounts still get throttled; this is acceptable per design but should be monitored against the runbook's "no `vkApiLimits` row predicate violation" criterion.
- **6 sync logical ticks at exactly 45-min intervals** confirms the cadence value the runbook is about to change. After deploy, the same captured-tick verification on 15-min interval is the primary functional gate.

## Risk model alignment with current state

Mapping runbook risks (lines 128–135) to current values:

1. **More frequent WAL/write pressure (3× hourly)** — current pg_wal trend at D2a closure was −32 MiB delta over 3h. Pre-deploy fresh anchor pending; post-deploy delta target: warn > 75 MB / hard-stop ≥ 150 MB per tick.
2. **More overlap windows** — current overlap math: token (6) + UZ (6) + sync (2) = 14/16, headroom 2. Frequency of overlap windows under 15-min sync = 4× per hour vs. current 1.33×.
3. **Worker carryover** — `syncBatchWorkerV2` worker-total timeout `570_000 ms` (9.5 min). Last 6 sync logical ticks completed within their 45-min window with no overlap; per-tick duration data not directly in this baseline but inferable from `_scheduled_functions completedTime - scheduledTime`. Important to sample post-deploy: if any tick's worker runs longer than ~13 min, the next dispatcher tick at 15 min is at risk of overlap.
4. **Heartbeat guard nuance** — `cronHeartbeats.syncDispatch` is dispatcher-level, NOT worker-level. Runbook flags this as a known limitation.
5. **Top-100 rotation behavior** — `listSyncableAccounts` selects from top-100 oldest `lastSyncAt` window. Closure should monitor updated-account counts per tick (runbook acceptance: ≥15 per tick, expected 18–20).

## Resume path for the cadence-change session

Code edit is already done — `ffdd32b fix(sync): reduce sync metrics cadence to 15 minutes` is committed and pushed to `origin/emergency/drain-scheduled-jobs`. Only deploy is pending. After explicit deploy go:

1. Re-verify this baseline gate (read-only): env, `/version`, `cronHeartbeats`, scheduled-jobs failed-since-D2a still 0. If anything diverged from frozen values, **stop and report — do not patch the runbook**.
2. Operator refreshes server-side anchors immediately before deploy (see "Pending server-side anchors" below): `pg_wal` byte-exact + `node check-sync-tick.cjs baseline` + backend stdout grep since D2a closure.
3. Verify `ffdd32b` is still the right commit and scope is unchanged: `git show ffdd32b -- convex/crons.ts` shows only `{ minutes: 45 }` → `{ minutes: 15 }` + recovery-comment update (runbook lines 240–253). No code edits should be applied in this session — `ffdd32b` is the canonical change.
4. Verify HEAD == origin (currently `99b15d4`; may have advanced if more doc-only commits land before deploy go, but no other behavior commits should appear).
5. Local typecheck: `npx tsc --noEmit -p convex/tsconfig.json` clean.
6. Deploy via `npx convex deploy --yes` against `http://178.172.235.49:3220` with admin key from `gen-admin-key.cjs`.
7. Immediately verify `/version` HTTP 200.
8. Post-deploy canary loop per runbook lines 311–342: monitor next 4+ organic sync ticks. Hard criteria per tick listed in runbook lines 321–336. Closure criteria in lines 346–360.

## Do not do during cadence change

- Do not change `SYNC_BATCH_SIZE_V2`, `SYNC_WORKER_COUNT_V2`, `APPLICATION_MAX_CONCURRENT_V8_ACTIONS`, `SYNC_METRICS_V2_POLL_MODERATION`, `SYNC_ESCALATION_ALERTS_ENABLED`, `UZ_BUDGET_V2_ENABLED`, `DISABLE_ERROR_ALERT_FANOUT` env vars (runbook lines 85–96).
- Do not change `uz-budget-increase` cadence; UZ stays 45 min (runbook lines 24–34).
- Do not restore `adminAlerts.notify`.
- Do not restore `vk-throttling-probe`.
- Do not restore or modify `recordRateLimit` body (D2a is in production; cadence change is independent of D2a).
- Do not restore `cleanupOldRealtimeMetrics` cron (per `docs/2026-05-07-storage-cleanup-recovery-analysis.md` recommendation: needs separate `manualMassCleanupV2` runbook).
- Do not run manual sync; first canary must be the next organic `sync-metrics` tick after deploy (runbook line 309).
- Do not bundle 45→15 with any other behavior change. `6768e7c` and `99b15d4` are doc-only ride-along and acceptable; `a7caf3a` is doc-only D2a closure ride-along and acceptable. No other behavior changes should be on branch HEAD beyond `ffdd32b`.

## Closure window expectation (from runbook)

- 60–90 min if first 4 ticks arrive clean and no token refresh overlap needs extra observation.
- 2–3h if token refresh overlap (every 2h) lands and needs explicit closure evidence.

## Rollback expectation (from runbook)

Rollback is code revert + deploy, not env set. Triggers listed in runbook lines 369–378. Rollback action: revert `ffdd32b` → commit `revert(sync): restore 45 minute sync cadence` → push → deploy after explicit rollback go.
