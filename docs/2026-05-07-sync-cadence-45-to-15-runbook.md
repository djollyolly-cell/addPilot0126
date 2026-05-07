# Sync cadence runbook: `sync-metrics` 45 min -> 15 min

Date: 2026-05-07
Branch: `emergency/drain-scheduled-jobs`
Scope: reduce user-visible rule-evaluation delay after sync throughput bumps closed clean.
Status: runbook only -- does not authorize code changes, deploy, or prod actions by itself.

## Why this runbook exists

The recovered sync service is now stable and faster per tick:

- `SYNC_BATCH_SIZE_V2=20`
- `SYNC_WORKER_COUNT_V2=2`
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`
- `SYNC_METRICS_V2_ENABLED=1`
- UZ budget automation is enabled and clean.

However, the `sync-metrics` cron still runs every `45 min`. That means rule evaluation can lag by tens of minutes even when the workers are healthy. For budget-sensitive rules, a `10-20 min` delay can be critical because spend continues while an ad waits for the next evaluation.

The objective of this runbook is to reduce rule-evaluation latency by changing the V2 sync cron cadence from `45 min` to `15 min`, while keeping the rest of the recovered production profile unchanged.

This is a code/deploy change, not an env-only change.

This runbook changes **sync only**. The UZ budget increase cron remains at `45 min`:

```ts
crons.interval(
  "uz-budget-increase",
  { minutes: 45 },
  internal.ruleEngine.uzBudgetDispatchV2,
);
```

Do not reduce UZ cadence in the same change. UZ is side-effecting: it writes to VK Ads and sends user notifications. Any future `uz-budget-increase` cadence change needs a separate runbook, separate business go, and separate canary.

## Current production profile

Expected before this runbook:

- `SYNC_METRICS_V2_ENABLED=1`
- `SYNC_WORKER_COUNT_V2=2`
- `SYNC_BATCH_SIZE_V2=20`
- `SYNC_METRICS_V2_POLL_MODERATION=0`
- `SYNC_ESCALATION_ALERTS_ENABLED=0`
- `UZ_BUDGET_V2_ENABLED=1`
- `DISABLE_ERROR_ALERT_FANOUT=1`
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`
- `recordRateLimit` remains disabled/no-op.
- `adminAlerts.notify` remains no-op/gated.

Current code:

```ts
crons.interval(
  "sync-metrics",
  { minutes: 45 },
  internal.syncMetrics.syncDispatchV2,
);
```

Target code:

```ts
crons.interval(
  "sync-metrics",
  { minutes: 15 },
  internal.syncMetrics.syncDispatchV2,
);
```

Do not restore V1 sync. Do not add a second cron. Keep the same cron name and the same V2 entrypoint.

## Decision: 15 min, not 30 min or 5 min

Candidate options:

- `45 -> 30 min`: safest small cadence step, but may still miss the `10-20 min` business requirement.
- `45 -> 15 min`: target step for this runbook; it reduces worst-case wait materially while staying far from the old `5 min` pressure profile.
- `45 -> 5 min`: not part of this runbook. The old 5-minute cadence resembles the pre-incident pressure profile and needs a separate design after sustained clean observation at 15 minutes.

Recommendation: use `15 min` if preflight is clean. If preflight shows any unresolved rollback signal, do not change cadence; stay at `45 min` and investigate first. Do not silently downgrade to `30 min` during execution. A `30 min` choice should be a separate operator decision and doc update.

## What this runbook does not do

- Does not change `SYNC_BATCH_SIZE_V2`.
- Does not change `SYNC_WORKER_COUNT_V2`.
- Does not change `APPLICATION_MAX_CONCURRENT_V8_ACTIONS`.
- Does not enable moderation polling.
- Does not enable sync escalation alerts.
- Does not change `uz-budget-increase` cadence; UZ remains `45 min`.
- Does not restore `adminAlerts.notify`.
- Does not restore `recordRateLimit`.
- Does not run manual sync.
- Does not run smoke `syncDispatchV2`.
- Does not run `npx convex codegen`.
- Does not combine with D1/D2 implementation.

## Risk model

Changing cadence increases the number of sync dispatches per hour:

```text
45 min cadence: ~1.33 sync ticks/hour
15 min cadence:  4.00 sync ticks/hour
Multiplier:     ~3x more sync dispatches/hour
```

Per-tick shape stays unchanged:

```text
batch_size=20
worker_count=2
chunk_size=ceil(20 / 2)=10
```

Worst-case overlap at `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16` remains:

```text
Token refresh worst-case: 6 V8 action slots
UZ worst-case:            6 V8 action slots
Sync current profile:     2 V8 action slots
Total:                   14 / 16 V8 action slots
Headroom:                 2 V8 action slots
```

The difference is frequency, not per-tick slot count. A 15-minute cadence makes overlap with UZ/token refresh more likely and gives less idle time between sync runs.

Primary risks:

1. **More frequent WAL/write pressure.** Per-tick WAL may stay small, but hourly WAL can rise about 3x.
2. **More overlap windows.** Token refresh, UZ, and sync share the same action pool; 15-minute sync increases the chance that a heavy sync is in flight when another cron runs.
3. **Worker carryover risk.** `syncBatchWorkerV2` has a worker-total timeout of `570_000 ms` (`9.5 min`). With a 15-minute cadence, a slow worker can finish close to the next dispatcher tick.
4. **Heartbeat guard nuance.** The dispatcher heartbeat prevents stale/running dispatcher overlap, but it does not directly prevent worker overlap if workers are still running after the dispatcher returns.
5. **Top-100 rotation behavior.** `listSyncableAccounts` selects from a top-100 oldest `lastSyncAt` window. Closure should monitor updated accounts and stale-count deltas, not assume linear `212 / 20` coverage math.

## Preconditions

All must be true before code edits:

- Explicit human go to start this runbook.
- Batch `10 -> 20` closed clean and is documented.
- Worker count `1 -> 2` closed clean and is documented.
- No D1/D2 implementation or deploy is in progress.
- No unresolved rollback signal from the latest sync/UZ/token ticks.
- Current branch is `emergency/drain-scheduled-jobs`.
- Local working tree has no uncommitted Convex code changes in `convex/`.
- Current production env matches the profile in this runbook.
- Latest sync, UZ, and token refresh heartbeats are completed/error null.
- `/version` returns HTTP `200`.

## Pre-change read-only baseline

Capture UTC time:

```bash
date -u
```

Verify env:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_METRICS_V2_ENABLED

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_WORKER_COUNT_V2

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_BATCH_SIZE_V2

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get APPLICATION_MAX_CONCURRENT_V8_ACTIONS

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_METRICS_V2_POLL_MODERATION

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_ESCALATION_ALERTS_ENABLED

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get UZ_BUDGET_V2_ENABLED

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get DISABLE_ERROR_ALERT_FANOUT
```

Expected:

```text
SYNC_METRICS_V2_ENABLED=1
SYNC_WORKER_COUNT_V2=2
SYNC_BATCH_SIZE_V2=20
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16
SYNC_METRICS_V2_POLL_MODERATION=0
SYNC_ESCALATION_ALERTS_ENABLED=0
UZ_BUDGET_V2_ENABLED=1
DISABLE_ERROR_ALERT_FANOUT=1
```

Capture sync/failed-counter baseline:

```bash
node check-sync-tick.cjs baseline
```

Capture surrounding cron baseline:

```bash
node check-token-refresh-tick.cjs
```

Capture byte-exact WAL:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal"
```

Check `/version`:

```bash
curl --resolve convex.aipilot.by:443:178.172.235.49 \
  -sS -w '\nHTTP %{http_code} time %{time_total}s' \
  --max-time 10 \
  https://convex.aipilot.by/version
```

Expected: HTTP `200`.

## Code change

Only edit `convex/crons.ts`:

```diff
 crons.interval(
   "sync-metrics",
-  { minutes: 45 },
+  { minutes: 15 },
   internal.syncMetrics.syncDispatchV2,
 );
```

Also update nearby recovery comments so they no longer describe 45 minutes as the current deployed cadence. Keep the incident warning about 5 minutes.

Do not touch generated files.

## Local verification before commit

Run:

```bash
npx tsc --noEmit -p convex/tsconfig.json
```

Optional if time permits:

```bash
npm run typecheck
```

Expected:

- TypeScript clean, or only known unrelated failures documented before this runbook.
- `git diff -- convex/crons.ts` shows only the cadence/comment change.

Commit message:

```text
fix(sync): reduce sync metrics cadence to 15 minutes
```

Push to:

```bash
git push origin emergency/drain-scheduled-jobs
```

Pushing is not deploy by itself for this branch. Deploy remains a separate explicit go.

## Deploy plan

Deploy only after explicit deploy go:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex deploy --yes
```

Immediately verify:

```bash
curl --resolve convex.aipilot.by:443:178.172.235.49 \
  -sS -w '\nHTTP %{http_code} time %{time_total}s' \
  --max-time 10 \
  https://convex.aipilot.by/version
```

Expected: HTTP `200`.

Do not run manual sync. The first canary must be the next organic `sync-metrics` tick after deploy.

## Post-deploy canary

Because the cadence is 15 minutes, the first few ticks should arrive quickly, but the exact schedule depends on Convex cron registration timing. Watch actual `syncDispatch` heartbeats rather than predicted timestamps.

For each organic sync tick, use a window from one minute before dispatcher start through at least 12 minutes after it:

```bash
node check-sync-tick.cjs <window-start-utc> <window-end-utc>
```

Hard criteria per tick:

- `syncDispatch` heartbeat completed/error null, in window.
- `syncBatchWorkerV2` success increments by `2`; failed stays `0`.
- Backend stdout:
  - `0 Too many concurrent`
  - `0 Transient error`
  - `0 TOKEN_EXPIRED` in sync worker context
  - `0 syncBatchV2.*Account .* failed`
- `adminAlerts.js:notify` schedules in window: `0`.
- Failed counters remain flat.
- `/version` remains HTTP `200`.
- `pg_wal` per-tick delta:
  - warning if `> 75 MB`;
  - hard stop if `>= 150 MB`.
- Account-update audit shows meaningful coverage. Expected per clean tick: around `18-20` accounts updated, accepted lower bound `>=15`.

Effectiveness interpretation:

- `15-17` updated accounts with no errors is a yellow effectiveness signal, not automatic rollback.
- `<15` updated accounts on one tick without external outage is not clean; investigate before closure.
- Any worker errors or V8/transient signals are rollback triggers.

## Closure criteria

Classify `45 -> 15 min` cadence as closed clean only after:

- at least four organic sync ticks at 15-minute cadence are observed;
- those ticks include at least one UZ overlap or adjacent UZ tick that is clean;
- if a token refresh tick lands inside the observation window, it is clean:
  - heartbeat completed/error null;
  - no retry storm;
  - no V8/transient lines;
  - token refresh failed counters flat;
- `syncBatchWorkerV2` success increases by `8` across the four sync ticks;
- no failed counter growth;
- no admin alert schedules;
- no WAL hard-stop delta;
- cumulative account-update audit across four ticks is `>=60` accounts updated;
- no worker carryover signal: next dispatcher does not skip because previous dispatcher/worker pressure is still unresolved.

Expected closure time:

- `60-90 min` if the first four ticks arrive clean and no token refresh overlap needs extra observation.
- `2-3h` if token refresh overlap lands and needs explicit closure evidence.

## Rollback

Rollback trigger:

- any `Too many concurrent` or `Transient error` in sync/token/UZ overlap windows;
- any `syncBatchV2.*Account .* failed`;
- `syncBatchWorkerV2` failed counter grows;
- `adminAlerts.notify` schedules appear;
- `pg_wal` delta `>=150 MB` in one sync tick;
- two consecutive ticks update `<15` accounts without external outage;
- dispatcher skip/takeover pattern appears because cadence is too tight;
- `/version` not HTTP `200` or backend health degrades.

Rollback action is a code revert + deploy, not an env set:

1. Revert the cron cadence change in `convex/crons.ts` back to `{ minutes: 45 }`.
2. Commit:

```text
revert(sync): restore 45 minute sync cadence
```

3. Push to `origin/emergency/drain-scheduled-jobs`.
4. Deploy after explicit rollback deploy go:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex deploy --yes
```

Rollback is not closed until:

- `/version` returns HTTP `200`;
- the next organic sync tick arrives at the restored cadence;
- that tick is clean by standard Phase 6 criteria;
- failed counters and `pg_wal` are stable.

If rollback is needed, do not attempt `15 -> 30` in the same incident window. Return to `45`, close rollback clean, then write a separate `45 -> 30` runbook if needed.

## Next candidates after this runbook

If `15 min` closes clean but users still need lower latency:

1. Observe at least 24h of 15-minute cadence before considering another cadence reduction.
2. Consider `15 -> 10 min` before `15 -> 5 min`.
3. Treat `5 min` as a separate high-risk design because it resembles the pre-incident sync pressure profile.

If `15 min` is not clean:

1. Roll back to `45 min`.
2. Consider `45 -> 30 min` as a safer intermediate step.
3. Investigate whether heavy-account runtime or VK API latency is the limiting factor before increasing cadence again.
