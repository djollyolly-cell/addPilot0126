# План запуска после drain `_scheduled_jobs`

Дата: 5 мая 2026
Контекст: аварийный drain Convex `_scheduled_jobs` после накопления большой очереди pending/inProgress jobs.

Цель этого плана: вернуть сервис в штатную работу по фазам, не включив обратно все producers/fan-out jobs одновременно.

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
- Первый batch должен быть не больше половины `APPLICATION_MAX_CONCURRENT_V8_ACTIONS`; при concurrency `8` это `4` jobs.
- Не хардкодить `16/8` под старый concurrency `32`. Считать immediate/stagger batch от `process.env.APPLICATION_MAX_CONCURRENT_V8_ACTIONS`, чтобы bump concurrency не требовал ручного изменения кода.
- Dispatcher должен обновлять свой `cronHeartbeat`, чтобы health check видел актуальное состояние.
- Желательно иметь kill switch для V2, чтобы отключить новую работу без отката всего drain-патча.
- `recordRateLimit` не включать через V2 в рамках emergency. Для него нужен отдельный bounded redesign.

Порядок первого V2-релиза:

1. Audit всех call-sites и `cronHeartbeat` references.
2. Реализовать только `auth.tokenRefreshOneV2` как точную копию рабочей V1-логики.
3. Обновить `tokenRefreshDispatch`, direct callers и cron на V2.
4. Если `tokenRefreshDispatch` делает fan-out, добавить stagger и ограничить первый batch до `4` jobs при текущем concurrency `8`.
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

Только после стабильности переходить к следующей области, например `syncBatchWorkerV2`.

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

Перед включением обязательно:

- убрать `runAfter(0)` fan-out;
- добавить stagger;
- считать immediate/stagger batch от `APPLICATION_MAX_CONCURRENT_V8_ACTIONS`, а не хардкодить под `32`;
- добавить guard: если предыдущий `syncDispatch` еще не завершен, новый dispatch делает skip;
- временно снизить `WORKER_COUNT` с `6` до `2`, если нужен дополнительный safety margin.

Включить:

- `syncMetrics.syncBatchWorker`
- `sync-metrics`

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
