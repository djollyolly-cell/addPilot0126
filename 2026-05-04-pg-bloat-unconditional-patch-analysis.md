# Анализ: раздувание PostgreSQL из-за безусловных patch-вызовов

**Дата:** 04.05.2026  
**Статус:** Верифицировано, ожидает фикса

---

## Суть проблемы

Convex self-hosted хранит документы в PostgreSQL с MVCC-версионированием. Каждый `ctx.db.patch()` создаёт новую версию документа в таблице `documents` и обновляет строки в `indexes`. Если GC/autovacuum не успевает за потоком записей — старые версии накапливаются.

Наблюдаемые симптомы (из отчёта по БД):
- `ads`: 68K живых документов → 9.1M PG rows (~134 версии на документ)
- `campaigns`: 51K живых документов → 8M PG rows (~157 версий на документ)

---

## Верифицированные места в коде

### 1. `upsertCampaignsBatch` — `convex/adAccounts.ts:1836–1845`

```typescript
if (existing) {
  const patch: Record<string, unknown> = {
    name: c.name,
    status: c.status,
    updatedAt: now,   // ← всегда пишется, даже если ничего не изменилось
  };
  if (c.adPlanId !== undefined) patch.adPlanId = c.adPlanId;
  if (c.dailyLimit !== undefined) patch.dailyLimit = c.dailyLimit;
  if (c.allLimit !== undefined) patch.allLimit = c.allLimit;
  await ctx.db.patch(existing._id, patch);   // ← безусловно
}
```

Dirty-check отсутствует. Даже если VK вернул те же name/status/dailyLimit — документ патчится.

### 2. `upsertAdsBatch` — `convex/adAccounts.ts:1962–1969`

```typescript
if (existing) {
  const patch: Record<string, unknown> = {
    name: ad.name,
    status: ad.status,
    updatedAt: now,   // ← всегда пишется
  };
  if (ad.approved !== undefined) patch.approved = ad.approved;
  await ctx.db.patch(existing._id, patch);   // ← безусловно
}
```

Идентичный паттерн.

### 3. `saveDailyBatch` — `convex/metrics.ts:163–178`

Патчит сегодняшнюю запись `metricsDaily` при каждом синке. Для активных объявлений это оправдано (VK обновляет кумулятивные метрики). Для паузированных — лишняя запись.

### 4. `saveRealtimeBatch` — `convex/metrics.ts:116–128`

Всегда INSERT (снапшоты). **Проблем нет** — это правильное поведение, cleanup cron на 2 дня уже есть.

---

## Частота вызовов

- Cron `sync-metrics`: каждые **5 минут** → **288 синков в сутки**
- Оба метода вызываются из `syncAll` и `syncBatch` в `convex/syncMetrics.ts` (строки 357 и 1131)

---

## Масштаб

```
campaigns: 288 синков/день × 264 аккаунта × ~100 кампаний = 7.6M patch-вызовов/день
ads:       288 синков/день × 264 аккаунта × ~200 объявлений = 15.2M patch-вызовов/день
Итого:     ~23M лишних PG-версий в сутки
```

При 134–157 версиях на документ и таком темпе записей PostgreSQL autovacuum не успевает чистить мёртвые версии — что усугубляет уже зафиксированную checkpoint storm проблему (см. `2026-05-03-postgres-checkpoint-storm-fix.md`).

---

## Разграничение: что лишнее, что нет

| Место | Паттерн | Лишние записи | Обоснование |
|---|---|---|---|
| `upsertCampaignsBatch` | Всегда patch + `updatedAt` | ~99% | Кампании меняются только при ручных изменениях в кабинете VK |
| `upsertAdsBatch` | Всегда patch + `updatedAt` | ~95% | Статус/модерация меняются нечасто |
| `saveDailyBatch` | Patch сегодняшней записи | Частично | Паузированные объявления не меняются, активные — меняются |
| `saveRealtimeBatch` | Всегда insert | 0% | Снапшоты, так и задумано |

---

## Рекомендуемый фикс

### Приоритет 1 — campaigns и ads (устраняет ~99% лишних записей)

Добавить dirty-check перед `ctx.db.patch()`:

**`upsertCampaignsBatch`:**
```typescript
if (existing) {
  const changed =
    existing.name !== c.name ||
    existing.status !== c.status ||
    (c.dailyLimit !== undefined && existing.dailyLimit !== c.dailyLimit) ||
    (c.allLimit !== undefined && existing.allLimit !== c.allLimit) ||
    (c.adPlanId !== undefined && existing.adPlanId !== c.adPlanId);

  if (changed) {
    const patch: Record<string, unknown> = {
      name: c.name,
      status: c.status,
      updatedAt: now,
    };
    if (c.adPlanId !== undefined) patch.adPlanId = c.adPlanId;
    if (c.dailyLimit !== undefined) patch.dailyLimit = c.dailyLimit;
    if (c.allLimit !== undefined) patch.allLimit = c.allLimit;
    await ctx.db.patch(existing._id, patch);
  }
}
```

**`upsertAdsBatch`:**
```typescript
if (existing) {
  const changed =
    existing.name !== ad.name ||
    existing.status !== ad.status ||
    (ad.approved !== undefined && existing.approved !== ad.approved);

  if (changed) {
    const patch: Record<string, unknown> = {
      name: ad.name,
      status: ad.status,
      updatedAt: now,
    };
    if (ad.approved !== undefined) patch.approved = ad.approved;
    await ctx.db.patch(existing._id, patch);
  }
}
```

### Приоритет 2 — saveDailyBatch (вторичный эффект)

Сравнивать 4 сырых поля (`impressions`, `clicks`, `spent`, `leads`) перед patch. Если ни одно не изменилось — пропускать. Актуально для паузированных объявлений, которые синкаются каждые 5 минут с теми же нулями.

```typescript
if (existing) {
  const changed =
    existing.impressions !== item.impressions ||
    existing.clicks !== item.clicks ||
    existing.spent !== item.spent ||
    existing.leads !== item.leads;

  if (changed) {
    // ... patch как прежде
  }
}
```

---

## Ожидаемый эффект фикса

- Снижение PG write-нагрузки на таблицы `campaigns` и `ads` на **90–99%**
- Разгрузка autovacuum и checkpoint-процессов PostgreSQL
- Прекращение роста версий документов — GC сможет работать в штатном режиме
- Не требует изменений схемы, API или фронтенда

---

## Что НЕ нужно менять

- `saveRealtimeBatch` — insert-снапшоты корректны
- Cleanup cron на 2 дня для `metricsRealtime` — уже есть
- Cleanup cron на 90 дней для `metricsDaily` — уже есть

---

## Cleanup существующего bloat (добавлено 05.05.2026)

**Контекст:** dirty-check фиксы (commits `0b6fa95`, `fedb2bd`, `d08014f`) остановили **рост** bloat, но не вычистили **накопленные** мёртвые версии. По snapshot'у на 05.05.2026:

| Метрика | Значение |
|---|---|
| `documents` table | 23 GB |
| `documents` indexes | 27 GB |
| `indexes` table (Convex internal) | 93 GB |
| Postgres data dir total | 143 GB |
| Disk used | 164 GB / 315 GB (55%) |
| `_scheduled_jobs` версии в documents | 1,410,808 (живых latest ~512K) |
| `_scheduled_jobs` tombstones | 315,960 |

За 5 дней Convex GC вычистил всего ~5,700 версий из 1.4M в `_scheduled_jobs`. Темп очистки крайне низкий — без активного вмешательства база останется на текущем размере месяцами, даже после полной остановки роста.

### Этап 1 — Online `VACUUM ANALYZE` (без downtime)

**Что:** `VACUUM` помечает dead tuples как переиспользуемые внутри файла таблицы. `ANALYZE` обновляет статистику для query planner.

**Эффект:**
- Не уменьшает размер файла таблицы немедленно (не shrinkает на диске)
- Стабилизирует размер: новые INSERT идут в переиспользуемые слоты вместо роста файла
- Улучшает performance запросов за счёт свежей статистики

**Команды:**

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker exec adpilot-postgres psql -U convex -d adpilot_prod -c "
VACUUM (ANALYZE, VERBOSE) documents;
VACUUM (ANALYZE, VERBOSE) indexes;
"'
```

Время выполнения: 5-15 мин на каждую таблицу. Безопасно прервать `Ctrl+C`. Не блокирует чтение/запись Convex backend.

**Когда выполнять:** в любой момент после стабилизации текущего emergency. Не во время активного дренажа очереди и не во время валидационных тиков (для тишины в логах и метриках).

---

### Этап 2 — Снизить `DOCUMENT_RETENTION_DELAY`

**Что:** Convex env variable, контролирует сколько хранятся старые версии документов до того, как Convex GC помечает их к удалению.

| Параметр | Сейчас | Предлагается |
|---|---|---|
| `DOCUMENT_RETENTION_DELAY` | `172800` (48 часов) | `86400` (24 часа) |

**Эффект:** Convex GC будет агрессивнее чистить старые версии. Снизит долгосрочный темп роста `documents`.

**Команды:**

1. Edit `/etc/dokploy/compose/adpilot-convex-gwoqbn/code/docker-compose.yml`:
   ```yaml
   environment:
     - DOCUMENT_RETENTION_DELAY=86400  # было 172800
   ```
2. Recreate backend container:
   ```bash
   ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
     'cd /etc/dokploy/compose/adpilot-convex-gwoqbn/code && \
      docker compose -p adpilot-convex-gwoqbn up -d backend'
   ```

**Риск:** требует restart backend container (downtime ~30 сек, frontend `/version` будет временно отвечать 502). Не делать во время активной работы или верификации тика.

**Когда выполнять:** после 2 clean тиков token refresh + после стабилизации sync/UZ, в плановое окно minimum traffic.

---

### Этап 3 — Maintenance window: `pg_repack` или `VACUUM FULL`

**Что:** Для физического освобождения места на диске нужно переписать таблицу без dead rows.

**Опции:**

| Tool | Lock | Downtime | Доступность |
|---|---|---|---|
| `VACUUM FULL` | `ACCESS EXCLUSIVE` на таблицу | 5-15 мин (Convex backend висит) | Встроен в Postgres |
| `pg_repack` | Без exclusive lock (rebuilt online, swap в конце) | <1 мин swap | Требует extension |

**Проверить наличие pg_repack:**
```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker exec adpilot-postgres psql -U convex -d adpilot_prod -c "
SELECT * FROM pg_extension WHERE extname = '\''pg_repack'\'';"'
```

**Если pg_repack установлен:**
```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker exec adpilot-postgres pg_repack -U convex -d adpilot_prod -t documents'
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'docker exec adpilot-postgres pg_repack -U convex -d adpilot_prod -t indexes'
```

**Если только VACUUM FULL:**
```sql
-- ВНИМАНИЕ: блокирует таблицу на 5-15 минут, Convex backend hangs
VACUUM FULL documents;
VACUUM FULL indexes;
```
Делать только в окне minimum traffic, предупредить пользователей.

**Ожидаемый эффект:** освободить значительный процент размера таблицы. По грубой оценке (315K tombstones из 1.4M записей в `_scheduled_jobs`) — 20-30% bloat, итого `documents` 23 GB → ~16-18 GB. Аналогично `indexes` 93 GB → ~70 GB.

**Когда выполнять:** только после полной стабилизации (минимум 2 clean тика token refresh + clean sync/UZ дни). Не сейчас.

---

### Этап 4 — Audit Convex internal cleanup activity

**Что:** Понять, почему Convex GC такой медленный (5.7K версий из 1.4M за 5 дней).

**Подходы:**

1. Логи `system_table_cleanup` в backend stdout:
   ```bash
   ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
     'docker logs adpilot-convex-backend 2>&1 | grep -E "system_table_cleanup|Compaction|GC|cleanup|retention" | tail -100'
   ```
2. Проверить периодичность: как часто Convex запускает internal retention cleanup, что обрабатывает за раз.
3. Если темп низкий — возможные причины:
   - Высокий `DOCUMENT_RETENTION_DELAY` (см. Этап 2)
   - Внутренний cleanup однопоточный и не успевает за previous bloat
   - GC требует свободных V8 slots, которые мы недавно сами всё time занимали fan-out workerами

**Когда выполнять:** параллельно с Этапом 1 (VACUUM не мешает чтению логов).

---

### Порядок исполнения

1. **Сейчас (во время emergency 05.05.2026):** ничего из cleanup. Emergency приоритет — стабилизация token refresh.
2. **После 2 clean тиков token refresh** (ожидается 13:09 + 15:09 UTC 05.05.2026):
   - Этап 1 (`VACUUM ANALYZE`) — безопасно, online, можно сделать сразу.
3. **После audit и фиксов `syncBatchWorker` / `uzBudgetBatchWorker`:**
   - Этап 4 (audit Convex GC) — для понимания темпа.
   - Этап 2 (`DOCUMENT_RETENTION_DELAY=86400`) — в плановое окно.
4. **В отдельное maintenance window (вечер/ночь):**
   - Этап 3 (`pg_repack` или `VACUUM FULL`).

### Что НЕ делать никогда

- ❌ `DELETE FROM documents WHERE table_id = ...` — сломает Convex storage инварианты (документировано в `2026-05-05-convex-scheduled-jobs-incident-report.md`).
- ❌ `TRUNCATE _scheduled_jobs` — то же самое, плюс затронет args/index references.
- ❌ `VACUUM FULL` без maintenance window — заблокирует Convex backend на 5-15 минут, `/version` timeout, frontend сломан.
- ❌ Изменение Convex storage напрямую через SQL — Convex MVCC требует строгой консистентности `documents` ↔ `indexes` ↔ `_scheduled_jobs.argsId` references.
