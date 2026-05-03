# Residual Convex memory carry-over fix — design

**Дата:** 2026-05-03 (после деплоя `90baea5` / `3ca60eb`)
**Контекст:** AdPilot, self-hosted Convex backend (PG 16.11, образ `ghcr.io/get-convex/convex-backend:latest`).
**Связанные документы:**
- `2026-05-03-convex-memory-carry-over-fix-design.md` — primary fix (vkApi + upsertCampaignsBatch).
- `2026-05-03-postgres-checkpoint-storm-fix.md` разделы 14, 15, 17 — история WS-разрывов.
**Тип задачи:** оптимизация кода (TypeScript) + диагностика; не инфраструктура.

---

## 1. Симптом и рабочие гипотезы

### Симптом
После primary memory-fix (commit `3ca60eb`) прежние главные hot paths (`vkApi.getMtBanners`, `vkApi.getMtStatistics`, `adAccounts.upsertCampaignsBatch`) больше не доминируют в `TooMuchMemoryCarryOver`. Но проблема **не закрыта полностью**: post-deploy логи показывают остаточные isolate restarts на других requests.

Срез post-deploy 2026-05-03 13:55 UTC:

- `TooMuchMemoryCarryOver` за 1h: 7
- за 30m: 3
- за 15m: 0
- контейнеры healthy, Postgres checkpoint storm не вернулся

Новые `last request` за последний час:

- `Action: vkApi.js:getCampaignTypeMap`
- `UDF: adAccounts.js:getInternal`
- `UDF: metrics.js:saveDailyBatch`
- `Action: ruleEngine.js:checkRulesForAccount`
- `UDF: users.js:getVkAdsCredentials`
- `UDF: metrics.js:saveRealtimeBatch`
- `UDF: adAccounts.js:upsertAdsBatch`

Остаточный фон в логах:

```
2026-05-03T11:59:52Z ERROR Restarting Isolate memory_carry_over:
  TooMuchMemoryCarryOver("63.80 MiB", "96 MiB"),
  last request: "UDF: metrics.js:saveDailyBatch"

2026-05-03T12:00:16Z ERROR Restarting Isolate memory_carry_over:
  TooMuchMemoryCarryOver("63.59 MiB", "96 MiB"),
  last request: "UDF: adAccounts.js:updateSyncTime"
```

### Рабочая гипотеза (не финальная корневая причина)

**(A) `metrics.saveDailyBatch` — частичный виновник через write-set transaction.**

`convex/metrics.ts:133` принимает `items: Array<{...12 полей...}>` размером до 100 (`CHUNK = 100` в `syncMetrics.ts:427` и `:1199`). В цикле для каждого item:
1. `ctx.db.query("metricsDaily").withIndex("by_adId_date").first()` — читает существующий документ (~12 полей).
2. `ctx.db.patch(existing._id, patch)` или `ctx.db.insert("metricsDaily", {...})`.

Один вызов = до 100 query + 100 patch/insert операций в одной транзакции. Convex держит read+write log до commit; точный heap footprint зависит от размера документов и runtime metadata. На большом аккаунте sync делает 10+ таких вызовов подряд.

**(A2) `metrics.saveRealtimeBatch` и `adAccounts.upsertAdsBatch` — такие же batch pressure candidates.**

Свежий post-deploy лог содержит `last request: "UDF: metrics.js:saveRealtimeBatch"` и `"UDF: adAccounts.js:upsertAdsBatch"`. Оба caller'а в `syncMetrics.ts` сейчас используют `CHUNK = 200`. Значит residual fix не должен ограничиваться только `saveDailyBatch`: все sync flush mutations с batch write-set должны получить bounded/adaptive chunking.

**(B) trivial queries/mutations (`updateSyncTime`, `getInternal`, `getVkAdsCredentials`) — скорее жертвы, не виновники.**

`convex/adAccounts.ts:1886` — один `ctx.db.patch` с 6 полями. `convex/adAccounts.ts:1939` и `convex/users.ts:539` — простые `db.get`. Они физически не похожи на операции, способные сами оставить ~64 MiB carry-over. Более вероятно: память накоплена предыдущими запросами в том же Isolate, а проверка heap срабатывает на выходе очередной маленькой функции. Поэтому `last request` нужно читать как **маркер момента рестарта**, а не всегда как прямую причину.

### Подтверждающее наблюдение

В обоих событиях carry-over size в одном и том же узком диапазоне:
- `63.80 MiB` (saveDailyBatch)
- `63.59 MiB` (updateSyncTime)
- `63.97 MiB` (saveRealtimeBatch)
- `63.96 MiB` (upsertAdsBatch)

Это **тот же диапазон**, что в pre-fix логах для vkApi (`63.70 MiB`), getMtBanners (`63.67`), getMtStatistics (`63.57`). Лимит срабатывания одинаков — значит механизм один: накопленный heap Isolate слегка переваливает за порог (≈60 MiB при cap 96), restart срабатывает на любой выходящей в этот момент функции.

### Контекст активности перед событиями

За 2 секунды до `11:59:52` в логах ~30 fetch'ей к `target.my.com` с response sizes от 93 байт до 285 KB. Это указывает на параллельную фоновую активность (ruleEngine 5-min cron, sync fan-out, или token refresh). Она может создавать общий memory pressure, но конкретный источник ещё нужно подтвердить.

### Гипотезы о источнике module state

Не подтверждены диагностикой, требуют профилирования:
- **Module-level кэши** (e.g. `getCampaignTypeMap` cache, `getValidTokenForAccount` cache, regex compiled patterns).
- **Imported large constants/JSON** (e.g. validators, schemas, large lookup tables).
- **JIT-compiled code retention** в hot paths.
- **Closure captures** в long-lived modules (e.g. global `console.warn` wrappers).

---

## 2. Цели

### Что должно стать
1. `TooMuchMemoryCarryOver` за 1 час — **0–1** при нормальной нагрузке (с текущих 7/час в последнем post-deploy срезе).
2. `metrics.saveDailyBatch` carry-over — **0** на 30-минутном окне.
3. `metrics.saveRealtimeBatch` и `adAccounts.upsertAdsBatch` carry-over — **0** на 30-минутном окне.
4. Trivial marker functions (`updateSyncTime`, `getInternal`, `getVkAdsCredentials`) carry-over — **0** на 30-минутном окне.
5. Не ухудшить acceptance § 6 предыдущего фикса (vkApi/upsertCampaignsBatch остаются 0).

### Что НЕ цель
- Поднятие heap limit Convex (96 MiB) — зашит в backend, env-override нет.
- Полная переархитектура module structure — это отдельный multi-PR проект.
- Vendoring/replacing Convex runtime.

---

## 3. План изменений

Двухступенчатый: сначала **дешёвый и точечный фикс** для sync batch flush mutations (write-set), параллельно **диагностический сбор данных** для понимания накопленного Isolate state. Только после диагностики — решение про module-level правки.

### Приоритет 0 — pre-fix production taxonomy

Перед кодом снять распределение `TooMuchMemoryCarryOver` за 2-4 часа:

```bash
docker logs --since 4h adpilot-convex-backend \
  | grep TooMuchMemoryCarryOver \
  | sed -E 's/.*last request: "([^"]+)".*/\1/' \
  | sort | uniq -c | sort -nr
```

Если `saveDailyBatch`, `saveRealtimeBatch`, `upsertAdsBatch` дают существенную долю событий — делать §3.1. Если почти все события на `ruleEngine` / `getCampaignTypeMap` — сначала диагностика §3.3-3.5, чтобы не делать косметический chunk-only PR.

### Приоритет 1 — sync batch write-set reduction

#### 3.1. Adaptive chunk size

**Сейчас:**

- `saveRealtimeBatch`: `CHUNK = 200` (`syncMetrics.ts:418`, `:1190`)
- `saveDailyBatch`: `CHUNK = 100` (`syncMetrics.ts:427`, `:1199`)
- `upsertAdsBatch`: `CHUNK = 200` (`syncMetrics.ts:342`, `:1115`)

**Стать:** по аналогии с `campaignUpsertChunkSize` из primary fix — адаптивно от количества items:

```typescript
const HEAVY_BATCH_THRESHOLD = 500; // ads per account per day
const HEAVY_DAILY_CHUNK = 25;
const HEAVY_REALTIME_CHUNK = 50;
const HEAVY_AD_UPSERT_CHUNK = 50;
const DEFAULT_DAILY_CHUNK = 100;
const DEFAULT_REALTIME_CHUNK = 200;
const DEFAULT_AD_UPSERT_CHUNK = 200;

function dailyMetricsChunkSize(itemsCount: number): number {
  return itemsCount > HEAVY_BATCH_THRESHOLD
    ? HEAVY_DAILY_CHUNK
    : DEFAULT_DAILY_CHUNK;
}

function realtimeMetricsChunkSize(itemsCount: number): number {
  return itemsCount > HEAVY_BATCH_THRESHOLD
    ? HEAVY_REALTIME_CHUNK
    : DEFAULT_REALTIME_CHUNK;
}

function adUpsertChunkSize(itemsCount: number): number {
  return itemsCount > HEAVY_BATCH_THRESHOLD
    ? HEAVY_AD_UPSERT_CHUNK
    : DEFAULT_AD_UPSERT_CHUNK;
}
```

Применить в обоих sync paths (`syncAll`, `syncBatchWorker`) для всех трёх flush sections.

**Trade-off:** получаем больше mutations для тяжёлых аккаунтов. Для 5-min sync приемлемо (следующий проход доисправит), но нужно проверить runtime p95 и queue backlog после деплоя.

#### 3.2. Read-set оптимизация (опционально, после §3.1)

`saveDailyBatch` делает N последовательных `query.first()`. Это не bulk-friendly — каждый запрос загружает полный документ.

**Альтернатива:** один `query.collect()` по списку adId через `or(...)` фильтры и в JS строить map. Но Convex `or` с N=100 условиями может упереться в свои лимиты и не быстрее. **Сначала измерить эффект §3.1 в одиночку**, потом решать про §3.2.

### Приоритет 2 — диагностика module state источника

#### 3.3. Профилирование Isolate перед carry-over

**Задача:** понять, какие модули/функции накапливают heap. Сделать internal action `dumpIsolateMemory`:

```typescript
// convex/admin.ts
export const dumpIsolateMemory = internalAction({
  handler: async (ctx) => {
    if (typeof process !== "undefined" && process.memoryUsage) {
      return process.memoryUsage();
    }
    if (typeof globalThis.gc === "function") globalThis.gc();
    return { note: "memoryUsage not available in Convex Isolate" };
  },
});
```

Вызвать вручную из Convex Dashboard в моменты разной нагрузки (сразу после деплоя; через час непрерывной работы; перед/после `ruleEngine.checkAllRules`). Сравнить heap snapshots.

**Реалистично:** Convex Isolate не даёт `process.memoryUsage`. Если так — fallback на косвенный метод: вызвать функцию, которая загружает большой документ, посмотреть в логах, насколько heap «прыгает».

#### 3.4. Module-level audit

`grep` всех `convex/*.ts` файлов на module-scope state, который может расти:

```bash
# Module-level Map/Set/Array
grep -nE "^(const|let) [a-zA-Z_]+\s*=\s*new (Map|Set|Array|WeakMap)" convex/*.ts

# Module-level objects with growing fields
grep -nE "^(const|let) [a-zA-Z_]+\s*=\s*\{" convex/*.ts | head -50

# Cached values
grep -rn "cache\|memoize\|_cache\|cached" convex/*.ts --include="*.ts"
```

Каждое module-scope mutable значение — кандидат на carry-over. Фиксы:
- Перенести в function-scope (если нет shared state requirement).
- Заменить на per-call instantiation.
- Если кэш нужен — обернуть в WeakMap или ввести TTL.

#### 3.5. Bundle size audit

Размер bundled JS каждого Convex модуля влияет на cold-start memory. Получить размеры через Convex Dashboard или `npx convex deploy --dry-run`.

Если какой-то модуль значительно крупнее остальных (особенно `ruleEngine.ts`, `videos.ts`, `vkApi.ts`) — рассмотреть разделение на меньшие модули или вынос static data в JSON-файлы (которые лениво грузятся).

### Приоритет 3 (опционально) — split heavy modules

**Только если §3.3-3.4 покажут конкретный module-level источник.** Не делать на упреждение.

Возможные кандидаты по эвристике:
- `ruleEngine.ts` — самый крупный по бизнес-логике, агрегатор всех типов правил.
- `videos.ts` — большой объём action кода (FFmpeg, Anthropic, S3).
- `vkApi.ts` — много interface определений, type guards.

Split = вынести независимые части в отдельные файлы (e.g. `ruleEngine/cpl.ts`, `ruleEngine/ctr.ts`), чтобы Convex bundler мог их грузить отдельно.

---

## 4. Чего НЕ делать

| Идея | Почему НЕ |
|---|---|
| Уменьшить `CHUNK` глобально для всех batch mutations | На лёгких аккаунтах увеличит число mutations без пользы. Только adaptive по размеру. |
| Заменить `for` цикл на `Promise.all` внутри mutation | Convex mutations sequential by design; Promise.all не даст параллелизма и сломает атомарность. |
| Перенести trivial markers (`updateSyncTime`, `getInternal`, `getVkAdsCredentials`) в action или переписать их первыми | Это маленькие `patch` / `db.get`, они скорее маркеры момента рестарта. Хак через `runMutation` ничего не даст — реальная причина в накопленном Isolate state, не в самих функциях. |
| Уменьшить `WORKER_COUNT` 6 → 3 | Удлинит sync дважды. Module state копится у одного worker'а одинаково; фикс не там. |
| Поднять Convex heap limit | Зашит в backend, env-override отсутствует. Plus — обход, не лечение. |
| Применять §3.3-3.5 без §3.1 | §3.1 даёт быстрый понятный win. Module-state работа — длинная, начинать с дешёвого. |

---

## 5. Опционально (диагностика, не лечение)

**Временный логгер heap.** Добавить в `convex/syncMetrics.ts` обёртку, которая логирует длительность и косвенный heap-сигнал перед/после тяжёлых mutation:

```typescript
const t0 = Date.now();
await ctx.runMutation(internal.metrics.saveDailyBatch, {...});
console.log(`[sync] saveDailyBatch took ${Date.now() - t0}ms, items=${chunk.length}`);
```

Если разброс длительности drastically варьируется (от 200ms до 5s) на одинаковых items — это сигнал о GC pause / Isolate memory pressure.

**Включить только на 24 часа**, потом убрать (логи раздуют storage).

---

## 6. Verification (acceptance criteria)

После §3.1 (без §3.3-3.5):

| # | Метрика | Целевое значение | Команда |
|---|---|---|---|
| 1 | `TooMuchMemoryCarryOver` на `metrics.saveDailyBatch` за 1 час | **0** | `ssh root@178.172.235.49 'docker logs --since 1h adpilot-convex-backend \| grep saveDailyBatch \| grep -c TooMuchMemoryCarryOver'` |
| 2 | `TooMuchMemoryCarryOver` на `saveRealtimeBatch` / `upsertAdsBatch` за 1 час | **0** | `docker logs --since 1h adpilot-convex-backend \| grep -E 'saveRealtimeBatch\|upsertAdsBatch' \| grep -c TooMuchMemoryCarryOver` |
| 3 | `TooMuchMemoryCarryOver` суммарно за 1 час | **0–1** (с 7 в последнем срезе) | `ssh root@178.172.235.49 'docker logs --since 1h adpilot-convex-backend \| grep -c TooMuchMemoryCarryOver'` |
| 4 | `saveDailyBatch`, `saveRealtimeBatch`, `upsertAdsBatch` p95 длительность не выросла | ≤ baseline +30% | Convex Dashboard → Functions → percentiles |
| 5 | trivial marker functions (`updateSyncTime`, `getInternal`, `getVkAdsCredentials`) carry-over исчез | **0** | `docker logs ... \| grep -E 'updateSyncTime\|getInternal\|getVkAdsCredentials' \| grep -c TooMuchMemoryCarryOver` |

Если в §6.5 хотя бы один marker остался ≠ 0 — значит накопленный Isolate state остался, переходить к §3.3-3.5.

---

## 7. Зависимости и риски

### Что должно остаться рабочим
- `metricsDaily` пишется корректно для всех ads на всех аккаунтах. Adaptive chunk не должен пропустить ни одной записи.
- `lastSyncAt` обновляется по завершении sync (для health checks `staleSyncCheck`).

### Риски
- **Atomicity loss в batch flush mutations** при разбиении на меньшие чанки. Если sync падает между чанками — частично применённые daily/realtime metrics или ads остаются. Не критично: следующий 5-min sync перезапишет/дозапишет; в worst case — на graph за час будет 1 «провал» или часть ads обновится на следующий проход. Для 5-min granularity это ниже порога видимости.
- **Распределение реальное:** перед фиксом измерить топ-10 аккаунтов по числу ads. Если *средний* аккаунт имеет 800+ ads — порог `HEAVY_BATCH_THRESHOLD = 500` слишком низкий, бьёт всех. Корректировать на основании данных.
- **Module-state hypothesis может быть неверной.** Если после §3.1 carry-over в `updateSyncTime` остался — не значит, что module state виноват; может быть другая последняя-выходящая mutation. §3.3 диагностика обязательна перед §3.4-3.5.

### Откат
Все правки — изменения кода, без необратимых операций. Откат через `git revert` соответствующих коммитов + redeploy через GitHub Actions (push в main).

---

## 8. Источники истины (что читать перед началом)

- `2026-05-03-convex-memory-carry-over-fix-design.md` — primary fix, контекст и история.
- `convex/metrics.ts:105` — `saveRealtimeBatch` (целевая функция §3.1).
- `convex/metrics.ts:133` — `saveDailyBatch` (целевая функция §3.1).
- `convex/adAccounts.ts:1824` — `upsertAdsBatch` (целевая функция §3.1).
- `convex/syncMetrics.ts:342`, `:418`, `:427`, `:1115`, `:1190`, `:1199` — caller'ы batch flush mutations (точки добавления adaptive chunk).
- `convex/adAccounts.ts:1886` — `updateSyncTime` (диагностический маркер; править не надо).
- `convex/ruleEngine.ts` — кандидат на module-level audit (самый крупный модуль).
- `convex/vkApi.ts` — cache helpers (`getCampaignTypeMap`, etc), кандидат на module-level audit.
- `convex/tokenRecovery.ts` — `quickTokenCheck`, может иметь module-level state.
- Memory `websocket-1006-investigation.md` — состояние WS-разрывов после primary fix.
- Memory `postgres-tuning.md` — состояние Postgres-фикса.

---

## 9. Implementation order

Делать строго в этой последовательности:

1. **Pre-step A:** снять production taxonomy §3.0 за 2-4 часа.
2. **Pre-step B:** замерить распределение ads per account через одноразовый `internalQuery` (по аналогии с §3.4 предыдущего спека). На основании реальных данных откорректировать `HEAVY_BATCH_THRESHOLD`.
3. **§3.1** — adaptive chunk для `saveDailyBatch`, `saveRealtimeBatch`, `upsertAdsBatch`. Один коммит, один push.
4. **30-60 мин мониторинг** — снять §6.1-§6.5. Если batch functions = 0 и total ≤ 1/час — задача закрыта.
5. **Если marker functions или ruleEngine/getCampaignTypeMap продолжают рестартить Isolate** — перейти к §3.3 диагностике. Не реализовывать §3.4-3.5 без диагностического подтверждения.
6. **§3.4-3.5** — только при наличии конкретного module-level источника. Каждое изменение — отдельный PR.

---

## 10. Связь с auto-link cron

Auto-link-video cron (см. primary spec §8) — независимая задача. Делать **после** этого residual fix, чтобы не путать сигнал по carry-over: если cron добавляет новый источник памяти одновременно с fix'ом метрик — будет неясно, что именно влияет.

---

## 11. Implementation results (2026-05-03)

**Deploy stack on `main`:**
- `87ee051` — feat(sync): add adaptive chunk-size helpers + tests
- `d1dc294` — perf(sync): adaptive chunking in syncAll path (3 sites)
- `f7d492e` — perf(sync): adaptive chunking in syncBatchWorker path (3 sites)
- `b75f051` — chore(diag): remove adsCountByAccount diagnostic

**Cleanup deploy timestamp UTC:** 2026-05-03T15:24:40Z
**Calibrated threshold:** `HEAVY_BATCH_THRESHOLD = 800` (top-1 = 2047 ads, top-5 median = 1471, 12/20 accounts > 1000 ads, batch flush share in Pre-Step A = 20%)

### Acceptance snapshots

| § | Метрика | Цель | Факт | Verdict |
|---|---|---|---|---|
| 6.1 | `saveDailyBatch` / 1h | 0 | **0** at 16:56Z, but **2** over 2h and **3** over 4h | ⚠️ improved, not closed |
| 6.2 | `saveRealtimeBatch` + `upsertAdsBatch` / 1h | 0 | **2** (2× upsertAdsBatch) at 16:56Z; `saveRealtimeBatch` = 0 over 1h/2h | ⚠️ improved, not closed |
| 6.3 | Total / 1h | 0–1 (was 7) | **9** at 16:56Z; **17** over 2h; **29** over 4h | ❌ |
| 6.4 | p95 of three flush mutations | ≤ baseline +30% | _not measured (no Dashboard access during automated execution; manual check pending)_ | — |
| 6.5 | Trivial markers (`updateSyncTime`/`getInternal`/`getVkAdsCredentials`, plus auth/rate-limit marker victims) / 1h | 0 | **2** at 16:56Z (`vkApiLimits:recordRateLimit`); **5** over 2h; **8** over 4h | ❌ |

### Distribution shift

**Pre-fix (Pre-Step A, last 4h before deploy):** 25 events / 4h ≈ 6/h. 16 distinct functions. Batch flush (saveDailyBatch + saveRealtimeBatch + upsertAdsBatch) = 5 events = 20%. Trivial markers (updateSyncTime + getInternal + getVkAdsCredentials) = 4 events = 16%.

**Post-fix early snapshot (T+42m, 30m window):** 3 events / 30m ≈ 6/h.
- `vkApiLimits:recordRateLimit` — 1 (**new source**, not present pre-fix)
- `adAccounts:upsertAdsBatch` — 1
- `vkApi:getCampaignsForAccount` — 1

**Post-fix fresh snapshot (16:56Z):**

| Window | Total | Batch flush | Marker victims | Top last requests |
|---|---:|---:|---:|---|
| 1h | 9 | 2 (`upsertAdsBatch` 2, `saveDailyBatch` 0, `saveRealtimeBatch` 0) | 2 (`vkApiLimits:recordRateLimit`) | `upsertAdsBatch`, `recordRateLimit`, `ruleEngine`, `vkApi` |
| 2h | 17 | 4 (`saveDailyBatch` 2, `upsertAdsBatch` 2) | 5 | `recordRateLimit`, `saveDailyBatch`, `upsertAdsBatch`, `ruleEngine` |
| 4h | 29 | 7 (`saveDailyBatch` 3, `upsertAdsBatch` 3, `saveRealtimeBatch` 1) | 8 | `recordRateLimit`, `saveDailyBatch`, `upsertAdsBatch`, `getMtStatistics`, `ruleEngine` |

### Observations

**What worked (in declared scope):**
- `saveRealtimeBatch` — 0 events in the fresh 1h/2h window and only 1 event over 4h. This path is effectively defanged by adaptive chunking.
- `saveDailyBatch` — improved in the fresh 1h window (0 events), but still appears over longer windows (2 events / 2h, 3 events / 4h). Adaptive chunk 25 reduced pressure but did not fully eliminate it.
- `upsertAdsBatch` — still appears (2 events / 1h, 3 events / 4h). Chunk 50 is an improvement over 200, but not enough to satisfy acceptance.
- Batch/write-set pressure is no longer the only dominant explanation. The distribution now includes ruleEngine/vkApi/rate-limit exits that are outside §3.1.

**What did not close:**
- Total carry-over rate did not drop enough. Pre-fix was ~6/h; post-fix fresh windows are ~8.5-9/h. The acceptance target 0-1/h is missed.
- A new/clearer victim source emerged: `vkApiLimits:recordRateLimit`. Hypothesis: smaller chunks multiply mutation count on heavy accounts, making the rate-limit recorder more likely to be the function exiting when an already-heavy Isolate crosses the carry-over threshold.
- Marker functions are not solved. They shifted from `updateSyncTime`/`getInternal`/`getVkAdsCredentials` toward `recordRateLimit` and other small UDF exits. This supports the module-level/shared-Isolate-state hypothesis more than a pure write-set hypothesis.
- p95 latency impact is unknown. Smaller chunks reduce per-mutation memory but increase mutation count. Do not claim latency improved or regressed until Dashboard p95 is checked.

### Decision

**Continue with §3.3 module-state diagnostic** as a separate follow-up plan. Reasoning:
1. The plan was scoped to batch flush write-set reduction (§3.1). Within that scope it partially worked, especially for `saveRealtimeBatch`, but it did not fully satisfy the per-function acceptance for `saveDailyBatch`/`upsertAdsBatch`.
2. The remaining background (~8.5-9/h in fresh windows) is diversified across vkApi/ruleEngine/getCampaignsForAccount/getCampaignTypeMap/recordRateLimit. Several of these do not have a large write-set pattern and look like Isolate-level shared state (modules, JIT caches, closures, retained module caches).
3. Do not blindly lower chunk sizes again yet. Lowering `upsertAdsBatch` from 50 to 25 could reduce write-set pressure but would further multiply mutation count and may worsen rate-limit recorder / scheduler overhead. First measure p95 and run module-state diagnostics.

Follow-up plan must address §3.3 (Isolate memory profiling) and §3.4 (module-level audit). Auto-link-video cron (primary spec §8) remains gated on this — do not start it before module-state is investigated, or signal will be muddied again.

### What to also check manually (pending)

- p95 duration of saveDailyBatch / saveRealtimeBatch / upsertAdsBatch via Convex Dashboard for heavy accounts (compare with pre-deploy 24h history). If +30%+ — consider raising `HEAVY_BATCH_THRESHOLD` to 1200 to reduce mutation count multiplier.
