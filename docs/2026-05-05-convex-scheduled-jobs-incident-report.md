# Отчет по сбою Convex scheduled jobs, 4-5 мая 2026

Дата инцидента: 4-5 мая 2026
Сервис: AdPilot / aipilot.by / self-hosted Convex + Postgres
Статус на момент диагностики: VPS живой, frontend поднимается, Convex backend остановлен, Postgres поднят отдельно для диагностики.
Emergency branch: `emergency/drain-scheduled-jobs`
Emergency commit: `f4523486aa5ed399a4b676afbd4b76411df21b5d` (`emergency: drain-mode no-op handlers for scheduled jobs queue`)
Phase 1 commit: `7aa2170` (safe cleanup crons restored)

## Кратко

Сервис стал недоступен снаружи: `aipilot.by`, `convex.aipilot.by` и прямой Convex endpoint таймаутились. SSH также был нестабилен: TCP-порт принимал соединение, но SSH banner часто не отдавался.

После перезагрузки сервер частично оживал, но Convex backend при запуске создавал или поднимал сильную нагрузку и затем останавливался.

Главная найденная проблема: в Convex scheduler накопилась очень большая очередь `_scheduled_jobs`.

На момент обновления отчета подготовлен drain-mode patch: старые pending scheduled jobs должны быстро завершаться no-op handlers, а новые producers/crons временно отключены.

Post-deploy observation: drain-mode стабилизировал backend, но не дал быстрого drain. После первичного drain scheduler обрабатывал очередь примерно `10-12 jobs/min`; после Phase 1 скорость выросла примерно до `25-30 jobs/min`, но полный drain все равно занял бы дни.

Текущее состояние после Phase 1:

- frontend `https://aipilot.by` отвечает `HTTP 200`;
- Convex `/version` отвечает `HTTP 200`, около `57ms`;
- backend healthy, uptime около `12 min` на момент замера;
- `cleanup-stuck-payments`, `cleanup-old-logs`, `cleanup-expired-invites` восстановлены;
- backlog продолжает медленно дренироваться.

## Влияние

- Пользовательский frontend открывался нестабильно или не открывался.
- Backend Convex был недоступен, приложение полноценно не работало.
- Автоматические sync/cron/rules/token jobs не выполнялись штатно.
- Был риск дальнейшего роста Postgres/WAL/Docker logs при повторных рестартах Convex.

## Подтвержденные симптомы

- `https://aipilot.by` -> timeout.
- `https://convex.aipilot.by/version` -> timeout или кратковременный `HTTP 200`.
- `http://178.172.235.49:3220/version` -> соединение устанавливалось, но ответа не было.
- SSH периодически падал на `Connection timed out during banner exchange`.
- После ребута сервер отвечал кратко, затем снова становился нестабильным.

## Состояние сервера

На момент успешного SSH-доступа:

- Диск: `/` занят примерно `167G / 315G`, свободно около `136G`, то есть диск не был заполнен.
- RAM: `39Gi total`, около `37Gi available`.
- Swap не использовался.
- `adpilot-frontend` был `healthy`.
- `dokploy-traefik` был поднят.
- `adpilot-postgres` удалось поднять отдельно.
- `adpilot-convex-backend` был остановлен.
- `adpilot-convex-dashboard` был остановлен.

## Postgres / Convex storage

Реальная база: `adpilot_prod`.

Основные размеры:

- `documents`: около `50 GB`
- `indexes`: около `93 GB`
- Postgres data dir: около `144 GB`
- `pg_wal`: около `3.6 GB`

Таблица Convex `_scheduled_jobs` по простому подсчету версий в `documents`:

- Всего строк: `1,416,507`
- `success`: `837,946`
- `pending`: `268,748`
- `inProgress`: `18,374`
- `failed`: `1,388`
- deleted/tombstones: `290,051`

Основная pending-очередь по этому первичному подсчету:

```text
vkApiLimits.js:recordRateLimit       248,692
ruleEngine.js:uzBudgetBatchWorker      6,126
syncMetrics.js:syncBatchWorker         6,114
auth.js:tokenRefreshOne                2,361
adminAlerts.js:notify                  2,244
adAccounts.js:deleteBatch              1,626
metrics.js:manualMassCleanup           1,580
```

Важное уточнение после Phase 2: `documents` хранит версии одного и того же document id. Один `_scheduled_jobs` id может иметь несколько строк в `documents`: сначала `pending`, затем `inProgress`, затем `success`. Поэтому простые запросы с `WHERE NOT deleted` показывают историю версий, а не только текущее состояние job.

Корректный текущий state нужно считать по latest version на `(table_id, id)`:

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
  j #>> '{state,type}' AS state_type,
  count(*) AS rows
FROM latest
WHERE NOT deleted
GROUP BY 1
ORDER BY count(*) DESC;
```

На latest-version проверке после Phase 2:

```text
success 543,521
failed      115
```

Текущих `pending` / `inProgress` по latest state не найдено. Большие числа `pending` в старом мониторинге были историческими версиями jobs, а не живой очередью.

## Ключевое наблюдение

Первичная гипотеза "все scheduled jobs уже success" оказалась неполной. Sample действительно попадал в `success`, но полный подсчет показал большую активную очередь: `268k pending` + `18k inProgress`.

Основная масса pending jobs - не `syncBatchWorker`, а `vkApiLimits.recordRateLimit`.

Отдельный вывод: удалять `_scheduled_jobs` напрямую из Postgres нельзя считать безопасным вариантом восстановления. Convex хранит документы, индексы, args и tombstones в собственном storage-формате (`documents`, `indexes`), поэтому прямое удаление может нарушить инварианты scheduler/storage.

Post-deploy уточнение: scheduler не заблокирован полностью, но работает медленно. Сначала drain шел около `10-12 jobs/min`; после Phase 1 и стабилизации backend наблюдалось около `25-30 jobs/min`. Это лучше, но все еще означает много дней до полного опустошения очереди. `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` убрал `Too many concurrent requests`, но не сделал drain достаточно быстрым для ожидания полного завершения.

## Вероятная причина

Наиболее вероятная причина сбоя: накопление огромной очереди Convex scheduled jobs, особенно telemetry jobs `vkApiLimits.recordRateLimit`, плюс fan-out jobs от sync/UZ/token/alerts.

При старте Convex backend scheduler пытался обрабатывать большой backlog. Это приводило к всплеску действий, fetch-запросов, записей статусов jobs, обновлений индексов и WAL. На фоне этого backend становился нестабильным или останавливался.

## Факторы усиления

- `sync-metrics` запускается каждые 5 минут.
- `syncDispatch` создает batch workers через `runAfter(0)`.
- `uz-budget-increase` тоже каждые 5 минут и тоже fan-out.
- `vkApiLimits.recordRateLimit` создавался как scheduled job на множество VK API responses.
- Повторные рестарты могли усиливать цикл: старт -> scheduler/fetch/write storm -> зависание/shutdown -> recovery -> повтор.

## Что не является основной причиной

- DNS не был причиной: домены резолвились в `178.172.235.49`.
- Диск не был полностью заполнен.
- RAM на момент проверки была свободна.
- Сеть контейнеров до `target.my.com` была проверена отдельно и работала.

## Рекомендованный план восстановления

1. Держать `adpilot-convex-backend` выключенным.
2. Поднять только `adpilot-postgres`.
3. Не запускать `check-full-health.cjs` и dashboard до drain.
4. Подготовить и задеплоить emergency drain-патч:
   - `vkApiLimits.recordRateLimit` -> no-op
   - `syncMetrics.syncBatchWorker` -> no-op
   - `ruleEngine.uzBudgetBatchWorker` -> no-op
   - `auth.tokenRefreshOne` -> no-op
   - `adminAlerts.notify` -> no-op
   - `metrics.manualMassCleanup` -> no-op
5. Сохранить точные типы функций и args validators.
6. Не трогать `adAccounts.deleteBatch` без отдельной выгрузки args.
7. Временно отключить crons в `convex/crons.ts`.
8. Поставить `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=4`.
9. Запустить Convex backend и быстро задеплоить drain-код.
10. Дождаться уменьшения `pending/inProgress`.
11. Вернуть нормальный код отдельным revert-коммитом, но уже с фиксами fan-out/stagger/guards.

## Подготовленный drain-патч

Коммит: `f4523486aa5ed399a4b676afbd4b76411df21b5d`

Ветка: `emergency/drain-scheduled-jobs`

Измененные файлы:

```text
convex/adminAlerts.ts
convex/auth.ts
convex/crons.ts
convex/metrics.ts
convex/ruleEngine.ts
convex/syncMetrics.ts
convex/vkApi.ts
convex/vkApiLimits.ts
```

Drain handlers:

- `vkApiLimits.recordRateLimit` -> `internalMutation`, args сохранены, handler возвращает `null`.
- `syncMetrics.syncBatchWorker` -> `internalAction`, args сохранены, no-op.
- `ruleEngine.uzBudgetBatchWorker` -> `internalAction`, args сохранены, no-op.
- `auth.tokenRefreshOne` -> `internalAction`, args сохранены, no-op.
- `adminAlerts.notify` -> `internalAction`, args сохранены, no-op.
- `metrics.manualMassCleanup` -> `internalAction`, args сохранены, no-op. Это также останавливает self-reschedule chain, потому что no-op не вызывает `ctx.scheduler.runAfter`.

Producer guards:

- В `convex/vkApi.ts` четыре producer'а `recordRateLimit` временно обернуты в `if (false && hasData)`, чтобы во время drain не пополнять очередь `vkApiLimits.js:recordRateLimit`.

Crons:

- В `convex/crons.ts` в коммите `f452348` закомментированы все cron registrations.
- Файл остается валидным и экспортирует пустой `cronJobs()` object.
- Это намеренно: цель drain - максимально тихий backend, без новых scheduled jobs, внешних API calls и фоновых writes.

Исключено из drain:

- `adAccounts.deleteBatch` не переведен в no-op. Это cascade delete, а не telemetry. Pending jobs этого типа должны выполняться штатно или разбираться отдельно после выгрузки args.

## Проверки drain-патча

Локальные проверки:

```bash
npx tsc --noEmit -p convex/tsconfig.json
```

Результат: clean.

Ожидаемое отклонение:

```bash
npm run test:unit -- convex/vkApiLimits.test.ts
```

Результат: `2 failed | 1 passed`.

Причина: тесты `recordRateLimit` ожидают insert id, а drain-mode handler намеренно возвращает `null`. Это ожидаемо для аварийного drain-коммита. Production deploy workflow `.github/workflows/deploy.yml` не зависит от CI unit tests: job `deploy-convex` делает `npm ci` и `npx convex deploy --yes`.

## Стратегия деплоя drain

Рекомендуемый вариант: локальный deploy, а не ожидание стандартного CI/CD.

Причины:

- быстрее;
- не зависит от красного CI;
- не запускает лишний Docker build как часть обычного deploy flow;
- позволяет попасть в короткое окно после старта Convex backend.

Порядок:

1. Push ветки как backup:

```bash
git push origin emergency/drain-scheduled-jobs
```

2. В Dokploy перед стартом backend добавить safety env:

```bash
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=4
```

При необходимости для еще более мягкого drain можно использовать `2`.

3. Включить только:

- `adpilot-postgres`
- `adpilot-convex-backend`

Не включать до drain:

- `adpilot-convex-dashboard`
- ручные health-check scripts
- `check-full-health.cjs`

4. Сразу после старта backend выполнить локальный deploy с self-hosted admin key:

```bash
CONVEX_SELF_HOSTED_URL=https://convex.aipilot.by \
CONVEX_SELF_HOSTED_ADMIN_KEY="<admin-key>" \
npx convex deploy --yes
```

Fallback, если Traefik/TLS тормозит:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="<admin-key>" \
npx convex deploy --yes
```

После deploy удалить временный файл с admin key, если он создавался, например `/tmp/admin-key.txt`.

## Мониторинг drain

Главный запрос для контроля state:

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
  j #>> '{state,type}' AS state_type,
  count(*) AS rows
FROM latest
WHERE NOT deleted
GROUP BY 1
ORDER BY count(*) DESC;
```

Top by `udfPath`:

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

Также смотреть:

```bash
docker logs -f --tail 120 adpilot-convex-backend
docker stats --no-stream adpilot-postgres adpilot-convex-backend
docker exec adpilot-postgres du -sh /var/lib/postgresql/data/pg_wal /var/lib/postgresql/data
curl -i --max-time 10 https://convex.aipilot.by/version
curl -I --max-time 10 https://aipilot.by
```

Критерий успешного drain:

- Convex backend живет 5-10 минут и не уходит в crash loop.
- `/version` отвечает стабильно.
- `_scheduled_jobs.pending` уменьшается.
- `_scheduled_jobs.inProgress` уменьшается или стабилизируется около нуля.
- `pg_wal` не растет гигабайтами.
- В логах нет нового шквала `target.my.com`.

Фактический результат после drain deploy:

- Backend стабилен.
- `/version` отвечает примерно `50-100ms`.
- Backend RAM около `70-80MB` в спокойном состоянии.
- Host/Postgres не перегружены.
- `pg_wal` стабилен около `3.4G`.
- `Too many concurrent requests` исчезли после повышения concurrency до `8`.
- Первичный drain rate был около `10-12 jobs/min`.
- Postgres не показывает активной нагрузки от scheduler.

Фактический результат после Phase 1:

- Commit `7aa2170` deployed.
- Восстановлены `cleanup-stuck-payments`, `cleanup-old-logs`, `cleanup-expired-invites`.
- Frontend `aipilot.by` отвечает `HTTP 200`.
- Convex `/version` отвечает `HTTP 200`, около `57ms`.
- Backend healthy, uptime около `12 min` на момент замера.
- `_scheduled_jobs.pending`: `268,577` -> `268,090` (`-487`).
- `_scheduled_jobs.inProgress`: `18,400` -> `18,417` (`+17`).
- `_scheduled_jobs.failed`: `1,414` -> `1,466` (`+52`).
- `_scheduled_jobs.success`: `838,222` -> `838,000`; снижение объясняется GC/history cleanup.
- Drain rate около `25-30 jobs/min`.

Фактический результат после Phase 2 V2:

- `auth.tokenRefreshOneV2` deployed как real handler.
- `auth.tokenRefreshOne` V1 остается no-op для старых ссылок.
- Простые history-запросы показывали `auth.js:tokenRefreshOneV2 pending=82`, но latest-version запрос показал, что это уже не текущий pending.
- Latest state по `_scheduled_jobs`: `success=543,521`, `failed=115`, текущих `pending/inProgress` нет.
- Top latest failed:
  - `syncMetrics.js:syncBatchWorker`: `37`
  - `adminAlerts.js:notify`: `36`
  - `ruleEngine.js:uzBudgetBatchWorker`: `36`
  - `auth.js:tokenRefreshOneV2`: `5`
  - `metrics.js:manualMassCleanup`: `1`

Вывод: стратегия V2 сработала лучше, чем показывал старый мониторинг. Дальше решения нужно принимать по latest-version queries, а не по raw history rows.

## Решение после медленного drain

Не ждать полного опустошения `_scheduled_jobs` перед частичным восстановлением пользовательского сервиса.

Выбранная стратегия: degraded restore + V2 versioned restore.

Оставить no-op до отдельного решения по очереди:

- `vkApiLimits.recordRateLimit`
- `syncMetrics.syncBatchWorker`
- `ruleEngine.uzBudgetBatchWorker`
- `auth.tokenRefreshOne`
- `adminAlerts.notify` до контролируемого включения
- `metrics.manualMassCleanup`

Оставить выключенными до фиксов:

- `sync-metrics`
- `uz-budget-increase`
- `proactive-token-refresh`
- `vk-throttling-probe`
- producer'ы `recordRateLimit` в `vkApi.ts`

Можно начинать возвращать только безопасные crons/handlers, которые не создают новый fan-out и не поднимают старый backlog. Полный план включения обратно вынесен в `docs/2026-05-05-convex-drain-reenable-plan.md`.

Для функций с backlog не возвращать реальную логику в старые names. Новая работа должна идти через новые entrypoints, например `auth.tokenRefreshOneV2`, а старый `auth.tokenRefreshOne` остается no-op до drain/purge старой очереди.

## Постоянные исправления после drain

- Убрать `runAfter(0)` fan-out для пачек.
- Добавить stagger для sync/UZ/token workers.
- Добавить lock/heartbeat guard, чтобы новый dispatch не стартовал поверх незавершенного.
- Переписать `vkApiLimits.recordRateLimit`, чтобы не создавать scheduled job на каждый API response.
- Добавить retention/cleanup для scheduled job history, если Convex self-hosted не чистит ее достаточно агрессивно.
- Добавить мониторинг количества `_scheduled_jobs` по state: `pending`, `inProgress`, `failed`, `success`.
