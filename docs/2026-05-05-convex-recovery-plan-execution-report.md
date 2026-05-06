# Отчет по выполнению плана восстановления Convex

Дата: 5 мая 2026  
Сервис: AdPilot / `aipilot.by`  
Ветка: `emergency/drain-scheduled-jobs`  
Текущий live commit на момент отчета: `9f62cfa`

Этот документ фиксирует не сам инцидент и не полный план восстановления, а фактический статус выполнения плана: что уже сделано, что проверено, какие решения приняты и какой следующий gate.

Связанные документы:

- `docs/2026-05-05-convex-scheduled-jobs-incident-report.md` - полный отчет по сбою.
- `docs/2026-05-05-convex-drain-reenable-plan.md` - план безопасного восстановления фазами.
- `docs/sql/convex-scheduled-jobs-latest-state.sql` - SQL для корректной проверки latest-state `_scheduled_jobs`.

## Executive Summary

Сервис выведен из crash/drain состояния в controlled degraded mode. Backend отвечает, frontend доступен, опасные backlog handlers оставлены no-op, а новая работа возвращается через versioned V2 entrypoints.

На текущий момент Phase 1 выполнена, Phase 2 token refresh восстановлена через V2 и закрыта после двух clean тиков подряд (`13:09 UTC` и `15:09 UTC`) после настоящего env fix. Phase 5a manual UZ canary прошла clean. Phase 5b cron canary прошла clean на двух органических cron tick'ах (`18:57 UTC`, `19:42 UTC`) с interval `45 min`; gate закрыт обратно (`UZ_BUDGET_V2_ENABLED=0`). Phase 6 sync metrics V2 deployed до `9f62cfa`; Phase 6a-bis manual canary закрыта clean, sync cron еще НЕ включен. `recordRateLimit` остается заблокирован.

Главный последний вывод: `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` должен быть установлен не только в container env, но и в Convex deployment env. До этого application code внутри V8 isolate видел default `32` и рассчитывал fan-out неправильно, хотя backend infra реально лимитил до `8`.

## Статус По Фазам

| Фаза | Статус | Что сделано | Gate / ограничение |
|---|---|---|---|
| Drain-mode emergency patch | выполнено | V1 backlog handlers переведены в no-op с сохранением сигнатур | Старые V1 handlers не возвращать, пока есть риск backlog execution |
| Phase 1 safe restore | выполнено | Восстановлены безопасные cleanup crons: `cleanup-stuck-payments`, `cleanup-old-logs`, `cleanup-expired-invites` | Сервис стабилен, backend/frontend отвечают |
| Phase 2 token refresh V2 | закрыто | Добавлен `tokenRefreshOneV2`, producers/dispatcher переключены на V2, V1 `tokenRefreshOne` оставлен no-op | Два clean тика подряд после env fix: `13:09 UTC`, `15:09 UTC` |
| Error alert fan-out gate | выполнено | Добавлен `DISABLE_ERROR_ALERT_FANOUT=1`, `systemLogger` перестал schedule'ить `adminAlerts.notify` на каждый error | При восстановлении `adminAlerts.notify` снять флаг одновременно |
| Env scope fix | выполнено | `DISABLE_ERROR_ALERT_FANOUT=1` и `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` установлены через Convex deployment env | Любые function-level env vars ставить через `convex env set` |
| UZ budget restore | Phase 5b cron canary clean | `3abc818` + `ba5cf83` deployed; Phase 5a manual canary clean; `a52a2a3` deployed with `45 min` V2 cron; two organic cron ticks clean; gate closed back to `0` | Production unattended UZ remains separate ops/business decision |
| Sync metrics restore | Phase 6a-bis clean; cron not enabled | V2 entrypoints deployed; escalation alert guard deployed; manual canary clean after guard | Phase 6b cron canary требует отдельный prepare/deploy при `SYNC_METRICS_V2_ENABLED=0` |
| `recordRateLimit` restore | запрещено в emergency | Producers остаются disabled / handler no-op | Нужен отдельный bounded redesign |

## Фактическая Хронология Выполнения

| Commit / действие | Результат |
|---|---|
| `f452348` | Drain-mode patch: тяжелые backlog handlers стали no-op, тяжелые crons отключены. |
| `7aa2170` | Phase 1 deployed: безопасные cleanup crons восстановлены. |
| `02bcfbb` | Phase 2 V2 token refresh: новая функция `tokenRefreshOneV2`, V1 оставлен no-op. |
| `4373678` | Добавлен первый stagger fan-out для token refresh. Тик показал, что формула слишком агрессивная. |
| `c34bbc3` | Учтены nested action slots частично (`slotsPerWorker=2`). Тик снова не clean. |
| `31cf100` | Уточнено `slotsPerWorker=3`, `FANOUT_STAGGER_MS=7000`. Ошибок стало меньше, но найдена alert amplification loop. |
| `9aa3a68` | Добавлен env-gated guard `DISABLE_ERROR_ALERT_FANOUT` в `systemLogger.ts`. |
| `convex env set DISABLE_ERROR_ALERT_FANOUT 1` | Подтверждено: error logs больше не создают `adminAlerts.notify` schedules. |
| `convex env set APPLICATION_MAX_CONCURRENT_V8_ACTIONS 8` | Исправлен disconnect между backend infra limit `8` и application code default `32`. |
| `f2c9042` | Добавлен `auth.diagFanoutConfig` для проверки, что V8 isolate видит env и считает fan-out правильно. |
| `e478dcb` | Prepare sync V2: `syncDispatchV2`, `dispatchSyncBatchesV2`, `syncBatchWorkerV2`, `SYNC_METRICS_V2_ENABLED`, `SYNC_METRICS_V2_POLL_MODERATION`, `check-sync-tick.cjs`. Deployed as part of Phase 6a. |
| `ed5d5bf` | Prepare follow-up: runtime env reads for sync worker/batch sizing and explicit V1 cron warning. Deployed as part of Phase 6a. |
| `a510695` | Prepare follow-up: `check-sync-tick.cjs` now counts per-account `syncBatchV2` failures and the ready-to-uncomment V1 5-min sync cron block was removed. Deployed as part of Phase 6a. |
| `3f92025` | Docs update: record Phase 6 prepare guardrails. Deployed code-wise together with sync V2 prepare. |
| `9f62cfa` | Sync escalation alert guard; deployed live with gates closed. |

## Текущий Production State

На момент последнего обновления:

- branch `emergency/drain-scheduled-jobs` запушена;
- Convex deploy live на `https://convex.aipilot.by`;
- frontend `aipilot.by` отвечал `HTTP 200`;
- Convex `/version` отвечал `HTTP 200`;
- backend `adpilot-convex-backend` healthy;
- Postgres не перезапускался во время последних code/env фиксов;
- compose-файл возвращен к pre-fix состоянию;
- единственный источник истины для `DISABLE_ERROR_ALERT_FANOUT` - Convex deployment env;
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` есть в Convex deployment env.

Диагностическая проверка `auth.diagFanoutConfig` после `f2c9042`:

```json
{
  "env_max_concurrent": "8",
  "env_disable_alert_fanout": "1",
  "computed_concurrency": 8,
  "computed_immediate_slots_for_3": 1,
  "fanout_stagger_ms": 7000,
  "sample_delays_at_3": [0, 7000, 14000, 21000, 28000, 35000]
}
```

Это подтверждает, что следующий token refresh тик должен шедулить примерно `1` worker каждые `7s`, а не пачки по `5`.

## Последний Проверенный Gate

Тик `11:09 UTC` был диагностическим, но не clean:

- `DISABLE_ERROR_ALERT_FANOUT` уже работал: `adminAlerts.notify` schedules в окне тика = `0`;
- но application code еще считал concurrency как `32`, потому что `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` не был установлен в Convex deployment env;
- после этого `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` установлен через `convex env set`;
- `diagFanoutConfig` подтвердил, что V8 isolate теперь видит правильные значения.

Следовательно, тик `13:09:36 UTC` / `16:09:36 MSK` был первым валидным clean-кандидатом после настоящего env fix.

## Тик 13:09 UTC: CLEAN

Тик `proactive-token-refresh` в `13:09 UTC` прошел clean. Это первый clean тик после env fix; Phase 2 пока не закрыта, потому что нужен второй подтверждающий clean тик.

Проверенные критерии:

1. `cronHeartbeats[name=tokenRefreshDispatch]`: started `2026-05-05T13:09:36.646Z`, completed `2026-05-05T13:09:37.338Z`, `error=null`.
2. Backend stdout за окно `13:09-13:22 UTC`: `0` строк `Too many concurrent`, `0` строк `Transient error`.
3. `systemLogs`: `0` error-level записей за последние 2 часа на момент проверки.
4. `_scheduled_jobs` latest-state: `0` `adminAlerts.js:notify` schedules в окне `13:09-13:22 UTC`.
5. `_scheduled_jobs` latest-state: `67` новых `auth.js:tokenRefreshOneV2` jobs в окне, все `success`; общий счетчик `auth.js:tokenRefreshOneV2` остался `failed=14`, `success=480`.
6. `/version`: `HTTP 200`.

Нюанс по проверке распределения: `_creationTime` у всех `67` jobs одинаковый, потому что их создал один dispatcher. Реальный delayed schedule хранится в `originalScheduledTs` в Convex integer encoding, поэтому простой SQL по `_creationTime` не доказывает stagger distribution. Для clean-решения использованы более сильные сигналы: `0` backend stdout errors, `0` systemLogs, `0` alert schedules и `67/67 success`.

## Тик 15:09 UTC: CLEAN, Phase 2 Closed

Тик `proactive-token-refresh` в `15:09 UTC` прошел clean. Это второй clean тик подряд после env fix, поэтому Phase 2 token refresh считается закрытой.

Проверенные критерии:

1. `cronHeartbeats[name=tokenRefreshDispatch]`: started `2026-05-05T15:09:36.639Z`, completed `2026-05-05T15:09:37.059Z`, `status=completed`, `error=null`.
2. Backend stdout за окно `15:09-15:22 UTC`: `0` строк `Too many concurrent`, `0` строк `Transient error`.
3. `systemLogs`: `0` error-level записей за последние 2 часа на момент проверки.
4. `_scheduled_jobs` latest-state: `0` `adminAlerts.js:notify` schedules в окне `15:09-15:22 UTC`.
5. `_scheduled_jobs` latest-state: `30` новых `auth.js:tokenRefreshOneV2` jobs в окне, все `success`; общий счетчик `auth.js:tokenRefreshOneV2`: `failed=14`, `success=510`.
6. `/version`: `HTTP 200`, около `0.09s` на момент проверки.

Failed counters без нового прироста:

- `adminAlerts.js:notify`: `failed=38`
- `syncMetrics.js:syncBatchWorker`: `failed=37`
- `ruleEngine.js:uzBudgetBatchWorker`: `failed=36`
- `auth.js:tokenRefreshOneV2`: `failed=14`
- `metrics.js:manualMassCleanup`: `failed=1`

## Следующий Шаг После Phase 2

Рекомендованный следующий шаг: Phase 5a manual UZ canary, но не в том же действии, где закрывалась Phase 2.

Текущее подготовленное состояние:

- commit `3abc818`: `prepare(uz): V2 budget dispatcher canary plumbing`;
- commit `ba5cf83`: `prepare(uz): layered kill-switch checks in V2 worker and dispatcher`;
- оба prepare-коммита pushed на `origin/emergency/drain-scheduled-jobs`;
- Convex deployment env: `UZ_BUDGET_V2_ENABLED=0` установлен явно как fail-closed перед deploy;
- deploy prepare-кода еще не выполнен на момент этой записи;
- cron UZ остается выключенным;
- expected next action для Phase 5a: deploy prepare-кода при `UZ_BUDGET_V2_ENABLED=0`, проверить `/version`, `diagFanoutConfig`, smoke `ruleEngine:uzBudgetDispatchV2` -> `{ skipped: true, reason: "v2_disabled" }`, убедиться что `0` V2 schedules и heartbeat unchanged.

Что остается запрещенным:

- не включать sync metrics до чистой UZ канарейки;
- не возвращать `recordRateLimit` в старом виде;
- не восстанавливать `adminAlerts.notify` без одновременного решения по `DISABLE_ERROR_ALERT_FANOUT`;
- не bump'ать concurrency `8 -> 16` как попутное действие перед UZ canary.

## Phase 5a Manual UZ Canary: CLEAN

Phase 5a была выполнена как один ручной запуск `ruleEngine:uzBudgetDispatchV2` при `UZ_BUDGET_V2_ENABLED=1`.

Результат:

- `uzBudgetDispatch` heartbeat: `startedAt=2026-05-05T17:24:51.690Z`, `completed`, `error=null`.
- `ruleEngine.js:uzBudgetBatchWorkerV2`: `2` workers, оба `success`.
- Backend stdout за окно ручной канарейки: `0` `Too many concurrent`, `0` `Transient error`.
- `systemLogs`: `0` errors.
- `adminAlerts.js:notify` schedules в окне: `0`, gate held.
- Failed counters не выросли:
  - `adminAlerts.js:notify failed=38`
  - `auth.js:tokenRefreshOneV2 failed=14`
  - `syncMetrics.js:syncBatchWorker failed=37`
  - `ruleEngine.js:uzBudgetBatchWorker failed=36`
- `/version`: `HTTP 200`.

Реальные side effects были ожидаемыми: VK Ads budget operations и Telegram уведомления могли выполняться согласно активным UZ rules.

После Phase 5a gate был закрыт:

```bash
npx convex env set UZ_BUDGET_V2_ENABLED 0
```

Smoke при закрытом gate подтвердил fail-closed:

```json
{ "skipped": true, "reason": "v2_disabled" }
```

## Phase 5b Cron Canary: CLEAN

Выбран безопасный cron interval `45 min`, а не `30 min`, потому что в Phase 5a один worker мог идти около `22-25 min`; `45 min` дает headroom против worker overlap при concurrency `8`.

Выполнено:

1. `a52a2a3` (`prepare(uz): enable 45m V2 cron canary registration`) создан.
2. `git push origin emergency/drain-scheduled-jobs`: `ba5cf83..a52a2a3`.
3. Deploy `a52a2a3` выполнен при `UZ_BUDGET_V2_ENABLED=0`.
4. Post-deploy fail-closed verification:
   - `/version`: `HTTP 200`;
   - smoke `ruleEngine:uzBudgetDispatchV2`: `{ "skipped": true, "reason": "v2_disabled" }`;
   - `uzBudgetDispatch` heartbeat не изменился;
   - `_scheduled_jobs` V2 paths: только `ruleEngine.js:uzBudgetBatchWorkerV2 success=2` от Phase 5a;
   - backend stdout без `Too many concurrent` / `Transient error`.
5. Gate открыт:

```bash
npx convex env set UZ_BUDGET_V2_ENABLED 1
```

Gate open time: `2026-05-05T18:19:48Z`.

Наблюдение после открытия gate:

- Cron `uz-budget-increase` зарегистрирован и вызывает `internal.ruleEngine.uzBudgetDispatchV2` каждые `45 min`.
- Manual trigger не выполнялся после открытия gate.
- Органические cron ticks:
  - `2026-05-05T18:57:10Z`: `2` new `ruleEngine.js:uzBudgetBatchWorkerV2` jobs, both `success`.
  - `2026-05-05T19:42:10Z`: `2` new `ruleEngine.js:uzBudgetBatchWorkerV2` jobs, both `success`.
- Final V2 worker total: `ruleEngine.js:uzBudgetBatchWorkerV2|success|6`:
  - `2` from Phase 5a manual canary;
  - `2` from first Phase 5b cron tick;
  - `2` from second Phase 5b cron tick.
- Backend stdout after gate open: `0` `Too many concurrent`, `0` `Transient error`.
- `systemLogs`: `0` errors.
- `adminAlerts.js:notify failed=38` without growth; no alert fan-out storm.
- `auth.js:tokenRefreshOneV2 failed=14` without growth.
- `/version`: `HTTP 200`.

Clean criteria для Phase 5b tick:

1. `uzBudgetDispatch` heartbeat обновился после `2026-05-05T18:19:48Z`, `status=completed`, `error=null`.
2. Появились новые `ruleEngine.js:uzBudgetBatchWorkerV2` jobs, ожидаемо `2`.
3. V2 worker jobs завершаются `success`, V2 `failed=0`.
4. Backend stdout: `0` `Too many concurrent`, `0` `Transient error`.
5. `adminAlerts.js:notify` schedules в окне: `0`.
6. `/version`: `HTTP 200`.

Emergency brake used after observation:

```bash
npx convex env set UZ_BUDGET_V2_ENABLED 0
```

Final safe state:

- commit `a52a2a3` deployed;
- cron `uz-budget-increase` registered at `45 min`;
- `UZ_BUDGET_V2_ENABLED=0`;
- future cron ticks skip at dispatcher entry and do not write heartbeat or schedule workers;
- UZ V2 production unattended mode is not enabled until a separate decision.

## Предыдущий Gate

Тик `13:09 UTC` был первым clean тиком после env fix. Второй тик `15:09 UTC` подтвердил стабильность.

Предпроверка перед тиком: около `14:50 UTC` / `17:50 MSK`.

Проверить:

- `/version`;
- `diagFanoutConfig`;
- последний heartbeat `tokenRefreshDispatch`;
- backend stdout за последние 15 минут;
- baseline `_scheduled_jobs`;
- compose/env state.

## Что Нельзя Делать До Закрытия Phase 2

- Не включать `syncBatchWorker` / sync metrics.
- Не включать `uzBudgetBatchWorker` / UZ budget cron.
- Не возвращать `recordRateLimit` в старом виде.
- Не bump'ать `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` с `8` до `16`.
- Не merge'ить emergency branch в `main`.
- Не удалять V1 no-op handlers.
- Не считать тик clean только по `systemLogs`; обязательно смотреть backend stdout.

## Что Делать После Двух Clean Тиков

1. Зафиксировать Phase 2 как closed в этом execution report.
2. Удалить или закрыть temporary diagnostic action `auth.diagFanoutConfig`.
3. Провести audit `process.env.*` в `convex/`: все env vars, нужные application code, должны быть в Convex deployment env.
4. Вынести общий slots-aware stagger helper для следующих fan-out dispatchers.
5. Восстанавливать порядок: UZ как канарейка, затем sync metrics.
6. Перед UZ/sync проверить `runAfter(0)` fan-out и добавить guard от overlap по `cronHeartbeats`.
7. Для `recordRateLimit` открыть отдельный bounded redesign, не возвращать старый producer/handler.

## Команды Для Следующего Исполнителя

Backend stdout:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker logs adpilot-convex-backend --since 2026-05-05T13:09:00Z --until 2026-05-05T13:22:00Z 2>&1 \
   | grep -cE 'Too many concurrent|Transient error'"
```

Health:

```bash
curl -sS -w '\nHTTP %{http_code} time %{time_total}s\n' https://convex.aipilot.by/version
```

Diagnostic env/fan-out:

```bash
node check-diag-fanout.cjs
```

Token refresh helper checks:

```bash
node check-token-refresh-tick.cjs
node check-token-refresh-errors.cjs
```

Correct `_scheduled_jobs` latest-state SQL:

```bash
docs/sql/convex-scheduled-jobs-latest-state.sql
```

## Итог На Сейчас

Phase 2 token refresh закрыта. Phase 5a manual UZ canary clean. Phase 5b cron UZ canary clean on two organic ticks. Gate закрыт обратно, поэтому UZ V2 entrypoints и cron live, но fail-closed. Phase 6a sync manual canary прошла как yellow-clean, затем Phase 6a-bis после escalation alert guard прошла clean по hard criteria.

Следующий этап: Phase 6b sync cron canary prepare. Не включать sync cron без отдельного prepare/deploy при `SYNC_METRICS_V2_ENABLED=0`. `recordRateLimit`, `adminAlerts.notify` restore, cleanup diagnostics и merge strategy остаются отдельными задачами.

## Phase 6 Sync Prep Notes

Pushed/deployed prepare chain:

- `e478dcb` - V2 sync entrypoints + moderation gate, not enabled.
- `ed5d5bf` - runtime env reads for `SYNC_WORKER_COUNT_V2` / `SYNC_BATCH_SIZE_V2` and explicit V1 cron warning.
- `a510695` - per-account failure check in `check-sync-tick.cjs` and removal of V1 ready-to-uncomment sync cron block.
- `3f92025` - docs guardrails for Phase 6 handoff.
- `9f62cfa` - escalation alert guard for sync canary; deployed live with gates closed.

Accepted guardrails:

1. `SYNC_METRICS_V2_ENABLED` stays fail-closed until a monitored canary window.
2. Phase 6a/6a-bis manual runs use `SYNC_WORKER_COUNT_V2=1`, `SYNC_BATCH_SIZE_V2=10`, `SYNC_METRICS_V2_POLL_MODERATION=0`.
3. `SYNC_ESCALATION_ALERTS_ENABLED=0` remains closed while `adminAlerts.notify` is no-op; sync escalation alerts are suppressed before scheduling.
4. `sync-metrics` cron remains disabled until after manual canary.
5. Monitoring must not rely only on `_scheduled_jobs` worker `success`. `syncBatchWorkerV2` catches per-account errors and can finish as `success` with internal account failures. `check-sync-tick.cjs` must count backend stdout lines matching `syncBatchV2.*Account .* failed` and treat any non-zero count as not clean.
6. The ready-to-uncomment V1 `syncDispatch` / 5-min cron registration block has been removed. Phase 6b candidate is V2 `syncDispatchV2` at `45 min`.
7. Manual trigger must be started only in an `xx:25-xx:55 UTC` window to avoid overlap with token refresh (`xx:09:36 UTC`, about 10 min dispatching).

Phase 6a manual sync canary (`2026-05-06T03:36Z`) result:

- `syncBatchWorkerV2`: `1 success`;
- backend stdout: `0` `Too many concurrent`, `0` `Transient error`;
- backend stdout: `0` `syncBatchV2.*Account .* failed`;
- `pg_wal`: flat (`1.9G -> 1.9G`);
- `lastSyncAt` stale count improved (`212 -> 203`);
- `adminAlerts.js:notify`: `5` schedules, attributed to sync escalation / known broken accounts. Because sync mechanics were clean but alert side-effect violated the original hard criterion, Phase 6a was classified yellow-clean.

Follow-up guard:

- `9f62cfa` added `SYNC_ESCALATION_ALERTS_ENABLED` in `syncMetrics.scheduleEscalationAlert`;
- when the flag is not `"1"`, the mutation returns before `adminAlertDedup` and before scheduling `adminAlerts.notify`;
- when enabled later, it dedups via existing `adminAlertDedup` using `sync:${dedupKey}` for 30 minutes.

Phase 6a-bis manual sync canary (`2026-05-06T04:31Z`) after `9f62cfa` result:

- live commit: `9f62cfa`;
- `SYNC_METRICS_V2_ENABLED=0` after run;
- `SYNC_ESCALATION_ALERTS_ENABLED=0`;
- `syncBatchWorkerV2`: `1 success`;
- `adminAlerts.js:notify`: `0` schedules;
- backend stdout: `0` `Too many concurrent`, `0` `Transient error`;
- backend stdout: `0` `syncBatchV2.*Account .* failed`;
- `pg_wal`: flat (`1.9G baseline`, observed `1.7G` after run);
- `cronHeartbeats[name=syncDispatch]`: `completed`, `error` absent, started `2026-05-06T04:31:01.607Z`, finished `2026-05-06T04:31:01.721Z`.

Conclusion: Phase 6a-bis closed clean by hard criteria. Phase 6b cron canary is unblocked as a separate prepare/deploy decision.

## Phase 5a Historical Stop Point

Историческая точка остановки перед первым prod deploy UZ V2:

1. `git push origin emergency/drain-scheduled-jobs` выполнен.
2. Remote HEAD: `ba5cf83`.
3. `npx convex env set UZ_BUDGET_V2_ENABLED 0` выполнен успешно.
4. Prod code еще не содержит UZ V2 entrypoints `ba5cf83`.
5. Cron UZ остается выключенным.

Следующий шаг требует отдельного go:

```bash
CONVEX_SELF_HOSTED_URL=https://convex.aipilot.by \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex deploy --yes
```

После deploy обязательные проверки:

1. `/version` -> `HTTP 200`.
2. `node check-diag-fanout.cjs` -> PASS, без изменений по token refresh fan-out.
3. Smoke `ruleEngine:uzBudgetDispatchV2` при `UZ_BUDGET_V2_ENABLED=0` -> `{ skipped: true, reason: "v2_disabled" }`.
4. `_scheduled_jobs` latest-state -> `0` новых `ruleEngine.js:uzBudgetBatchWorkerV2` / `dispatchUzBatchesV2` jobs.
5. Heartbeat `uzBudgetDispatch` unchanged или no-op-safe; не должен запускаться реальный UZ.

Только после этих проверок можно отдельно обсуждать включение `UZ_BUDGET_V2_ENABLED=1` и ручной trigger.
