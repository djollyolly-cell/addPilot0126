# Отчет по выполнению плана восстановления Convex

Дата: 5 мая 2026  
Сервис: AdPilot / `aipilot.by`  
Ветка: `emergency/drain-scheduled-jobs`  
Текущий live commit на момент отчета: `b0258fc`

Этот документ фиксирует не сам инцидент и не полный план восстановления, а фактический статус выполнения плана: что уже сделано, что проверено, какие решения приняты и какой следующий gate.

Связанные документы:

- `docs/2026-05-05-convex-scheduled-jobs-incident-report.md` - полный отчет по сбою.
- `docs/2026-05-05-convex-drain-reenable-plan.md` - план безопасного восстановления фазами.
- `docs/sql/convex-scheduled-jobs-latest-state.sql` - SQL для корректной проверки latest-state `_scheduled_jobs`.

## Executive Summary

Сервис выведен из crash/drain состояния в controlled degraded mode. Backend отвечает, frontend доступен, опасные backlog handlers оставлены no-op, а новая работа возвращается через versioned V2 entrypoints.

На текущий момент Phase 1 выполнена, Phase 2 token refresh восстановлена через V2 и закрыта после двух clean тиков подряд (`13:09 UTC` и `15:09 UTC`) после настоящего env fix. Phase 5a manual UZ canary прошла clean. Phase 5b cron canary прошла clean на двух органических cron tick'ах (`18:57 UTC`, `19:42 UTC`) с interval `45 min`; затем после отдельного business go UZ unattended production mode был открыт `2026-05-06T11:35Z`, и первый organic production tick `2026-05-06T12:12:10Z` прошёл clean. Phase 6 sync metrics V2 deployed до `b0258fc`; Phase 6a-bis manual canary закрыта clean, Phase 6b V2 cron canary закрыта clean на двух органических tick'ах (`05:34 UTC`, `06:19 UTC`) с interval `45 min`; после Phase 6b `SYNC_METRICS_V2_ENABLED` закрыт обратно в `0` перед token refresh overlap window. После того как `07:09 UTC` token refresh тик прошёл clean (89 V2 jobs success, без аномалий), sync gate переоткрыт в live mode в `2026-05-06T08:50Z` без других env изменений; organic live sync тики `09:19:10Z`, `10:04:10Z`, `10:49:10Z`, `11:34:10Z` и post-UZ tick `12:19:10Z` прошли acceptance criteria. `recordRateLimit` остается заблокирован.

Главный последний вывод: `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` должен быть установлен не только в container env, но и в Convex deployment env. До этого application code внутри V8 isolate видел default `32` и рассчитывал fan-out неправильно, хотя backend infra реально лимитил до `8`.

## Статус По Фазам

| Фаза | Статус | Что сделано | Gate / ограничение |
|---|---|---|---|
| Drain-mode emergency patch | выполнено | V1 backlog handlers переведены в no-op с сохранением сигнатур | Старые V1 handlers не возвращать, пока есть риск backlog execution |
| Phase 1 safe restore | выполнено | Восстановлены безопасные cleanup crons: `cleanup-stuck-payments`, `cleanup-old-logs`, `cleanup-expired-invites` | Сервис стабилен, backend/frontend отвечают |
| Phase 2 token refresh V2 | закрыто | Добавлен `tokenRefreshOneV2`, producers/dispatcher переключены на V2, V1 `tokenRefreshOne` оставлен no-op | Два clean тика подряд после env fix: `13:09 UTC`, `15:09 UTC` |
| Error alert fan-out gate | выполнено | Добавлен `DISABLE_ERROR_ALERT_FANOUT=1`, `systemLogger` перестал schedule'ить `adminAlerts.notify` на каждый error | При восстановлении `adminAlerts.notify` снять флаг одновременно |
| Env scope fix | выполнено | `DISABLE_ERROR_ALERT_FANOUT=1` и `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` установлены через Convex deployment env | Любые function-level env vars ставить через `convex env set` |
| UZ budget restore | live after first production organic tick | `3abc818` + `ba5cf83` deployed; Phase 5a manual canary clean; `a52a2a3` deployed with `45 min` V2 cron; two Phase 5b organic cron ticks clean; business go received; gate opened `2026-05-06T11:35Z`; first production organic tick `12:12:10Z` clean | Keep gate `1`; monitor second organic UZ tick before restoring more side-effecting crons |
| Sync metrics restore | live (gate reopened 2026-05-06T08:50Z) | V2 entrypoints deployed; escalation alert guard deployed; manual canary clean after guard; V2 `sync-metrics` cron registered at `45 min`; two organic Phase 6b ticks clean; gate flipped `0→1` after `07:09 UTC` token refresh verified clean; live organic ticks `09:19:10 UTC` and `10:04:10 UTC` passed acceptance criteria including overlap with `09:09 UTC` token refresh dispatcher | Conservative profile preserved (worker=1, batch=10, moderation off, escalation alerts off); future ticks organic only, no manual trigger; bumps remain separate decisions |
| Phase 8 concurrency bump 8 → 16 | closed clean | Bump `2026-05-06T15:35:06Z`; KEY canary token refresh `17:09Z` clean (`immediate=2` burst, `auth.js:tokenRefreshOneV2 success +25`, no V8/transient/alert signals); post-token UZ `17:27Z` clean (`uzBudgetBatchWorkerV2 16→22`); post-token sync `17:34Z` clean (`syncBatchWorkerV2 13→16`); strict closure `2026-05-06T17:47Z`; `pg_wal` `1,627,389,952 → 1,593,835,520 bytes` | `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16` is new production norm; do not combine with worker/batch bumps, moderation poll, `16→32`, or merge to `main` |
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
| `b0258fc` | Phase 6b prepare: V2 `sync-metrics` cron registration at `45 min`; deployed with `SYNC_METRICS_V2_ENABLED=0` and fail-closed smoke verified. |

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

Phase 2 token refresh закрыта. Phase 5a manual UZ canary clean. Phase 5b cron UZ canary clean on two organic ticks. После отдельного business go UZ gate открыт `2026-05-06T11:35Z`; первый unattended production organic tick `12:12:10Z` прошёл clean. Phase 6a sync manual canary прошла как yellow-clean, затем Phase 6a-bis после escalation alert guard прошла clean по hard criteria. Phase 6b V2 sync cron закрыт clean на двух organic tick'ах; gate закрыт обратно в `0` перед token refresh overlap window. После того как `07:09Z` token refresh тик прошёл clean, sync gate переоткрыт в live mode `2026-05-06T08:50Z`; live sync ticks `09:19:10Z`, `10:04:10Z`, `10:49:10Z`, `11:34:10Z` и post-UZ `12:19:10Z` прошли acceptance criteria.

Следующий этап: оставить sync и UZ на conservative/live profile, мониторить второй organic UZ tick (без manual trigger), и отдельно решать `recordRateLimit`, `adminAlerts.notify` restore, `SYNC_ESCALATION_ALERTS_ENABLED` lift, `SYNC_METRICS_V2_POLL_MODERATION` enable, worker/batch bumps, concurrency `8→16` (после устойчивого live окна), cleanup diagnostics и merge strategy.

## Phase 6 Sync Prep Notes

Pushed/deployed prepare chain:

- `e478dcb` - V2 sync entrypoints + moderation gate, not enabled.
- `ed5d5bf` - runtime env reads for `SYNC_WORKER_COUNT_V2` / `SYNC_BATCH_SIZE_V2` and explicit V1 cron warning.
- `a510695` - per-account failure check in `check-sync-tick.cjs` and removal of V1 ready-to-uncomment sync cron block.
- `3f92025` - docs guardrails for Phase 6 handoff.
- `9f62cfa` - escalation alert guard for sync canary; deployed live with gates closed.
- `b0258fc` - V2 `sync-metrics` cron registration at `45 min`; deployed live fail-closed.

Accepted guardrails:

1. `SYNC_METRICS_V2_ENABLED=0` after Phase 6b close; sync cron remains registered but paused before a separate overlap/post-token decision.
2. Phase 6a/6a-bis manual runs use `SYNC_WORKER_COUNT_V2=1`, `SYNC_BATCH_SIZE_V2=10`, `SYNC_METRICS_V2_POLL_MODERATION=0`.
3. `SYNC_ESCALATION_ALERTS_ENABLED=0` remains closed while `adminAlerts.notify` is no-op; sync escalation alerts are suppressed before scheduling.
4. `sync-metrics` cron V2 is registered at `45 min`; while `SYNC_METRICS_V2_ENABLED=0`, ticks skip before worker dispatch.
5. Monitoring must not rely only on `_scheduled_jobs` worker `success`. `syncBatchWorkerV2` catches per-account errors and can finish as `success` with internal account failures. `check-sync-tick.cjs` must count backend stdout lines matching `syncBatchV2.*Account .* failed` and treat any non-zero count as not clean.
6. The ready-to-uncomment V1 `syncDispatch` / 5-min cron registration block has been removed. The active Phase 6b path is V2 `syncDispatchV2` at `45 min`.
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

Conclusion: Phase 6a-bis closed clean by hard criteria. Phase 6b cron canary is now closed clean after two organic ticks.

Phase 6b cron deploy (`2026-05-06T04:50Z`, `b0258fc`) result:

- Deploy clean to Convex production.
- `/version`: `HTTP 200`.
- Fail-closed smoke `syncDispatchV2`: `{ "skipped": true, "reason": "v2_disabled" }`.
- `cronHeartbeats[name=syncDispatch]`: unchanged from Phase 6a-bis after smoke.
- New schedules after deploy: none for `syncMetrics.js:syncBatchWorkerV2`, `dispatchSyncBatchesV2`, `syncDispatchV2`, or `adminAlerts.js:notify`.
- Backend stdout after deploy: `0` `Too many concurrent`, `0` `Transient error`, `0` `syncBatchV2.*Account .* failed`.
- Phase 6b pre-open baseline captured at `2026-05-06T05:07:38Z`: `/version` HTTP 200, `pg_wal=1.6G`, `lastSyncAt stale=212/212`, V2 jobs only historical `syncBatchWorkerV2|success|2`, failed counters unchanged.

Phase 6b organic cron canary result:

- Gate opened at `2026-05-06T05:29:09Z`.
- First organic tick `2026-05-06T05:34:10Z`: heartbeat completed/error null, `syncBatchWorkerV2 success=1`, `adminAlerts.notify=0`, V8/transient/per-account failures `0`, WAL delta `+16 MiB`, 10 accounts eventually updated by the async worker.
- Second organic tick `2026-05-06T06:19:10Z`: heartbeat completed/error null, `syncBatchWorkerV2 success=1`, `adminAlerts.notify=0`, V8/transient/per-account failures `0`, WAL byte-exact sample stable at `1,711,276,032` bytes, failed counters unchanged.
- `SYNC_METRICS_V2_ENABLED` was then set back to `0` at `2026-05-06T06:37:51Z` to avoid an implicit overlap test with the `07:09Z` token refresh window; `SYNC_ESCALATION_ALERTS_ENABLED=0` and `SYNC_METRICS_V2_POLL_MODERATION=0` remain closed.

## Phase 6 Live Reopen + Production Overlap Test

После Phase 6b закрытия `SYNC_METRICS_V2_ENABLED=0` держался от `06:37:51Z` до `08:50Z`, чтобы пропустить token refresh тик `07:09Z` без неявного overlap-теста.

Pre-conditions verified before reopen:

- `07:09Z` token refresh тик clean: `tokenRefreshDispatch` heartbeat completed/error null, `89` `tokenRefreshOneV2` jobs all `success`, `0` `Too many concurrent` / `Transient error`, `0` `systemLogs` errors, failed counters без прироста, `/version` HTTP 200, `pg_wal` ~`1.6G` стабилен.
- Sync cron оставался зарегистрированным на `45 min`, тики пропускались при `gate=0`, новых V2/admin schedules не создавалось.
- Последний `syncDispatch` heartbeat — Phase 6b second clean tick `06:19:10Z`.

Reopen action: `2026-05-06T08:50Z`, `SYNC_METRICS_V2_ENABLED 0 → 1`. Никакие другие gates не трогались. Conservative profile сохранён: `SYNC_WORKER_COUNT_V2=1`, `SYNC_BATCH_SIZE_V2=10`, `SYNC_METRICS_V2_POLL_MODERATION=0`, `SYNC_ESCALATION_ALERTS_ENABLED=0`, `UZ_BUDGET_V2_ENABLED=0`, `DISABLE_ERROR_ALERT_FANOUT=1`, `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8`.

Первый organic live sync тик: `2026-05-06T09:19:10Z`. Это первый реальный production overlap token refresh и sync с момента инцидента 2026-05-04/05 — token refresh dispatcher тикнул в `09:09Z` (~10 мин), sync dispatcher тикнул в `09:19Z`, когда token refresh workers могли ещё крутиться.

Все 8 acceptance criteria прошли:

1. `syncDispatch` heartbeat: started `09:19:10.274Z`, finished `09:19:10.365Z`, status completed, error null.
2. `syncBatchWorkerV2`: total success `4 → 5`, failed без изменений на `0`.
3. Backend stdout `09:09Z..09:33Z`: `0` `Too many concurrent`, `0` `Transient error`, `0` `syncBatchV2.*Account .* failed`.
4. `adminAlerts.js:notify` schedules в sync window: `0`.
5. Failed counters без прироста: `adminAlerts=38`, V1 sync=37, V1 UZ=36, `tokenRefreshOneV2=14`, `manualMassCleanup=1`.
6. `pg_wal` byte-exact: `1,711,276,032 → 1,711,276,032`, delta `0`. Phase 6b first tick был `+16 MiB`; conservative profile + WAL recycling даёт нулевой прирост на текущей нагрузке.
7. `/version`: HTTP 200.
8. Token refresh `09:09Z` overlap: dispatcher completed/error null, `systemLogs` errors `0`. Один `tokenRecovery` warn по отдельному аккаунту — `warn`-уровень (не `error`), per-account, не системный; не rollback trigger.

Outcome: Phase 6 sync V2 работает в live production overlap mode. Conservative profile остаётся в силе. Все ранее приостановленные решения остаются отдельными gate'ами (`SYNC_ESCALATION_ALERTS_ENABLED`, `SYNC_METRICS_V2_POLL_MODERATION`, worker/batch bumps, `UZ_BUDGET_V2_ENABLED`, `recordRateLimit` redesign, concurrency `8→16`, merge to `main`).

Second live organic sync tick: `2026-05-06T10:04:10Z`.

Acceptance criteria:

1. `syncDispatch` heartbeat: started `10:04:10.284Z`, finished `10:04:10.363Z`, status completed, error null.
2. `syncBatchWorkerV2`: total success `5 → 6`, failed без изменений на `0`.
3. Backend stdout `10:03Z..10:18Z`: `0` `Too many concurrent`, `0` `Transient error`, `0` `syncBatchV2.*Account .* failed`.
4. `adminAlerts.js:notify` schedules в sync window: `0`.
5. Failed counters без прироста: `adminAlerts=38`, V1 sync=37, V1 UZ=36, `tokenRefreshOneV2=14`, `manualMassCleanup=1`.
6. `pg_wal` byte-exact sample: `1,711,276,032` bytes, unchanged from live reopen baseline.
7. `/version`: HTTP 200.
8. `systemLogs` errors: `0`.

Outcome after two live ticks: Phase 6 sync V2 can remain live in conservative production profile. Do not bump worker/batch/concurrency, enable moderation poll, or enable sync escalation alerts as part of this step.

Cron cadence: следующие organic ticks ожидаются `~10:49Z`, `11:34Z`, … Будущие тики только organic; manual trigger запрещён.

## UZ Live Reopen: First Production Organic Tick CLEAN

Business go был получен `2026-05-06`: оператор подтвердил, что unattended UZ делает реальные изменения в VK Ads и отправляет user-facing Telegram notifications.

Open action:

- `2026-05-06T11:35Z`: `UZ_BUDGET_V2_ENABLED 0 -> 1`.
- Другие gates не менялись: sync остался в conservative live profile, `SYNC_ESCALATION_ALERTS_ENABLED=0`, `SYNC_METRICS_V2_POLL_MODERATION=0`, `DISABLE_ERROR_ALERT_FANOUT=1`.
- Manual UZ trigger не запускался; первый запуск был только organic cron.

Pre-open baseline:

- Active UZ rules: `123`.
- Unique users: `46`.
- Unique target accounts: `174`.
- Expected workers: `2` (`UZ_WORKER_COUNT_V2` clamped at `2`).
- `uzBudgetDispatch` heartbeat до открытия был `completed`, not `running`.
- Exact `pg_wal` baseline: `1,627,389,952` bytes.

First organic production tick:

- `uzBudgetDispatch` started `2026-05-06T12:12:10.525Z`, finished `2026-05-06T12:12:10.674Z`, status `completed`, `error=null`.
- `ruleEngine.js:uzBudgetBatchWorkerV2`: total success `6 -> 8`, failed stayed `0`.
- Backend rollback-pattern grep in `12:10Z..12:25Z`: `0` `Too many concurrent`, `0` `Transient error`, `0` `TOKEN_EXPIRED`, `0` `[uzBatchV2#.*] Account .* failed`, `0` `syncBatchV2.*Account .* failed`.
- `adminAlerts.js:notify`: `0` schedules in window.
- `systemLogs` error level during the UZ worker window through `12:18Z`: `0`.
- Exact `pg_wal`: `1,627,389,952 -> 1,627,389,952` bytes, delta `0`.
- Failed counters stayed on baseline: `adminAlerts.js:notify=38`, `syncMetrics.js:syncBatchWorker=37`, `ruleEngine.js:uzBudgetBatchWorker=36`, `auth.js:tokenRefreshOneV2=14`, `metrics.js:manualMassCleanup=1`, `ruleEngine.js:uzBudgetBatchWorkerV2 failed=0`.
- `/version`: HTTP `200`.

Business-side audit:

- `actionLogs` in `12:10Z..12:55Z`: `216` `budget_increased|success`.
- Failed/reverted budget actionLogs: `0`.
- Scope: `7` users, `19` accounts, `20` rules, `216` ads.
- Coverage note: this was `19` accounts out of the `163` active UZ target accounts found in the pre-open snapshot (`174` unique target refs minus `11` orphan account refs). The other active UZ accounts did not match current rule conditions on this tick; this is expected because UZ evaluates fresh state and does not replay missed schedules.
- No `budget_reset` or `zero_spend_alert` rows in the window.
- Sample reasons were ordinary budget increments such as `150₽ -> 200₽ (+50₽)`, `185₽ -> 225₽ (+40₽)`, `240₽ -> 340₽ (+100₽)`.

Post-UZ sync check:

- `syncDispatch` at `2026-05-06T12:19:10.287Z -> 12:19:10.385Z`, status `completed`, `error=null`.
- `syncMetrics.js:syncBatchWorkerV2`: total success `9`, failed unchanged.
- Backend rollback-pattern grep: `0`.
- `adminAlerts.js:notify`: `0`.
- Failed counters unchanged.
- Secondary yellow note: `systemLogs` recorded one later `syncMetrics` error at `2026-05-06T12:20:12Z` (`checkRulesForAccount failed: request timed out`). It happened `+8 min` after UZ dispatcher start and `+1 min` after the sync dispatcher, inside a plausible UZ-worker + sync-worker overlap window. It is classified as transient overlap pressure, not a UZ rollback trigger, because backend rollback grep was `0`, scheduled-job failed counters did not grow, and the `13:09Z` token refresh dispatcher later completed cleanly.
- Watch criteria for recurrence: one isolated timeout on a later sync tick is a yellow note; `>=2` timeout lines in one sync window, the same account timing out repeatedly, or any timeout correlated with V8 slot pressure / `TOKEN_EXPIRED` / failed counters requires analysis before any further gate restore.
- Read-only RCA context captured after the tick: the timeout account was `j978z1sbh3ra5ym2hh3wqmb88184cs47` (`Вардек мск спб`), status `active`, `lastError=null`, `lastSyncError=null`, token fresh until `2026-05-07T13:12:04Z`. The same account already had `checkRulesForAccount timed out` records before UZ live restore (`2026-05-03` and `2026-05-04`), so this is not a new UZ-specific failure. Active rules on the account include two `cpl_limit` rules with `timeWindow=since_launch`; stack line `ruleEngine.ts:1759` is `getAccountAllAdIds`, which collects all historical `metricsDaily` rows for the account. A direct read-only call to `getAccountAllAdIds` for this account timed out during investigation. Follow-up read-only `systemLogs` scope query over current 10-day retention found `2` affected active accounts (`Вардек мск спб` and `Интерьер`), each with `4` timeout records. This points to a heavy historical metrics query / rule-evaluation path, not a broken token.

Second organic production tick:

- `uzBudgetDispatch` started `2026-05-06T12:57:10.529Z`, finished `2026-05-06T12:57:10.665Z`, status `completed`, `error=null`.
- `ruleEngine.js:uzBudgetBatchWorkerV2`: total success `8 -> 10`, failed stayed `0`.
- Backend rollback-pattern grep in `12:55Z..13:35Z`: `0`.
- `adminAlerts.js:notify`: `0`; `systemLogs` error level: `0`.
- Exact `pg_wal` stayed `1,627,389,952` bytes.
- Failed counters stayed on baseline.
- `/version`: HTTP `200`.
- `actionLogs` in `12:55Z..13:35Z`: `89` `budget_increased|success`, `0` failed/reverted budget actions.
- Token refresh `13:09Z`: dispatcher completed/error null; `systemLogs` errors in the recent token window were `0`, with one known `tokenRecovery` warn for `Милород Челябинск`.

Outcome: first two unattended UZ production organic ticks are clean, with `305` successful `budget_increased` VK Ads writes and `0` failed/reverted budget actions. The following `13:09Z` token refresh dispatcher stayed clean. Keep `UZ_BUDGET_V2_ENABLED=1` unless business requests pause. Watch the next sync ticks for repeats of the `12:20Z` `syncMetrics` timeout before restoring additional side-effecting crons.

## Phase 8 Concurrency Bump 8 → 16: CLEAN

Bump time: `2026-05-06T15:35:06Z = 18:35:06 MSK`. Strict closure: `2026-05-06T17:47Z = 20:47 MSK`. Final state: `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`.

Architectural reason: at concurrency `8`, token refresh dispatcher computed `immediate = floor(8 / (3 * 2)) = 1` worker and staggered the rest by `7s` (`[0, 7000, 14000, 21000, 28000, 35000]`). Bump to `16` produces `immediate = floor(16 / (3 * 2)) = 2` workers (`[0, 0, 7000, 7000, 14000, 14000]`), giving the system real overlap headroom for token refresh + sync + UZ + system actions without saturating slots.

Pre-bump baseline (`2026-05-06T15:30:04Z`): all gates as expected, `/version` HTTP 200 ~`1.2s`, `pg_wal=1,627,389,952 bytes`, all dispatcher heartbeats `completed`/`error=null`, failed counters at established baseline (`adminAlerts=38`, V1 sync=37, V1 UZ=36, `tokenRefreshOneV2=14`, `manualMassCleanup=1`), V2 success cumulative `syncBatchWorkerV2=13`, `uzBudgetBatchWorkerV2=16`.

Bump action: `npx convex env set APPLICATION_MAX_CONCURRENT_V8_ACTIONS 16` succeeded; `auth:diagFanoutConfig` confirmed `computed_concurrency=16`, `computed_immediate_slots_for_3=2`, `sample_delays_at_3=[0, 0, 7000, 7000, 14000, 14000]`. `/version` immediately post-bump: HTTP 200, `1.27s`. No rollback signals.

Already clean before strict closure window:

- UZ tick `2026-05-06T15:57Z`: `uzBudgetDispatch` completed/null; `uzBudgetBatchWorkerV2 16 → 18`; rollback grep `0`; `adminAlerts.notify=0`; `systemLogs` errors `0`.
- Sync tick `2026-05-06T16:04Z`: `syncDispatch` completed/null; `syncBatchWorkerV2 13 → 14`; rollback grep `0`; `adminAlerts.notify=0`.

KEY canary — token refresh `2026-05-06T17:09Z` (first dispatcher run with `immediate=2` burst):

- `tokenRefreshDispatch` heartbeat: `completed`, `error=null`, `finishedAt=2026-05-06T17:09:38.215Z`.
- `auth.js:tokenRefreshOneV2`: `+25 success` in window, failed unchanged at baseline `14`.
- Backend rollback grep in window: `0` `Too many concurrent`, `0` `Transient error`, `0` `TOKEN_EXPIRED` burst.
- `adminAlerts.js:notify` schedules in window: `0`.
- `systemLogs` errors in window: `0` (one known `tokenRecovery` warn for `Милород Челябинск` remains a warn, not a rollback trigger).
- `/version`: HTTP `200`.

Post-token overlap canaries:

- UZ `2026-05-06T17:27:10Z`: `uzBudgetDispatch` heartbeat `completed`, `error=null`. `ruleEngine.js:uzBudgetBatchWorkerV2` cumulative `16 → 22`, failed `0`. Backend rollback grep `0`, `adminAlerts.notify=0`.
- Sync `2026-05-06T17:34:10Z`: `syncDispatch` heartbeat `completed`, `error=null`. `syncMetrics.js:syncBatchWorkerV2` cumulative `13 → 16`, failed `0`. Backend rollback grep `0`, `adminAlerts.notify=0`.

Failed counters at strict closure (unchanged from pre-bump baseline):

```text
adminAlerts.js:notify              = 38
syncMetrics.js:syncBatchWorker     = 37
ruleEngine.js:uzBudgetBatchWorker  = 36
auth.js:tokenRefreshOneV2          = 14
metrics.js:manualMassCleanup       = 1
syncMetrics.js:syncBatchWorkerV2     failed = 0
ruleEngine.js:uzBudgetBatchWorkerV2  failed = 0
```

`pg_wal` byte-exact: `1,627,389,952 → 1,593,835,520 bytes` (delta `-33 MiB`, normal Postgres checkpoint behavior, well under `+50 MB` hard stop). The `immediate=2` token-refresh burst did not produce measurable WAL pressure.

Outcome: Phase 8 closed clean. `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16` is the new production norm. No rollback executed. Per-runbook constraint, do not combine with sync worker/batch bumps, moderation poll, UZ reset cron, billing/subscription cron restore, `recordRateLimit` redesign, `adminAlerts.notify` restore, code deploy/codegen, or `16 → 32` concurrency change — each is a separate runbook. Next steps governed by `docs/2026-05-06-post-phase-8-checklist.md`.

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
