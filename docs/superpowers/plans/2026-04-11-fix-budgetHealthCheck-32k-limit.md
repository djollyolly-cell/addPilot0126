# План: Fix checkBudgetGrowthWithoutSpent — Too many documents (32000 limit)

**Дата:** 2026-04-11
**Статус:** Ожидает подтверждения

## Корневая причина

Функция `checkBudgetGrowthWithoutSpent` в `convex/budgetHealthCheck.ts:164-234` превышает лимит Convex в 32000 прочитанных документов за одно выполнение.

**2 уровня проблемы:**

1. **Строка 170:** `ctx.db.query("rules").collect()` — full table scan всех правил (~200-500 документов, ~2% лимита)
2. **Строки 179-189:** Запрос actionLogs с индексом `by_ruleId` читает ВСЕ логи правила за всё время, а фильтры `createdAt`, `actionType`, `status` применяются post-index. При 20 UZ-правил × 1500+ логов = 30000+ документов → превышение лимита.

## Решение

### Основной фикс: Compound index `by_ruleId_createdAt`

Добавить индекс на таблицу `actionLogs`:
```typescript
.index("by_ruleId_createdAt", ["ruleId", "createdAt"])
```

Это позволит `createdAt` быть частью индекса (range query на последнем поле), а не post-filter.

**Было:** ~1500 документов/правило → **Стало:** ~10-50 документов/правило (только сегодняшние).

### Файлы для изменения

#### Обязательные (основной фикс):

| Файл | Изменение | Тип |
|---|---|---|
| `convex/schema.ts` | Добавить индекс `by_ruleId_createdAt` на `actionLogs` | Schema |
| `convex/budgetHealthCheck.ts:179-189` | `checkBudgetGrowthWithoutSpent`: `by_ruleId` → `by_ruleId_createdAt` с `.gte("createdAt", dayStartUtc)` в индексе | Query |
| `convex/budgetHealthCheck.ts:317-327` | `getRecentBudgetLogs`: `by_ruleId` → `by_ruleId_createdAt` с `.gte("createdAt", twoHoursAgo)` в индексе | Query |

#### Опциональные (рекомендуется, можно отдельным PR):

| Файл | Функция | Строка | Выгода |
|---|---|---|---|
| `convex/ruleEngine.ts` | `isAlreadyTriggeredToday` | 322 | Высокая — все логи правила за всё время |
| `convex/ruleEngine.ts` | `hasRecentBudgetIncrease` | 1589 | Высокая |
| `convex/ruleEngine.ts` | `isFirstBudgetIncreaseToday` | 1662 | Высокая |
| `convex/healthCheck.ts` | `checkRuleCoverage` | 937 | Высокая — `.collect()` без лимита |
| `convex/healthCheck.ts` | `checkLogDynamics` | 984 | Высокая — `.collect()` без лимита |
| `convex/uzBudgetCron.ts` | `hasResetToday` | 204 | Высокая |

## Анализ рисков

### 1. Порядок сортировки
При переключении `by_ruleId` → `by_ruleId_createdAt` порядок по умолчанию меняется с `_creationTime` на `createdAt`. На практике `createdAt = Date.now()` совпадает с `_creationTime`. В `checkBudgetGrowthWithoutSpent` результаты сортируются вручную (строка 200), порядок из индекса не важен.
**Вердикт:** Безопасно.

### 2. Существующий индекс `by_ruleId`
НЕ удаляем. Добавляем `by_ruleId_createdAt` как дополнительный индекс. Оба сосуществуют. 13+ запросов используют `by_ruleId` — миграция постепенная.
**Вердикт:** Безопасно (additive change).

### 3. Размер индекса / производительность записи
`actionLogs` имеет 4 индекса, добавится 5-й. При ~100-200 вставках/день нагрузка ничтожная.
**Вердикт:** Безопасно.

### 4. `rules` full table scan
Остаётся на строке 170. ~200-500 документов = ~2% лимита. Основная экономия — в actionLogs.
**Вердикт:** Допустимо, не блокирует.

## Ожидаемый результат

- Документов за запрос: ~600 вместо 30000+ (снижение в 50x)
- Диагностика `Бюджет без расхода` перестаёт падать
- Без breaking changes — все существующие запросы продолжают работать
