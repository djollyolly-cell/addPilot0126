# Правило «Работа с УЗ» — Спецификация

## Обзор

Новый тип правила `uz_budget_manage` для автоматического управления дневным бюджетом кампании (группы) в VK Ads. Стратегия: установить начальный бюджет → при приостановке по бюджету увеличить на шаг → опционально сбросить в начале суток.

Цель: тонкое управление расходом на группы с форматом «Универсальная запись».

**Важно:** «Универсальная запись» — это формат объявления (определяется `package_id` группы), а НЕ objective кампании. В myTarget API v2:
- `ad_plans.json` = Кампании (верхний уровень, имеет `objective`)
- `campaigns.json` = Группы (средний уровень, имеет `package_id`)
- `banners.json` = Объявления

Группы с форматом УЗ определяются по `package_id = 960`.

## Параметры правила

### conditions

| Поле | Тип | Обязательное | Валидация | Описание |
|---|---|---|---|---|
| `initialBudget` | number | да | > 0 | Начальный дневной бюджет (₽) |
| `budgetStep` | number | да | > 0 | Шаг увеличения бюджета (₽) |
| `maxDailyBudget` | number | нет | > `initialBudget` | Максимальный бюджет за день. Без лимита если не задан |
| `resetDaily` | boolean | да | — | Сбрасывать бюджет на `initialBudget` в начале суток |

### actions

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `notify` | boolean | true | Отправлять уведомления |
| `notifyOnEveryIncrease` | boolean | false | Уведомлять при каждом увеличении бюджета |
| `notifyOnKeyEvents` | boolean | true | Уведомлять при ключевых событиях: достижение максимума, первое увеличение дня |
| `notifyChannel` | string | "telegram" | Канал уведомлений |

### Фильтрация

| Поле | Обязательное | Описание |
|---|---|---|
| `targetAccountIds` | да | Рекламные аккаунты |
| `targetCampaignIds` | да (для этого типа) | Группы (campaigns в myTarget API). Обязательно. В UI показывать только группы с `package_id = 960` (формат «Универсальная запись») |

## Логика работы

### 1. Проверка каждые 5 минут (в рамках syncAll → checkAllRules)

```
Для каждого активного правила типа uz_budget_manage:
  Для каждой целевой группы (campaigns.json):
    1. Получить статус группы и dailyLimit из VK API
    2. Определить «приостановлена по бюджету»:
       status == "blocked" И spent >= dailyLimit
       (myTarget не различает ручную остановку и бюджетную — используем косвенную проверку)
    3. Если НЕ приостановлена по бюджету → пропустить
    4. Если приостановлена по бюджету:
       a. Прочитать текущий dailyLimit группы
       b. Если maxDailyBudget задан И dailyLimit >= maxDailyBudget:
          → НЕ увеличиваем
          → Уведомляем «Достигнут максимальный бюджет» (если notifyOnKeyEvents)
          → Записываем в actionLogs
          → Пропустить
       c. Иначе:
          → newLimit = dailyLimit + budgetStep
          → Если maxDailyBudget задан: newLimit = min(newLimit, maxDailyBudget)
          → PATCH dailyLimit через VK API
          → Записываем в actionLogs (actionType: "budget_increased")
          → Уведомляем (если notifyOnEveryIncrease ИЛИ первое увеличение дня + notifyOnKeyEvents)
```

### 2. Крон сброса бюджета (00:00 по часовому поясу пользователя)

```
Для каждого активного правила типа uz_budget_manage с resetDaily = true:
  Для каждой целевой кампании:
    1. PATCH dailyLimit = initialBudget через VK API
    2. Записываем в actionLogs (actionType: "budget_reset")
    3. Уведомляем (если notifyOnKeyEvents)
```

Часовой пояс берётся из `userSettings.timezone`. По умолчанию UTC.

### 3. Дедупликация

- Не увеличиваем бюджет, если уже увеличивали для этой кампании в текущем 5-минутном цикле
- Проверяем по actionLogs: если есть `budget_increased` для кампании в последние 5 минут → пропускаем

## Изменения в схеме БД

### Таблица rules

Добавить `uz_budget_manage` в union типов правил:
```
type: v.union(
  ...existing types...,
  v.literal("uz_budget_manage")
)
```

### Таблица actionLogs

Добавить новые actionType:
```
actionType: v.union(
  ...existing types...,
  v.literal("budget_increased"),
  v.literal("budget_reset")
)
```

Поле `savedAmount` для `budget_increased` = размер увеличения (budgetStep).

## VK API

### Иерархия сущностей myTarget API v2

```
ad_plans.json  → Кампании (objective, budget_limit)
campaigns.json → Группы (package_id, daily_limit, status)
banners.json   → Объявления
```

### Определение «приостановлена по бюджету»

myTarget API НЕ имеет отдельного статуса `budget_reached`. При исчерпании бюджета группа получает `status: "blocked"`. Косвенная проверка:
```
status == "blocked" AND spent_today >= daily_limit
```
Это отличает бюджетную остановку от ручной (при ручной остановке spent < dailyLimit).

### Получение групп с форматом УЗ

```
GET /api/v2/campaigns.json?fields=id,name,status,package_id,daily_limit
```
Фильтр: `package_id == 960` → формат «Универсальная запись».

### Изменение бюджета группы

```
POST /api/v2/campaigns.json
Content-Type: application/json

[{"id": campaignId, "daily_limit": newLimitInKopecks}]
```

Бюджет в myTarget API передаётся в **копейках** (`daily_limit * 100`).

### Возобновление показов после увеличения бюджета

После увеличения `daily_limit` группа может не возобновиться автоматически. Если нужно — отправить:
```
POST /api/v2/campaigns.json
[{"id": campaignId, "status": "active"}]
```

## UI — Форма создания правила

При выборе типа `uz_budget_manage`:

### Поля формы
1. **Начальный бюджет** — числовое поле, суффикс «₽», placeholder «100»
2. **Шаг увеличения** — числовое поле, суффикс «₽», placeholder «1»
3. **Максимальный бюджет** — числовое поле, суффикс «₽», placeholder «Без ограничений» (опционально)
4. **Сбрасывать бюджет ежедневно** — переключатель (toggle), по умолчанию включён
5. **Выбор групп** — обязательный мультиселект, показывать только группы с `package_id = 960` (формат УЗ)
6. **Уведомления**:
   - Чекбокс «При каждом увеличении»
   - Чекбокс «Только ключевые события» (по умолчанию включён)

### Описание в списке типов
Название: «Работа с УЗ»
Описание: «Управление дневным бюджетом группы: автоматическое увеличение при приостановке и сброс в начале суток»

## Уведомления в Telegram

### При увеличении бюджета (если notifyOnEveryIncrease)
```
📊 Бюджет увеличен
Кампания: {campaignName}
Бюджет: {oldLimit}₽ → {newLimit}₽ (+{step}₽)
```

### При достижении максимума (если notifyOnKeyEvents)
```
⚠️ Достигнут максимальный бюджет
Кампания: {campaignName}
Текущий бюджет: {dailyLimit}₽ / {maxDailyBudget}₽
```

### При сбросе (если notifyOnKeyEvents)
```
🔄 Бюджет сброшен
Кампания: {campaignName}
Бюджет: {initialBudget}₽
```

### При первом увеличении дня (если notifyOnKeyEvents и НЕ notifyOnEveryIncrease)
```
📊 Первое увеличение бюджета за день
Кампания: {campaignName}
Бюджет: {oldLimit}₽ → {newLimit}₽
```

## Файлы для изменения

| Файл | Изменения |
|---|---|
| `convex/schema.ts` | Добавить `uz_budget_manage` в типы правил, новые actionType |
| `convex/ruleEngine.ts` | Логика проверки статуса + увеличение бюджета |
| `convex/vkApi.ts` | Функция `updateCampaignBudget()` |
| `convex/crons.ts` | Крон сброса бюджета |
| `convex/rules.ts` | Валидация нового типа при создании |
| `convex/telegram.ts` | Шаблоны уведомлений для бюджетных событий |
| `src/pages/RulesPage.tsx` | Форма с полями для нового типа |

## Ограничения и риски

1. **Rate limit VK API** — при большом количестве групп частые PATCH запросы. `callMtApi` уже обрабатывает 429 с retry.
2. **Косвенное определение бюджетной остановки** — `status: "blocked" + spent >= dailyLimit` не 100% точно. Если пользователь вручную остановил группу в момент когда spent == dailyLimit, правило ошибочно увеличит бюджет. Риск низкий и безвредный (увеличение бюджета не навредит остановленной группе).
3. **Возобновление показов** — после увеличения `daily_limit` myTarget может не возобновить показы автоматически. Нужно дополнительно отправить `status: "active"`. Проверить на реальном аккаунте.
4. **Часовые пояса** — крон сброса должен учитывать timezone каждого пользователя. Текущий крон работает в UTC.
5. **package_id = 960** — значение взято из кодбазы (`aiCabinet.ts`). Если VK изменит ID, нужно обновить. Вынести в конфигурацию.
