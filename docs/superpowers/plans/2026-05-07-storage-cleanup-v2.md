# Storage Cleanup V2 — безопасное восстановление очистки после emergency drain

Дата: 2026-05-07  
Статус: исходный high-level план; актуальный execution trail живет в `memory/`
Контекст: ветка `emergency/drain-scheduled-jobs`, Convex self-hosted, большой backlog в `metricsRealtime` / `metricsDaily` / `vkApiLimits`, старые V1 scheduled handlers частично оставлены no-op.

## Status Update — 2026-05-08

Этот файл остается исходным high-level планом Storage Cleanup V2. Актуальный источник
правды по выполнению, параметрам и gate-дисциплине теперь находится в `memory/`.

Выполнено:

- Phase 4 canary closed clean: `memory/storage-cleanup-v2-canary-closure-2026-05-08.md`.
- Phase 5 controlled run `maxRuns=3` closed clean: `memory/storage-cleanup-v2-controlled-closure-2026-05-08.md`.
- Phase 5 controlled run `maxRuns=5` closed clean: `memory/storage-cleanup-v2-controlled-closure-2026-05-08-maxRuns5.md`.
- Phase 6 cron wrapper code deployed fail-closed at `a1775dd` with `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`.

Current Phase 6 source of truth:

- Runbook: `memory/storage-cleanup-v2-phase6-cron-restore-runbook-2026-05-08.md`.
- Gate A/B checklist draft: `memory/storage-cleanup-v2-phase6-gate-b-checklist-2026-05-08.md`.
- Cron closure draft: `memory/storage-cleanup-v2-cron-closure-2026-05-08.md`.

Superseded details from this original plan:

- The original suggested first Phase 6 `maxRuns=10` is superseded.
- Current first organic cron profile is `batchSize=500`, `timeBudgetMs=10000`, `restMs=90000`, `maxRuns=5`, cadence `0 */6 * * *`.
- `maxRuns=5` is the Gate B proof baseline, not the long-term backlog-drain profile.
- Ramp plan is `5 -> 8 -> 10`, only after clean organic tick evidence per the Phase 6 runbook.

## Goal

Восстановить app-level cleanup для больших Convex-таблиц так, чтобы:

- не оживить старые `_scheduled_jobs` с V1 `udfPath`;
- не вернуть write/job storm, из-за которого был emergency drain;
- сначала уменьшить live/backlog documents в Convex;
- только потом выполнять PostgreSQL maintenance (`VACUUM ANALYZE`, позже возможно `VACUUM FULL` / `pg_repack`).

Главная цель первой итерации: безопасно вернуть cleanup для `metricsRealtime`, потому что свежий storage report показывает, что она доминирует в `indexes`.

## Связанные документы

- `docs/storage-report-2026-05-07.md` - свежий снимок storage.
- `docs/2026-05-07-storage-cleanup-recovery-analysis.md` - анализ текущего recovery-состояния.
- `docs/superpowers/plans/2026-04-28-pg-bloat-cleanup.md` - старый общий план bloat cleanup.
- `docs/superpowers/plans/2026-04-16-metrics-realtime-cleanup.md` - старый план realtime cleanup до emergency drain.
- `docs/2026-05-05-convex-drain-reenable-plan.md` - правило V1 no-op + новая работа через V2 entrypoints.
- `docs/2026-05-06-restore-matrix-uz-runbook.md` - матрица восстановления cron/gates.

## Current State

### Уже сделано

- Dirty-check для `campaigns`, `ads`, `metricsDaily` реализован.
- `recordRateLimit` D2a восстановлен как direct mutation только для `429`.
- Старый scheduler-transport для `recordRateLimit` не используется.
- Активен `cleanup-old-logs`, который вызывает `logCleanup.runDaily`.
- `logCleanup.runDaily` чистит `vkApiLimits`, но только batch `2000` за запуск.

### Не сделано

- `cleanup-old-realtime-metrics` закомментирован в `convex/crons.ts`.
- `cleanup-old-metrics-daily` закомментирован в `convex/crons.ts`.
- `manualMassCleanup` в `convex/metrics.ts` сейчас no-op.
- `manualMassCleanupV2` не существует.
- `cleanupOldRealtimeMetrics` сейчас делегирует в `scheduleMassCleanup`, а тот ставит старый no-op `manualMassCleanup`.

Вывод: просто раскомментировать `cleanup-old-realtime-metrics` недостаточно. В текущем коде cron дойдёт до no-op и не удалит `metricsRealtime`.

## Non-goals

- Не восстанавливать старый `manualMassCleanup` body.
- Не делать прямой SQL delete из `documents`, `indexes`, `_scheduled_jobs`.
- Не запускать `VACUUM FULL` в рамках первой итерации.
- Не включать все cleanup crons одним deploy.
- Не менять sync cadence, UZ cadence, token refresh, `adminAlerts.notify`, `vk-throttling-probe`.
- Не расширять `recordRateLimit` за пределы текущего 429-only поведения.

## Key Safety Principle

Старый `metrics.manualMassCleanup` должен остаться no-op, пока historical backlog по `metrics.js:manualMassCleanup` не доказанно drained. Новая очистка должна идти через новый function name, например:

```text
internal.metrics.manualMassCleanupV2
```

Так новые jobs не совпадут с историческим V1 `udfPath`.

## V2 Conventions

These conventions apply to all cleanup V2 work. Phase 1 implements only
`metricsRealtime`; later `metricsDaily` and `vkApiLimits` phases reuse the same
conventions but must capture their own numeric calibration immediately before
that phase.

### Chunking model

Use bounded scheduled invocations, not long sleeps inside a single action.

```ts
// One invocation:
// 1. claim/update persistent run state
// 2. delete up to batchSize eligible rows
// 3. record observability fields
// 4. if runNumber < maxRuns and hasMore, schedule the next invocation after restMs
// 5. return; do not hold a V8 slot during restMs
```

This model holds at most one cleanup V8 action slot at a time. With the current
post-cadence profile, worst-case overlap becomes:

```text
token refresh 6 + UZ 6 + sync 2 + cleanup 1 = 15/16 V8 action slots
```

That leaves 1 slot of headroom. Any implementation that can schedule more than
one cleanup worker concurrently is outside this plan.

### Entrypoints and run state

- `triggerMassCleanupV2` must be an `internalMutation`, not a public `mutation`.
  It is for operator/admin `npx convex run` use only, never frontend use.
  Existing `triggerMassCleanup` is currently a public `mutation` (`convex/metrics.ts:403`);
  V2 entrypoint MUST NOT inherit that visibility. See Phase 4 for the operator
  command that invokes an `internalMutation` from CLI with admin key.
- Run tracking must be persistent, not in-memory. Choice between extending
  `cronHeartbeats` and adding a dedicated `cleanupRunState` table is deferred
  to Phase 1 code design (`cronHeartbeats` is semantically a cron-tick status
  row; cleanup run chain is closer to a job-state singleton). The persistence
  requirement itself is non-negotiable.
- Persistent run state minimum schema:

  ```text
  cleanupName:    string                                           // e.g. "metrics-realtime-v2"
  runId:          string                                           // ULID or epoch-ms-based, unique per claim
  state:          "claimed" | "running" | "completed" | "failed"
  startedAt:      number
  lastBatchAt:    number | null
  runNumber:      number
  maxRuns:        number
  ```

  New claim MUST refuse if a non-terminal row (`claimed` / `running`) exists
  for the same `cleanupName`. This is the structural guard that prevents a
  canary `maxRuns=1` from silently becoming multiple runs on retry.
- `runNumber` / `maxRuns` in args are not sufficient by themselves; they are
  inputs, the persistent state row is the source of truth.
- Cron path must also pass an explicit `maxRuns`; canary and cron use different
  bounds.

### Kill switch env gate (per-table, not global)

Each cleanup V2 entrypoint reads a per-table env flag at the top of every
invocation and exits no-op if it is not set to `1`. Phase 1 introduces:

```text
METRICS_REALTIME_CLEANUP_V2_ENABLED=0     // default, deploy-safe
```

Operator sets it to `1` only immediately before canary, and back to `0` after
the controlled-runs window if cleanup must be paused without redeploy. Same
pattern as existing `SYNC_METRICS_V2_ENABLED`. Phase 7 and Phase 8 introduce
their own narrow flags (`METRICS_DAILY_CLEANUP_V2_ENABLED`,
`VK_API_LIMITS_CLEANUP_V2_ENABLED`) — never reuse one global flag, and never
combine cleanup-v2 enable with sync/UZ/token gates.

### Observability fields

Every run must log or persist at least, with the listed measurement points:

```text
{
  cutoffUsed,                 // start, set at run start, immutable for the run
  deletedCount,               // post, summed across batches in the run
  batchesRun,                 // post, count of committed batches
  durationMs,                 // post, wall-clock from claim to release
  oldestRemainingTimestamp,   // post, sampled AFTER the last batch commit
  errorOrNull                 // post, null on clean release
}
```

`oldestRemainingTimestamp` is the leading indicator for whether cleanup is
catching up. It MUST be sampled after the delete batch commits, otherwise it
reports stale state and lies about progress. Total table count is useful but
lags behind the cleanup run itself and is a trailing indicator only.

### Safety invariants

- Cleanup predicates must use a cutoff well behind active writes. For
  `metricsRealtime`, retention is 2 days, so `cutoff < now - 1h` is always true.
  That makes races with current sync writes structurally impossible.
- Canary and controlled runs should be triggered immediately after an observed
  `syncBatchWorkerV2` `kind: "success"` row. With 15-min sync cadence, this gives
  roughly 13 minutes before the next sync tick.
- WAL thresholds must be set from a read-only pre-canary estimate, not copied
  from read-heavy sync canaries. Estimate:
  `eligible_rows * avg_row_size * WAL_amplification(2-3x)`.
- Each closure point must write a memory file:
  - `memory/storage-cleanup-v2-canary-closure-<date>.md`
  - `memory/storage-cleanup-v2-controlled-closure-<date>.md`
  - `memory/storage-cleanup-v2-cron-closure-<date>.md`
- Phase 6 cron rollback is a code rollback: revert the cron-enable commit, push,
  and deploy after explicit operator go.
- One commit equals one table. Phase 1 implementation scope is `metricsRealtime`
  only. `metricsDaily` and `vkApiLimits` reuse the conventions later, but must
  not be implemented or tuned in the Phase 1 commit.

## Phase 0: Read-only Preflight

Перед любым code/deploy:

- [ ] Проверить `/version` backend.
- [ ] Снять `df -h /`.
- [ ] Снять `pg_wal` byte size.
- [ ] Проверить PostgreSQL activity.
- [ ] Проверить `pg_stat_user_tables` для `documents` и `indexes`.
- [ ] Проверить active VACUUM.
- [ ] Проверить latest-state `_scheduled_jobs` / `_scheduled_functions` для:
  - `metrics.js:manualMassCleanup`
  - `metrics.js:manualMassCleanupV2` если уже существует
  - `metrics.js:cleanupOldRealtimeMetrics`
- [ ] Снять current counts:
  - `metricsRealtime`
  - `metricsDaily`
  - `vkApiLimits`
- [ ] Снять `metricsRealtime` eligible cleanup anchor:
  - `cutoff = Date.now() - 172_800_000`
  - `count(metricsRealtime WHERE timestamp < cutoff)`
  - `min(timestamp)` / `oldestRemainingTimestamp`
- [ ] Проверить последние sync / UZ / token refresh heartbeats.
- [ ] Посчитать read-only pre-canary WAL estimate для `metricsRealtime`:
  - формула: `eligible_rows * avg_row_size * WAL_amplification(2-3x)`
  - финальные warning/hard-stop thresholds для first canary фиксируются из этой оценки перед go.
  - Worked example (illustrative — operator MUST recompute with real numbers
    sampled in Phase 0 and recaptured in Phase 4):
    `500 rows × ~200 B/row × 3 = ~300 KB` → suggested `warn ≥ 5 MB`,
    `hard-stop ≥ 50 MB` for one canary tick. Order of magnitude is the point;
    absolute numbers come from real measurements, not from this example.

Read-only SQL:

```sql
SELECT relname,
       pg_size_pretty(pg_total_relation_size(relid)) AS total,
       pg_size_pretty(pg_relation_size(relid)) AS heap,
       pg_size_pretty(pg_indexes_size(relid)) AS indexes,
       n_live_tup,
       n_dead_tup,
       last_autovacuum,
       last_autoanalyze
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

SELECT * FROM pg_stat_progress_vacuum;

SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age,
       now() - query_start AS query_age,
       left(query, 160) AS query
FROM pg_stat_activity
WHERE datname = 'adpilot_prod'
  AND pid <> pg_backend_pid()
ORDER BY query_start NULLS LAST;
```

Read-only Convex-side anchors:

```text
metricsRealtime cutoff: Date.now() - 172_800_000
eligible_count: count(timestamp < cutoff)
oldest_remaining_timestamp: min(timestamp where timestamp < cutoff)
avg_row_size_estimate: capture from storage report / PG sample before canary
```

Hard stop before implementation:

- `Too many concurrent` появляется в backend stdout.
- Есть свежие failed jobs после D2a/cadence baseline.
- `pg_wal` уже растёт runaway.
- Последние sync/UZ/token refresh heartbeats не `completed` или имеют `error`.

## Phase 1: Code Plan for `metricsRealtime` Cleanup V2

Phase 1 implementation scope is `metricsRealtime` only. `metricsDaily` and
`vkApiLimits` reuse the conventions later, but must not be implemented or tuned
in the Phase 1 commit.

### Files

- Modify: `convex/metrics.ts`
- Modify later: `convex/crons.ts` only after manual V2 canary closes clean.
- Tests: `convex/metrics.test.ts` or a small focused test file if feasible.

### Required changes

- [ ] Оставить `manualMassCleanup` V1 no-op.
- [ ] Добавить `manualMassCleanupV2`.
- [ ] Добавить `scheduleMassCleanupV2`.
- [ ] Добавить `triggerMassCleanupV2` as `internalMutation` for manual canary.
- [ ] Переключить `cleanupOldRealtimeMetrics` на `scheduleMassCleanupV2`.
- [ ] Добавить conservative args/limits:
  - `batchSize`
  - `timeBudgetMs`
  - `restMs`
  - `runNumber`
  - `maxRuns`
- [ ] Использовать persistent run tracking: heartbeat row or dedicated cleanup run state table.
- [ ] Добавить heartbeat/status logging with V2-specific name, например `cleanup-realtime-metrics-v2`.
- [ ] Логировать required observability fields from `V2 Conventions`.
- [ ] Не использовать `ctx.scheduler.runAfter(0)` бесконечно без bounds.
- [ ] Не использовать `systemLogger.log({ level: "error" })` в catch path до D1 alert redesign.

### `metricsRealtime` constants

```text
retentionMs: 172_800_000 (2 days)
cutoff: Date.now() - retentionMs
concurrency invariant: cutoff < now - 1h
```

### Suggested conservative defaults

Для первого canary:

```text
batchSize: 500
timeBudgetMs: 10_000
restMs: 60_000
maxRuns: 1
```

First canary uses one scheduled invocation and one delete chunk unless the
implementation records a smaller safe batch during Phase 0. It must not schedule
more than `maxRuns=1`.

Для controlled cleanup после clean canary:

```text
batchSize: 1000-3000
timeBudgetMs: 15_000-25_000
restMs: 60_000
maxRuns: bounded, not infinite by default
```

Не начинать с aggressive старых значений, пока не будет свежего наблюдения по WAL/V8 slots.

## Phase 2: Local Verification

- [ ] `npx tsc --noEmit -p convex/tsconfig.json`
- [ ] Focused tests for:
  - V1 `manualMassCleanup` remains no-op.
  - V2 schedules V2, not V1.
  - `cleanupOldRealtimeMetrics` references only `manualMassCleanupV2`, not `manualMassCleanup`.
  - `deleteRealtimeBatch` keeps retention cutoff.
  - `cleanupOldRealtimeMetrics` delegates to V2.
- [ ] Grep guard (broad inventory):

```bash
rg "manualMassCleanup|manualMassCleanupV2|scheduleMassCleanup|scheduleMassCleanupV2|cleanupOldRealtimeMetrics" convex/metrics.ts convex/crons.ts
```

Expected:

- old `manualMassCleanup` still exists and no-ops;
- all new cleanup scheduling points use V2;
- no new cron enabled yet.

- [ ] Grep guard (zero-hits assertion on V1 udfPath in any scheduling position):

```bash
rg "internal\.metrics\.manualMassCleanup\b" convex/
```

Expected: hits ONLY the V1 declaration line in `convex/metrics.ts`. Any other
hit (in particular inside a `ctx.scheduler.runAfter(...)`, a cron registration,
or a V2 helper) is a fail-the-build bug — V2 code MUST NOT schedule the V1
udfPath, otherwise jobs will collide with the historical
`metrics.js:manualMassCleanup` failed-counter and re-poison the drain.

## Phase 3: Deploy V2 Code with Cron Still Disabled

Deploy only after explicit go.

Deploy scope:

- add V2 cleanup functions;
- keep `cleanup-old-realtime-metrics` cron commented;
- no behavior unless manual trigger is run.

Post-deploy smoke:

- [ ] `/version` HTTP 200.
- [ ] no new failed `_scheduled_jobs`.
- [ ] no `manualMassCleanupV2` jobs unless manually triggered.
- [ ] no `manualMassCleanup` V1 backlog growth.

## Phase 4: Manual V2 Canary

Run one bounded manual V2 cleanup after explicit go.

### Pre-trigger sequence (explicit, no skipping)

- [ ] Set narrow env flag for this canary only:
  - `METRICS_REALTIME_CLEANUP_V2_ENABLED=1`
  - confirm other cleanup-V2 flags (Phase 7/8) remain `0`.
- [ ] Recapture anchors immediately before trigger (Phase 0 baseline may have
      drifted between Phase 0 read and Phase 4 trigger; do not rely on it):
  - `metricsRealtime` total count
  - `metricsRealtime WHERE timestamp < cutoff` count (eligible)
  - `oldestRemainingTimestamp = min(timestamp WHERE timestamp < cutoff)`
  - `pg_wal` byte size (anchor for delta)
  - finalized warning / hard-stop thresholds derived from recaptured numbers
    (worked example in Phase 0 — recompute, do not copy)
  - latest `syncBatchWorkerV2` / `uzBudgetBatchWorkerV2` / `tokenRefreshOneV2`
    rows must be `kind: "success"` (any new failed → abort canary)
  - backend stdout window since last deploy must contain 0 rollback patterns
- [ ] Wait for an organic `syncBatchWorkerV2 kind: "success"` row to land,
      then trigger within the next ~13 minutes (before the next 15-min sync
      tick). Do not trigger blind off the wall clock — the success row is the
      gate, not the schedule.

### Operator trigger command

`triggerMassCleanupV2` is `internalMutation` — frontend / Convex Dashboard
run-form cannot invoke it. Use Convex CLI with a freshly-generated admin key
(per `memory/convex-deploy.md`, AES-128-GCM-SIV from `CONVEX_INSTANCE_NAME` +
`CONVEX_INSTANCE_SECRET`, ephemeral):

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex run internal.metrics.triggerMassCleanupV2 \
  '{"batchSize": 500, "timeBudgetMs": 10000, "restMs": 60000, "maxRuns": 1}'
```

Admin key is ephemeral — generate per-canary, do not commit, do not paste into
shared logs.

### Canary observation checklist

- [ ] Use small batch and `maxRuns=1` (matches Phase 1 conservative defaults).
- [ ] Observe backend stdout for:
  - `Too many concurrent`
  - `Transient error`
  - `TOKEN_EXPIRED`
  - rollback-pattern errors
- [ ] Check `pg_wal` before/after — must stay under warn threshold from
      recapture, hard-stop on breach.
- [ ] Check `_scheduled_jobs`:
  - `manualMassCleanupV2` success expected;
  - no `manualMassCleanup` V1 growth (failed-counter must not advance).
- [ ] Verify `metricsRealtime` eligible count decreases AND `deletedCount > 0`.
- [ ] Verify observability fields populated with correct measurement points
      (start vs post — see V2 Conventions / Observability fields):
  - `cutoffUsed` (start)
  - `deletedCount` (post)
  - `batchesRun` (post)
  - `durationMs` (post)
  - `oldestRemainingTimestamp` (post — sampled after last commit, advances vs recapture)
  - `errorOrNull` (null on clean release)
- [ ] Verify persistent run-state row reached `state: "completed"`,
      not stuck at `claimed` / `running`.
- [ ] Verify backend remains healthy (`/version` HTTP 200, sync/UZ/token
      heartbeats clean).
- [ ] Set `METRICS_REALTIME_CLEANUP_V2_ENABLED=0` after canary closes — kill
      switch returns to deploy-safe state until controlled runs are approved.
- [ ] Write `memory/storage-cleanup-v2-canary-closure-<date>.md` if clean.

### Hard stop

- Any V8 concurrency errors.
- `pg_wal` delta beyond warning threshold from recapture.
- New failed V2 cleanup jobs.
- Cleanup self-schedules more than intended (run-state row in non-terminal
  state past expected window, or `runNumber` advances beyond `maxRuns`).
- Sync/UZ/token refresh failures appear in the same window.

**Priority of rollback signals:** any sync/UZ/token regression overrides
cleanup progress; pause cleanup (set `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`)
until core crons are clean again. Cleanup-only signals (own `pg_wal` delta,
own self-schedule overshoot) are second priority — investigate, but do not let
them mask a concurrent core-cron regression.

## Phase 5: Controlled Cleanup Runs

After one clean canary:

- [ ] Increase `maxRuns` carefully.
- [ ] Keep batch/time bounded.
- [ ] Run in a window away from token refresh and heavy sync/UZ overlaps.
- [ ] Record deleted count per run.
- [ ] Record `metricsRealtime` count trend.
- [ ] Record `oldestRemainingTimestamp` trend.
- [ ] Record `pg_wal` trend.
- [ ] Write `memory/storage-cleanup-v2-controlled-closure-<date>.md` after controlled runs close clean.

Do not enable cron yet if manual controlled runs are not clean.

## Phase 6: Restore `cleanup-old-realtime-metrics` Cron

Only after manual V2 cleanup has passed:

- [ ] Change `convex/crons.ts` to enable `cleanup-old-realtime-metrics`.
- [ ] Keep cadence conservative.
- [ ] Cron path must pass explicit `maxRuns` (suggested first value: `10`).
- [ ] First cron tick must be organic, not manual.
- [ ] Observe one full tick window.
- [ ] Confirm:
  - backend healthy;
  - V2 cleanup job success;
  - no V1 cleanup job growth;
  - `pg_wal` controlled;
  - metrics count decreasing;
  - no sync/UZ/token regressions.

Suggested first cadence:

```text
every 6 hours
```

Do not move to hourly until at least several clean cron ticks and storage pressure justifies it.

Rollback after cron enable:

```text
revert cron-enable commit -> push -> deploy after explicit operator go
```

If clean, write `memory/storage-cleanup-v2-cron-closure-<date>.md`.

## Phase 7: Restore `metricsDaily` Cleanup

Separate commit/deploy after realtime cleanup is stable.

Uses the same V2 conventions defined above. Numeric calibration (cutoff, count
anchor, WAL estimate, batch sizes) must be captured immediately before this
phase, not now.

### Naming convention

Future phases should prefer `cleanupOldMetricsDailyV2` (and a corresponding
narrow env gate `METRICS_DAILY_CLEANUP_V2_ENABLED=0` default) unless a
phase-specific audit proves the existing UDF path has no backlog or collision
risk in `_scheduled_jobs`. The Key Safety Principle that governed
`metrics.manualMassCleanup` -> `manualMassCleanupV2` applies whenever batch
size, self-scheduling, or chunking changes.

Current function:

```text
internal.logCleanup.cleanupOldMetricsDaily
```

Current behavior:

```text
delete metricsDaily older than 90 days, batch 500
```

Plan:

- [ ] Audit `_scheduled_jobs` for `logCleanup.js:cleanupOldMetricsDaily` failed
      backlog. If non-empty → fork to V2 name. If clean → V1 name MAY be reused
      with explicit justification recorded in the phase closure memo.
- [ ] Read-only count rows older than retention.
- [ ] Decide if batch 500 is enough.
- [ ] Enable `cleanup-old-metrics-daily` separately.
- [ ] Observe first organic tick.
- [ ] Do not bundle with realtime cleanup cron restore.

## Phase 8: `vkApiLimits` Cleanup Follow-up

D2a restored bounded writes for real `429` only, but retention cleanup still needs attention.

Uses the same V2 conventions defined above. Numeric calibration (cutoff, count
anchor, WAL estimate, batch sizes) must be captured immediately before this
phase, not now.

### Naming convention

Future phases should prefer `cleanupOldVkApiLimitsV2` (and a corresponding
narrow env gate `VK_API_LIMITS_CLEANUP_V2_ENABLED=0` default) unless a
phase-specific audit proves the existing UDF path has no backlog or collision
risk in `_scheduled_jobs`. Same principle as Phase 7.

Current behavior:

```text
cleanupOldVkApiLimits: delete 2000 rows older than 7 days
called from cleanup-old-logs daily
```

Open question:

- Is 2000/day enough for current backlog and future 429-only write rate?

Current math:

```text
current backlog: ~925,000 rows
current cleanup: 2,000 rows/day
drain time at current batch: ~463 days
D2a observed write rate: 10 rows / 3h canary ~= 80 rows/day
```

Conclusion: current batch is not enough to drain historical backlog on an
operationally useful timeline. Phase 8 should plan either a larger bounded batch
or controlled manual cleanup, while keeping D2a's 429-only predicate unchanged.

Plan:

- [ ] Count `vkApiLimits` older than 7 days.
- [ ] Count post-D2a daily write rate.
- [ ] If backlog is large, either:
  - increase batch cautiously, or
  - add separate bounded self-scheduling cleanup, or
  - run controlled manual cleanup.
- [ ] Keep `vk-throttling-probe` disabled unless separate D2b/D2c runbook approves it.

## Phase 9: PostgreSQL Maintenance

### Step 9.1: VACUUM ANALYZE

After app-level cleanup is running or after a meaningful manual cleanup batch:

```sql
VACUUM (ANALYZE, VERBOSE) documents;
VACUUM (ANALYZE, VERBOSE) indexes;
```

Expected effect:

- marks dead tuples reusable;
- refreshes stats;
- does not shrink files on disk significantly;
- should not require downtime like `VACUUM FULL`.

Recommended before running:

- [ ] Check no active long transactions.
- [ ] Check `pg_stat_progress_vacuum` empty.
- [ ] Capture pre-VACUUM `n_dead_tup` / `n_live_tup` for `documents` and `indexes`.
- [ ] Check disk free space.
- [ ] Run in a low-traffic window.
- [ ] Monitor backend and WAL.
- [ ] Capture post-VACUUM `n_dead_tup` / `n_live_tup` for `documents` and `indexes`.
- [ ] Record before/after values in a closure memo; "VACUUM ran" is not sufficient evidence.

### Step 9.2: Physical shrink later

Only after Convex live backlog is reduced:

- `VACUUM FULL documents`
- `VACUUM FULL indexes`
- or `pg_repack` if installed/planned

Current finding:

- `pg_repack` extension is not installed.
- `VACUUM FULL` requires maintenance window and blocks tables.

Do not run `VACUUM FULL` as part of this first cleanup restore.

## Rollback

For V2 cleanup code:

- disable new cron if enabled;
- stop scheduling new V2 runs;
- leave old V1 `manualMassCleanup` no-op;
- revert V2 cleanup commit only after confirming no V2 jobs are pending/inProgress.

For manual canary:

- do not schedule further runs;
- inspect failed/success V2 jobs;
- keep old no-op V1 handler unchanged.

For `VACUUM ANALYZE`:

- if running too long or causing pressure, cancel the backend PID from Postgres after explicit operator go.
- Do not use `kill -9`.

## Acceptance Criteria

Storage cleanup V2 can be considered ready for normal cron operation when ALL
of the following hold.

Runtime:

- `manualMassCleanupV2` canary succeeds.
- No V1 `manualMassCleanup` jobs are created or executed by new code.
- `metricsRealtime` count decreases AND `oldestRemainingTimestamp` advances.
- `_scheduled_jobs` pending/inProgress remains controlled.
- No V8 concurrency errors.
- No sync/UZ/token refresh regressions in the observation window.
- `pg_wal` delta stays under agreed thresholds.
- Backend `/version` stays HTTP 200.

Paper trail (closure memos must exist and be clean):

- `memory/storage-cleanup-v2-canary-closure-<date>.md`
- `memory/storage-cleanup-v2-controlled-closure-<date>.md`
- `memory/storage-cleanup-v2-cron-closure-<date>.md`

A runtime-clean state without the corresponding closure memo is NOT acceptance —
the memo IS the operational record per `feedback_no_pr` workflow.

## Final Recommended Order

1. Add V2 realtime cleanup code, cron still disabled.
2. Deploy after go.
3. Manual V2 canary.
4. Controlled V2 cleanup runs.
5. Enable realtime cleanup cron.
6. Restore metricsDaily cleanup in separate deploy.
7. Tune vkApiLimits cleanup in separate deploy.
8. Run `VACUUM (ANALYZE)` for `documents` and `indexes`.
9. Decide on `VACUUM FULL` / `pg_repack` only after app-level cleanup has reduced live backlog.
