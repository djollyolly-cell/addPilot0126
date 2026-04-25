# Video Rotation Module — Design Spec

**Дата:** 2026-04-25
**Статус:** Draft

## Обзор

Модуль ротации рекламных кампаний — отдельная функциональность AdPilot, позволяющая последовательно откручивать остановленные кампании (видео, клипы и др.) по заданному расписанию. Кампании запускаются по одной на фиксированный временной слот, затем автоматически переключаются на следующую. По завершении полного цикла — запуск с начала.

Модуль доступен только пользователям, которым его включил админ. Админ видит его по умолчанию.

## Архитектурное решение

**Подход A** — новый тип правила `video_rotation` в существующей таблице `rules`. Логика ротации вынесена в отдельный модуль `convex/videoRotation.ts`. Состояние ротации хранится в новой таблице `rotationState`.

Обоснование: максимальное переиспользование существующего CRUD, UI, фильтрации, admin gating. Execution-логика изолирована в отдельном файле.

## Schema

### Изменения в `rules`

Новый тип в union: `video_rotation`.

Поле `conditions` для типа `video_rotation`:

```typescript
{
  slotDurationHours: number,     // 1-24, целое число
  dailyBudget: number,           // рублей, > 0
  quietHoursEnabled: boolean,
  quietHoursStart: string,       // "HH:MM" (UTC), например "23:00"
  quietHoursEnd: string,         // "HH:MM" (UTC), например "07:00"
  campaignOrder: string[],       // vkCampaignId в порядке ротации
}
```

`targetCampaignIds` хранит список кампаний (как у обычных правил). `conditions.campaignOrder` задаёт порядок ротации (те же ID, но упорядоченные).

### Новая таблица `rotationState`

```typescript
rotationState: defineTable({
  ruleId: v.id("rules"),
  accountId: v.id("adAccounts"),
  currentIndex: v.number(),              // индекс в campaignOrder
  currentCampaignId: v.string(),         // vkCampaignId активной кампании
  slotStartedAt: v.number(),             // timestamp начала текущего слота (ms)
  dailyBudgetRemaining: v.number(),      // остаток дневного бюджета (руб.)
  budgetDayStart: v.string(),            // "YYYY-MM-DD" — день, к которому относится бюджет
  cycleNumber: v.number(),               // номер текущего цикла (для уведомлений)
  status: v.union(
    v.literal("running"),
    v.literal("paused_quiet_hours"),
    v.literal("paused_intervention"),
    v.literal("stopped"),
  ),
  pausedAt: v.optional(v.number()),              // timestamp паузы
  pausedElapsed: v.optional(v.number()),         // сколько времени слота уже прошло до паузы (ms)
  consecutiveErrors: v.optional(v.number()),     // счётчик последовательных ошибок API
  lastError: v.optional(v.string()),
})
.index("by_ruleId", ["ruleId"])
.index("by_accountId", ["accountId"])
```

### Изменения в `users`

```typescript
videoRotationEnabled: v.optional(v.boolean())  // админ включает модуль пользователю
```

## Логика ротации (convex/videoRotation.ts)

### tick() — основной цикл

Вызывается из `syncMetrics.syncAll()` каждые 5 минут, после `checkAllRules()`. Для каждого `rotationState`:

**1. Проверка внешнего вмешательства (status = "running")**

Запросить статус текущей активной кампании из VK API. Если статус != "active" (кто-то остановил снаружи):
- `status = "paused_intervention"`
- Telegram critical: "Ротация приостановлена: кампания X была остановлена извне"
- return

**2. Тихие часы**

Если сейчас тихие часы и `status = "running"`:
- Остановить текущую кампанию через VK API
- Сохранить `pausedElapsed` = время, прошедшее с начала слота
- `status = "paused_quiet_hours"`, `pausedAt = now`

Если тихие часы закончились и `status = "paused_quiet_hours"`:
- Запустить кампанию через VK API
- `slotStartedAt = now - pausedElapsed` (чтобы оставшееся время слота было корректным)
- `status = "running"`, очистить `pausedAt` и `pausedElapsed`

**3. Проверка времени слота (status = "running")**

```
elapsed = now - slotStartedAt
if elapsed >= slotDurationHours * 3600 * 1000:
    switchToNext()
```

### switchToNext() — переключение кампании

1. Остановить текущую кампанию (VK API -> status "blocked")
2. Рассчитать остаток бюджета:
   - Получить `metricsDaily.spent` за сегодня для текущей кампании
   - `dailyBudgetRemaining -= spent` за этот слот
3. Проверить смену дня: если `budgetDayStart != today`:
   - `dailyBudgetRemaining = dailyBudget` (полный сброс)
   - `budgetDayStart = today`
4. `currentIndex = (currentIndex + 1) % campaignOrder.length`
5. Если index вернулся к 0:
   - `cycleNumber++`
   - Telegram standard: "Цикл ротации #N завершён (X кампаний), запускаю заново"
6. Запустить следующую кампанию:
   - VK API -> status "active"
   - `setCampaignBudget(dailyBudgetRemaining)`
   - `slotStartedAt = now`
   - `currentCampaignId = campaignOrder[currentIndex]`
7. Telegram standard: "Ротация: кампания Y запущена (слот Xч, бюджет Z руб.)"

### activate(ruleId) — при включении правила

1. Остановить все кампании из `targetCampaignIds` через VK API
2. Создать `rotationState`:
   - `currentIndex: 0`
   - `currentCampaignId: campaignOrder[0]`
   - `slotStartedAt: Date.now()`
   - `dailyBudgetRemaining: dailyBudget`
   - `budgetDayStart: todayStr()`
   - `cycleNumber: 1`
   - `status: "running"`
   - `consecutiveErrors: 0`
3. Запустить первую кампанию + установить бюджет
4. Telegram standard: "Ротация запущена: X кампаний, слот Yч, бюджет Z руб./сутки"

### deactivate(ruleId) — при выключении правила

1. Остановить текущую активную кампанию через VK API
2. `status = "stopped"`
3. Telegram standard: "Ротация остановлена, все кампании выключены"

## Валидации

### При создании/редактировании правила video_rotation

1. **Пересечение с другими ротациями:** ни одна кампания из `targetCampaignIds` не должна быть в другом активном правиле `video_rotation`. Ошибка: "Кампания X уже участвует в другой ротации"

2. **Конфликт с обычными правилами (по кампаниям):** ни одна кампания из `targetCampaignIds` не должна быть в `targetCampaignIds` или `targetAdIds` другого активного правила любого типа. Ошибка: "Кампания X используется в правиле Y — ротация невозможна"

3. **Конфликт с обычными правилами (по аккаунту):** если на том же аккаунте есть активное правило без `targetCampaignIds` (= покрывает все кампании аккаунта), ротация запрещена. Ошибка: "На аккаунте есть правило Y без фильтра кампаний — ротация невозможна"

4. **Обратная валидация:** при создании обычного правила — проверить, не входят ли выбранные кампании в активную ротацию. Ошибка: "Кампания X участвует в ротации — назначение правил запрещено"

5. **Минимум кампаний:** `campaignOrder.length >= 2`

6. **Лимиты:**
   - `slotDurationHours`: 1-24, целое число
   - `dailyBudget`: > 0
   - `campaignOrder.length`: 2-50

7. **Доступ к модулю:** мутация `create` для типа `video_rotation` проверяет `user.videoRotationEnabled === true` или `isAdmin`. Иначе ошибка: "Модуль ротации не активирован"

## Интеграция с существующей системой

### syncMetrics.ts

В конце `syncAll()`, после `checkAllRules()`:

```typescript
await videoRotation.tick(accountId, accessToken)
```

Порядок: сначала метрики обновляются, потом ротация читает актуальный `metricsDaily.spent`.

### ruleEngine.ts

В `checkAllRules()` — skip кампаний в активной ротации:

```typescript
// Перед evaluateCondition для каждого ad:
if (rotatingCampaignIds.has(ad.campaignId)) -> skip
```

Страховка на случай обхода валидации при создании правила.

### rules.ts (CRUD)

- `create` / `update` — все валидации из раздела "Валидации"
- `toggleActive` — при активации `video_rotation` вызывает `videoRotation.activate()`, при деактивации — `videoRotation.deactivate()`

### admin.ts

Новая мутация:

```typescript
toggleVideoRotation(userId: Id<"users">, enabled: boolean)
```

## Уведомления (Telegram)

| Событие | Тип | Пример |
|---|---|---|
| Переключение кампании | standard | "Ротация: кампания Y запущена (слот 4ч, бюджет 1500 руб.)" |
| Завершение цикла | standard | "Цикл ротации #2 завершён (15 кампаний), запускаю заново" |
| Старт ротации | standard | "Ротация запущена: 15 кампаний, слот 4ч, бюджет 6000 руб./сутки" |
| Остановка ротации | standard | "Ротация остановлена, все кампании выключены" |
| Внешнее вмешательство | critical | "Ротация приостановлена: кампания X была остановлена извне" |
| Ошибка VK API (3+ подряд) | critical | "Ротация приостановлена: не удалось переключить кампанию X" |
| Кампания не найдена | critical | "Кампания X не найдена в VK, пропущена" |

Тихие часы Telegram не применяются к critical-уведомлениям ротации.

## UI

### Страница Правила (/rules)

Тип `video_rotation` ("Ротация кампаний") появляется в селекторе типа правила, если `user.videoRotationEnabled === true` или `isAdmin`.

Форма создания правила ротации:

- **Название** — текстовое поле
- **Аккаунт** — выпадающий список подключённых аккаунтов
- **Кампании** — мультиселект с нумерованным порядком (1, 2, 3...). Кампании, участвующие в других ротациях или покрытые другими правилами, недоступны для выбора
- **Время слота** — выпадающий список от 1ч до 24ч (шаг 1ч)
- **Бюджет на сутки** — числовое поле (руб.)
- **Тихие часы** — чекбокс + два поля времени (с/до)

### Карточка правила в списке

- Бейдж: "Ротация" (`variant="secondary"`)
- Статус ротации: "Кампания 3/15 — Название кампании" или "Пауза (тихие часы)" или "Приостановлена (вмешательство)"
- Прогресс цикла: "Цикл #2, осталось 8 кампаний"

### Админ-панель (/admin) — вкладка "Модули"

Таблица: пользователь x модуль. Столбцы:
- Имя пользователя
- Email
- Ротация кампаний (toggle)
- (будущие модули добавляются как новые столбцы)

## Edge Cases

### Сбой сервера / пропуск sync

При следующем `tick()` проверяем `slotStartedAt`. Если прошло больше `slotDurationHours` — переключаем. Если пропущено несколько слотов — переключаем по одному за tick (не перескакиваем), чтобы каждая кампания получила хотя бы несколько минут.

### Ошибка VK API при переключении

- Retry на следующем tick (через 5 минут)
- После 3 неудачных попыток подряд (`consecutiveErrors >= 3`): `status = "paused_intervention"`, Telegram critical
- Счётчик `consecutiveErrors` сбрасывается при успешном действии

### Удаление кампании из VK

При попытке запуска API вернёт ошибку — пропускаем, переходим к следующей по очереди. Telegram critical: "Кампания X не найдена в VK, пропущена". Если все кампании удалены — `status = "paused_intervention"`.

### Тихие часы на границе слота

Слот 4 часа, начался в 21:00, тихие часы 23:00-07:00:
- В 23:00: кампания останавливается, `pausedElapsed = 2ч`
- В 07:00: кампания возобновляется, `slotStartedAt = now - 2ч` (докрутит оставшиеся 2 часа)

### Остаток бюджета при переходе через полночь

Слот может пересекать границу суток. При первом tick нового дня, если `budgetDayStart != today`:
- `dailyBudgetRemaining = dailyBudget` (полный сброс)
- `budgetDayStart = today`
- Устанавливаем новый `budget_limit_day` на активную кампанию

## Файлы для создания/изменения

| Файл | Действие |
|---|---|
| `convex/schema.ts` | Добавить `rotationState` таблицу, `video_rotation` в тип правила, `videoRotationEnabled` в users |
| `convex/videoRotation.ts` | **Новый** — tick(), switchToNext(), activate(), deactivate() |
| `convex/rules.ts` | Валидации для video_rotation, вызов activate/deactivate при toggleActive |
| `convex/ruleEngine.ts` | Skip кампаний в активной ротации |
| `convex/syncMetrics.ts` | Вызов videoRotation.tick() после checkAllRules() |
| `convex/admin.ts` | toggleVideoRotation мутация |
| `src/pages/rules/RulesPage.tsx` | Условное отображение типа video_rotation |
| `src/pages/rules/RuleForm.tsx` (или новый компонент) | Форма создания правила ротации |
| `src/pages/rules/RotationStatusCard.tsx` | **Новый** — карточка правила с live-статусом ротации |
| `src/pages/admin/AdminModulesTab.tsx` | **Новый** — вкладка "Модули" |
| `src/pages/admin/AdminPage.tsx` | Добавить вкладку "Модули" |
| `convex/telegram.ts` | Шаблоны уведомлений ротации |

## deleteUser cascade

При удалении пользователя: удалить все `rotationState` записи, связанные с его правилами `video_rotation`.

## Data retention

`rotationState` — удаляется вместе с правилом или при деактивации (status = "stopped"). Нет отдельного TTL — запись живёт пока правило активно.
