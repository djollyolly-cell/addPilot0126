# План запуска после drain `_scheduled_jobs`

Дата: 5 мая 2026
Контекст: аварийный drain Convex `_scheduled_jobs` после накопления большой очереди pending/inProgress jobs.

Цель этого плана: вернуть сервис в штатную работу по фазам, не включив обратно все producers/fan-out jobs одновременно.

Отчет по фактическому выполнению этого плана: `docs/2026-05-05-convex-recovery-plan-execution-report.md`.

Post-deploy update: drain-mode стабилизировал backend. Сначала scheduler дренил очередь только около `10-12 jobs/min`; после Phase 1 скорость выросла примерно до `25-30 jobs/min`, но полный drain `268k pending` все равно занял бы дни. Поэтому план меняется с "ждать полного drain" на controlled degraded restore + V2 versioned restore: вернуть базовую работу сервиса, оставив опасные backlog handlers no-op.

Текущее состояние после Phase 1:

- commit `7aa2170` deployed;
- ветка запушена;
- восстановлены `cleanup-stuck-payments`, `cleanup-old-logs`, `cleanup-expired-invites`;
- frontend `aipilot.by` отвечает `HTTP 200`;
- Convex `/version` отвечает `HTTP 200`, около `57ms`;
- backend healthy, uptime около `12 min` на момент замера;
- drain идет около `25-30 jobs/min`.

Update после Phase 2 V2: обнаружено, что старые мониторинговые SQL-запросы считали не latest state, а все не-deleted версии документов в Convex `documents`. Из-за этого один и тот же scheduled job мог одновременно попадать в подсчеты `pending`, `inProgress` и `success` как разные версии. Для решений по восстановлению использовать только latest-version queries.

Update после token refresh hotfix: первый полный тик Phase 2 V2 после commit `4373678` не прошел clean. `tokenRefreshDispatch` завершился успешно, heartbeat был `completed`, но в окне тика появились `Too many concurrent requests` в token refresh worker'ах. Причина подтверждена кодом: `tokenRefreshOneV2` вызывает nested `ctx.runAction`, поэтому один worker может занимать больше одного V8 action slot в пике. Commit `c34bbc3` исправил fan-out stagger: helper теперь учитывает `slotsPerWorker`, а token refresh использует `slotsPerWorker=2`. Convex deploy на `https://convex.aipilot.by` прошел, `/version` после deploy отвечал `HTTP 200` примерно за `1.37-1.46s`.

Update после контрольного тика `07:09 UTC`: тик после `c34bbc3` тоже не прошел clean. Backend stdout в окне `07:09:30-07:10:30 UTC` показал десятки `Too many concurrent requests`, хотя в `systemLogs` попала только часть ошибок. Причина уточнена: реальная пиковая глубина token refresh worker обычно `3` V8 action slots: `tokenRefreshOneV2 -> getValid* -> refresh*`. Кроме того, waves в логах шли каждые `5-7s`, значит `FANOUT_STAGGER_MS=3000` слишком короткий и batch'и накладываются. Следующий hotfix должен использовать `slotsPerWorker=3` и stagger `7000ms`.

Следующий контрольный тик после hotfix `slotsPerWorker=3`:

- last successful `tokenRefreshDispatch`: `2026-05-05 05:09:36 UTC`;
- cron interval: `2h`;
- предыдущий тик `2026-05-05 07:09 UTC` не clean;
- следующий ожидаемый тик после нового deploy нужно считать от последнего `tokenRefreshDispatch` heartbeat;
- окно проверки держать не меньше `12 min` после старта тика, потому что при concurrency `8`, `slotsPerWorker=3`, `stagger=7s`, 80-90 targets могут выполняться около `9-10 min`.

## Главная цель восстановления

Вернуть Convex backend в управляемое живое состояние, не дав ему снова уйти в scheduled jobs / write storm.

Ближайший критерий успеха:

- Convex backend стартует и не падает.
- `https://convex.aipilot.by/version` отвечает стабильно.
- `_scheduled_jobs.pending` и `_scheduled_jobs.inProgress` уменьшаются или остаются около нуля после drain.
- Postgres/WAL не разгоняются снова.
- Новые тяжелые jobs не создаются, пока старая очередь дренируется.
- Frontend может подключиться к backend хотя бы в degraded mode.

После первых наблюдений критерий "pending быстро уходит в ноль" снят как обязательный для начала восстановления. Достаточно, чтобы:

- backend стабильно отвечает;
- pending не растет;
- WAL не разгоняется;
- новые fan-out producers отключены;
- старые backlog handlers остаются no-op.

## Фаза D: controlled degraded restore

Эта фаза нужна, если drain идет слишком медленно.

Факты, при которых применяется degraded restore:

- backend healthy;
- `/version` отвечает примерно `50-100ms`;
- `pg_wal` стабилен;
- Postgres idle или near-idle;
- `Too many concurrent requests` исчезли;
- drain rate остается слишком низким для ожидания полного завершения, даже если он вырос с `10-12 jobs/min` до `25-30 jobs/min`.

Цель degraded restore: вернуть базовую доступность backend/frontend, не возвращая опасные producers и не выполняя старую очередь реальной бизнес-логикой.

Оставить no-op:

- `vkApiLimits.recordRateLimit`
- `syncMetrics.syncBatchWorker`
- `ruleEngine.uzBudgetBatchWorker`
- `auth.tokenRefreshOne`
- `metrics.manualMassCleanup`

До отдельного контролируемого включения также можно оставить no-op:

- `adminAlerts.notify`

Оставить выключенными:

- `sync-metrics`
- `uz-budget-increase`
- `proactive-token-refresh`
- `vk-throttling-probe`
- producer'ы `recordRateLimit` в `vkApi.ts`

Не делать:

- не ждать полного drain неделями;
- не возвращать настоящие handlers для функций, у которых еще есть pending backlog;
- не делать прямой SQL cleanup `_scheduled_jobs`, пока нет отдельного безопасного плана по `documents` + `indexes` + args/tombstones.

## V2 versioned restore

Если у функции есть значительный backlog в `_scheduled_jobs`, не возвращать реальную бизнес-логику в старый exported handler. Старые pending jobs уже ссылаются на конкретный `udfPath`, например `auth.js:tokenRefreshOne`, поэтому возврат реального V1 handler приведет к исполнению старой очереди.

Правило восстановления:

- V1 handlers с backlog остаются exported no-op с теми же validators.
- Новая работа запускается через новые entrypoints с новыми именами, например `auth.tokenRefreshOneV2`.
- Все producers, dispatchers, direct callers и crons переключаются на V2.
- Self-reschedule функции должны self-reschedule только на V2, не на V1.
- Старые V1 functions удалить или оставить с deprecation marker только после drain/purge старого backlog.

Перед любым V2-релизом выполнить audit:

```bash
rg "tokenRefreshOne|syncBatchWorker|uzBudgetBatchWorker|manualMassCleanup|recordRateLimit|runAfter|runAt|runAction|runMutation|crons\\.|cronHeartbeat" convex
```

Проверить не только cron dispatchers, но и любые прямые вызовы через `ctx.runAction`, `ctx.runMutation`, `ctx.scheduler.runAfter` и `ctx.scheduler.runAt`.

Guardrails для V2:

- Сначала включать только одну функциональную область за релиз.
- Для fan-out использовать stagger, не `runAfter(0)` для всех jobs.
- Первый batch считать не только от `APPLICATION_MAX_CONCURRENT_V8_ACTIONS`, но и от пикового числа V8 slots на worker: `immediate = floor(concurrency / (slotsPerWorker * 2))`.
- Для token refresh использовать `slotsPerWorker=3`, потому что `tokenRefreshOneV2` вызывает `getValid*`, а тот при refresh вызывает еще один nested action `refresh*`; при concurrency `8` первый batch должен быть `1` worker.
- Не хардкодить `16/8` под старый concurrency `32`. Считать immediate/stagger batch от `process.env.APPLICATION_MAX_CONCURRENT_V8_ACTIONS`, чтобы bump concurrency не требовал ручного изменения кода.
- Dispatcher должен обновлять свой `cronHeartbeat`, чтобы health check видел актуальное состояние.
- Желательно иметь kill switch для V2, чтобы отключить новую работу без отката всего drain-патча.
- `recordRateLimit` не включать через V2 в рамках emergency. Для него нужен отдельный bounded redesign.

Порядок первого V2-релиза:

1. Audit всех call-sites и `cronHeartbeat` references.
2. Реализовать только `auth.tokenRefreshOneV2` как точную копию рабочей V1-логики.
3. Обновить `tokenRefreshDispatch`, direct callers и cron на V2.
4. Если `tokenRefreshDispatch` делает fan-out, добавить stagger через slots-aware helper; при текущем concurrency `8` и `slotsPerWorker=3` первый batch должен быть `1` job.
5. Убедиться, что heartbeat `tokenRefreshDispatch` продолжает обновляться.
6. Оставить `auth.tokenRefreshOne` V1 no-op.
7. Typecheck, commit, push, deploy.
8. Наблюдать 15-30 минут.

Мониторинг после первого V2-релиза:

- `/version` отвечает стабильно;
- pending по `auth.js:tokenRefreshOne` не растет, V1 drain продолжается;
- pending по `auth.js:tokenRefreshOneV2` маленький или около нуля;
- failed по V1/V2 не растет резко;
- нет новых `Too many concurrent requests`;
- нет шквала VK Ads token errors в business logs;
- `cronHeartbeat` для `tokenRefreshDispatch` обновляется.

Критерий clean после hotfix `slotsPerWorker=3`:

- `cronHeartbeats[name=tokenRefreshDispatch]`: `status=completed`, `error=null`, `finishedAt` после ожидаемого тика;
- backend stdout за окно тика: `0` записей с `Too many concurrent requests`;
- `systemLogs` за окно тика: `0` записей с `Too many concurrent requests`;
- `systemLogs` за окно тика: `0` новых `level=error`, `source=auth` про token refresh failures;
- `/version` отвечает `HTTP 200`.

Проверять backend stdout обязательно, не только `systemLogs`:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker logs adpilot-convex-backend --since <window-start> --until <window-end> 2>&1 \
   | grep -cE 'Too many concurrent|Transient error'"
```

Окно проверки token refresh тика должно быть не меньше `11-12 min`: тик + полный dispatch около `9-10 min` + buffer.

Команды `node check-token-refresh-tick.cjs` и `node check-token-refresh-errors.cjs` использовать как diagnostic output. Они помогают быстро увидеть heartbeat/logs, но результат нужно сверять глазами по критериям выше, если скрипты не возвращают строгий non-zero exit на нарушениях.

Phase 2 считается закрытой только после `2` clean token refresh тиков подряд. До этого:

- не включать UZ/sync;
- не bump'ать `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` с `8` до `16`;
- не merge'ить emergency branch в `main`.

Только после стабильности переходить к следующей области, например `syncBatchWorkerV2`.

## Риск cron collision

Token refresh после hotfix может занимать около `9-10 min`. В это окно остаются ограниченные V8 action slots для пользовательских actions и других crons. Перед включением следующих фаз проверить overlap в `convex/crons.ts`.

Если token refresh конфликтует с другим тяжелым cron:

- не считать это ошибкой token refresh;
- проверить backend stdout в общем окне overlap;
- рассмотреть перевод `proactive-token-refresh` с `crons.interval({ hours: 2 })` на фиксированное расписание со смещением, если текущий Convex self-hosted setup это поддерживает;
- либо добавить guard/skip при занятости, если фиксированное смещение неудобно.

Не обещать "сместить на xx:11" как простое действие, пока cron API и текущая регистрация не проверены.

## Error alert fan-out gate

Обнаружена amplification loop:

```text
systemLogger.log(level="error")
  -> ctx.scheduler.runAfter(0, internal.adminAlerts.notify)
  -> adminAlerts.notify no-op в drain-mode, но все равно занимает V8 action slot
  -> меньше свободных slots для token refresh workers
  -> новые Too many concurrent / Transient error
  -> новые systemLogger.log(level="error")
```

Фикс:

- commit `9aa3a68`;
- `convex/systemLogger.ts` получил env-gated guard;
- флаг: `DISABLE_ERROR_ALERT_FANOUT=1`;
- `adminAlerts.notify` остается no-op в drain-mode.

Важный урок по env scope:

- container env через compose сам по себе оказался недостаточным для Convex function env;
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` в container env реально применялся Convex backend infra как внутренний лимит, но application code внутри V8 isolate его не видел через `process.env` и считал default `32`;
- `DISABLE_ERROR_ALERT_FANOUT` должен быть установлен в Convex deployment env;
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` тоже должен быть продублирован через Convex deployment env, если application code использует его в формулах fan-out;
- первый тест `09:52 UTC` создал `systemLog` и `adminAlerts.notify` schedule, потому что Convex env еще не был применен;
- второй тест `09:53 UTC` создал `systemLog`, но не создал `adminAlerts.notify` schedule, что подтвердило работающий gate;
- top-level const читает env при загрузке модуля/isolate, поэтому изменение env не считать обычным runtime toggle.

Текущий production state после `f2c9042`:

- branch `emergency/drain-scheduled-jobs` pushed;
- Convex deploy live;
- backend `/version` отвечает `HTTP 200`;
- `DISABLE_ERROR_ALERT_FANOUT=1` есть в Convex deployment env;
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` есть в Convex deployment env;
- compose-файл вернут к pre-fix состоянию; единственный источник истины для `DISABLE_ERROR_ALERT_FANOUT` - Convex deployment env.

Pre-check перед следующим тиком:

- commit `f2c9042` добавил `auth.diagFanoutConfig`;
- live diagnostic PASS:
  - `env_max_concurrent="8"`;
  - `env_disable_alert_fanout="1"`;
  - `computed_concurrency=8`;
  - `computed_immediate_slots_for_3=1`;
  - `fanout_stagger_ms=7000`;
  - `sample_delays_at_3=[0,7000,14000,21000,28000,35000]`.

Тик `13:09 UTC` был первым валидным clean-кандидатом после настоящего env fix и прошел clean:

- `tokenRefreshDispatch`: `13:09:36.646Z -> 13:09:37.338Z`, `error=null`;
- backend stdout `13:09-13:22 UTC`: `0` `Too many concurrent`, `0` `Transient error`;
- `systemLogs`: `0` error-level записей за 2 часа на момент проверки;
- `_scheduled_jobs`: `0` `adminAlerts.js:notify` schedules в окне;
- `_scheduled_jobs`: `67` новых `auth.js:tokenRefreshOneV2` jobs в окне, все `success`;
- `/version`: `HTTP 200`.

Нюанс: `_creationTime` у всех новых workers одинаковый, потому что jobs созданы одним dispatcher'ом. Не использовать `_creationTime` как доказательство stagger distribution; delayed time хранится в `originalScheduledTs` в Convex integer encoding. Clean подтвержден runtime-сигналами и successful completion.

Второй подтверждающий тик `15:09 UTC` / `18:09 MSK` тоже прошел clean:

- `tokenRefreshDispatch`: `15:09:36.639Z -> 15:09:37.059Z`, `status=completed`, `error=null`;
- backend stdout `15:09-15:22 UTC`: `0` `Too many concurrent`, `0` `Transient error`;
- `systemLogs`: `0` error-level записей за 2 часа на момент проверки;
- `_scheduled_jobs`: `0` `adminAlerts.js:notify` schedules в окне;
- `_scheduled_jobs`: `30` новых `auth.js:tokenRefreshOneV2` jobs в окне, все `success`;
- общий `auth.js:tokenRefreshOneV2`: `failed=14`, `success=510`;
- `/version`: `HTTP 200`.

Итог: Phase 2 token refresh закрыта после двух clean тиков подряд (`13:09 UTC`, `15:09 UTC`).

Phase 5a manual UZ canary прошла clean: `2` V2 workers завершились `success`, backend stdout дал `0` `Too many concurrent` / `Transient error`, `adminAlerts.notify` schedules в окне = `0`, heartbeat `uzBudgetDispatch` completed/error=null.

Phase 5b cron canary прошла clean:

- commit `a52a2a3` deployed;
- `crons.interval("uz-budget-increase", { minutes: 45 }, internal.ruleEngine.uzBudgetDispatchV2)` активен;
- deploy выполнялся при `UZ_BUDGET_V2_ENABLED=0`;
- fail-closed smoke после deploy вернул `{ skipped: true, reason: "v2_disabled" }`;
- gate открыт в `2026-05-05T18:19:48Z` через `UZ_BUDGET_V2_ENABLED=1`;
- manual trigger после открытия gate не выполнялся;
- organic cron tick `18:57:10 UTC`: `2` V2 workers success;
- organic cron tick `19:42:10 UTC`: `2` V2 workers success;
- итоговый `ruleEngine.js:uzBudgetBatchWorkerV2|success|6` = `2` manual 5a + `4` cron 5b;
- backend stdout: `0` `Too many concurrent`, `0` `Transient error`;
- `systemLogs`: `0` errors;
- failed counters (`adminAlerts`, `tokenRefreshOneV2`, V1 UZ/sync) без прироста.

Gate закрыт обратно (`UZ_BUDGET_V2_ENABLED=0`) до отдельного решения оставлять UZ cron unattended. Следующий этап: Phase 6 sync metrics только через audit/prep, не через немедленное включение.

После стабилизации удалить или закрыть `diagFanoutConfig`; это временная diagnostic action.

Restore-drain checklist:

- когда `adminAlerts.notify` возвращается из no-op в настоящий handler, одновременно снять `DISABLE_ERROR_ALERT_FANOUT`;
- пройти остальные direct call-sites `adminAlerts.notify` и добавить dedup/guard перед полным восстановлением alert fan-out;
- долгосрочно заменить `runAfter(0)` на каждый error log на batched/dedup alert queue.
- провести audit `process.env.*` в `convex/`: все значения, нужные application code внутри V8 isolate, должны быть доступны через Convex deployment env, не только container env.

## Фаза 0: зафиксировать drain baseline

Перед возвратом кода сохранить числа:

```sql
-- _scheduled_jobs по текущему latest state, не по history versions
WITH latest AS (
  SELECT DISTINCT ON (id)
    id,
    ts,
    deleted,
    convert_from(json_value,'UTF8')::jsonb AS j
  FROM documents
  WHERE table_id = decode('7ee519d746cd4bc3221534e5d95c5010','hex')
  ORDER BY id, ts DESC
)
SELECT
  j #>> '{state,type}' AS state_type,
  count(*) AS rows
FROM latest
WHERE NOT deleted
GROUP BY 1
ORDER BY count(*) DESC;
```

Также зафиксировать:

- `_scheduled_jobs.pending`
- `_scheduled_jobs.inProgress`
- `_scheduled_jobs.failed`
- размер `pg_wal`
- размер `documents`
- размер `indexes`

```bash
docker exec adpilot-postgres du -sh /var/lib/postgresql/data/pg_wal /var/lib/postgresql/data
```

## Как НЕ надо мониторить `_scheduled_jobs`

Не использовать raw-подсчет по `documents`:

```sql
SELECT
  convert_from(json_value,'UTF8')::jsonb #>> '{state,type}' AS state_type,
  count(*) AS rows
FROM documents
WHERE table_id = decode('7ee519d746cd4bc3221534e5d95c5010','hex')
  AND NOT deleted
GROUP BY 1;
```

Почему нельзя: Convex storage хранит исторические версии одного document id. Один scheduled job может иметь строки `pending`, `inProgress` и `success`; raw-подсчет покажет ложную живую очередь.

Использовать только latest-version запросы через `DISTINCT ON (id) ... ORDER BY id, ts DESC`.

Готовый файл:

```bash
docs/sql/convex-scheduled-jobs-latest-state.sql
```

Список временно отключенного drain-кодом:

- `vkApiLimits.recordRateLimit` no-op
- `syncMetrics.syncBatchWorker` no-op
- `ruleEngine.uzBudgetBatchWorker` no-op
- `auth.tokenRefreshOne` no-op
- `adminAlerts.notify` no-op
- `metrics.manualMassCleanup` no-op
- тяжелые crons в `convex/crons.ts`
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=4`

## Фаза 1: вернуть безопасные уведомления и диагностику

Включить обратно:

- `adminAlerts.notify`
- `system-health-check`
- `budget-health-check`
- `cleanup-stuck-payments`
- `cleanup-old-logs`
- `cleanup-expired-invites`

Наблюдать 10-15 минут:

- backend жив;
- pending не растет резко;
- WAL не растет гигабайтами;
- Telegram не заспамлен.

Если pending backlog по `adminAlerts.js:notify` еще значительный и есть риск массовых старых алертов, не возвращать `adminAlerts.notify` сразу. Сначала оставить no-op, а диагностику включить без Telegram side effects или с новым dedup/guard.

## Фаза 2: вернуть token refresh через V2

Не возвращать реальную логику в:

- `auth.tokenRefreshOne`

Пока в `_scheduled_jobs` есть pending backlog по `auth.js:tokenRefreshOne`, V1 остается no-op.

Включить через V2:

- `auth.tokenRefreshOneV2`
- `tokenRefreshDispatch` / `proactive-token-refresh`, переключенные на V2

Оставить:

```bash
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8
```

Проверить:

- нет шквала token errors;
- pending по `auth.js:tokenRefreshOne` не растет;
- pending по `auth.js:tokenRefreshOneV2` маленький или около нуля;
- `cronHeartbeat` для `tokenRefreshDispatch` обновляется;
- accounts не уходят массово в error.

Не начинать эту фазу как V1-restore. Если V2 не готов, Phase 2 откладывается.

Статус Phase 2 на `2026-05-05 05:49 UTC`:

- commit `c34bbc3` deployed;
- helper учитывает `slotsPerWorker`, но значение `2` оказалось заниженным;
- `tokenRefreshDispatch`/`proactive-token-refresh` включены через V2;
- тик около `2026-05-05 07:09 UTC` не прошел clean;
- следующий статусный шаг - hotfix `slotsPerWorker=3`, `FANOUT_STAGGER_MS=7000`.

## Фаза 3: вернуть low-frequency cleanup

Включить:

- `metrics.manualMassCleanup`
- `cleanup-old-metrics-daily`
- `cleanup-old-realtime-metrics`
- `cleanup-old-ai-generations`
- `cleanup-credential-history`

Проверять:

- `pg_wal`
- общий размер Postgres data dir
- CPU/RAM Postgres
- логи Postgres checkpoint

Если WAL быстро растет, остановить cleanup и уменьшать batch size/частоту.

## Фаза 4: вернуть read/report/background jobs

Включить:

- `daily-digest`
- `weekly-digest`
- `monthly-digest`
- `monthly-org-report`
- `ai-recommendations`
- `analyze-new-creatives`
- `validate-community-profiles`
- `agency-token-health`
- `function-verification`

Проверить:

- нет внешнего API storm;
- pending по этим функциям не копится;
- backend остается доступен.

## Фаза 5: вернуть UZ/video

Перед включением желательно уже иметь фикс: stagger вместо `runAfter(0)`.
Не переносить старый паттерн `runAfter(0)` из `dispatchUzBatches`; Phase 5 blocked, пока UZ dispatcher не получит stagger, рассчитанный от `APPLICATION_MAX_CONCURRENT_V8_ACTIONS`.
Перед патчем UZ сделать audit именно worker body:

```bash
grep -n "ctx\\.runAction" convex/ruleEngine.ts | head -20
```

Для UZ/sync `slotsPerWorker` нельзя автоматически брать из token refresh. Там fan-out идет по chunk workers, а worker может держать action slot долго.

Включить:

- `video-rotation-tick`
- `uz-budget-reset`
- `ruleEngine.uzBudgetBatchWorker`
- `uz-budget-increase`

Проверять:

- pending по `ruleEngine.js:uzBudgetBatchWorker`;
- action logs;
- бюджетные изменения;
- VK API errors.

Не возвращать `ruleEngine.uzBudgetBatchWorker`, пока pending backlog по `ruleEngine.js:uzBudgetBatchWorker` не очищен или не отменен безопасным способом.

## Фаза 6: вернуть sync metrics

Это самая опасная фаза. Возвращать последней из core business jobs.

Статус на `2026-05-06`: Phase 6 sync V2 deployed through manual canary. Phase 6a first run was yellow-clean due sync escalation alert schedules; Phase 6a-bis after guard `9f62cfa` closed clean. Phase 6b cron canary is the next separate prepare step.

- `e478dcb` - V2 entrypoints: `syncDispatchV2`, `dispatchSyncBatchesV2`, `syncBatchWorkerV2`, fail-closed gate `SYNC_METRICS_V2_ENABLED`, separate moderation gate `SYNC_METRICS_V2_POLL_MODERATION`, monitoring script `check-sync-tick.cjs`.
- `ed5d5bf` - runtime env reads for `SYNC_WORKER_COUNT_V2` / `SYNC_BATCH_SIZE_V2` and explicit V1 cron warning.
- `a510695` - `check-sync-tick.cjs` counts per-account `syncBatchV2` failures and the ready-to-uncomment V1 5-min sync cron block is physically removed.
- `3f92025` - docs guardrails for Phase 6 handoff.
- `9f62cfa` - sync escalation alert guard; suppresses `adminAlerts.notify` scheduling unless `SYNC_ESCALATION_ALERTS_ENABLED=1`.

Перед включением обязательно:

- убрать `runAfter(0)` fan-out;
- добавить stagger;
- считать immediate/stagger batch от `APPLICATION_MAX_CONCURRENT_V8_ACTIONS`, а не хардкодить под `32`;
- добавить guard: если предыдущий `syncDispatch` еще не завершен, новый dispatch делает skip;
- guard должен читать предыдущий `cronHeartbeats[name=syncDispatch]` до собственной записи `status=running`;
- временно снизить `WORKER_COUNT` с `6` до `2`, если нужен дополнительный safety margin.
- для первого Phase 6a manual run поставить `SYNC_WORKER_COUNT_V2=1`, `SYNC_BATCH_SIZE_V2=10`, `SYNC_METRICS_V2_POLL_MODERATION=0`;
- держать `SYNC_ESCALATION_ALERTS_ENABLED=0`, пока `adminAlerts.notify` остается no-op в drain-mode;
- запускать manual trigger только в окне `xx:25-xx:55 UTC`, чтобы не пересекаться с token refresh cron (`xx:09:36 UTC`, около 10 минут dispatching);
- не считать worker `success` достаточным clean-критерием: `syncBatchWorkerV2` может поймать per-account error, продолжить цикл и завершиться как scheduled job `success`;
- `check-sync-tick.cjs` должен считать backend stdout `syncBatchV2.*Account .* failed`; любой non-zero count = канарейка не clean.

Перед патчем sync сделать audit именно worker body:

```bash
grep -n "ctx\\.runAction" convex/syncMetrics.ts | head -20
```

Включать только V2:

- Phase 6a: manual trigger `internal.syncMetrics.syncDispatchV2` при `SYNC_METRICS_V2_ENABLED=1`.
- Phase 6b: `sync-metrics` cron только на `internal.syncMetrics.syncDispatchV2`, interval `45 min`; first cron canary should keep `SYNC_WORKER_COUNT_V2=1`, `SYNC_BATCH_SIZE_V2=10`, `SYNC_METRICS_V2_POLL_MODERATION=0`, `SYNC_ESCALATION_ALERTS_ENABLED=0`.

Не включать V1:

- `syncMetrics.syncBatchWorker`
- `syncMetrics.syncDispatch`
- старый `sync-metrics` cron с interval `5 min`

Важно: старый V1 5-min `crons.interval(... internal.syncMetrics.syncDispatch)` больше не хранится в `convex/crons.ts` как готовый commented block. Это сделано намеренно, чтобы будущий operator не включил V1 случайно.

Проверять каждые 5-10 минут:

```sql
WITH latest AS (
  SELECT DISTINCT ON (id)
    id,
    ts,
    deleted,
    convert_from(json_value,'UTF8')::jsonb AS j
  FROM documents
  WHERE table_id = decode('7ee519d746cd4bc3221534e5d95c5010','hex')
  ORDER BY id, ts DESC
)
SELECT
  j ->> 'udfPath' AS udf_path,
  j #>> '{state,type}' AS state_type,
  count(*) AS rows
FROM latest
WHERE NOT deleted
GROUP BY 1, 2
ORDER BY count(*) DESC
LIMIT 30;
```

Также проверять:

- размер `pg_wal`;
- свежесть `lastSyncAt`;
- логи `adpilot-convex-backend`;
- ошибки VK API.

Не возвращать `syncMetrics.syncBatchWorker`, пока pending backlog по `syncMetrics.js:syncBatchWorker` не очищен или не отменен безопасным способом.

## Фаза 7: вернуть `vkApiLimits`

Это источник главной очереди. Не возвращать в прежнем виде.

Перед возвратом изменить механику:

- не создавать scheduled job на каждый API response;
- либо прямой bounded insert только для `429`;
- либо sampling/rate-limit: максимум 1 запись на `account + endpoint + minute`;
- либо агрегировать в action и писать batch.

Только после этого включить:

- `vkApiLimits.recordRateLimit`
- `vk-throttling-probe`
- producer'ы в `vkApi.ts`

Не возвращать `recordRateLimit` в прежнем виде даже после drain. Это главный источник очереди.

## Фаза 8: вернуть concurrency

После 12-24 часов стабильности:

```bash
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8
```

Если стабильно:

```bash
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16
```

К `32` возвращаться только если есть явная причина и мониторинг показывает, что scheduler, Postgres и внешние API выдерживают нагрузку.

## Главное правило

Ничего не включать пачкой.

Каждая фаза:

1. deploy;
2. 10-30 минут наблюдения;
3. проверка pending/inProgress/WAL;
4. только потом следующая фаза.

Самые последние к возврату:

- `sync-metrics`
- `vkApiLimits.recordRateLimit`
