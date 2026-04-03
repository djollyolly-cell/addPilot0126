# Digest Redesign v2 — Per-Campaign, Typed Results, Period Comparison

## Goal

Переработать Telegram-дайджесты (сутки/неделя/месяц):
- Группировать данные по **VK Ads кампаниям** (ad_plan), а не по группам (ad_group)
- Разделять результаты по типу: **лиды**, **сообщения**, **подписки**, **просмотры** (awareness)
- Клики — отдельная метрика, не путать с результатом
- Сводка по правилам, сравнение с прошлым периодом

## Иерархия myTarget API v2

```
ad_plans.json  (= VK Ads Кампании)    — id, name, objective
  └─ ad_groups.json (= VK Ads Группы) — id, ad_plan_id, package_id
       └─ banners.json (= VK Объявления) — id, campaign_id (= ad_group_id)
```

**Критически важно:**
- `metricsDaily.campaignId` хранит `ad_group_id` (не ad_plan_id!)
- `banners.campaign_id` = `ad_group_id`
- Тип результата определяется по `package_id` на уровне **ad_group**
- Группировка в дайджесте — по `ad_plan_id` (кампания VK Ads)

## Architecture

Единый пайплайн для всех трёх дайджестов:

1. **Маппинг** — загружаем `ad_groups.json` (ad_group_id → ad_plan_id, package_id) + `packages.json` (package_id → name) + `ad_plans.json` (ad_plan_id → name)
2. **Классификация** — `package_id` → `packages.json` name → ключевые слова → 4 типа
3. **Агрегация** — метрики из `metricsDaily` → через banner → ad_group → ad_plan
4. **Форматирование** — `formatDigestMessage(type, data)` — по кампаниям VK Ads
5. **Отправка** — существующий `sendMessageWithRetry`

### 4 типа результатов (по package_id)

```typescript
type CampaignType = "lead" | "message" | "subscription" | "awareness";

function classifyCampaignPackage(packageName: string): CampaignType {
  const lower = packageName.toLowerCase();
  if (["join", "subscri", "подписк"].some(kw => lower.includes(kw)))
    return "subscription";
  if (["contact", "_engage", "clip", "video_and_live", "socialvideo", "сообщени"].some(kw => lower.includes(kw)))
    return "message";
  if (["branding", "reach", "video_view", "awareness"].some(kw => lower.includes(kw)))
    return "awareness";
  return "lead";
}
```

**Подтверждено на реальных данных VK API:**
- `objective=socialengagement` + package с "join" → subscription (подписка ДТП)
- `objective=socialengagement` + package без ключевых слов → lead (СС_ключи_кузовной)
- `objective=branding_socialengagement` → awareness (узнаваемость пост/видео)
- `objective=promoted_vk_post` → зависит от package

### Данные

```typescript
interface DigestCampaignData {
  adPlanId: number;
  adPlanName: string;
  type: CampaignType;              // Определяется по package_id группы
  impressions: number;
  clicks: number;                   // Отдельная метрика, НЕ результат
  spent: number;
  results: number;                  // Типизированный результат
  costPerResult: number;            // spent / results
}

interface DigestAccountData {
  name: string;
  campaigns: DigestCampaignData[];
  metrics: {
    impressions: number;
    clicks: number;
    spent: number;
    leads: number;
    messages: number;
    subscriptions: number;
    views: number;                  // Для awareness кампаний
    cpl: number;
    costPerMsg: number;
    costPerSub: number;
  };
  prevMetrics?: typeof metrics;
  ruleEvents: { ruleName: string; count: number; }[];
  savedAmount: number;
}

interface DigestData {
  accounts: DigestAccountData[];
  totals: DigestAccountData['metrics'];
  prevTotals?: DigestAccountData['metrics'];
}
```

### Маппинг ad_group → ad_plan

Для каждого кабинета при сборе дайджеста:
1. Загружаем `ad_groups.json` с полями `id, ad_plan_id, package_id`
2. Загружаем `packages.json` → `package_id → name`
3. Загружаем `ad_plans.json` → `ad_plan_id → name`
4. Строим маппинг: `ad_group_id → { adPlanId, adPlanName, type }`
5. Для каждой записи metricsDaily: `campaignId` (= ad_group_id) → маппинг → агрегируем по ad_plan

### Получение результатов

- `leads` = `metricsDaily.leads` (= Math.max из 5 источников, для rule engine)
- Для дайджеста используем `metricsDaily.vkResult` (= `base.vk.result`), если есть
- Fallback: `metricsDaily.leads` если `vkResult` не сохранён

## Формат сообщений

### Дневной дайджест

```
📊 Дайджест за 01.04.2026

📋 Сервис Парк:
📈 Показы: 89 738 | 👆 Клики: 176
💰 Расход: 5 745₽

Кампании:
🎯 СС_ключи_кузовной — лиды: 2 | CPL: 650₽
👥 подписка ДТП — подписки: 143 | стоимость: 2₽
👁 узнаваемость пост — просмотры: 20
👁 узнаваемость видео — просмотры: 10

⚙️ Правила: сработало 3 раза
• Клики без лидов — 2 раза
• CPL лимит — 1 раз
✅ Сэкономлено: ~1 200₽

Итого: расход 5 745₽, лиды 2, подписки 143
```

**Правила отображения:**
- Показываем только кампании с ненулевым расходом или результатом
- Иконка по типу: 🎯 лиды, 💬 сообщения, 👥 подписки, 👁 просмотры
- Клики — общая метрика кабинета, не дублируется по кампаниям
- Если у типа 0 результатов — не показываем в итогах

### Недельный/месячный — аналогично + дельты (↑↓%)

## Сравнение с прошлым периодом

```typescript
function formatDelta(current: number, previous: number): string {
  if (previous === 0) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "";
  return pct > 0 ? ` (↑${pct}%)` : ` (↓${Math.abs(pct)}%)`;
}
```

## Группировка правил

```typescript
const grouped = new Map<string, number>();
for (const event of events) {
  const name = event.ruleName || event.reason.split("—")[0].trim();
  grouped.set(name, (grouped.get(name) || 0) + 1);
}
```

## Изменения в файлах

### `convex/vkApi.ts`
- Обновить `getCampaignTypeMap` → возвращать `{ adGroupId, adPlanId, type }[]`
- Добавить загрузку `ad_groups.json` с `ad_plan_id`
- Добавить загрузку `ad_plans.json` с `id, name`

### `convex/telegram.ts`
- Обновить `classifyCampaignPackage` — добавить тип `awareness`
- Обновить `DigestMetrics` — добавить `views`
- Переписать `collectDigestData` — группировка по ad_plan, 4 типа результатов
- Переписать `formatDigestMessage` — по-кампанийный формат
- Обновить `sendDailyDigest`, `sendWeeklyDigest`, `sendMonthlyDigest`

### Не трогаем
- `convex/schema.ts` — без изменений
- `convex/crons.ts` — расписание не меняется
- `convex/ruleEngine.ts` — логика правил не меняется

## Edge Cases

- Кабинет без кампаний → не показываем
- Все результаты = 0 → показываем кабинет с общими метриками
- Package name не содержит ключевых слов → `lead` (safe default)
- `objective=branding_socialengagement` → может дополнительно использоваться как fallback для awareness
- Ad_group не найдена в маппинге → результат идёт в "lead" (fallback)
- Нет данных за прошлый период → без процентов
- Telegram лимит 4096 символов → разбиваем на части
- Кабинет без VK токена → пропускаем, не ломаем остальные
- vkResult=0 → используем undefined (не путать с отсутствием результата)
