# Ralph Wiggum Loop — Условия остановки, запуска и перехода

**Версия:** 1.0
**Дата:** 25 января 2026 г.
**Для:** AdPilot Project

---

## 1. Условия запуска Ralph Wiggum Loop

### 1.1 Предусловия для старта нового спринта

Перед запуском Ralph Loop для спринта N необходимо проверить:

| # | Условие | Команда проверки | Ожидаемый результат |
|---|---------|------------------|---------------------|
| 1 | Предыдущий спринт завершён | `./scripts/check-sprint-completion.sh $((N-1))` | EXIT 0 |
| 2 | Все зависимости установлены | `npm ci` | EXIT 0 |
| 3 | Convex схема валидна | `npx convex dev --once` | No errors |
| 4 | TypeScript компилируется | `npx tsc --noEmit` | No errors |
| 5 | Git clean | `git status --porcelain` | Empty output |

### 1.2 Команда запуска

```bash
/ralph-wiggum:ralph-loop "Спринт N: <название>" --max-iterations 15 --completion-promise "<критерий завершения спринта>"
```

### 1.3 Примеры completion-promise по спринтам

| Sprint | Completion Promise |
|--------|-------------------|
| 1 | "VK OAuth работает, пользователь создаётся в БД, профиль отображается" |
| 2 | "VK кабинеты получаются, подключаются и синхронизируются" |
| 3 | "Лимиты тарифов проверяются, UpgradeModal показывается" |
| 4 | "4 типа правил создаются с валидацией" |
| 5 | "Targets привязываются, actions настраиваются" |
| 6 | "Лимиты правил работают, stopAd блокируется для Freemium" |
| 7 | "Cron синхронизирует метрики каждые 5 минут" |
| 8 | "Rule Engine проверяет правила и останавливает объявления" |
| 9 | "Telegram бот подключается через /start" |
| 10 | "Уведомления отправляются в Telegram при срабатывании" |
| 11 | "Inline-кнопки работают, откат объявлений возможен" |
| 12 | "Дайджест отправляется в 09:00, тихие часы работают" |
| 13 | "Виджет экономии анимируется, график за 7 дней показывается" |
| 14 | "Блок активности и карточки кабинетов отображаются" |
| 15 | "Лента событий с фильтрами работает" |
| 16 | "Полный UI правил с 2 колонками работает" |
| 17 | "Графики recharts рендерятся корректно" |
| 18 | "Top-10, ROI, экспорт PNG/CSV работают" |
| 19 | "Экран логов с поиском и фильтрами работает" |
| 20 | "Настройки профиля и подписки отображаются" |
| 21 | "Telegram таб и API таб работают" |
| 22 | "Responsive для 320px-1024px работает" |
| 23 | "PWA установка, push, offline работают" |
| 24 | "Оплата Start/Pro проходит успешно" |
| 25 | "Уведомления об истечении, обновление лимитов работают" |
| 26 | "Полный E2E journey проходит" |
| 27 | "Docker build успешен, CI/CD green" |
| 28 | "Smoke-тесты проходят, мониторинг настроен" |

---

## 2. Условия остановки Ralph Wiggum Loop

### 2.1 Успешное завершение (Promise выполнено)

Loop завершается когда ВСЕ критерии TRUE:

```javascript
const isComplete = (sprint) => {
  return (
    unitTests.allPass === true &&
    integrationTests.allPass === true &&
    screenshotsCount >= sprint.expectedScreenshots &&
    domChecks.allPass === true &&
    consoleErrors === 0 &&
    edgeCases.allTested === true &&
    artifacts.allExist === true &&
    buildSuccess === true
  );
};
```

### 2.2 Критерии в виде чеклиста

```markdown
## Чеклист завершения спринта N

- [ ] `npm run test:unit` — 0 failures
- [ ] `npm run test:integration` — 0 failures
- [ ] `ls screenshots/sN-*.png | wc -l` >= ожидаемое количество
- [ ] Все `querySelector('[data-testid="..."]')` находят элементы
- [ ] DevTools Console — 0 errors
- [ ] Все edge-cases из DoD проверены
- [ ] Все артефакты из списка существуют
- [ ] `npm run build` — success
```

### 2.3 Принудительная остановка

```bash
/ralph-wiggum:cancel-ralph
```

Используется когда:
- Обнаружена критическая ошибка архитектуры
- Требуется изменение PRD
- Достигнут max-iterations без выполнения promise

### 2.4 Максимальное количество итераций

При достижении `--max-iterations`:
1. Loop останавливается
2. Сохраняется состояние в `.claude/ralph-loop.local.md`
3. Выводится причина незавершения
4. Требуется ручное вмешательство

---

## 3. Условия перехода к следующему спринту

### 3.1 Автоматическая проверка

```bash
#!/bin/bash
# scripts/check-sprint-completion.sh

SPRINT=$1
EXPECTED_SCREENSHOTS=$(get_expected_screenshots $SPRINT)

# 1. Unit тесты
npm run test:unit > /tmp/unit.log 2>&1
if [ $? -ne 0 ]; then
    echo "FAIL: Unit tests failed"
    exit 1
fi

# 2. Integration тесты
npm run test:integration > /tmp/integration.log 2>&1
if [ $? -ne 0 ]; then
    echo "FAIL: Integration tests failed"
    exit 1
fi

# 3. Скриншоты
ACTUAL=$(ls screenshots/s${SPRINT}-*.png 2>/dev/null | wc -l)
if [ $ACTUAL -lt $EXPECTED_SCREENSHOTS ]; then
    echo "FAIL: Screenshots missing. Expected: $EXPECTED_SCREENSHOTS, Actual: $ACTUAL"
    exit 1
fi

# 4. DOM проверки (через Playwright)
npx playwright test tests/dom-checks/sprint-${SPRINT}.spec.ts > /tmp/dom.log 2>&1
if [ $? -ne 0 ]; then
    echo "FAIL: DOM checks failed"
    exit 1
fi

# 5. Console errors
npx playwright test tests/console-check.spec.ts > /tmp/console.log 2>&1
if [ $? -ne 0 ]; then
    echo "FAIL: Console has errors"
    exit 1
fi

# 6. Артефакты
for artifact in $(get_expected_artifacts $SPRINT); do
    if [ ! -f "$artifact" ]; then
        echo "FAIL: Missing artifact: $artifact"
        exit 1
    fi
done

# 7. Build
npm run build > /tmp/build.log 2>&1
if [ $? -ne 0 ]; then
    echo "FAIL: Build failed"
    exit 1
fi

echo "SUCCESS: Sprint $SPRINT completed. Ready for Sprint $((SPRINT + 1))"
exit 0
```

### 3.2 Матрица переходов

| Из спринта | В спринт | Дополнительные условия |
|------------|----------|------------------------|
| 1 | 2 | OAuth работает, пользователи создаются |
| 2 | 3 | VK API интеграция работает |
| 3 | 4 | Лимиты тарифов проверяются |
| 4 | 5 | CRUD правил работает |
| 5 | 6 | Targets и actions настраиваются |
| 6 | 7 | Лимиты правил работают |
| 7 | 8 | Cron синхронизация работает |
| 8 | 9 | Rule Engine работает |
| 9 | 10 | Telegram бот подключается |
| 10 | 11 | Уведомления отправляются |
| 11 | 12 | Inline-кнопки работают |
| 12 | 13 | Дайджест и тихие часы работают |
| 13 | 14 | Виджет экономии работает |
| 14 | 15 | Карточки кабинетов работают |
| 15 | 16 | Лента событий работает |
| 16 | 17 | UI правил полностью работает |
| 17 | 18 | Графики рендерятся |
| 18 | 19 | Экспорт работает |
| 19 | 20 | Логи работают |
| 20 | 21 | Профиль и подписка работают |
| 21 | 22 | Telegram и API настройки работают |
| 22 | 23 | Responsive работает |
| 23 | 24 | PWA работает |
| 24 | 25 | Оплата работает |
| 25 | 26 | Биллинг полностью работает |
| 26 | 27 | E2E тесты проходят |
| 27 | 28 | Docker и CI/CD работают |
| 28 | DONE | Smoke и мониторинг настроены |

### 3.3 Блокирующие условия

Переход к следующему спринту БЛОКИРУЕТСЯ если:

| # | Условие | Причина блокировки |
|---|---------|-------------------|
| 1 | Unit tests failures > 0 | Код не работает |
| 2 | Integration tests failures > 0 | Интеграции сломаны |
| 3 | Screenshots missing | Нет доказательств |
| 4 | DOM checks failed | UI не соответствует ожиданиям |
| 5 | Console errors > 0 | Есть JS ошибки |
| 6 | Artifacts missing | Не все файлы созданы |
| 7 | Build failed | Production сборка сломана |
| 8 | Edge cases not tested | Не проверены граничные случаи |

---

## 4. Логика Ralph Loop для спринта

### 4.1 Псевдокод одной итерации

```javascript
async function ralphLoopIteration(sprint, iteration) {
  console.log(`=== Iteration ${iteration} for Sprint ${sprint} ===`);

  // 1. Проверить текущее состояние
  const state = await checkSprintState(sprint);

  // 2. Определить что не сделано
  const pending = state.filter(item => !item.completed);

  if (pending.length === 0) {
    // Все сделано, проверяем критерии
    const canProceed = await verifyAllCriteria(sprint);
    if (canProceed) {
      return { status: 'COMPLETE', message: 'Sprint completed' };
    }
  }

  // 3. Взять следующую задачу
  const task = pending[0];

  // 4. Выполнить задачу
  try {
    await executeTask(task);
    task.completed = true;
  } catch (error) {
    task.error = error;
    task.retries++;
  }

  // 5. Сохранить состояние
  await saveState(sprint, state);

  // 6. Вернуть статус
  return {
    status: 'IN_PROGRESS',
    completed: state.filter(i => i.completed).length,
    total: state.length
  };
}
```

### 4.2 Структура состояния спринта

```yaml
# .claude/sprint-state.yaml
sprint: 1
iteration: 3
tasks:
  - id: setup-convex
    status: completed
    artifacts:
      - convex/schema.ts

  - id: vk-oauth
    status: in_progress
    attempts: 1
    lastError: null

  - id: users-crud
    status: pending

tests:
  unit:
    total: 10
    passed: 7
    failed: 3
  integration:
    total: 5
    passed: 5
    failed: 0

screenshots:
  expected: 13
  actual: 8
  missing:
    - s1-invalid-token.png
    - s1-relogin.png
    - s1-oauth-cancel.png
```

---

## 5. Обработка ошибок

### 5.1 Retry-стратегия

```javascript
const retryConfig = {
  maxRetries: 3,
  backoffMs: [1000, 2000, 4000],
  retryableErrors: [
    'ECONNRESET',
    'ETIMEDOUT',
    'VK_API_RATE_LIMIT',
    'CONVEX_TIMEOUT'
  ]
};

async function executeWithRetry(task) {
  for (let i = 0; i < retryConfig.maxRetries; i++) {
    try {
      return await executeTask(task);
    } catch (error) {
      if (!retryConfig.retryableErrors.includes(error.code)) {
        throw error; // Не повторяем
      }
      await sleep(retryConfig.backoffMs[i]);
    }
  }
  throw new Error(`Task failed after ${retryConfig.maxRetries} retries`);
}
```

### 5.2 Fallback-действия

| Ошибка | Fallback |
|--------|----------|
| VK API 500 | Mock данные для продолжения |
| Convex deploy fail | Откат к предыдущей версии |
| Screenshot timeout | Увеличить timeout до 30s |
| DOM element not found | Проверить data-testid |
| Build fail | Исправить TS ошибки |

---

## 6. Интеграция с основным планом

### 6.1 Связь с AdPilot_RalphWiggum_Plan_FULL.md

```
AdPilot_RalphWiggum_Plan_FULL.md (план)
         │
         ▼
RalphWiggum_Conditions.md (условия)
         │
         ▼
RalphWiggum_Commands.md (команды)
         │
         ▼
.claude/ralph-loop.local.md (состояние)
         │
         ▼
.claude/sprint-state.yaml (детали спринта)
```

### 6.2 Обновление состояния

После каждой итерации обновляется:

1. `.claude/ralph-loop.local.md` — iteration counter
2. `.claude/sprint-state.yaml` — детали прогресса
3. Артефакты — скриншоты, логи, тесты

---

## 7. Выход из цикла

### 7.1 Успешное завершение

Когда `completion_promise` выполнено:

```
<promise>все тесты и условия написаны и работают</promise>
```

### 7.2 Неуспешное завершение

При достижении max-iterations:

```markdown
## Ralph Loop завершён без выполнения promise

**Итерации:** 15/15
**Причина:** Не все критерии выполнены

### Невыполненные критерии:
- [ ] Screenshot s1-oauth-cancel.png отсутствует
- [ ] Unit test users.updateTier failing

### Рекомендации:
1. Исправить falling test
2. Сделать недостающий скриншот
3. Перезапустить loop
```

---

*Документ: RalphWiggum_Conditions.md*
*Версия: 1.0*
*Дата: 25 января 2026 г.*
