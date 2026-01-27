# Ralph Wiggum Loop — Команды для запуска

**Версия:** 1.0
**Дата:** 25 января 2026 г.
**Для:** AdPilot Project

---

## 1. Инициализация проекта

### 1.1 Создание Convex проекта
```bash
npm create convex@latest adpilot-app
cd adpilot-app
npm install
```

### 1.2 Установка зависимостей
```bash
# UI библиотеки
npm install react react-dom react-router-dom
npm install @tanstack/react-query
npm install recharts

# Shadcn UI
npx shadcn-ui@latest init
npx shadcn-ui@latest add button card input form avatar dialog dropdown-menu toast tabs switch radio-group checkbox select

# Тестирование
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
npm install -D playwright @playwright/test
npm install -D @vitest/coverage-v8
```

### 1.3 Инициализация тестов
```bash
# Vitest config
npx vitest init

# Playwright setup
npx playwright install
npx playwright install-deps
```

---

## 2. Команды запуска разработки

### 2.1 Convex Dev Server
```bash
npx convex dev
```

### 2.2 Frontend Dev Server
```bash
npm run dev
```

### 2.3 Параллельный запуск
```bash
npm run dev & npx convex dev
```

---

## 3. Команды тестирования

### 3.1 Unit тесты
```bash
# Запуск всех unit тестов
npm run test:unit

# Запуск с coverage
npm run test:unit -- --coverage

# Запуск конкретного файла
npm run test:unit -- convex/users.test.ts

# Запуск по паттерну
npm run test:unit -- --grep "users.create"

# Watch mode
npm run test:unit -- --watch
```

### 3.2 Integration тесты
```bash
# Запуск всех integration тестов
npm run test:integration

# Запуск конкретного теста
npm run test:integration -- --grep "vkApi"

# С подробным выводом
npm run test:integration -- --reporter=verbose
```

### 3.3 E2E тесты (Playwright)
```bash
# Запуск всех E2E
npx playwright test

# С UI режимом
npx playwright test --ui

# Конкретный файл
npx playwright test tests/e2e/full-journey.spec.ts

# С видео записью
npx playwright test --video=on

# Только определённый браузер
npx playwright test --project=chromium

# Debug режим
npx playwright test --debug

# Генерация отчёта
npx playwright show-report
```

### 3.4 Все тесты вместе
```bash
npm run test:all

# С coverage отчётом
npm run test:coverage
```

---

## 4. Команды проверки качества кода

### 4.1 TypeScript
```bash
# Проверка типов
npx tsc --noEmit

# С подробностями
npx tsc --noEmit --diagnostics
```

### 4.2 ESLint
```bash
# Проверка
npm run lint

# Автоисправление
npm run lint:fix
```

### 4.3 Prettier
```bash
# Проверка форматирования
npm run format:check

# Форматирование
npm run format
```

---

## 5. Команды Convex

### 5.1 Тестирование функций
```bash
# Запуск Convex тестов
npx convex test

# Конкретный тест
npx convex test -t "users.create"

# С verbose
npx convex test --verbose
```

### 5.2 Деплой
```bash
# Preview deploy
npx convex deploy --preview

# Production deploy
npx convex deploy
```

### 5.3 Логи
```bash
# Просмотр логов
npx convex logs

# В реальном времени
npx convex logs --follow

# Фильтрация
npx convex logs --filter "error"
```

---

## 6. Команды Docker

### 6.1 Build
```bash
# Сборка образа
docker build -t adpilot:latest .

# С тегом версии
docker build -t adpilot:v1.0.0 .
```

### 6.2 Run
```bash
# Запуск контейнера
docker run -p 3000:3000 -e CONVEX_URL=$CONVEX_URL adpilot:latest

# С именем
docker run --name adpilot -p 3000:3000 -e CONVEX_URL=$CONVEX_URL adpilot:latest

# Detached mode
docker run -d --name adpilot -p 3000:3000 -e CONVEX_URL=$CONVEX_URL adpilot:latest
```

### 6.3 Docker Compose
```bash
# Запуск
docker-compose up

# В фоне
docker-compose up -d

# Остановка
docker-compose down
```

---

## 7. Команды CI/CD

### 7.1 Локальная проверка CI
```bash
# Полный CI pipeline
npm run ci

# Что включает:
# 1. npm run lint
# 2. npx tsc --noEmit
# 3. npm run test:unit
# 4. npm run test:integration
# 5. npm run build
# 6. npx playwright test
```

### 7.2 GitHub Actions (локальный запуск)
```bash
# С помощью act
act -j test
act -j build
act -j deploy
```

---

## 8. Команды для спринтов

### 8.1 Проверка готовности спринта
```bash
# Проверить все критерии DoD
./scripts/check-sprint-dod.sh <sprint_number>
```

### 8.2 Генерация скриншотов
```bash
# Playwright screenshots
npx playwright test --project=chromium --update-snapshots

# Конкретный спринт
npx playwright test tests/screenshots/sprint-${N}.spec.ts
```

### 8.3 Проверка артефактов
```bash
# Проверить наличие скриншотов
ls screenshots/s${N}-*.png

# Проверить логи
ls logs/s${N}-*.json

# Проверить все артефакты спринта
./scripts/verify-artifacts.sh <sprint_number>
```

---

## 9. Команды Ralph Wiggum Loop

### 9.1 Запуск цикла
```bash
# Инициализация
/ralph-wiggum:ralph-loop <задача> --max-iterations <N> --completion-promise "<условие>"
```

### 9.2 Проверка статуса
```bash
# Текущая итерация
head -10 .claude/ralph-loop.local.md

# Полный статус
cat .claude/ralph-loop.local.md
```

### 9.3 Отмена цикла
```bash
/ralph-wiggum:cancel-ralph
```

---

## 10. Smoke-тесты после деплоя

### 10.1 Автоматизированные
```bash
npm run test:smoke
```

### 10.2 Ручная проверка
```bash
# Health check
curl https://adpilot.example.com/api/health

# Проверка статуса
curl -s https://adpilot.example.com/api/health | jq .status
```

---

## 11. Мониторинг

### 11.1 Логи ошибок
```bash
# Convex logs
npx convex logs --filter "error"

# Sentry CLI
sentry-cli issues list --project adpilot
```

### 11.2 Метрики
```bash
# Lighthouse
npx lighthouse https://adpilot.example.com --output=json --output-path=./lighthouse-report.json

# Bundle size
npm run analyze
```

---

## 12. Условия перехода к следующему спринту

### 12.1 Автоматическая проверка
```bash
./scripts/check-sprint-completion.sh <current_sprint>

# Возвращает:
# - EXIT 0: Спринт завершён, можно переходить
# - EXIT 1: Спринт не завершён, причины в stdout
```

### 12.2 Критерии (все должны быть TRUE)
```bash
# 1. Unit тесты
npm run test:unit 2>&1 | grep -q "PASS" && echo "OK" || echo "FAIL"

# 2. Integration тесты
npm run test:integration 2>&1 | grep -q "PASS" && echo "OK" || echo "FAIL"

# 3. Скриншоты
[ $(ls screenshots/s${N}-*.png 2>/dev/null | wc -l) -ge $EXPECTED ] && echo "OK" || echo "FAIL"

# 4. Console errors
npx playwright test tests/console-check.spec.ts 2>&1 | grep -q "PASS" && echo "OK" || echo "FAIL"

# 5. Build
npm run build 2>&1 && echo "OK" || echo "FAIL"
```

---

## 13. Troubleshooting

### 13.1 Convex проблемы
```bash
# Сброс локального состояния
npx convex dev --clear

# Переинициализация
npx convex dev --init
```

### 13.2 Тесты не проходят
```bash
# Verbose output
npm run test:unit -- --reporter=verbose

# Debug mode
DEBUG=* npm run test:unit
```

### 13.3 Playwright проблемы
```bash
# Переустановка браузеров
npx playwright install --force

# Trace on
npx playwright test --trace on
```

---

*Документ: RalphWiggum_Commands.md*
*Версия: 1.0*
*Дата: 25 января 2026 г.*
