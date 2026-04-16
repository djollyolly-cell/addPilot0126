# metricsRealtime Cleanup — Design Spec

**Date:** 2026-04-16
**Status:** Approved (rev.7 — + устойчивость к action timeout, ручной запуск для ускорения)
**Problem:** metricsRealtime — 24.3 млн записей, 73 ГБ в PostgreSQL. Диск сервера 100%.

## Причина

`syncMetrics` каждые 5 мин создаёт INSERT на каждое объявление. При ~57 аккаунтах = 70-280K строк/день. Ротации нет — данные копятся с момента запуска.

## Кто использует metricsRealtime

| Потребитель | Файл | Что берёт | Нужен период |
|---|---|---|---|
| `fast_spend` / `low_impressions` / `clicks_no_leads` правило | `ruleEngine.ts:getRealtimeHistory()` | Записи за time window (1h/6h/24h) | макс 24h |
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

**Результат в schema.ts (после Deploy 2):**
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

### Архитектура cleanup: Action + Mutation (паттерн syncAll)

Две функции по проверенному паттерну `syncAll`:

#### `cleanupOldRealtimeMetrics` — internalAction (оркестратор)

```
internalAction в convex/metrics.ts:
  args: { batchSize?: number }

  Константы (топ metrics.ts):
    RETENTION_DAYS = 4
    DEFAULT_BATCH_SIZE = 500
    BATCH_DELAY_MS = 100
    LOG_EVERY_N_BATCHES = 100
    CLEANUP_MAX_RUNNING_MS = 12 * 60 * 60 * 1000  // 12h

  1. batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE

  // Guard от дублирующего запуска
  2. const hb = await ctx.runQuery(internal.syncMetrics.getCronHeartbeat, { name: "cleanup-realtime-metrics" })
  3. Если hb?.status === "running":
     a. elapsed = Date.now() - hb.startedAt
     b. Если elapsed < CLEANUP_MAX_RUNNING_MS → skip
        console.log "[cleanup-realtime] Already running (started ${minutesAgo}min ago), skipping"
        return
     c. Если elapsed >= CLEANUP_MAX_RUNNING_MS → zombie
        console.warn "[cleanup-realtime] Previous run STUCK (${minutesAgo}min ago, >720min). Overriding."

  4. await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, { name: "cleanup-realtime-metrics", status: "running" })

  5. try:
     a. runningTotal = 0, batchCount = 0, startedAt = Date.now()
     b. Цикл:
        - batch = await ctx.runMutation(internal.metrics.deleteRealtimeBatch, { batchSize })
        - runningTotal += batch.deleted
        - batchCount++
        - Если batchCount % LOG_EVERY_N_BATCHES === 0:
          elapsed = (Date.now() - startedAt) / 1000
          rate = Math.round(runningTotal / (elapsed / 60))
          console.log "[cleanup-realtime] Progress: deleted ${runningTotal}, rate ~${rate}/min, elapsed ${elapsed}s"
        - Если batch.hasMore → await sleep(BATCH_DELAY_MS) → продолжаем
        - Если !batch.hasMore → break
     c. elapsed = (Date.now() - startedAt) / 1000
     d. console.log "[cleanup-realtime] Complete. Deleted ${runningTotal} records in ${elapsed}s (~${Math.round(elapsed/60)} min)"
     e. await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, { name: "cleanup-realtime-metrics", status: "completed" })

  6. catch (error):
     a. console.error "[cleanup-realtime] ERROR: ${message}. Stopped at ${runningTotal} deleted. Will retry next cron cycle."
     b. await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, { name: "cleanup-realtime-metrics", status: "failed", error: message })
     c. НЕ retry — подождать следующий cron через 24h
```

#### `deleteRealtimeBatch` — internalMutation (чистая транзакция)

```
internalMutation в convex/metrics.ts:
  args: { batchSize: v.number() }

  1. cutoff = Date.now() - RETENTION_DAYS * 86_400_000
  2. records = await ctx.db
       .query("metricsRealtime")
       .withIndex("by_timestamp", q => q.lt("timestamp", cutoff))
       .take(args.batchSize)
  3. for (const record of records):
       await ctx.db.delete(record._id)
  4. return { deleted: records.length, hasMore: records.length === args.batchSize }
```

**sleep в action:** `const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))` — стандартный паттерн, уже используется в `vkApi.ts`, `reports.ts`, `telegram.ts`.

**Почему Action + Mutation (а не одна Mutation):**
- Mutation транзакционная — при ошибке откатывается ВСЁ, включая heartbeat "failed". Action не транзакционная — catch реально пишет "failed".
- Паттерн 1:1 с `syncAll` (internalAction) — знакомый, обкатанный в проекте.
- `sleep(100ms)` в action вместо `ctx.scheduler.runAfter(100)` — не забивает scheduler queue 48K jobs.

**Почему батч 500:** Convex mutation лимит ~8 сек. 500 delete-операций укладывается с запасом.

**Configurable batch size:** `batchSize` как аргумент с дефолтом 500 — позволяет тюнить при ручном вызове без передеплоя.

**Duplicate guard:** Heartbeat "running" + stale timeout 12h. Если cron запускает cleanup, а предыдущий ещё работает — новый skip-ается. Если предыдущий завис > 12h — считается зомби, запускается заново.

**Порог 12 часов:** используется в двух местах — `CLEANUP_MAX_RUNNING_MS` в action guard и `maxRunningMin: 720` в healthCheck. Оба = 12 часов. При изменении — менять синхронно.

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
Записывается через `upsertCronHeartbeat` в 3 точках lifecycle:
```ts
// 1. Начало
upsertCronHeartbeat({ name: "cleanup-realtime-metrics", status: "running" })

// 2. Завершение
upsertCronHeartbeat({ name: "cleanup-realtime-metrics", status: "completed" })

// 3. Ошибка
upsertCronHeartbeat({ name: "cleanup-realtime-metrics", status: "failed", error: message })
```

**Health check:**
В `healthCheck.ts:checkCronHeartbeats` добавить в `CRON_CONFIGS`:

```ts
{ name: "cleanup-realtime-metrics", label: "cleanup-realtime", maxStaleMin: 25 * 60, maxRunningMin: 12 * 60 },
```

Текущий stuck detection использует hardcoded `> 10` минут (healthCheck.ts:92). Cleanup может легитимно работать 2-8 часов (первый запуск). Нужно заменить hardcoded порог на `cfg.maxRunningMin ?? 10`:

```ts
// Было:
if (hb.status === "running" && minutesAgo(hb.startedAt) > 10) {

// Стало:
const maxRunMin = cfg.maxRunningMin ?? 10;
if (hb.status === "running" && minutesAgo(hb.startedAt) > maxRunMin) {
```

Добавить поле `maxRunningMin` в тип `CRON_CONFIGS`:
```ts
const CRON_CONFIGS: Array<{
  name: string;
  label: string;
  maxStaleMin?: number;
  maxRunningMin?: number;  // ← новое поле
}> = [
  { name: "syncAll", label: "sync-metrics", maxStaleMin: 10 },
  // ... существующие записи без изменений (дефолт 10 мин) ...
  { name: "cleanup-realtime-metrics", label: "cleanup-realtime", maxStaleMin: 25 * 60, maxRunningMin: 12 * 60 },
];
```

**Console log (прореженный):**
- Каждые 100 батчей (50K записей): `[cleanup-realtime] Progress: deleted ${total}, rate ~${rate}/min, elapsed ${elapsed}s`
- Финал: `[cleanup-realtime] Complete. Deleted ${total} records in ${elapsed}s (~${min} min)`
- Ошибка: `[cleanup-realtime] ERROR: ${message}. Stopped at ${total} deleted. Will retry next cron cycle.`
- Skip: `[cleanup-realtime] Already running (started ${minutesAgo}min ago), skipping`
- Zombie: `[cleanup-realtime] Previous run STUCK (${minutesAgo}min ago, >720min). Overriding.`

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

### Тестовые мутации (`saveRealtimePublic`, `saveDailyPublic`)

НЕ удаляем. Обе используются в тестах:
- `saveRealtimePublic` → `metrics.test.ts:32,63,73`, `ruleEngine.test.ts:404`
- `saveDailyPublic` → `metrics.test.ts:98,134,145,172,196,244,277,287`

Удаление сломает тесты. Очистка тестовых мутаций — отдельная задача (перевод тестов на `internal.*`).

### Первый запуск

~24 млн записей / 500 за батч = ~48 000 вызовов.
При 100ms delay + 50-500ms execution = 150-600ms на батч → **2-8 часов** (если action не прерывается timeout-ом).
Разброс зависит от нагрузки на сервер. Работает в фоне внутри action, не блокирует sync и правила.

После первого cleanup: retention 4 дня при 70-280K строк/день = **280K-1.1M записей** (вместо 24 млн).

### Устойчивость к action timeout

Self-hosted Convex может иметь лимит на длительность action (~10 мин, точное значение зависит от версии backend). Дизайн устойчив к этому:

**Почему безопасно:**
- Каждый `deleteRealtimeBatch` — отдельная mutation-транзакция, коммитится независимо
- Если action убит timeout-ом — уже удалённые записи остаются удалёнными, прогресс не теряется
- Heartbeat остаётся "running" → следующий cron (через 24h) видит elapsed > 12h → zombie override → новый cleanup продолжает с того места

**Оценка при ~10-мин timeout:**
- За 10 мин: ~100ms delay + ~200ms execution = ~3300 батчей × 500 = **~1.65M записей за запуск**
- 1 запуск/день (cron 05:00 UTC): ~1.65M/день → **полная очистка 24M за ~14 дней**
- Каждый запуск освобождает ~5 ГБ (при ~3 КБ/запись)
- Новые данные: ~280K записей/день (~840 МБ) — чистый выигрыш ~4 ГБ/день

**Ускорение через ручной запуск:**
Для быстрой первичной очистки можно вызвать `cleanupOldRealtimeMetrics` вручную из Convex Dashboard (Functions → internal.metrics.cleanupOldRealtimeMetrics → Run). Каждый ручной запуск удалит ещё ~1.65M записей. Duplicate guard не мешает: если предыдущий run завершился (status: "completed" или "failed"), новый запустится сразу. Если предыдущий ещё "running" из-за timeout — подождать пока elapsed > 12h или вручную патчнуть heartbeat через Dashboard.

`batchSize` передаётся как аргумент (дефолт 500) — можно увеличить при ручном вызове для ускорения.

## Порядок деплоя (двухэтапный)

**Проблема:** замена индексов в одном деплое сломает рабочие запросы. Старый `by_adId` удаляется, новый `by_adId_timestamp` ещё строится на 24 млн записях (часы) → `getRealtimeHistory` и `getRealtimeByAd` падают.

### Deploy 1: добавить индексы + cleanup код

| Файл | Изменение |
|---|---|
| `convex/schema.ts` | **Добавить** `by_adId_timestamp` + `by_timestamp`. Старые `by_adId` и `by_accountId_timestamp` НЕ трогаем |
| `convex/metrics.ts` | + константы cleanup, + `deleteRealtimeBatch`, + `cleanupOldRealtimeMetrics` |
| `convex/crons.ts` | + cron `cleanup-old-realtime-metrics` |
| `convex/healthCheck.ts` | + `maxRunningMin` в тип, заменить hardcoded `> 10`, + cleanup в CRON_CONFIGS |

**Риск:** 0. Старые запросы работают на старых индексах. Cleanup использует только новый `by_timestamp`. Cron начнёт чистить данные сразу после построения `by_timestamp`.

### Пауза: дождаться построения индексов

Проверить в Convex dashboard (`http://178.172.235.49:6792`) что `by_adId_timestamp` и `by_timestamp` построены (статус Ready). На 24 млн записях — ориентировочно 10-60 минут.

### Deploy 2: переключить запросы + удалить старые индексы

| Файл | Изменение |
|---|---|
| `convex/schema.ts` | **Удалить** `by_adId` + `by_accountId_timestamp` |
| `convex/ruleEngine.ts` | `getRealtimeHistory`: переключить на `by_adId_timestamp` с range scan |
| `convex/metrics.ts` | `getRealtimeByAd`: переключить на `by_adId_timestamp` |
| `.claude/rules/database-schema.md` | Обновить индексы metricsRealtime |

**Риск:** 0. Новые индексы уже построены, переключение мгновенное.

## Что НЕ меняется

- `saveRealtimePublic` / `saveDailyPublic` — используются в тестах, удаление отдельной задачей
- `metricsRealtime` моложе 4 дней — нужны для правил
- `metricsDaily` — историческая аналитика
- `actionLogs` — отдельная задача (125K записей не критично)
- `upsertCronHeartbeat` — используется as-is, без модификаций
