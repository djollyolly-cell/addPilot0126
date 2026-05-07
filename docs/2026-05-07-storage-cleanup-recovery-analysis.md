# Storage Cleanup / Dirty-Check Recovery Analysis — 2026-05-07

Дата анализа: 2026-05-07  
Контекст: ветка `emergency/drain-scheduled-jobs`, восстановление после большого сбоя Convex `_scheduled_jobs`, проверка проблемы раздувания PostgreSQL/Convex storage и статуса dirty-check фиксов.

## Что проверялось

- `docs/storage-report-2026-05-07.md`
- `2026-05-04-pg-bloat-unconditional-patch-analysis.md`
- `docs/superpowers/plans/2026-04-28-pg-bloat-cleanup.md`
- `docs/superpowers/plans/2026-05-04-dirty-check-upsert.md`
- recovery-документы:
  - `docs/2026-05-05-convex-drain-reenable-plan.md`
  - `docs/2026-05-05-convex-scheduled-jobs-incident-report.md`
  - `docs/2026-05-06-post-phase-8-checklist.md`
  - `docs/2026-05-06-merge-cleanup-scope.md`
  - `memory/phase-6-sync-canary-status.md`
- код:
  - `convex/adAccounts.ts`
  - `convex/metrics.ts`
  - `convex/crons.ts`
  - `convex/syncMetrics.ts`
  - `convex/logCleanup.ts`
  - `convex/vkApiLimits.ts`
  - `convex/vkApi.ts`
- тесты:
  - `tests/unit/dirty-check-upsert.test.ts`
  - `convex/adAccounts.test.ts`
  - `convex/metrics.test.ts`

## Короткий вывод

Dirty-check часть для `ads`, `campaigns` и `metricsDaily` реализована и соответствует первоначальному плану. Безусловные `ctx.db.patch()` в горячих upsert/saveDaily местах заменены проверками изменений, и узкие тесты проходят.

Основная незакрытая часть сейчас не dirty-check, а storage cleanup после emergency drain. В документах есть общий recovery-принцип "V1 handler с backlog оставлять no-op, новую работу запускать через V2", но отдельного плана для `manualMassCleanupV2` или аналогичного V2-cleanup entrypoint сейчас нет.

## Текущие данные по storage

Свежий storage report от 2026-05-07 показывает:

- `metricsRealtime`: 9 629 187 live документов, рост с 3 254 123.
- `metricsDaily`: 1 434 396 live документов, рост с 974 967.
- `vkApiLimits`: 925 350 документов, cleanup batch 2000/день отстаёт.
- `indexes`: 93 GB, примерно 75% index rows относятся к `metricsRealtime`.
- `documents`: 50 GB.
- `ads`: 67 129 live документов, но 8 148 386 PG rows.
- `campaigns`: 50 056 live документов, но 7 130 894 PG rows.
- `adAccounts`: 264 live документов, но 61 933 PG rows из-за token rotation.

Это подтверждает две разные проблемы:

1. Накопленный объём `metricsRealtime` / `metricsDaily` / `vkApiLimits`, который требует cleanup.
2. Update-amplification на `ads` / `campaigns` / `adAccounts`, где каждый лишний patch создавал новую PG-версию документа.

## Dirty-check статус

### `convex/adAccounts.ts`

Проверено:

- `upsertCampaign`
- `upsertCampaignsBatch`
- `hasCampaignChanged`
- `upsertAd`
- `upsertAdsBatch`
- `hasAdChanged`

Текущее поведение:

- существующая campaign/ad патчится только если изменились синхронизируемые поля;
- `updatedAt` не меняется при полном совпадении данных;
- batch-функции возвращают counters `{ inserted, patched, skipped }`;
- перенос объявления в другую campaign учитывается через `campaignId`, чтобы не получить вечный dirty loop.

### `convex/metrics.ts`

Проверено:

- `saveDaily`
- `saveDailyBatch`
- `saveDailyPublic`
- `saveRealtimeBatch`

Текущее поведение:

- `saveDaily*` патчит существующий daily record только если изменились сырые или записываемые optional поля;
- `saveDailyBatch` возвращает `{ inserted, patched, skipped }`;
- `saveRealtimeBatch` по-прежнему всегда вставляет snapshot, что корректно для realtime-снимков.

### Проверка

Запуск:

```bash
npm run test:unit -- --reporter=verbose tests/unit/dirty-check-upsert.test.ts convex/adAccounts.test.ts convex/metrics.test.ts
npx tsc --noEmit -p convex/tsconfig.json
```

Результат:

- targeted unit/integration tests: 3 files, 80 tests passed;
- Convex TypeScript check: passed.

В тестах есть существующие предупреждения Convex test harness про прямой вызов Convex functions из Convex functions. Они не относятся к dirty-check изменению и не приводят к падению targeted прогонов.

## Sync path после recovery

Старый V1 sync path больше не является текущим production path.

В branch HEAD подготовлен переход на `15 min`:

```ts
crons.interval(
  "sync-metrics",
  { minutes: 15 },
  internal.syncMetrics.syncDispatchV2,
);
```

Но prod до отдельного deploy всё ещё работает на последнем deployed revision (a5ff381) с `{ minutes: 45 }` cadence. Behavior change в `ffdd32b` закоммичен, но не задеплоен.

Для storage-cleanup выводов это различие не меняет основную рекомендацию: realtime cleanup cron всё равно disabled в prod и branch, а `manualMassCleanup` остаётся no-op.

Старый `syncBatchWorker` сейчас no-op, чтобы не оживить старую очередь `_scheduled_jobs`. Реальная работа идёт через `syncDispatchV2` -> `dispatchSyncBatchesV2` -> `syncBatchWorkerV2` -> `syncSingleAccount`.

Важно: `syncSingleAccount` уже возвращает counters по dirty-check batch-функциям, но `syncBatchWorkerV2` сейчас вызывает его как `await syncSingleAccount(...)` и не агрегирует результат в итоговый worker log. Это не ломает запись данных, но снижает наблюдаемость: skip-rate в реальном V2 cron path видно хуже, чем могло бы быть.

Рекомендация: добавить aggregate counters log именно в `syncBatchWorkerV2`, а не только в старый V1/legacy path.

## Storage cleanup gap

### Что есть в документах

В recovery-документах есть правило:

- V1 handlers с историческим backlog в `_scheduled_jobs` оставлять no-op;
- новую работу запускать через новые V2 entrypoints;
- не восстанавливать старый handler, пока не доказано, что backlog drained.

`metrics.manualMassCleanup` явно указан как V1 no-op handler, который нужно держать до проверки historical backlog.

### Чего нет

Отдельного плана или кода для `manualMassCleanupV2` сейчас нет.

Поиск по репозиторию не нашёл:

- `manualMassCleanupV2`
- отдельный storage-cleanup V2 runbook
- конкретный план, где расписано безопасное восстановление realtime cleanup через новый V2 entrypoint

### Текущий код

В `convex/metrics.ts`:

- `triggerMassCleanup` ставит job на `internal.metrics.manualMassCleanup`;
- `manualMassCleanup` является no-op;
- `cleanupOldRealtimeMetrics` вызывает `scheduleMassCleanup`;
- `scheduleMassCleanup` снова ставит job на старый no-op `manualMassCleanup`.

Итог: даже если вызвать `triggerMassCleanup` или включить `cleanupOldRealtimeMetrics`, текущая self-scheduling цепочка не выполнит реальную очистку, потому что упирается в no-op `manualMassCleanup`.

В `convex/crons.ts`:

- `cleanup-old-metrics-daily` закомментирован;
- `cleanup-old-realtime-metrics` закомментирован.

Поэтому простое "раскомментировать cron" недостаточно и потенциально опасно как recovery-подход: оно может создать видимость восстановленного cleanup, но реальная очистка `metricsRealtime` не пойдёт.

## `vkApiLimits` статус

Старый incident был усилен тем, что `vkApiLimits.recordRateLimit` создавал scheduled jobs на множество VK API responses.

Сейчас `recordRateLimit` переписан как `internalMutation` и вставляет запись только при `statusCode === 429`. Это снижает риск повторной job-amplification.

Остаётся отдельная storage-задача:

- исторический backlog `vkApiLimits` уже накоплен;
- `cleanupOldVkApiLimits` всё ещё удаляет только `take(2000)` в рамках daily cleanup;
- `vk-throttling-probe` cron отключён и зависит от отдельного решения по telemetry.

Рекомендация storage report увеличить batch или изменить частоту cleanup для `vkApiLimits` остаётся актуальной, но после стабилизации и отдельного маленького плана.

## Риски

### Риск 1: включить cleanup cron без V2 entrypoint

Если просто раскомментировать `cleanup-old-realtime-metrics`, текущая цепочка придёт в no-op `manualMassCleanup`. Результат: cleanup не сработает, а оператор может решить, что проблема уже исправлена.

### Риск 2: вернуть старый `manualMassCleanup` вместо V2

Если восстановить реальное тело старого `manualMassCleanup`, исторические pending jobs с `udfPath = metrics.js:manualMassCleanup` могут начать исполняться старой накопленной очередью. Это нарушает основной recovery-принцип и может снова создать нагрузку.

### Риск 3: удалить данные напрямую через SQL

Recovery docs отдельно запрещают прямой SQL cleanup `_scheduled_jobs` / Convex storage. Convex хранит данные и индексы во внутренних таблицах `documents` / `indexes`, и прямое удаление может нарушить инварианты storage.

### Риск 4: считать dirty-check полным решением storage bloat

Dirty-check останавливает значительную часть будущих лишних update-версий для `ads`, `campaigns`, `metricsDaily`, но не удаляет уже накопленные версии и не решает рост `metricsRealtime`, если cleanup отключён.

## Рекомендации

### 1. Создать маленький отдельный план/runbook для storage cleanup V2

Предлагаемый scope:

- не трогать старый `manualMassCleanup`;
- добавить новый реальный V2 entrypoint, например `manualMassCleanupV2`;
- добавить `scheduleMassCleanupV2`;
- добавить ручной trigger/canary для V2;
- переключить `cleanupOldRealtimeMetrics` на V2 only;
- только после canary включать `cleanup-old-realtime-metrics` cron.

### 2. Добавить acceptance criteria

Минимальные критерии:

- `/version` HTTP 200 до/после;
- `pg_wal` не растёт runaway;
- no `Too many concurrent requests`;
- `_scheduled_jobs` latest-state не получает V1 `manualMassCleanup` backlog;
- V2 cleanup jobs bounded и завершаются;
- количество `metricsRealtime` live документов уменьшается;
- cron heartbeat для cleanup понятен и не stuck.

### 3. Начать с ручного canary, а не с cron

Сначала запустить V2 cleanup вручную с консервативными лимитами:

- маленький batch;
- короткий time budget;
- без агрессивного self-reschedule;
- отдельное окно наблюдения.

Только после clean canary включать cron.

### 4. Разделить cleanup-задачи

Не объединять в один deploy:

- `metricsRealtime` cleanup V2;
- `metricsDaily` cleanup cron restore;
- `vkApiLimits` cleanup batch/frequency change;
- `VACUUM ANALYZE`;
- `VACUUM FULL` / `pg_repack`.

Каждая часть имеет свой профиль нагрузки и свои rollback/stop criteria.

### 5. Добавить aggregate dirty-check counters в V2 sync worker

Это не блокер для cleanup, но полезно перед storage-работами. Нужно агрегировать результат `syncSingleAccount` в `syncBatchWorkerV2`, чтобы видеть реальный `inserted/patched/skipped` по campaigns/ads/metrics в active cron path.

### 6. Обновить существующие документы

Нужно поправить формулировки, где написано, что cleanup-функции "целые, надо только раскомментировать cron". В текущем emergency branch это уже не совсем верно: `cleanupOldRealtimeMetrics` существует, но фактическая self-scheduling цепочка ведёт в no-op `manualMassCleanup`.

## Предлагаемый минимальный план V2 cleanup

1. Read-only preflight:
   - проверить latest-state `_scheduled_jobs` по `metrics.js:manualMassCleanup`;
   - снять count `metricsRealtime`, `metricsDaily`, `vkApiLimits`;
   - снять `pg_wal`, `/version`, active errors.
2. Code design:
   - `manualMassCleanup` оставить no-op;
   - добавить `manualMassCleanupV2`;
   - добавить `scheduleMassCleanupV2`;
   - добавить `triggerMassCleanupV2` или internal manual action/mutation для canary;
   - переключить `cleanupOldRealtimeMetrics` на V2.
3. Conservative canary:
   - один ручной запуск;
   - small batch/time budget;
   - без cron restore.
4. Observation:
   - проверить backend stdout;
   - проверить failed counters;
   - проверить `metricsRealtime` count delta;
   - проверить `pg_wal`.
5. Cron restore:
   - включить `cleanup-old-realtime-metrics` отдельно;
   - наблюдать первый organic tick.
6. После стабильности:
   - отдельно вернуть `cleanup-old-metrics-daily`;
   - отдельно увеличить/изменить cleanup для `vkApiLimits`;
   - после удаления данных выполнить `VACUUM (ANALYZE)` для `documents` / `indexes`;
   - `VACUUM FULL` / `pg_repack` только в maintenance window.

## Итог

Dirty-check fix готов и подтверждён тестами. Он снижает будущую update-amplification нагрузку.

Storage cleanup после emergency drain не закрыт планом до конца. Ключевая дырка: старый `manualMassCleanup` правильно оставлен no-op, но новый V2 entrypoint для реальной очистки `metricsRealtime` не создан и не описан отдельным runbook. До появления такого V2-плана включать realtime cleanup cron рано.

