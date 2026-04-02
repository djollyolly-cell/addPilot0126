# Digest Redesign — Leads vs Subscriptions, Per-Account, Period Comparison

## Goal

Переработать Telegram-дайджесты (сутки/неделя/месяц): разделить лиды и подписки, показывать данные в разрезе кабинетов, добавить сводку по правилам (сколько раз сработало каждое), сравнение с прошлым периодом для недельного/месячного.

## Architecture

Единый пайплайн для всех трёх дайджестов:

1. **Сбор данных** — `collectDigestData(ctx, userId, dateFrom, dateTo, prevDateFrom?, prevDateTo?)` — метрики + события правил + package mapping, в разрезе кабинетов
2. **Классификация** — по `package_id` группы → `packages.json` name → ключевые слова → лид или подписка
3. **Форматирование** — `formatDigestMessage(type, data)` — единая функция с вариациями по типу
4. **Отправка** — существующий `sendMessageWithRetry`

### Определение лидов vs подписок

1. Для каждого кабинета загружаем `packages.json` + `ad_groups.json` из VK API
2. Строим `packageMap: package_id → name`
3. Для каждой кампании берём `package_id` первой группы
4. Ищем в имени пакета ключевые слова: `"подписк"`, `"subscribe"`, `"community"`, `"join"` → **подписка**
5. Всё остальное → **лид**
6. `results` кампании (из `metricsDaily.leads` или `vk.result`) идут в соответствующую категорию

```typescript
function isSubscriptionPackage(packageName: string): boolean {
  const lower = packageName.toLowerCase();
  return ["подписк", "subscribe", "community", "join"].some(kw => lower.includes(kw));
}
```

### Данные

```typescript
interface DigestAccountData {
  name: string;                    // Название кабинета
  metrics: {
    impressions: number;
    clicks: number;
    spent: number;
    leads: number;                 // Результаты из "лидовых" кампаний
    subscriptions: number;         // Результаты из "подписочных" кампаний
    cpl: number;                   // spent_leads / leads
    costPerSub: number;            // spent_subs / subscriptions
  };
  prevMetrics?: typeof metrics;    // Метрики за прошлый период (неделя/месяц)
  ruleEvents: {
    ruleName: string;
    count: number;
  }[];
  savedAmount: number;
}

interface DigestData {
  accounts: DigestAccountData[];
  totals: DigestAccountData['metrics'];
  prevTotals?: DigestAccountData['metrics'];
}
```

### Сбор метрик по категориям

Для разделения spent между лидами и подписками:
- Группируем кампании в `metricsDaily` по типу (лид/подписка) через campaign → ad_group → package_id
- `spent_leads` = сумма spent по "лидовым" кампаниям
- `spent_subs` = сумма spent по "подписочным" кампаниям
- `CPL = spent_leads / leads`
- `CostPerSub = spent_subs / subscriptions`

### Маппинг campaign → package_id

`metricsDaily` хранит `campaignId` (строка, VK campaign ID = ad_plan ID). Для определения типа:
1. Загружаем `ad_groups.json` → получаем `ad_plan_id → package_id`
2. Загружаем `packages.json` → получаем `package_id → name`
3. Для каждого `ad_plan_id` берём `package_id` первой группы → определяем тип

Кеширование: пакеты не меняются часто, но для простоты запрашиваем при каждом дайджесте (раз в сутки — не нагрузка).

## Формат сообщений

### Дневной дайджест

```
📊 Дайджест за 01.04.2026

📋 Сервис Парк:
📈 Показы: 106 989 | 👆 Клики: 278
💰 Расход: 6 418₽
🎯 Лиды: 9 | CPL: 768₽
👥 Подписки: 571 | Стоимость: 52₽

⚙️ Правила: сработало 3 раза
• Клики без лидов — 2 раза
• CPL лимит — 1 раз
✅ Сэкономлено: ~1 200₽

📋 Другой кабинет:
📈 Показы: 50 000 | 👆 Клики: 150
💰 Расход: 3 200₽
🎯 Лиды: 25 | CPL: 128₽

✅ Правила не сработали

Итого: расход 9 618₽, лиды 34, подписки 571
```

**Правила:** если лидов = 0, строку "Лиды" не показываем. Аналогично для подписок.

### Недельный дайджест

```
📊 Сводка за неделю (24.03 — 30.03.2026)
📉 Сравнение с прошлой неделей (17.03 — 23.03)

📋 Сервис Парк:
📈 Показы: 750 000 (↑12%)
👆 Клики: 2 100 (↓3%)
💰 Расход: 45 200₽ (↑8%)
🎯 Лиды: 9 | CPL: 95₽ (↓5%)
👥 Подписки: 580 | Стоимость: 52₽ (↑2%)

⚙️ Правила: сработало 17 раз
• CPL лимит — 12 раз
• Клики без лидов — 5 раз
✅ Сэкономлено: ~8 500₽

Итого: расход 45 200₽ (↑8%), лиды 9, подписки 580
```

Если данных за прошлый период нет — показываем без процентов.

### Месячный дайджест

```
📅 Отчёт за март 2026
📉 Сравнение с февралём 2026

📋 Сервис Парк:
📈 Показы: 3 200 000 (↑5%)
👆 Клики: 8 900 (↑10%)
💰 Расход: 185 000₽ (↑3%)
🎯 Лиды: 45 | CPL: 620₽ (↓12%)
👥 Подписки: 2 400 | Стоимость: 51₽ (↓2%)

⚙️ Правила: сработало 68 раз
• CPL лимит — 45 раз
• Клики без лидов — 15 раз
• Быстрый расход — 8 раз
✅ Сэкономлено: ~35 000₽

Итого: расход 185 000₽ (↑3%), лиды 45, подписки 2 400
```

## Сравнение с прошлым периодом

```typescript
function formatDelta(current: number, previous: number): string {
  if (previous === 0) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "";
  return pct > 0 ? ` (↑${pct}%)` : ` (↓${Math.abs(pct)}%)`;
}
```

- **Неделя:** текущая пн-вс vs предыдущая пн-вс
- **Месяц:** текущий vs предыдущий календарный месяц
- **Дневной:** без сравнения (слишком шумно)

## Группировка правил (решение проблемы 973 дублей)

Текущая проблема: каждое срабатывание правила = отдельная строка в дайджесте.

Решение: группировать по `ruleName` и показывать количество:
```typescript
// Вместо 973 строк "🛑 Ad 209963110 — 25 кликов без лидов"
// Показываем: "• Клики без лидов — 973 раза"

const grouped = new Map<string, number>();
for (const event of events) {
  const name = event.ruleName || event.reason.split("—")[0].trim();
  grouped.set(name, (grouped.get(name) || 0) + 1);
}
```

## Изменения в файлах

### `convex/telegram.ts`
- Добавить: `collectDigestData(ctx, userId, dateFrom, dateTo, prevFrom?, prevTo?)` — новая функция сбора данных
- Переписать: `formatDailyDigest()` — новый формат с кабинетами, лиды/подписки
- Переписать: `formatWeeklyDigest()` — с дельтами
- Переписать: `formatMonthlyDigest()` — с дельтами
- Переписать: `sendDailyDigest` — использовать `collectDigestData`
- Переписать: `sendWeeklyDigest` — использовать `collectDigestData` + prev period
- Переписать: `sendMonthlyDigest` — использовать `collectDigestData` + prev period

### `convex/telegram.ts` — новые queries
- `getMetricsByAccount(userId, dates[])` — метрики в разрезе кабинетов
- `getActionLogsByRule(userId, since, until)` — события сгруппированные по правилам

### Не трогаем
- `convex/schema.ts` — без изменений схемы
- `convex/crons.ts` — расписание остаётся тем же
- `convex/ruleEngine.ts` — логика правил не меняется
- `convex/reports.ts` — packageMap уже добавлен

## Edge Cases

- Кабинет без кампаний → не показываем в дайджесте
- Все результаты = 0 → показываем кабинет с нулями (пользователь должен видеть что мониторинг работает)
- Package name не содержит ключевых слов → считаем лидом (safe default)
- Нет данных за прошлый период → показываем без процентов, убираем строку "Сравнение с..."
- Telegram лимит 4096 символов → если сообщение длиннее, разбиваем на несколько
- Кабинет без VK токена (expired) → пропускаем, не ломаем дайджест остальных
