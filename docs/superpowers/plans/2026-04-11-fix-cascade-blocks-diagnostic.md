# План: Улучшение диагностики каскадных блокировок

**Дата:** 2026-04-11
**Статус:** Ожидает подтверждения

## Корневая проблема

Диагностика `checkCascadeBlocks` показывает "20 ad_plans blocked, 5 users" — но **не различает причину блокировки**. В реальности:

- **Все обнаруженные blocked ad_plans** имеют issue `STOPPED` — ручная остановка пользователем в VK кабинете
- Это **не системная проблема** и не баг cascade unblock — система корректно пропускает такие campaigns
- Но диагностика создаёт ложное ощущение аварии (error status, красная иконка)

### Реальные данные (2026-04-11, выборка 26 из 188 аккаунтов):

| Пользователь | Blocked plans | Campaigns | Issue | Аккаунты |
|---|---|---|---|---|
| kx73c1pg5yqfnschqfa0b38jmn843bv5 | 6 | 50 | STOPPED | Омск/Яна, Лазерка/Мск, Уренгой |
| kx7dz8f32fv6b4psr9skscpqtd8431rx | 1 | 1 | STOPPED | КК |

Все campaigns: status=blocked, delivery=not_delivering, spent=0₽, budget=100₽ (initialBudget).

## Решение

### Изменение 1: Классификация причин блокировки в `checkCascadeBlocks`

**Файл:** `convex/budgetHealthCheck.ts:96-115`

Сейчас: план со статусом "blocked" → сразу считается проблемой (error).

Нужно: использовать `issues` из VK API ответа для классификации.

```typescript
// Было:
const planData = await mtApi<{ items: Array<{ id: number; status: string; name: string }> }>(
  "ad_plans.json", token, { _id: String(planId), fields: "id,status,name" }
);

// Стало:
const planData = await mtApi<{ items: Array<{
  id: number; status: string; name: string;
  issues?: Array<{ code: string; message: string }>
}> }>(
  "ad_plans.json", token, { _id: String(planId), fields: "id,status,name,issues" }
);
```

Классификация по issue code:
| VK Issue Code | Наша категория | Уровень |
|---|---|---|
| `STOPPED` | Ручная остановка | info (не error) |
| `BUDGET_LIMIT` | Бюджет исчерпан | warning |
| `MODERATION` / другие | Модерация / системная | error |
| Нет issues | Неизвестно | warning |

### Изменение 2: Раздельный подсчёт и отчёт

**Файл:** `convex/budgetHealthCheck.ts:61-63, 140-158`

Вместо одного счётчика `blockedPlans` — три:
```typescript
let manuallyStoppedPlans = 0;   // STOPPED — не ошибка
let budgetBlockedPlans = 0;     // BUDGET_LIMIT — cascade unblock должен был справиться
let moderationBlockedPlans = 0; // MODERATION и другие — реальная проблема
```

Логика определения статуса:
```typescript
if (moderationBlockedPlans > 0) status = "error";
else if (budgetBlockedPlans > 0) status = "warning";
// manuallyStoppedPlans → не влияет на status (info only)
```

### Изменение 3: Улучшенный формат сообщения

**Файл:** `convex/budgetHealthCheck.ts:151-158`

Было:
```
🛑 Каскадные блокировки: 7 ad_plans, 0 групп с blocked баннерами
  Юзер1: 6 ad_plans blocked (50 групп)
  Юзер2: 1 ad_plans blocked (1 групп)
```

Стало:
```
✅ Каскадные блокировки: ок (7 ad_plans остановлены вручную)
```

или если есть реальные проблемы:
```
🛑 Каскадные блокировки: 2 ad_plans модерация, 1 бюджет (+ 7 ручных)
  Юзер1: 2 ad_plans модерация (12 групп)
  Юзер2: 1 ad_plan бюджет (5 групп)
```

### Изменение 4: userProblems с детализацией

**Файл:** `convex/budgetHealthCheck.ts:63, 106-113`

```typescript
// Было:
const userProblems = new Map<string, { plans: number; groups: number }>();

// Стало:
const userProblems = new Map<string, {
  stopped: number;      // ручная остановка
  budget: number;       // бюджетная блокировка
  moderation: number;   // модерация/другое
  groups: number;       // affected campaigns
}>();
```

## Файлы для изменения

| Файл | Строки | Изменение |
|---|---|---|
| `convex/budgetHealthCheck.ts` | 96-115 | Добавить `issues` в VK API запрос, классификация |
| `convex/budgetHealthCheck.ts` | 61-63 | Три счётчика вместо одного |
| `convex/budgetHealthCheck.ts` | 106-113 | userProblems с категориями |
| `convex/budgetHealthCheck.ts` | 140-158 | Новая логика статуса + формат сообщения |

## Анализ рисков

### 1. VK API поле `issues`
`issues` — стандартное поле VK API для ad_plans. Документировано, стабильное. Добавление `issues` в `fields` параметр не ломает существующую логику.
**Вердикт:** Безопасно.

### 2. Изменение уровня severity
Ручные остановки перестают быть error → info. Если реальная проблема скрывается за STOPPED статусом, мы её не увидим. Но VK API issue code — это авторитетный источник.
**Вердикт:** Безопасно. STOPPED = ручная остановка однозначно.

### 3. Обратная совместимость
`CheckResult` интерфейс не меняется (name, status, message, details). Формат details (массив строк) сохраняется. `healthCheck.saveResult` продолжает работать.
**Вердикт:** Безопасно.

### 4. Производительность
Один дополнительный field в запросе `ad_plans.json` (issues). Количество запросов не меняется.
**Вердикт:** Ничтожная нагрузка.

## Ожидаемый результат

- Ручные остановки ad_plans перестают генерировать ложные error-алерты
- Реальные проблемы (модерация, бюджетная блокировка) по-прежнему видны
- Диагностика информативнее: видно причину блокировки каждого плана
- Без breaking changes
