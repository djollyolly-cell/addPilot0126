# metricsRealtime Cleanup — Design Spec

**Date:** 2026-04-16
**Status:** Approved (rev.3 — heartbeat lifecycle, duplicate guard, 4-day retention, configurable batch)
**Problem:** metricsRealtime — 24.3 млн записей, 73 ГБ в PostgreSQL. Диск сервера 100%.

## Причина

`syncMetrics` каждые 5 мин создаёт INSERT на каждое объявление. При ~57 аккаунтах = 70-280K строк/день. Ротации нет — данные копятся с момента запуска.

## Кто использует metricsRealtime

| Потребитель | Файл | Что берёт | Нужен период |
|---|---|---|---|
| `fast_spend` / `low_impressions` правило | `ruleEngine.ts:getRealtimeHistory()` | Записи за time window (1h/6h/24h) | макс 24h |
| Dashboard (последняя точка) | `metrics.ts:getRealtimeByAd()` | 1 последняя запись | последняя |
| Frontend | — | НЕ используется | — |

**Вывод:** записи старше 4 дней не нужны. 4 дня = 4x safety margin от макс. окна 24h (запас на задержки sync, timezone drift, edge cases).

## Решение

### Миграция индексов

**Текущие индексы:**
| Индекс | Поля | Используется | Где |
|---|---|---|---|
| `by_adId` | `["adId"]` | Да (2 запроса) | `getRealtimeHistory()`, `getRealtimeByAd()` |
| `by_accountId_timestamp` | `["accountId", "timestamp"]` | **Нет (0 использований)** | Нигде в коде |

**Новые индексы:**
| Индекс | Поля | Назначение |
|---|---|---|
| `by_adId_timestamp` | `["adId", "timestamp"]` | Заменяет `by_adId` — покрывает оба запроса + range scan по timestamp |
| `by_timestamp` | `["timestamp"]` | Для cleanup: range query `timestamp < cutoff` |

**Что меняется:**
- **Удаляем** `by_adId` — заменён на `by_adId_timestamp` (prefix match по `adId` работает так же)
- **Удаляем** `by_accountId_timestamp` — 0 использований в коде, артефакт старого дизайна (2026-04-12 spec)
- **Добавляем** `by_adId_timestamp` — покрывает `getRealtimeByAd()` (prefix + order desc) и `getRealtimeHistory()` (range scan по timestamp)
- **Добавляем** `by_timestamp` — для cleanup batch deletion

Итого: было 2 индекса (один мёртвый), стало 2 индекса (оба используются).

**Результат в schema.ts:**
```ts
metricsRealtime: defineTable({
  accountId: v.id("adAccounts"),
  adId: v.string(),
  timestamp: v.number(),
  spent: v.number(),
  leads: v.number(),
  impressions: v.number(),
  clicks: v.number(),
})
  .index("by_adId_timestamp", ["adId", "timestamp"])
  .index("by_timestamp", ["timestamp"]),
```

### Mutation: `cleanupOldRealtimeMetrics`

```
internalMutation в convex/metrics.ts:
  args: { batchSize?: number, deletedSoFar?: number, startedAt?: number }

  RETENTION_DAYS = 4
  DEFAULT_BATCH_SIZE = 500
  STALE_TIMEOUT = 12 * 60 * 60 * 1000  // 12h

  1. batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE
  2. cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  3. startedAt = args.startedAt ?? Date.now()
  4. isFirstBatch = (args.deletedSoFar ?? 0) === 0

  // Guard от дублирующего запуска
  5. Если isFirstBatch:
     a. Проверить heartbeat "cleanup-realtime-metrics"
     b. Если status === "running" И startedAt < 12h назад → skip, console.log "[cleanup-realtime] Already running, skipping"
     c. Записать heartbeat status: "running", startedAt: startedAt

  6. try:
     a. Запрос: metricsRealtime.withIndex("by_timestamp", q => q.lt("timestamp", cutoff)).take(batchSize)
     b. Удалить каждую запись через ctx.db.delete()
     c. runningTotal = (args.deletedSoFar ?? 0) + deleted
     d. elapsed = (Date.now() - startedAt) / 1000
     e. rate = runningTotal / (elapsed / 60)  // записей/мин
     f. Если удалено == batchSize →
        - Console log: "[cleanup-realtime] Batch: deleted ${deleted}, total ${runningTotal}, rate ~${rate}/min, continuing..."
        - ctx.scheduler.runAfter(100, cleanup, { batchSize, deletedSoFar: runningTotal, startedAt })
     g. Если удалено < batchSize → завершение:
        - Console log: "[cleanup-realtime] Complete. Deleted ${runningTotal} records in ${elapsed}s"
        - Записать heartbeat status: "completed"
  7. catch (error):
     - Console error: "[cleanup-realtime] ERROR: ${message}. Stopped at ${runningTotal} deleted. Will retry next cron cycle."
     - Записать heartbeat status: "failed", error: message
     - НЕ reschedule — подождать следующий cron через 24h
  8. Return { deleted: count, hasMore: boolean }
```

**Почему батч 500:** Convex mutation лимит ~8 сек. 500 delete-операций укладывается с запасом.

**Почему `runAfter(100)` а не `runAfter(0)`:** при первом запуске ~48 000 батчей. `runAfter(0)` создаёт все jobs мгновенно в scheduler queue. 100ms throttle распределяет нагрузку и не мешает другим scheduled jobs (syncAll, правила).

**Configurable batch size:** `batchSize` как аргумент с дефолтом 500 — позволяет тюнить при ручном вызове без передеплоя.

**Error handling:** Convex mutation — транзакционная. Если `ctx.db.delete()` падает — весь батч откатывается. try/catch ловит ошибку, записывает failed heartbeat, и cleanup останавливается до следующего cron запуска через 24h. Это предотвращает бесконечный retry при систематических ошибках.

**Duplicate guard:** Heartbeat "running" + stale timeout 12h. Если cron запускает cleanup, а предыдущий ещё работает — новый skip-ается. Если предыдущий завис > 12h без записи "failed" — считается зомби, запускается заново.

**Heartbeat lifecycle:**
1. Первый батч → heartbeat `status: "running"`
2. Промежуточные батчи → heartbeat не трогается (только console.log)
3. Последний батч → heartbeat `status: "completed"`
4. Ошибка → heartbeat `status: "failed"` + error message

Используется `upsertCronHeartbeat` из `syncMetrics.ts` (строки 593-622) — не дублируем код.

### Cron

```
convex/crons.ts:
  crons.cron(
    "cleanup-old-realtime-metrics",
    "0 5 * * *",          // ежедневно 05:00 UTC
    internal.metrics.cleanupOldRealtimeMetrics
  );
```

05:00 UTC выбрано чтобы не пересекаться с:
- syncAll (каждые 5 мин)
- daily digest (06:00 UTC)
- другими cleanup (02:00, 03:00, 04:00 UTC)

### Мониторинг

**Heartbeat:**
Записывается через `upsertCronHeartbeat` (из `syncMetrics.ts`) в 3 точках lifecycle:
```ts
// 1. Начало (первый батч)
{ name: "cleanup-realtime-metrics", startedAt, status: "running" }

// 2. Завершение (последний батч)
{ name: "cleanup-realtime-metrics", startedAt, finishedAt: Date.now(), status: "completed" }

// 3. Ошибка
{ name: "cleanup-realtime-metrics", startedAt, finishedAt: Date.now(), status: "failed", error: message }
```

healthCheck уже умеет детектить stuck "running" heartbeats — cleanup автоматически попадёт под мониторинг.

**Health check:**
В `healthCheck.ts` добавить проверку:
- Есть ли heartbeat `cleanup-realtime-metrics` со статусом `completed` за последние 25 часов?
- Нет → warning: "Cleanup realtime metrics не выполнялся"
- Статус `running` + startedAt > 12h → warning: "Cleanup realtime metrics завис"

**Console log (с rate):**
- Каждый батч: `[cleanup-realtime] Batch: deleted ${count}, total ${runningTotal}, rate ~${rate}/min, continuing...`
- Финал: `[cleanup-realtime] Complete. Deleted ${total} records in ${duration}s`
- Ошибка: `[cleanup-realtime] ERROR: ${message}. Stopped at ${runningTotal} deleted. Will retry next cron cycle.`
- Skip (duplicate): `[cleanup-realtime] Already running (started ${minutesAgo}min ago), skipping`

### Оптимизация запросов (используют новый `by_adId_timestamp`)

#### `getRealtimeHistory` (ruleEngine.ts)

**Текущий код:**
```ts
const records = await ctx.db
  .query("metricsRealtime")
  .withIndex("by_adId", (q) => q.eq("adId", args.adId))
  .collect();                    // ← загружает ВСЕ записи по adId
return records.filter((r) => r.timestamp >= args.sinceTimestamp);  // ← фильтрует в JS
```

**Проблема:** `.collect()` загружает все записи для adId (потенциально тысячи за 4 дня), потом фильтрует в JS. Это full scan по всем записям adId.

**Оптимизация — range scan по составному индексу:**
```ts
const records = await ctx.db
  .query("metricsRealtime")
  .withIndex("by_adId_timestamp", (q) =>
    q.eq("adId", args.adId).gte("timestamp", args.sinceTimestamp)
  )
  .collect();
return records;
```

`by_adId_timestamp: ["adId", "timestamp"]` — Convex использует prefix match по `adId`, затем range scan по `timestamp`. Читает только документы в нужном time window. При окне 1h из 4 дней данных — читает ~1/96 записей вместо всех.

#### `getRealtimeByAd` (metrics.ts)

**Текущий код:**
```ts
.withIndex("by_adId", (q) => q.eq("adId", args.adId))
.order("desc")
.take(1);
```

**Обновление — тот же prefix match:**
```ts
.withIndex("by_adId_timestamp", (q) => q.eq("adId", args.adId))
.order("desc")
.take(1);
```

Prefix match по `adId` работает идентично старому `by_adId`. `.order("desc")` сортирует по `timestamp` (второе поле индекса) — получаем последнюю запись за O(1).

### Удаление `saveRealtimePublic`

`saveRealtimePublic` (metrics.ts:92-112) — публичная мутация-дубль `saveRealtime`. Тестовый код в проде. Удаляем в этом же PR, т.к. уже трогаем `metrics.ts`. Минимальный риск, один файл.

### Первый запуск

~24 млн записей / 500 за батч = ~48 000 вызовов.
При 100ms throttle + 50-500ms execution = 150-600ms на батч → **2-8 часов**.
Разброс зависит от нагрузки на сервер. Работает в фоне через scheduler, не блокирует sync и правила.

После первого cleanup: retention 4 дня при 70-280K строк/день = **280K-1.1M записей** (вместо 24 млн).

## Файлы

| Файл | Изменение |
|---|---|
| `convex/schema.ts` | Удалить `by_adId` + `by_accountId_timestamp`, добавить `by_adId_timestamp` + `by_timestamp` |
| `convex/metrics.ts` | + `cleanupOldRealtimeMetrics` (internalMutation с heartbeat lifecycle, guard, configurable batch) |
| `convex/metrics.ts` | Удалить `saveRealtimePublic` (тестовый код) |
| `convex/metrics.ts` | `getRealtimeByAd`: обновить на `by_adId_timestamp` (prefix match) |
| `convex/crons.ts` | + cron `cleanup-old-realtime-metrics` |
| `convex/healthCheck.ts` | + проверка heartbeat cleanup (completed за 25h, stuck > 12h) |
| `convex/ruleEngine.ts` | `getRealtimeHistory`: range scan по `by_adId_timestamp` вместо full scan + JS filter |
| `.claude/rules/database-schema.md` | Обновить индексы metricsRealtime |

## Что НЕ удаляется

- `metricsRealtime` моложе 4 дней — нужны для правил
- `metricsDaily` — историческая аналитика
- `actionLogs` — отдельная задача (125K записей не критично)
