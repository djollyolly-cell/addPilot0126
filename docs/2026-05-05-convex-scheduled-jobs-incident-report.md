# Отчет по сбою Convex scheduled jobs, 4-5 мая 2026

Дата инцидента: 4-5 мая 2026
Сервис: AdPilot / aipilot.by / self-hosted Convex + Postgres
Статус на момент диагностики: VPS живой, frontend поднимается, Convex backend остановлен, Postgres поднят отдельно для диагностики.
Emergency branch: `emergency/drain-scheduled-jobs`
Emergency commit: `f4523486aa5ed399a4b676afbd4b76411df21b5d` (`emergency: drain-mode no-op handlers for scheduled jobs queue`)
Phase 1 commit: `7aa2170` (safe cleanup crons restored)

Связанный отчет по выполнению плана восстановления: `docs/2026-05-05-convex-recovery-plan-execution-report.md`.

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

Фактический результат после первого полного token refresh тика:

- `tokenRefreshDispatch` heartbeat: `completed`, без `error`, duration около `605ms`.
- `/version` отвечал `HTTP 200`.
- Pending по dispatcher не рос.
- Критерий "нет новых Too many concurrent requests" не прошел: в окне тика появилось `4` ошибки `Too many concurrent requests` в token refresh worker'ах.
- Примеры источника: `auth` / VK token refresh failures для `user_vk` targets.

Причина: commit `4373678` считал immediate fan-out как `floor(APPLICATION_MAX_CONCURRENT_V8_ACTIONS / 2)`. При concurrency `8` это давало `4` immediate workers. Но `tokenRefreshOneV2` внутри worker вызывает nested `ctx.runAction` (`getValidTokenForAccount`, `getValidVkAdsToken`, `getValidVkToken`), поэтому один worker может занимать больше одного V8 action slot в пике. `4 workers * 2 slots` насыщают весь лимит `8`, не оставляя headroom для других system actions/crons.

Корректирующий hotfix:

- Commit: `c34bbc3` (`fix: account for sub-action V8 slots in token refresh fan-out stagger`)
- Branch push: `emergency/drain-scheduled-jobs` `4373678..c34bbc3`
- Convex deploy: успешно задеплоено на `https://convex.aipilot.by`
- `/version` после deploy: `HTTP 200`, около `1.37-1.46s`
- Время deploy/checkpoint: около `2026-05-05 05:49 UTC`

Новая формула:

```text
immediate = floor(concurrency / (slotsPerWorker * 2))
```

Для token refresh:

```text
concurrency = 8
slotsPerWorker = 2
immediate = floor(8 / (2 * 2)) = 2 workers
```

Исторический gate после `c34bbc3`:

- last successful `tokenRefreshDispatch`: `2026-05-05 05:09:36 UTC`
- interval: `2h`
- next tick: около `2026-05-05 07:09:36 UTC`
- окно проверки: `07:08-07:20 UTC`

Критерий clean:

- `cronHeartbeats[name=tokenRefreshDispatch]`: `status=completed`, `error=null`, `finishedAt > 2026-05-05 07:09 UTC`
- `systemLogs` за окно `07:08-07:20 UTC`: `0` записей с `Too many concurrent requests`
- `systemLogs` за окно `07:08-07:20 UTC`: `0` новых `level=error`, `source=auth` про token refresh failures
- `/version`: `HTTP 200`

Пока этот gate не пройден, не переходить к UZ/sync восстановлению.

Итог: этот gate не был пройден. Результат зафиксирован ниже.

Фактический результат контрольного тика `2026-05-05 07:09 UTC`:

- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` подтверждено в контейнере.
- Backend не рестартовался; Convex deploy выполнялся hot-load.
- Latest-state `_scheduled_jobs`: текущих `pending/inProgress` для token refresh нет; проблема не в очереди, а в peak saturation во время тика.
- `auth.js:tokenRefreshOneV2`: `236 success`, `14 failed`, `0 pending`, `0 inProgress` на момент проверки.
- Backend stdout в окне `07:09:30-07:10:30 UTC` показал десятки `Too many concurrent requests`, больше чем попало в `systemLogs`.
- Первый warning появился около `07:09:42 UTC`, примерно через `6s` после старта dispatch.
- Waves шли каждые `5-7s`, что больше прежнего `FANOUT_STAGGER_MS=3000`; batch'и накладывались.

Уточненная причина:

```text
tokenRefreshOneV2                         slot 1
  -> getValidVkToken/getValidVkAdsToken/
     getValidTokenForAccount              slot 2
       -> refreshVkToken/refreshVkAdsToken/
          refreshTokenForAccount          slot 3
```

Для account-ветки fallback-пути могут вызывать и другие provider actions, поэтому `slotsPerWorker=3` - минимально подтвержденная безопасная оценка, а не верхняя граница для всех веток.

Что не подтвердилось:

- `retryRecovery` не был главным потребителем slots;
- старый `proactiveTokenRefresh` V1 не запускался параллельно;
- user-facing requests не были основной причиной;
- stagger работает, но был откалиброван неправильно.

Новый корректирующий hotfix:

- `slotsPerWorker` для token refresh: `2 -> 3`
- `FANOUT_STAGGER_MS`: `3000 -> 7000`
- При concurrency `8`: `immediate = floor(8 / (3 * 2)) = 1 worker`
- Ожидаемое время dispatch для `80-90` targets: около `9-10 min`

Пока этот hotfix не пройдет clean тик, UZ/sync остаются заблокированы.

Требование к закрытию Phase 2:

- пройти `2` clean token refresh тика подряд;
- проверять both sources: backend stdout и `systemLogs`;
- окно проверки каждого тика держать не меньше `11-12 min`;
- до этого не bump'ать concurrency `8 -> 16`;
- до этого не merge'ить emergency branch в `main`;
- до этого не включать UZ/sync.

Команда для проверки backend stdout:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker logs adpilot-convex-backend --since <window-start> --until <window-end> 2>&1 \
   | grep -cE 'Too many concurrent|Transient error'"
```

Риск cron collision: token refresh теперь может занимать около `9-10 min`, поэтому другие crons, попавшие в это окно, могут конкурировать за V8 action slots. Если будет overlap, не считать это автоматически поломкой token refresh; сначала проверить, какие crons работали в том же окне. Возможные решения: фиксированное cron-расписание со смещением вместо `crons.interval({ hours: 2 })`, если поддерживается текущим setup, или guard/skip при занятости.

Дополнительная причина amplification loop:

В окне тика `09:09 UTC` найдено точное совпадение между token refresh errors и scheduled jobs `adminAlerts.js:notify`. Причина в `convex/systemLogger.ts`: при `level="error"` он автоматически schedule'ит `internal.adminAlerts.notify` через `runAfter(0)`.

В drain-mode `adminAlerts.notify` является no-op, но scheduled action все равно не бесплатный: он занимает V8 action slot, загружает функцию и завершает job. Поэтому каждая token refresh ошибка могла создавать дополнительный no-op alert worker, который конкурировал с последующими token refresh workers и усиливал `Too many concurrent`.

Корректирующий gate:

- Commit: `9aa3a68` (`fix: env-gated guard for error alert fan-out`)
- Флаг: `DISABLE_ERROR_ALERT_FANOUT=1`
- Место фикса: `convex/systemLogger.ts`
- Смысл: error logs продолжают записываться, но больше не создают `adminAlerts.notify` fan-out при включенном флаге.

Урок по env scope:

- container env через compose был добавлен и backend был пересоздан;
- после первого теста выяснилось, что этого недостаточно для Convex function env: `systemLog` в `09:52 UTC` все еще создал `adminAlerts.notify` schedule;
- после установки флага в Convex deployment env второй тест в `09:53 UTC` создал `systemLog`, но `adminAlerts.notify` schedule уже не создался;
- значит для таких function-level guards нужно проверять именно Convex deployment env, а не только container env;
- такой же флаг оставлен в compose как fallback, но compose правился напрямую; после стабилизации продублировать в Dokploy UI.

Текущий статус после `9aa3a68`:

- branch `emergency/drain-scheduled-jobs` pushed;
- Convex deploy live;
- backend healthy;
- `/version` отвечает `HTTP 200`;
- `DISABLE_ERROR_ALERT_FANOUT=1` verified working;
- после restart с `09:34 UTC` backend stdout не показывал `Too many concurrent` / `Transient error`;
- после `09:34 UTC` новых `adminAlerts.js:notify` schedules не найдено.

Restore-drain checklist:

- когда `adminAlerts.notify` будет восстановлен из no-op в настоящий handler, одновременно снять `DISABLE_ERROR_ALERT_FANOUT`;
- иначе Telegram/admin alerts могут работать частично, но error-fanout из `systemLogger` останется тихо выключенным;
- при восстановлении пройти остальные direct call-sites `adminAlerts.notify`;
- долгосрочно заменить auto-schedule на каждый error log на batch/dedup alert queue.

## Phase 2 V2 верификация: хронология коммитов и тиков

После начального деплоя Phase 2 V2 (commit `02bcfbb`) для отладки фан-аут механики потребовалось четыре последовательных коммита, каждый верифицированный отдельным тиком cron `proactive-token-refresh` (2h interval).

Условные обозначения:
- "Too many concurrent" в `docker logs adpilot-convex-backend` — реальные ошибки backend isolate'ов
- "errors" в `systemLogs` — ошибки, дошедшие до catch-блоков с явной записью через `systemLogger.log({level: "error"})`
- `adminAlerts.notify scheduled` — записи в `_scheduled_jobs` с `udfPath = adminAlerts.js:notify` в окне тика

| Тик UTC | Commit before | docker logs errors | systemLogs errors | adminAlerts.notify scheduled | Вывод |
|---|---|---|---|---|---|
| 03:09 | `02bcfbb` (V2 без stagger fix?) | n/a | 5 | n/a | пре-фикс baseline |
| 05:09 | `4373678` (stagger /2, 3s) | 40+ | 4 | n/a | первый эффект stagger, но не достаточно |
| 07:09 | `c34bbc3` (slotsPerWorker=2, 3s) | 40+ | 4 | n/a | формула ошибочная — реальная глубина 3 |
| 09:09 | `31cf100` (slotsPerWorker=3, stagger 7s) | 11 | 4 | **8** | сильное улучшение, но не clean. Найдена amplification loop по совпадению timestamps |
| 11:09 | `9aa3a68` (`DISABLE_ERROR_ALERT_FANOUT=1` gate) | 27 | n/a | 0 | diagnostic tick: alert fan-out gate работает, но code считал concurrency=32 из-за отсутствия Convex env |
| 13:09 | `f2c9042` (`diagFanoutConfig`, Convex env fixed) | 0 | 0 | 0 | первый clean тик после env fix |
| 15:09 | `f2c9042` live / prepare commits `3abc818` + `ba5cf83` not deployed | 0 | 0 | 0 | второй clean тик подряд; Phase 2 closed |

Ключевые наблюдения:

- `systemLogs.error` показывает только верхушку айсберга. В тике `07:09` `docker logs` зафиксировал около `40` warnings `Too many concurrent`, в `systemLogs` дошло только `4` (через `try/catch` в `getValidVkToken`). Остальные обрабатывались Convex internally и не записывались в нашу таблицу.
- Поэтому критерий clean должен проверять оба источника: `docker logs` через SSH + `systemLogs` через `systemLogger:getRecentByLevel`.
- Тик `09:09` зафиксировал точное соответствие: `adminAlerts.notify` schedules в те же миллисекунды (±50ms), что и `Too many concurrent` errors. 4 errors at 09:11:20.014-043 → 4 schedules at 09:11:20.015-045. Это и есть подпись feedback loop.
- Тик `11:09` доказал, что `DISABLE_ERROR_ALERT_FANOUT` работает (`adminAlerts.notify scheduled=0`), но также выявил второй env-scope разрыв: application code не видел `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` и шедулил fan-out как при default `32`.

## Методология диагностики (что использовать в следующий раз)

Для воспроизведения такого диагноза без чужой помощи в подобных инцидентах:

1. **SSH к серверу:** `ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49`
2. **Поиск compose контекста:** `docker inspect adpilot-convex-backend --format '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}'` — даёт `com.docker.compose.project.config_files=...` с путём к compose-файлу.
3. **Backend stdout:** `docker logs adpilot-convex-backend --since <ISO> --until <ISO> 2>&1 | grep -cE 'Too many concurrent|Transient error'`. Окно — минимум `dispatch_duration + 5min` (для текущей конфигурации stagger 7s, slotsPerWorker=3 это около 11 минут).
4. **`_scheduled_jobs` latest-state:** `docker exec adpilot-postgres psql -U convex -d adpilot_prod -t -c "<SQL>"`. База называется `adpilot_prod`, table_id `_scheduled_jobs` — `decode('7ee519d746cd4bc3221534e5d95c5010','hex')`. Готовый запрос в `docs/sql/convex-scheduled-jobs-latest-state.sql`.
5. **Heartbeats + admin queries:** через `ConvexHttpClient` с admin auth, ключ генерируется `node gen-admin-key.cjs` (использует `INSTANCE_NAME=adpilot-prod` и `INSTANCE_SECRET`). Системные таблицы доступны через `/api/list_snapshot`, public/internal queries — через `client.query()`.
6. **Cross-correlation:** ключевая техника — сравнить временные метки errors из `docker logs` с метками `_creationTime` записей в `_scheduled_jobs`. Если в одни и те же миллисекунды (±50ms) появляются `adminAlerts.notify` schedules, это amplification loop.
7. **Аудит глубины nested actions:**
   ```bash
   awk '/^export const FUNCTION_NAME = internalAction/,/^}\)/' convex/auth.ts | grep -E 'ctx\.runAction|ctx\.runMutation'
   ```
   Считать peak `ctx.runAction` calls (mutations не занимают V8 slot).

## Урок: Convex deployment env vs container env

В self-hosted Convex backend container env **не пробрасывается автоматически** в V8 isolate, исполняющий functions. Convex backend infra может читать `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` из container env и реально лимитить backend до `8`, но application code внутри V8 isolate через `process.env.APPLICATION_MAX_CONCURRENT_V8_ACTIONS` этого не видел и считал default `32`. Любые env vars, которые нужны именно application code, должны быть установлены через `convex env set <KEY> <VALUE>`.

Доказательство в реальности (тик `09:53`):

| Время | Действие | Где env | Test result |
|---|---|---|---|
| 09:34:22 | Backend recreated с container env `DISABLE_ERROR_ALERT_FANOUT=1` | container only | — |
| 09:35 | `npx convex deploy` — код с гейтом задеплоен | code live | — |
| 09:52:04 | Synthetic error log → `systemLogger:log({level: "error"})` | container only | **adminAlerts.notify scheduled = 1** ❌ gate не сработал |
| 09:52:30 | `npx convex env set DISABLE_ERROR_ALERT_FANOUT 1` (без рестарта) | container + Convex env | — |
| 09:53:03 | Повторный synthetic error log | container + Convex env | **adminAlerts.notify scheduled = 0** ✅ gate работает |

Выводы:
- `convex env set` применяется **мгновенно** без рестарта backend container.
- Container env для `DISABLE_ERROR_ALERT_FANOUT` после установки Convex env стал избыточным.
- Решение по чистоте: **container env удалён** из `docker-compose.yml` после стабилизации; единственный источник истины — Convex deployment env. Backup compose-файла сохранён: `/etc/dokploy/compose/adpilot-convex-gwoqbn/code/docker-compose.yml.bak.2026-05-05-pre-fanout-fix`.
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` также установлен в Convex deployment env, потому что application code использует его в формуле fan-out.
- Аналогичные ошибки могут повторяться при будущих emergency: всегда проверять оба слоя env при добавлении функционального флага или при использовании infra-настройки в application code.

## Текущий статус и verification

Состояние на момент последнего обновления отчёта (`11:35 UTC` / `14:35 MSK`):

- Branch `emergency/drain-scheduled-jobs` HEAD = `f2c9042` (pushed)
- Convex deploy live на `https://convex.aipilot.by`
- `DISABLE_ERROR_ALERT_FANOUT=1` в Convex deployment env (verified working through synthetic test)
- `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=8` в Convex deployment env
- Container `adpilot-convex-backend`: started `09:34:22`, healthy
- Compose-файл идентичен pre-fix backup'у
- `/version` HTTP 200, ~1.4s
- backend stdout с `09:34:22` до `09:50`: 0 `Too many concurrent`, 0 `Transient error`, 0 ERROR-level

Тик `11:09 UTC` был диагностическим и не является clean-кандидатом: application code еще считал concurrency как default `32`, потому что `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` не был установлен в Convex deployment env. После `npx convex env set APPLICATION_MAX_CONCURRENT_V8_ACTIONS 8` формула fan-out наконец совпадает с фактическим backend limit.

Commit `f2c9042` добавил live diagnostic action `auth.diagFanoutConfig`. Проверка прошла:

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

Verification gates `13:09 UTC` and `15:09 UTC`: **CLEAN**.

Результат первого clean тика после env fix:

1. `cronHeartbeats[name=tokenRefreshDispatch]`: started `2026-05-05T13:09:36.646Z`, completed `2026-05-05T13:09:37.338Z`, `error=null`.
2. `docker logs adpilot-convex-backend --since 2026-05-05T13:09:00Z --until 2026-05-05T13:22:00Z`: `0` `Too many concurrent`, `0` `Transient error`.
3. `systemLogger:getRecentByLevel({level: "error"})`: `0` error-level записей за 2 часа на момент проверки.
4. `_scheduled_jobs` latest-state в окне `13:09-13:22`: `0` `adminAlerts.js:notify` schedules.
5. `_scheduled_jobs` latest-state в окне `13:09-13:22`: `67` новых `auth.js:tokenRefreshOneV2` jobs, все `success`; общий счетчик `auth.js:tokenRefreshOneV2` остался `failed=14`, `success=480`.
6. `/version`: `HTTP 200`.

Нюанс: `_creationTime` показывает время создания jobs dispatcher'ом, поэтому все `67` token workers видны в одну секунду. Это не опровергает stagger, потому что delayed execution хранится в `originalScheduledTs` в Convex integer encoding. Для clean-решения использованы реальные runtime-сигналы: backend stdout, `systemLogs`, отсутствие `adminAlerts.notify` schedules и successful completion всех новых V2 jobs.

Второй clean тик `15:09 UTC`:

1. `cronHeartbeats[name=tokenRefreshDispatch]`: started `2026-05-05T15:09:36.639Z`, completed `2026-05-05T15:09:37.059Z`, `status=completed`, `error=null`.
2. Backend stdout `15:09-15:22 UTC`: `0` `Too many concurrent`, `0` `Transient error`.
3. `systemLogger:getRecentByLevel({level: "error"})`: `0` error-level записей за 2 часа на момент проверки.
4. `_scheduled_jobs` latest-state в окне `15:09-15:22`: `0` `adminAlerts.js:notify` schedules.
5. `_scheduled_jobs` latest-state в окне `15:09-15:22`: `30` новых `auth.js:tokenRefreshOneV2` jobs, все `success`; общий счетчик `auth.js:tokenRefreshOneV2`: `failed=14`, `success=510`.
6. `/version`: `HTTP 200`, около `0.09s`.

Итог: **Phase 2 token refresh closed**. Разблокирована только Phase 5a manual UZ canary. Sync metrics, `recordRateLimit`, restore `adminAlerts.notify` и bump concurrency остаются отдельными решениями.

Phase 5a manual UZ canary позже прошла clean: `2` `ruleEngine.js:uzBudgetBatchWorkerV2` jobs завершились `success`, V2 failed не появился, `adminAlerts.notify` schedules в окне = `0`, backend stdout дал `0` `Too many concurrent` / `Transient error`, heartbeat `uzBudgetDispatch` completed/error=null.

Phase 5b cron canary затем была подготовлена, развернута и прошла clean:

- `a52a2a3` (`prepare(uz): enable 45m V2 cron canary registration`) pushed и deployed;
- cron `uz-budget-increase` активен на V2 dispatcher с interval `45 min`;
- deploy был выполнен при `UZ_BUDGET_V2_ENABLED=0`;
- fail-closed smoke после deploy: `{ "skipped": true, "reason": "v2_disabled" }`;
- gate открыт в `2026-05-05T18:19:48Z` через `UZ_BUDGET_V2_ENABLED=1`;
- manual trigger после открытия gate не выполнялся;
- organic cron tick `2026-05-05T18:57:10Z`: `2` V2 workers `success`;
- organic cron tick `2026-05-05T19:42:10Z`: `2` V2 workers `success`;
- итоговый V2 worker total: `ruleEngine.js:uzBudgetBatchWorkerV2|success|6`;
- backend stdout после gate open: `0` `Too many concurrent`, `0` `Transient error`;
- `systemLogs`: `0` errors;
- gate закрыт обратно (`UZ_BUDGET_V2_ENABLED=0`) после наблюдения.

Phase 6 sync metrics после этого подготовлена, pushed и частично восстановлена через manual canary:

- `e478dcb` (`prepare(sync): V2 entrypoints + moderation gate (NOT enabled)`) добавляет `syncDispatchV2`, `dispatchSyncBatchesV2`, `syncBatchWorkerV2`, fail-closed gate `SYNC_METRICS_V2_ENABLED`, отдельный gate `SYNC_METRICS_V2_POLL_MODERATION` для `pollAiBannerModeration`, и `check-sync-tick.cjs`;
- `ed5d5bf` (`prepare(sync): runtime env reads + explicit V1 cron warning`) переносит `SYNC_WORKER_COUNT_V2` / `SYNC_BATCH_SIZE_V2` на runtime env reads и фиксирует предупреждение не включать V1 5-min sync cron;
- `a510695` (`prepare(sync): per-account failure check + drop V1 ready-to-uncomment block`) добавляет явный мониторинг `syncBatchV2.*Account .* failed` и удаляет готовый к раскомментированию V1 5-min sync cron block из `convex/crons.ts`;
- `3f92025` фиксирует docs guardrails для Phase 6 handoff;
- `9f62cfa` добавляет fail-closed guard `SYNC_ESCALATION_ALERTS_ENABLED` для `syncMetrics.scheduleEscalationAlert`, чтобы sync escalation не schedule'ил `adminAlerts.notify` while `adminAlerts.notify` is drain no-op.
- `b0258fc` включает только V2 `sync-metrics` cron registration at `45 min`; deployed live with `SYNC_METRICS_V2_ENABLED=0`, then Phase 6b gate was opened and two organic ticks closed clean. Gate was set back to `0` after Phase 6b to avoid an implicit token-refresh overlap test.

Phase 6a first manual run должен использовать `SYNC_WORKER_COUNT_V2=1`, `SYNC_BATCH_SIZE_V2=10`, `SYNC_METRICS_V2_POLL_MODERATION=0`; trigger запускать только в окне `xx:25-xx:55 UTC`, чтобы не пересекаться с token refresh cron (`xx:09:36 UTC`, около 10 минут dispatching).

Дополнительный clean-критерий для Phase 6: scheduled job `success` для `syncBatchWorkerV2` не гарантирует отсутствие частичных ошибок. Worker ловит per-account exceptions и может завершиться successfully, если отдельные аккаунты упали внутри цикла. Поэтому Phase 6 monitoring обязан считать backend stdout `syncBatchV2.*Account .* failed`; любое ненулевое значение означает, что sync canary не clean, даже если `_scheduled_jobs` показывает worker `success`.

Phase 6a manual canary (`2026-05-06T03:36Z`) was yellow-clean:

- sync mechanics clean: `1` `syncBatchWorkerV2` success, `0` V8/transient, `0` per-account failures, `pg_wal` flat;
- `adminAlerts.js:notify` schedules in window: `5`;
- analysis: alerts were consistent with sync escalation paths for known broken accounts while `adminAlerts.notify` was still no-op, not with the old `Too many concurrent` amplification loop.

Phase 6a-bis after `9f62cfa` (`2026-05-06T04:31Z`) closed clean:

- `syncBatchWorkerV2`: `1 success`;
- `adminAlerts.js:notify`: `0` schedules;
- backend stdout: `0` `Too many concurrent`, `0` `Transient error`, `0` `syncBatchV2.*Account .* failed`;
- `pg_wal`: flat;
- `syncDispatch` heartbeat: completed/error absent in window;
- gates after run: `SYNC_METRICS_V2_ENABLED=0`, `SYNC_ESCALATION_ALERTS_ENABLED=0`.

Phase 6b cron deploy after `b0258fc` (`2026-05-06T04:50Z`) is fail-closed:

- `sync-metrics` cron is registered at `45 min` and calls `internal.syncMetrics.syncDispatchV2`;
- smoke at closed gate returned `{ skipped: true, reason: "v2_disabled" }`;
- `syncDispatch` heartbeat did not change during smoke;
- no new V2 worker/admin alert schedules were created after deploy;
- pre-open baseline at `2026-05-06T05:07:38Z`: `pg_wal=1.6G`, `lastSyncAt stale=212/212`, failed counters unchanged.

Phase 6b organic sync cron canary then closed clean:

- gate opened at `2026-05-06T05:29:09Z`;
- first organic tick at `2026-05-06T05:34:10Z` clean;
- second organic tick at `2026-05-06T06:19:10Z` clean;
- in both windows: dispatcher heartbeat completed/error null, `syncBatchWorkerV2 success=1`, `adminAlerts.notify=0`, backend stdout `0` V8/transient/per-account failures, failed counters unchanged;
- `SYNC_METRICS_V2_ENABLED` was set back to `0` after the second clean tick. V2 cron remains registered, but sync work is paused until a separate reopen/overlap decision. Moderation poll and sync escalation alerts remain disabled.

Phase 6 live reopen and first production overlap test (`2026-05-06`):

- Pre-reopen: `07:09Z` token refresh tick verified clean (`89` `tokenRefreshOneV2` jobs all `success`, `0` `Too many concurrent` / `Transient error`, `0` `systemLogs` errors, failed counters unchanged, `/version` HTTP 200, `pg_wal` ~`1.6G` stable).
- Sync gate reopened at `2026-05-06T08:50Z` (`SYNC_METRICS_V2_ENABLED 0 → 1`). No other gates touched. Conservative profile preserved (`SYNC_WORKER_COUNT_V2=1`, `SYNC_BATCH_SIZE_V2=10`, `SYNC_METRICS_V2_POLL_MODERATION=0`, `SYNC_ESCALATION_ALERTS_ENABLED=0`).
- First organic live sync tick at `2026-05-06T09:19:10Z`. This was the first real production overlap of token refresh and sync since the 2026-05-04/05 incident — token refresh dispatcher fired at `09:09Z` (~10 min duration), sync dispatcher fired at `09:19Z` while token refresh workers may still have been active.
- First-tick acceptance criteria (all 8 passed):
  - `syncDispatch` heartbeat: started `09:19:10.274Z`, finished `09:19:10.365Z`, status completed, error null.
  - `syncBatchWorkerV2`: total success `4 → 5`, failed unchanged at `0`.
  - Backend stdout `09:09Z..09:33Z`: `0` `Too many concurrent`, `0` `Transient error`, `0` `syncBatchV2.*Account .* failed`.
  - `adminAlerts.js:notify` schedules in sync window: `0`.
  - Failed counters unchanged: `adminAlerts=38`, V1 sync=37, V1 UZ=36, `tokenRefreshOneV2=14`, `manualMassCleanup=1`.
  - `pg_wal` byte-exact: `1,711,276,032 → 1,711,276,032`, delta `0` (Phase 6b first tick was `+16 MiB`; conservative profile + WAL recycling yields no measurable growth at current load).
  - `/version`: HTTP 200.
  - Token refresh `09:09Z` overlap: dispatcher completed/error null, `systemLogs` errors `0`. One `tokenRecovery` warn for a single account observed — `warn`-level (not `error`), per-account, not systemic; not a rollback trigger.
- Second organic live sync tick at `2026-05-06T10:04:10Z` confirmed steady-state cadence:
  - `syncDispatch` heartbeat: started `10:04:10.284Z`, finished `10:04:10.363Z`, status completed, error null.
  - `syncBatchWorkerV2`: total success `5 → 6`, failed unchanged at `0`.
  - Backend stdout `10:03Z..10:18Z`: `0` `Too many concurrent`, `0` `Transient error`, `0` `syncBatchV2.*Account .* failed`.
  - `adminAlerts.js:notify` schedules in window: `0`.
  - Failed counters unchanged from first-tick baseline.
  - `pg_wal` byte-exact sample: `1,711,276,032` bytes, unchanged from live reopen baseline.
  - `systemLogs` errors: `0`.
  - `/version`: HTTP 200.
- Outcome after two live ticks: Phase 6 sync V2 is operating in live production conservative profile. Future ticks must be organic only; no manual trigger. All previously paused decisions remain separate (`SYNC_ESCALATION_ALERTS_ENABLED` lift, `SYNC_METRICS_V2_POLL_MODERATION` enable, worker/batch bumps, `UZ_BUDGET_V2_ENABLED=1`, `recordRateLimit` redesign, concurrency `8→16`, merge to `main`).

Phase 8 concurrency bump (`8 → 16`) closed clean on `2026-05-06T17:47Z`:

- Bump executed `2026-05-06T15:35:06Z`. Final state: `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`.
- KEY canary token refresh `17:09Z` (first dispatcher run with `immediate=2` worker burst — architectural reason for the bump): `tokenRefreshDispatch` completed/error null, `auth.js:tokenRefreshOneV2 success +25`, backend rollback grep `0`, `adminAlerts.notify=0`, `systemLogs` errors `0`, `/version` HTTP 200.
- Post-token UZ `17:27Z`: `uzBudgetDispatch` completed/null, `uzBudgetBatchWorkerV2 16→22`, rollback grep `0`, `adminAlerts.notify=0`.
- Post-token sync `17:34Z`: `syncDispatch` completed/null, `syncBatchWorkerV2 13→16`, rollback grep `0`, `adminAlerts.notify=0`.
- Failed counters flat: `adminAlerts=38`, V1 sync=37, V1 UZ=36, `tokenRefreshOneV2=14`, `manualMassCleanup=1`, V2 failed `0`.
- `pg_wal`: `1,627,389,952 → 1,593,835,520 bytes` (delta `-33 MiB`, below pre-bump baseline; normal checkpoint behavior, well under `+50 MB` hard stop).
- Full execution log + closure block: `docs/2026-05-06-concurrency-bump-8-to-16-runbook.md`. Next-step sequencing: `docs/2026-05-06-post-phase-8-checklist.md`.

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
- Long-term TODO: уменьшить V8 slot depth token refresh. Сейчас `tokenRefreshOneV2` вызывает `getValid*`, а тот вызывает `refresh*`, поэтому пиковая глубина около `3` action slots. После emergency можно рассмотреть inline/refactor refresh logic в один action или выделение pure helpers, чтобы снизить `slotsPerWorker` и ускорить dispatch без повышения concurrency.
