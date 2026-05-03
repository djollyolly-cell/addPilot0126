# Convex Isolate memory carry-over fix — design

**Дата:** 2026-05-03
**Контекст:** AdPilot, self-hosted Convex backend (PG 16.11, образ `ghcr.io/get-convex/convex-backend:latest`).
**Связанный отчёт:** `2026-05-03-postgres-checkpoint-storm-fix.md` разделы 14, 15, 17.
**Тип задачи:** оптимизация кода (TypeScript), не инфраструктура.

---

## 1. Симптом и корневая причина

### Симптом
WebSocket-разрывы 1006 на `convex.aipilot.by` сохраняются после устранения Traefik `idleTimeout = 180s`. На свежей вкладке `/dashboard` за 30 минут — 7 разрывов; в логах Convex backend в эти моменты видны массовые синхронные разрывы (7–8 одновременно).

### Корневая причина
V8 Isolate в Convex имеет лимит heap **96 MiB**. Когда после GC между запросами остаётся **>60 MiB живых объектов** — Convex принудительно рестартует Isolate. **Все WS-соединения через этот Isolate в момент рестарта рвутся**.

В логах за 30-минутное окно замера:
```
51 ERROR / 30 min  (включая Restarting Isolate memory_carry_over)
46 WARN  / 30 min  (WebSocket protocol error / ping-pong timeout)
```

### Виновные функции (по логам)
- `Action: vkApi.js:getMtBanners` — 63.70 MiB carry-over
- `UDF: adAccounts.js:upsertCampaignsBatch` — 63.67 MiB
- `Action: vkApi.js:getMtStatistics` — 63.57 MiB

### Анализ кода (по реальным файлам)

**`convex/syncMetrics.ts:938+`** — per-account worker одновременно держит:
- `banners` (full объекты с `textblocks`, `urls`, `content` — самое тяжёлое)
- `bannerIds`, `bannerCampaignMap`
- `stats`, `leadCounts`
- `vkCampaigns`, `groupData`, `campaignTypeMap`
- `fetchedAdPlans`, `adPlanBudgets`

ВСЕ одновременно в одном sync-worker'е. `convex/syncMetrics.ts:15` объявляет `WORKER_COUNT = 6` — sync dispatch разбивает аккаунты на 6 параллельных batch-worker'ов. `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=32` — общий ceiling на ВСЕ V8 actions (sync + nested + crons + другие).

**`convex/adAccounts.ts:1709`** — `upsertCampaignsBatch` делает sequential цикл по `args.campaigns` внутри одной `internalMutation`. На batch=200 это 200 query+patch операций в одной транзакции; mutation держит весь read/write set до commit.

---

## 2. Цели

### Что должно стать
1. `TooMuchMemoryCarryOver` в логах — **0 за час** при нормальной нагрузке.
2. WS 1006 разрывов — **0–2 / час** на свежей вкладке `/dashboard`.
3. Sync на самом тяжёлом аккаунте (через admin panel) — **без Isolate restart**.

### Что НЕ цель
- `shared_buffers` — отдельная задача (раздел 11 связанного отчёта).
- Закрытие порта 5433 — отдельный одиночный PR.
- Поднятие heap limit Convex — зашит в backend, env-override нет.

---

## 3. План изменений

### Приоритет 1 — `syncMetrics.ts` per-account worker memory budget

#### 3.1. Lightweight `getMtBanners` для sync path

**Сейчас:** `getMtBanners` возвращает полный объект баннера, включая поле `content` (превью с URL'ами, видео, креативы — самое тяжёлое поле).

**Стать:** добавить параметр `fields` в `convex/vkApi.ts:getMtBanners`. Для обычного sync вызывать с лёгким набором:

```
fields=id,campaign_id,textblocks,status,moderation_status
```

**Обоснование выбора полей:**
- `id`, `campaign_id`, `status` — нужны для построения `bannerCampaignMap` и фильтрации.
- `moderation_status` — используется ниже в логике sync (банить/обновлять).
- `textblocks` — нужно для `upsertAdsBatch` (обновление имени объявления).
- `content` — НЕ нужно для метрик/sync. Auto-link-video, если использует `content`, выносить в отдельную задачу/cron (не в sync path).

**Без nested field selection.** myTarget API не гарантированно поддерживает `textblocks.title.text` — берём `textblocks` целиком (он сам по себе небольшой).

**Где вызывается:** `syncMetrics.ts:938`. Добавить второй вызов `getMtBanners` (full) на пути auto-link-video, если он останется.

#### 3.2. Scoped helpers вместо удержания тяжёлых объектов

**Сейчас:** в `syncMetrics.ts` per-account worker все тяжёлые объекты держатся в одном scope ~70+ строк подряд.

**Стать:** extract в helper-функции, которые принимают токен/id и возвращают **только компактный результат**:

```typescript
// Вместо:
//   const banners = await getMtBanners(...);  // живёт всё время
//   const bannerCampaignMap = new Map();
//   for (const b of banners) bannerCampaignMap.set(...)
//   ...использование map'а 50+ строк ниже...

// Стать:
const bannerCampaignMap = await buildBannerCampaignMap(accessToken, accountId);
// banners как переменная не существует в этом scope — GC заберёт сразу

async function buildBannerCampaignMap(
  token: string,
  accountId: Id<"adAccounts">
): Promise<Map<string, string>> {
  const banners = await getMtBannersLight(token, accountId);
  const map = new Map<string, string>();
  for (const b of banners) map.set(String(b.id), String(b.campaign_id));
  return map;
}
```

**Преимущества:**
- Тяжёлая переменная `banners` живёт только внутри helper'а.
- На return Map — все ссылки на массив `banners` исчезают, GC может его собрать.
- Не нужно `banners = null` (мутация let-переменной — императивно и часто бесполезно: компилятор может оптимизировать иначе).
- Чище для review: явный контракт «беру токен → отдаю Map».

**Применить тот же паттерн для:**
- `vkCampaigns` → `buildGroupDataMap()` returning `Map<string, GroupData>`.
- `campaignTypeMap` → `buildCampaignTypeMap()` (уже почти helper, finalize).
- `fetchedAdPlans` → `buildAdPlanBudgetsMap()`.

#### 3.3. Streaming-обработка по этапам

**Сейчас:** sync собирает ВСЕ структуры (banners, stats, leadCounts, campaigns, types, ad_plans), потом на их основании делает upserts.

**Стать (мысленно):** разбить на этапы, где каждый этап завершает работу с тяжёлой переменной до следующего:

```
Этап 1: получить bannerCampaignMap → освободить banners
Этап 2: получить stats + leadCounts → агрегировать в metricsRows → освободить stats, leadCounts
Этап 3: получить groupData + campaignTypeMap → построить adPlanBudgets → освободить
Этап 4: построить итоговый payload для upsert mutations
Этап 5: вызвать upsert mutations, освободить локальные структуры
```

Технически в TypeScript это значит — каждый этап оборачивается в `await`-функцию-helper, которая возвращает только нужное наружу.

### Приоритет 2 — `upsertCampaignsBatch` chunk-size

#### 3.4. Замерить распределение

Нужен **Convex internal query** (SQL напрямую к `campaigns` не подходит — Convex хранит app-таблицы во внутренних document/index структурах Postgres, не как `public.campaigns`):

```typescript
// convex/admin.ts — добавить internalQuery
export const campaignCountByAccount = internalQuery({
  handler: async (ctx) => {
    const all = await ctx.db.query("campaigns").collect();
    const counts: Record<string, number> = {};
    for (const c of all) counts[c.accountId] = (counts[c.accountId] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20);
  },
});
```

Запустить через Convex Dashboard → Functions → run. Получить топ-20 аккаунтов по числу кампаний.

#### 3.5. Адаптивный chunk-size

На основании замера в 3.4:
- Для аккаунтов с **>500 кампаний** — chunk **50**.
- Для остальных — оставить **200**.

Реализация: в `syncMetrics.ts` перед вызовом `upsertCampaignsBatch` определять размер на основании текущего количества кампаний и резать массив `campaigns` на чанки соответствующего размера, вызывая mutation N раз вместо одного.

**Trade-off:** теряем атомарность всего batch'а в пользу memory pressure relief. Если sync падает между чанками — частично применённые изменения не откатываются. Это приемлемо для ежеминутного sync (следующий проход всё доисправит).

---

## 4. Чего НЕ делать

| Идея | Почему НЕ |
|---|---|
| `JSON.parse(JSON.stringify(x))` для разрыва ссылок | Удваивает пик памяти (создаётся вторая копия), не помогает с carry-over |
| Поднять `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` 32 → 64 | Больше параллельных worker'ов с большими массивами = хуже |
| Поднять Convex heap limit (96 MiB) | Зашит в backend, env-override в self-hosted нет; даже если найдётся — обход, не лечение |
| `banners = null` после использования | Императивная мутация let, часто бесполезна (компилятор может игнорировать); scoped helper чище |
| Использовать nested field selection `textblocks.title.text` | myTarget API не гарантированно поддерживает; брать `textblocks` целиком |

---

## 5. Опционально (диагностика, не лечение)

**Временно понизить** `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` 32 → 16 в env переменной контейнера `adpilot-convex-backend`.

Все carry-over restart'ы в логах валятся на `vkApi.js:getMtBanners` и `getMtStatistics` — те самые функции, которые планируется оптимизировать. Если при ALPP=16 restart'ы заметно сократятся — подтверждение гипотезы «проблема в одновременном удержании больших объектов параллельными worker'ами».

**Это не лечение**, лечение — оптимизация функций (пункты 3.1–3.5). Диагностический сигнал.

---

## 6. Verification (acceptance criteria)

После деплоя оптимизаций:

| # | Метрика | Целевое значение | Команда / способ |
|---|---|---|---|
| 1 | Isolate restart'ы за 1 час | **0** | `ssh root@178.172.235.49 'docker logs --since 1h adpilot-convex-backend 2>&1 \| grep TooMuchMemoryCarryOver \| wc -l'` |
| 2 | WS 1006 разрывов | **0–2 / час** | Свежая вкладка `aipilot.by/dashboard`, ждать 60+ минут, считать `WebSocket closed with code 1006` в console |
| 3 | Sync тяжёлого аккаунта | **без Isolate restart** | Через admin panel запустить sync на топ-1 аккаунт (по количеству кампаний из 3.4), наблюдать `docker logs -f adpilot-convex-backend` |
| 4 | Postgres-метрики не деградировали | `checkpoints_req` ≤ 5/час | `docker exec adpilot-postgres psql -U convex -d convex_adpilot -c 'SELECT * FROM pg_stat_bgwriter'` |

---

## 7. Зависимости и риски

### Что должно остаться рабочим
- `upsertAdsBatch` использует `textblocks` для имени → проверить, что lightweight `getMtBanners` отдаёт `textblocks` (да, в списке).
- Auto-link-video использует `content`, поэтому в текущем memory-fix **временно отключается в primary sync path**. Функциональность должна быть восстановлена отдельным cron PR; не возвращать `content` в обычный sync.

### Риски
- **Atomicity loss в `upsertCampaignsBatch`:** при разбиении на chunk'и теряем full-batch транзакцию. Для еждуминутного sync приемлемо (следующий проход доисправит). Для миграционных сценариев — нет.
- **Lightweight `getMtBanners` ломает где-то ещё:** надо grep'нуть все вызовы `getMtBanners`, проверить какие поля они используют. Те, что используют `content`, — оставить на full-вызове или мигрировать.

### Откат
Все правки — изменения кода, без необратимых операций. Откат через `git revert` соответствующих коммитов + redeploy через GitHub Actions (push в main).

---

## 8. Follow-up cron requirements

Auto-link-video должен вернуться отдельным low-frequency cron/job, а не в primary sync path.

Hard requirements:

1. **Частота:** раз в 30–60 минут. Не запускать каждые 5 минут, иначе тяжёлый `getMtBanners(content)` снова станет регулярным источником memory pressure.
2. **Videos-first bounded scan:** сначала дешёво выбрать bounded набор candidate-видео/баннеров из Convex: `vkMediaId`, без `vkAdId`, `uploadStatus === "ready"`, `linkAbandoned !== true`, `LIMIT maxCandidates` (например 200). Единица лимита — candidate/banner, не account.
3. **Fair ordering:** выбирать candidates по `lastLinkAttemptAt ASC NULLS FIRST`, fallback `_creationTime ASC`. После каждой попытки обновлять `lastLinkAttemptAt`/`linkAttempts`, чтобы backlog двигался вперёд и хвост не голодал.
4. **Group after cap:** только после bounded/fair выборки сгруппировать candidates по `accountId`. Один аккаунт с 1500 pending videos не должен съедать весь будущий backlog навсегда; 30 аккаунтов по 5 candidates должны пройти в том же окне.
5. **Per-account sequential:** обрабатывать группы аккаунтов строго последовательно. Не использовать `Promise.all(accountIds.map(...))` и не запускать несколько full-content fetch одновременно.
6. **Scoped heavy payload:** full `getMtBanners(fields: "id,content")` делать только для аккаунтов, попавших в текущий candidate set. Payload должен жить внутри короткого helper/IIFE, наружу возвращать только компактный `bannerVideoMap`.
7. **Zombie protection:** добавить TTL или attempt-counter для видео, которые невозможно привязать, потому что баннер удалён/недоступен в VK. Например `linkAttempts`, `lastLinkAttemptAt`, `linkAbandoned`, или фильтр по возрасту `createdAt`.
8. **Verification:** после cron PR проверить `TooMuchMemoryCarryOver` за 1 час, WS 1006, и число pending unlinked videos до/после.

Commit/PR notes for current memory-fix:

- Auto-link-video disabled in primary sync intentionally, pending dedicated cron PR.
- Suggested subject: `perf(sync): reduce memory carry-over; disable auto-link-video pending cron`.

---

## 9. Источники истины (что читать перед началом)

- `2026-05-03-postgres-checkpoint-storm-fix.md` разделы 14, 15, 17 — диагностика и история.
- Memory `websocket-1006-investigation.md` — краткое состояние.
- Memory `postgres-tuning.md` — состояние Postgres-фикса.
- `convex/syncMetrics.ts:15` (`WORKER_COUNT = 6`), `:938+` (per-account worker).
- `convex/vkApi.ts` — функции `getMtBanners`, `getMtStatistics`, `getMtLeadCounts`.
- `convex/adAccounts.ts:1709` — `upsertCampaignsBatch`.
- `docker/docker-compose.convex-selfhosted.yml` — env vars (`APPLICATION_MAX_CONCURRENT_V8_ACTIONS`).
