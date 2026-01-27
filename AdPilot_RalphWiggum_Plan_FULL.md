# AdPilot — Ralph Wiggum Loop Implementation Plan (FULL)

**Версия:** 2.1 FULL
**Источник:** AdPilot_PRD_v1.0.md
**Дата:** 24 января 2026 г.
**Итерация Ralph Loop:** 1

---

## 1. Реконструкция PRD

### 1.1 Продукт

**AdPilot** — автоматизированный ассистент для таргетологов VK Ads, предотвращающий неэффективный расход рекламного бюджета через мониторинг в реальном времени и автоматические действия.

**USP:** «AdPilot сохраняет ваш бюджет, пока вы спите»

### 1.2 Целевая аудитория

| Сегмент | Приоритет | Характеристики | Боли |
|---------|-----------|----------------|------|
| Фрилансеры-таргетологи | Первичная | 3-15 клиентов, высокий репутационный риск | Невозможность контролировать кампании ночью, страх «проснуться и увидеть слитый бюджет», сложность доказать клиенту эффективность |
| Инхаус-маркетологи | Вторичная | Работают в штате, отчитываются руководству, бюджеты выше | Ответственность за бюджет перед руководством, страх ночных «сливов» |
| Небольшие агентства (2-5 человек) | Третичная | Масштабирование, множество клиентских кабинетов | Операционная эффективность, работа с множеством кабинетов |

### 1.3 Ключевые проблемы (из PRD дословно)

1. Таргетологи физически не могут контролировать рекламные кампании 24/7
2. «Слив» бюджета ночью и в выходные
3. Потеря денег на неэффективных объявлениях
4. Репутационные риски перед клиентами
5. Стресс и профессиональное выгорание

### 1.4 Ограничения и Rate-Limits

#### VK Ads API (из документации VK)

| Метод | Назначение | Rate Limit | Обработка |
|-------|------------|------------|-----------|
| ads.getAccounts | Список кабинетов | 5 req/sec | Кэш 1 час |
| ads.getCampaigns | Список кампаний | 5 req/sec | Кэш 30 мин |
| ads.getAds | Список объявлений | 5 req/sec | Кэш 30 мин |
| ads.getStatistics | Метрики | 5 req/sec | Основной, каждые 5 мин |
| ads.updateAds | Остановка/запуск | 5 req/sec | По событию, retry |

**Обработка rate-limits:**
- error_code: 6 (Too many requests) → exponential backoff: 1s, 2s, 4s, 8s, max 5 retries
- Batch-запросы: до 2000 ids за запрос
- Очередь с приоритетами: critical (остановка) > normal (метрики)

#### Telegram Bot API

| Метод | Rate Limit | Обработка |
|-------|------------|-----------|
| sendMessage | 30 msg/sec глобально, 1 msg/sec в один чат | Группировка по chatId |
| setWebhook | Без ограничений | Один раз |
| answerCallbackQuery | 1 req на callback | Мгновенный ответ |

**Обработка:**
- HTTP 429 → retry через Retry-After header
- Группировка: собирать сообщения 5 сек, отправлять одним

#### Convex Platform Limits

| Ресурс | Лимит | Митигация |
|--------|-------|-----------|
| Function execution time | 300 sec | Batch по 100 аккаунтов |
| Document size | 1 MB | Нормализация, отдельные таблицы |
| Cron minimum interval | 1 минута | Используем 5 минут |
| Concurrent actions | 1000 | Достаточно для 10K юзеров |
| Database reads/sec | 20,000 | Индексы, кэширование |

#### Биллинг — Тарифы (из PRD)

| Тариф | Цена | Кабинеты | Правила | Автоостановка | Особенности |
|-------|------|----------|---------|---------------|-------------|
| Freemium | 0 ₽ | 1 | 2 | ❌ Нет | Только уведомления |
| Start | 990 ₽/мес | 3 | 10 | ✅ Да | Полный функционал |
| Pro | 2990 ₽/мес | ∞ | ∞ | ✅ Да | Приоритетная поддержка |

### 1.5 Нефункциональные требования (из PRD)

| Категория | Метрика | Требование | Измерение |
|-----------|---------|------------|-----------|
| Производительность | Загрузка дашборда | < 2 секунд | Lighthouse Performance |
| Производительность | Время реакции правила | < 60 секунд | timestamp в логах |
| Производительность | Real-time обновления | < 100 мс | Convex metrics |
| Производительность | Пропускная способность | 1000 кабинетов/5мин | Load test |
| Надёжность | Uptime | 99.9% | UptimeRobot |
| Надёжность | ACID транзакции | Гарантированы | Convex native |
| Надёжность | Graceful degradation | При недоступности VK API | Retry + уведомление |
| Безопасность | HTTPS | Обязательно | SSL Labs A+ |
| Безопасность | Токены | Зашифрованы в env | Audit |
| Безопасность | Row-level security | В каждой функции | Code review |

---

## 2. Стек и Архитектура (СТРОГО из PRD)

### 2.1 Технологический стек

| Компонент | Технология | Обоснование (из PRD) |
|-----------|------------|---------------------|
| Frontend | React 18+ (Vite) | Быстрая разработка, современный tooling |
| UI Kit | Shadcn UI + Tailwind CSS | Быстрая разработка профессионального UI |
| Routing | React Router / TanStack Router | SPA-навигация |
| Rich Text | Tiptap (OSS) | Кастомные отчёты |
| Backend | Convex | Serverless backend, real-time из коробки |
| Database | Convex Database | Реактивная БД, автоматическое кэширование |
| Scheduled Jobs | Convex Cron / Scheduled Functions | Синхронизация метрик каждые 5 мин |
| Background Tasks | Convex Actions | HTTP-вызовы к VK API, Telegram |
| AI | Convex + OpenAI | Парсинг текста в правила |
| Telegram | Convex HTTP Actions | Webhook-обработка, отправка сообщений |
| File Storage | Convex File Storage | Скриншоты объявлений, отчёты |
| Hosting | Vercel / Netlify | Статический хостинг React-приложения |

### 2.2 Архитектурная схема (из PRD)

```
┌─────────────────────────────────────────────────────────────────┐
│                    REACT APPLICATION                            │
│                   (Vite + React 18+)                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  Dashboard  │  │   Rules     │  │  Analytics  │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                 │
│  useQuery() ──── Real-time subscriptions ──── useMutation()    │
└────────────────────────────┬────────────────────────────────────┘
                             │ WebSocket (автоматически)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CONVEX                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Convex Functions                      │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │   │
│  │  │ Queries  │  │Mutations │  │ Actions  │  │  Crons   │ │   │
│  │  │(read DB) │  │(write DB)│  │(HTTP/AI) │  │(scheduled│ │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Convex Database (Document DB)               │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │   │
│  │  │ users  │ │accounts│ │ rules  │ │ logs   │ │metrics │ │   │
│  │  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
  │  VK Ads API │    │  Telegram   │    │   OpenAI    │
  │  (Actions)  │    │  Bot API    │    │   (AI)      │
  └─────────────┘    └─────────────┘    └─────────────┘
```

### 2.3 Структура Convex-функций (из PRD)

```
convex/
├── schema.ts              # Схема базы данных
├── auth.ts                # Аутентификация (VK OAuth)
├── users.ts               # Управление пользователями
├── adAccounts.ts          # Рекламные кабинеты
├── rules.ts               # CRUD правил
├── ruleEngine.ts          # Логика проверки правил
├── metrics.ts             # Метрики и аналитика
├── actionLogs.ts          # Логи действий
├── notifications.ts       # Отправка уведомлений
├── vkApi.ts               # HTTP Actions для VK Ads API
├── telegram.ts            # HTTP Actions для Telegram Bot
├── billing.ts             # Биллинг и подписки
└── crons.ts               # Scheduled jobs
```

### 2.4 Схема базы данных (из PRD)

```typescript
// convex/schema.ts — ТОЧНО как в PRD
export default defineSchema({
  users: defineTable({
    email: v.string(),
    vkId: v.string(),
    telegramChatId: v.optional(v.string()),
    subscriptionTier: v.union(
      v.literal("freemium"),
      v.literal("start"),
      v.literal("pro")
    ),
    onboardingCompleted: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_vkId", ["vkId"])
    .index("by_email", ["email"]),

  adAccounts: defineTable({
    userId: v.id("users"),
    vkAccountId: v.string(),
    name: v.string(),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("error")
    ),
    lastSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_vkAccountId", ["vkAccountId"]),

  rules: defineTable({
    userId: v.id("users"),
    name: v.string(),
    type: v.union(
      v.literal("cpl_limit"),
      v.literal("min_ctr"),
      v.literal("fast_spend"),
      v.literal("spend_no_leads")
    ),
    conditions: v.object({
      metric: v.string(),
      operator: v.string(),
      value: v.number(),
      minSamples: v.optional(v.number()),
    }),
    actions: v.object({
      stopAd: v.boolean(),
      notify: v.boolean(),
      notifyChannel: v.optional(v.string()),
    }),
    targetAccountIds: v.array(v.id("adAccounts")),
    targetCampaignIds: v.optional(v.array(v.string())),
    targetAdIds: v.optional(v.array(v.string())),
    isActive: v.boolean(),
    triggerCount: v.number(),
    lastTriggeredAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_active", ["userId", "isActive"]),

  actionLogs: defineTable({
    userId: v.id("users"),
    ruleId: v.id("rules"),
    accountId: v.id("adAccounts"),
    adId: v.string(),
    adName: v.string(),
    actionType: v.union(
      v.literal("stopped"),
      v.literal("notified"),
      v.literal("stopped_and_notified")
    ),
    reason: v.string(),
    metricsSnapshot: v.object({
      cpl: v.optional(v.number()),
      ctr: v.optional(v.number()),
      spent: v.number(),
      leads: v.number(),
    }),
    savedAmount: v.number(),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("reverted")
    ),
    revertedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_date", ["userId", "createdAt"])
    .index("by_ruleId", ["ruleId"]),

  metricsDaily: defineTable({
    accountId: v.id("adAccounts"),
    adId: v.string(),
    date: v.string(),
    impressions: v.number(),
    clicks: v.number(),
    spent: v.number(),
    leads: v.number(),
    cpl: v.optional(v.number()),
    ctr: v.optional(v.number()),
  })
    .index("by_accountId_date", ["accountId", "date"])
    .index("by_adId_date", ["adId", "date"]),

  metricsRealtime: defineTable({
    accountId: v.id("adAccounts"),
    adId: v.string(),
    timestamp: v.number(),
    spent: v.number(),
    leads: v.number(),
    impressions: v.number(),
    clicks: v.number(),
  })
    .index("by_adId", ["adId"])
    .index("by_accountId_timestamp", ["accountId", "timestamp"]),
});
```

### 2.5 Cron Jobs (из PRD)

```typescript
// convex/crons.ts — ТОЧНО как в PRD
const crons = cronJobs();

// Синхронизация метрик каждые 5 минут
crons.interval(
  "sync-metrics",
  { minutes: 5 },
  internal.metrics.syncAllActiveAccounts
);

// Синхронизация структуры кампаний каждые 30 минут
crons.interval(
  "sync-campaigns",
  { minutes: 30 },
  internal.adAccounts.syncCampaignStructure
);

// Ежедневный дайджест в 09:00 MSK
crons.daily(
  "daily-digest",
  { hourUTC: 6, minuteUTC: 0 },
  internal.notifications.sendDailyDigests
);

// Очистка старых realtime-метрик
crons.daily(
  "cleanup-realtime-metrics",
  { hourUTC: 3, minuteUTC: 0 },
  internal.metrics.cleanupOldRealtime
);

export default crons;
```

### 2.6 Критерии Production-Ready

| Критерий | Метрика | Проверка |
|----------|---------|----------|
| Unit test coverage | > 80% | `npm run test:coverage` |
| Integration tests | Все API пути | `npm run test:integration` |
| E2E tests | Full journey | `npx playwright test` |
| Lighthouse Performance | > 90 | Chrome DevTools |
| Lighthouse PWA | > 90 | Chrome DevTools |
| Error tracking | Настроен | Sentry dashboard |
| Uptime monitoring | Настроен | UptimeRobot |
| CI/CD | Работает | GitHub Actions green |
| Docker build | Успешен | `docker build .` |

---

## 3. Epics и User Stories (ВСЕ из PRD)

### EPIC-1: Аутентификация и управление пользователями

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-1.US-1 | Как пользователь, я хочу авторизоваться через VK OAuth | OAuth flow работает, токены сохраняются | Невалидный токен; Отмена OAuth; Повторный вход |
| EPIC-1.US-2 | Как пользователь, я хочу видеть свой профиль с данными подписки | email, тариф, дата окончания | Нет подписки; Истекла подписка |
| EPIC-1.US-3 | Как пользователь, я хочу выйти из системы | Сессия завершается, токены удаляются | Повторный выход |
| EPIC-1.US-4 | Как пользователь, я хочу войти в кабинет через email и пароль VK Ads | Форма входа по email работает, сессия создаётся, переход в дашборд | Неверный email; Неверный пароль; Пустые поля; Rate limiting; Переключение на OAuth |

### EPIC-2: Подключение рекламных кабинетов

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-2.US-1 | Как пользователь, я хочу получить список доступных VK кабинетов | ads.getAccounts возвращает список | VK API ошибка; Пустой список |
| EPIC-2.US-2 | Как пользователь, я хочу выбрать кабинет для мониторинга | Кабинет сохраняется в adAccounts | Уже подключен |
| EPIC-2.US-3 | Как пользователь, я хочу видеть статус синхронизации | lastSyncAt, status, lastError | Ошибка синхронизации |
| EPIC-2.US-4 | Как пользователь, я хочу принудительно синхронизировать | Немедленная синхронизация | Уже идёт синхронизация |
| EPIC-2.US-5 | Как пользователь Freemium, я могу подключить 1 кабинет | Лимит 1 | Попытка добавить 2-й |
| EPIC-2.US-6 | Как пользователь Start, я могу подключить до 3 кабинетов | Лимит 3 | Попытка добавить 4-й |
| EPIC-2.US-7 | Как пользователь Pro, я могу подключить неограниченно | Без лимита | - |

### EPIC-3: Система правил

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-3.US-1 | Как пользователь, я хочу создать правило «Лимит CPL» | type=cpl_limit, порог в ₽ | CPL=0; CPL отрицательный |
| EPIC-3.US-2 | Как пользователь, я хочу создать правило «Минимальный CTR» | type=min_ctr, порог в % | CTR>100%; CTR<0 |
| EPIC-3.US-3 | Как пользователь, я хочу создать правило «Быстрый скрут» | type=fast_spend, % за 15 мин | %>100 |
| EPIC-3.US-4 | Как пользователь, я хочу создать правило «Сумма без лидов» | type=spend_no_leads, макс ₽ | Сумма<0 |
| EPIC-3.US-5 | Как пользователь, я хочу включить/выключить правило | isActive переключается | Уже в нужном состоянии |
| EPIC-3.US-6 | Как пользователь, я хочу привязать правило к объектам | targets заполняются | Пустой выбор |
| EPIC-3.US-7 | Как пользователь, я хочу действие: только уведомить | notify=true, stopAd=false | - |
| EPIC-3.US-8 | Как пользователь, я хочу действие: остановить | stopAd=true | Freemium → недоступно |
| EPIC-3.US-9 | Как пользователь, я хочу действие: остановить и уведомить | оба true | Freemium → только notify |
| EPIC-3.US-10 | Как пользователь Freemium, я могу создать 2 правила | Лимит 2 | 3-е правило |
| EPIC-3.US-11 | Как пользователь Freemium, автоостановка недоступна | stopAd=false всегда | Попытка включить |
| EPIC-3.US-12 | Как пользователь Start, я могу создать 10 правил | Лимит 10 | 11-е правило |

### EPIC-4: Движок правил

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-4.US-1 | Как система, проверять правила каждые 5 минут | Cron работает | Нет активных правил |
| EPIC-4.US-2 | Как система, останавливать объявление | ads.updateAds вызывается | VK API ошибка |
| EPIC-4.US-3 | Как система, записывать лог срабатывания | actionLogs создаётся | - |
| EPIC-4.US-4 | Как система, рассчитывать экономию | savedAmount корректен | Нет данных за час |
| EPIC-4.US-5 | Как система, реагировать < 60 секунд | timestamp подтверждает | - |

### EPIC-5: Система уведомлений (Telegram)

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-5.US-1 | Как пользователь, подключить Telegram-бота | /start сохраняет chatId | Повторный /start |
| EPIC-5.US-2 | Как пользователь, получать критические уведомления мгновенно | Мгновенная отправка | Telegram недоступен |
| EPIC-5.US-3 | Как пользователь, получать стандартные с группировкой | Группировка 5 мин | Одно событие |
| EPIC-5.US-4 | Как пользователь, получать дайджест в 09:00 | Cron отправляет | Нет событий |
| EPIC-5.US-5 | Как пользователь, настроить тихие часы | Уведомления блокируются | 00:00-00:00 |
| EPIC-5.US-6 | Как пользователь, видеть inline-кнопки | Кнопки работают | - |
| EPIC-5.US-7 | Как пользователь, отменить остановку | Объявление возобновляется | > 5 мин |

### EPIC-6: Дашборд

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-6.US-1 | Как пользователь, видеть виджет «Сэкономлено» | Real-time, анимация | Нет данных |
| EPIC-6.US-2 | Как пользователь, видеть график за 7 дней | График рендерится | Нет данных |
| EPIC-6.US-3 | Как пользователь, видеть % изменения | Расчёт корректен | Предыдущий=0 |
| EPIC-6.US-4 | Как пользователь, видеть блок активности | Числа кликабельны | Нет активности |
| EPIC-6.US-5 | Как пользователь, видеть карточки кабинетов | Все данные | Нет кабинетов |
| EPIC-6.US-6 | Как пользователь, видеть индикатор здоровья | Зелёный/жёлтый/красный | Ошибка синхронизации |
| EPIC-6.US-7 | Как пользователь, видеть ленту событий | Хронологический список | Нет событий |
| EPIC-6.US-8 | Как пользователь, фильтровать ленту | Фильтры работают | Нет результатов |

### EPIC-7: Экран настройки правил

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-7.US-1 | Как пользователь, видеть список правил | Карточки | Нет правил |
| EPIC-7.US-2 | Как пользователь, добавить правило | Редактор открывается | Лимит достигнут |
| EPIC-7.US-3 | Как пользователь, видеть конструктор условий | Dropdowns работают | - |
| EPIC-7.US-4 | Как пользователь, видеть валидацию | Ошибки показываются | Невалидное значение |
| EPIC-7.US-5 | Как пользователь, видеть блок действий | Радио-кнопки | Freemium ограничения |
| EPIC-7.US-6 | Как пользователь, настроить текст уведомления | Текст сохраняется | Пустой текст |
| EPIC-7.US-7 | Как пользователь, видеть селектор применения | Дерево работает | Нет кампаний |

### EPIC-8: Экран аналитики

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-8.US-1 | Как пользователь, выбрать период | Селектор работает | Будущая дата |
| EPIC-8.US-2 | Как пользователь, видеть график экономии | Линейный график | Нет данных |
| EPIC-8.US-3 | Как пользователь, видеть разбивку по типам | Столбчатая | Один тип |
| EPIC-8.US-4 | Как пользователь, видеть круговую диаграмму | Pie chart | Нет срабатываний |
| EPIC-8.US-5 | Как пользователь, видеть топ-10 объявлений | Таблица | Меньше 10 |
| EPIC-8.US-6 | Как пользователь, видеть ROI | Расчёт | Freemium |
| EPIC-8.US-7 | Как пользователь, экспортировать PNG | Кнопка работает | - |
| EPIC-8.US-8 | Как пользователь, экспортировать CSV | Кнопка работает | Нет данных |

### EPIC-9: Экран логов

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-9.US-1 | Как пользователь, видеть список событий | Timestamp точный | Нет событий |
| EPIC-9.US-2 | Как пользователь, видеть детали события | Все поля | - |
| EPIC-9.US-3 | Как пользователь, фильтровать | Все фильтры | Нет результатов |
| EPIC-9.US-4 | Как пользователь, искать | Полнотекстовый | Пустой запрос |
| EPIC-9.US-5 | Как пользователь, видеть детальную панель | Метрики, правило | Нет скриншота |
| EPIC-9.US-6 | Как пользователь, отменить действие | Кнопка работает | > 5 мин |

### EPIC-10: Настройки

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-10.US-1 | Как пользователь, видеть профиль | Email, дата | - |
| EPIC-10.US-2 | Как пользователь, сменить пароль | Обновляется | Неверный старый |
| EPIC-10.US-3 | Как пользователь, видеть подписку | Тариф, дата | Freemium |
| EPIC-10.US-4 | Как пользователь, видеть платежи | Список | Нет платежей |
| EPIC-10.US-5 | Как пользователь, видеть инструкцию Telegram | QR-код | Уже подключен |
| EPIC-10.US-6 | Как пользователь, настроить тихие часы | Сохраняются | - |
| EPIC-10.US-7 | Как пользователь, видеть статус VK | Активно/ошибка | Токен истёк |
| EPIC-10.US-8 | Как пользователь, видеть ошибки синхронизации | Список | Нет ошибок |

### EPIC-11: PWA

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-11.US-1 | Как пользователь, видеть вертикальный стек на мобильном | Responsive | 320px |
| EPIC-11.US-2 | Как пользователь, видеть нижнее меню | 5 пунктов | - |
| EPIC-11.US-3 | Как пользователь, получать push | PWA push | Не поддерживается |
| EPIC-11.US-4 | Как пользователь, просматривать оффлайн | SW кэширует | Нет кэша |

### EPIC-12: Биллинг

| ID | User Story | Acceptance Criteria | Edge Cases |
|----|------------|---------------------|------------|
| EPIC-12.US-1 | Как пользователь, оформить Start | Оплата проходит | Ошибка оплаты |
| EPIC-12.US-2 | Как пользователь, оформить Pro | Оплата проходит | - |
| EPIC-12.US-3 | Как пользователь, получить уведомление об окончании | За 7 и 1 день | - |
| EPIC-12.US-4 | Как пользователь, обновление лимитов при смене тарифа | Лимиты обновляются | Downgrade |

---

## 4. Карта спринтов (28 спринтов, ПОЛНЫЙ ФОРМАТ)

---

### Sprint 1 — Инфраструктура и Convex Setup

**Цель:** Настройка базовой инфраструктуры проекта

**User stories:** EPIC-1.US-1, EPIC-1.US-2, EPIC-1.US-3, EPIC-1.US-4

**Scope:**
- Инициализация Convex проекта
- Схема базы данных (все таблицы из PRD)
- VK OAuth
- Вход через Email (VK Ads)
- Базовые функции пользователей
- React + Vite + Shadcn UI
- Страницы: Login (OAuth + Email), Profile

**Задачи:**
1. `npm create convex@latest adpilot-app`
2. `convex/schema.ts` — все таблицы
3. `convex/auth.ts` — VK OAuth
4. `convex/authEmail.ts` — Вход через Email (валидация, аутентификация, rate limiting)
5. `convex/users.ts` — CRUD
6. React + Vite setup
7. Shadcn UI + Tailwind
8. Layout компонент
9. LoginPage (вкладки/переключатель: OAuth и Email)
10. EmailLoginForm компонент (поля email/password, валидация, ошибки)
11. ProfilePage
12. Unit тесты (включая email login)

**Команды:**
```bash
# Init
npm create convex@latest adpilot-app
cd adpilot-app
npm install

# Shadcn
npx shadcn-ui@latest init
npx shadcn-ui@latest add button card input form avatar

# Run
npm run dev &
npx convex dev

# Test
npx convex test
```

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | Создание пользователя | `npx convex test -t "users.create"` | Pass, userId возвращён | logs/test-output.txt |
| 2 | Unit | Получение по vkId | `npx convex test -t "users.getByVkId"` | Pass, user найден | logs/test-output.txt |
| 3 | Unit | Обновление тарифа | `npx convex test -t "users.updateTier"` | Pass, tier=start | logs/test-output.txt |
| 4 | Browser | Страница логина | Открыть http://localhost:5173 | Страница загружается < 2 сек | screenshots/s1-login.png |
| 5 | Browser | DOM кнопки | document.querySelector('[data-testid="login-button"]') | Элемент найден | screenshots/s1-login-dom.png |
| 6 | Browser | OAuth редирект | Клик по "Войти через VK" | Редирект на oauth.vk.com | screenshots/s1-oauth-redirect.png |
| 7 | Browser | Callback | Вернуться с code | Пользователь создан, профиль | screenshots/s1-profile.png |
| 8 | Browser | Профиль DOM | querySelector('[data-testid="user-profile"]') | Элемент найден | screenshots/s1-profile-dom.png |
| 9 | Network | OAuth callback | Network tab → /api/auth/callback | Status 200 | logs/s1-network.json |
| 10 | Console | Нет ошибок | DevTools Console | 0 errors | screenshots/s1-console.png |
| 11 | Edge | Невалидный токен | Подменить code=invalid | Ошибка "Невалидный токен" | screenshots/s1-invalid-token.png |
| 12 | Edge | Повторный вход | Войти второй раз тем же аккаунтом | Токен обновлён, тот же userId | screenshots/s1-relogin.png |
| 13 | Edge | Отмена OAuth | Отменить на странице VK | Возврат на /login, сообщение | screenshots/s1-oauth-cancel.png |
| 14 | Browser | Форма Email логина | Переключиться на вкладку «Вход по Email» | Форма с полями email/password отображается | screenshots/s1-email-login-form.png |
| 15 | Browser | DOM формы Email | document.querySelector('[data-testid="email-login-form"]') | Элемент найден | screenshots/s1-email-login-dom.png |
| 16 | Browser | Успешный Email логин | Ввести корректный email/пароль, клик «Войти» | Переход на дашборд, сессия создана | screenshots/s1-email-login-success.png |
| 17 | Unit | Email валидация | `npx convex test -t "authEmail.validateEmail"` | Pass, невалидный email отклонён | logs/test-output.txt |
| 18 | Unit | Email аутентификация | `npx convex test -t "authEmail.login"` | Pass, токен возвращён | logs/test-output.txt |
| 19 | Edge | Неверный пароль | Ввести корректный email + неверный пароль | Ошибка «Неверный email или пароль» | screenshots/s1-email-wrong-password.png |
| 20 | Edge | Пустые поля Email | Клик «Войти» без заполнения полей | Валидация: «Заполните все поля» | screenshots/s1-email-empty-fields.png |
| 21 | Edge | Rate limiting Email | 6 неудачных попыток подряд | Ошибка «Слишком много попыток, повторите позже» | screenshots/s1-email-rate-limit.png |
| 22 | Browser | Переключение OAuth ↔ Email | Клик по ссылке «Войти через VK» / «Войти по Email» | Переключение между формами без перезагрузки | screenshots/s1-login-switch.png |

**Артефакты:**
```
convex/schema.ts
convex/auth.ts
convex/authEmail.ts
convex/authEmail.test.ts
convex/users.ts
convex/users.test.ts
src/App.tsx
src/components/Layout.tsx
src/components/LoginButton.tsx
src/components/EmailLoginForm.tsx
src/pages/LoginPage.tsx
src/pages/ProfilePage.tsx
screenshots/s1-login.png
screenshots/s1-login-dom.png
screenshots/s1-oauth-redirect.png
screenshots/s1-email-login-form.png
screenshots/s1-email-login-dom.png
screenshots/s1-email-login-success.png
screenshots/s1-email-wrong-password.png
screenshots/s1-email-empty-fields.png
screenshots/s1-email-rate-limit.png
screenshots/s1-login-switch.png
screenshots/s1-profile.png
screenshots/s1-profile-dom.png
screenshots/s1-console.png
screenshots/s1-invalid-token.png
screenshots/s1-relogin.png
screenshots/s1-oauth-cancel.png
logs/s1-network.json
logs/test-output.txt
```

**Типичные ошибки:**

| Ошибка | Симптом | Диагностика | Fix |
|--------|---------|-------------|-----|
| redirect_uri mismatch | 401 от VK | Сравнить URI | Обновить в VK App |
| Schema validation | Deploy fails | convex dev output | Исправить типы |
| CORS | Fetch error | Network tab | Добавить origin в Convex |
| Missing env | Runtime error | Console | .env.local |
| Email rate limit | 429 / блокировка | Console + UI | Подождать 15 мин или сбросить лимит |
| Email auth fail | «Неверный email или пароль» | UI error | Проверить credentials |

---

### Sprint 2 — Подключение рекламных кабинетов VK

**Цель:** Интеграция VK Ads API

**User stories:** EPIC-2.US-1, EPIC-2.US-2, EPIC-2.US-3, EPIC-2.US-4

**Scope:**
- VK API Actions: getAccounts, getCampaigns, getAds
- adAccounts CRUD
- UI страницы кабинетов
- Синхронизация

**Задачи:**
1. `convex/vkApi.ts` — getAccounts, getCampaigns, getAds
2. Обработка rate limits
3. `convex/adAccounts.ts` — list, connect, disconnect, syncNow
4. `AccountsPage.tsx`
5. `AccountCard.tsx`
6. `SyncButton.tsx`

**Команды:**
```bash
npm run test:unit -- --grep "adAccounts"
npm run test:integration -- --grep "vkApi"
```

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | list возвращает кабинеты | `npx convex test -t "adAccounts.list"` | Pass, массив аккаунтов | logs/test-output.txt |
| 2 | Unit | connect сохраняет | `npx convex test -t "adAccounts.connect"` | Pass, accountId | logs/test-output.txt |
| 3 | Unit | disconnect удаляет | `npx convex test -t "adAccounts.disconnect"` | Pass, deleted | logs/test-output.txt |
| 4 | Integration | ads.getAccounts | Mock VK API | Список из 3 кабинетов | logs/integration.txt |
| 5 | Integration | ads.getCampaigns | Mock VK API | Список кампаний | logs/integration.txt |
| 6 | Browser | Страница кабинетов | Открыть /accounts | Список VK кабинетов | screenshots/s2-accounts-list.png |
| 7 | Browser | DOM списка | querySelector('[data-testid="account-list"]') | Найден | screenshots/s2-accounts-dom.png |
| 8 | Browser | Подключить кабинет | Клик "Подключить" | Карточка появляется | screenshots/s2-account-connected.png |
| 9 | Browser | DOM карточки | querySelector('[data-testid="account-card"]') | Найден | screenshots/s2-card-dom.png |
| 10 | Browser | Синхронизация | Клик "Синхронизировать" | Спиннер → успех | screenshots/s2-sync-loading.png |
| 11 | Browser | DOM кнопки | querySelector('[data-testid="sync-button"]') | Найден | screenshots/s2-sync-dom.png |
| 12 | Network | VK API запрос | Network tab | 200 или mock | logs/s2-network.json |
| 13 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s2-console.png |
| 14 | Edge | VK API 500 | Mock error | Сообщение "Ошибка VK API" | screenshots/s2-api-error.png |
| 15 | Edge | Пустой список | Mock empty | "Нет доступных кабинетов" | screenshots/s2-empty.png |
| 16 | Edge | Токен истёк | Mock 401 | "Переавторизуйтесь" + кнопка | screenshots/s2-token-expired.png |
| 17 | Edge | Rate limit | Mock error_code:6 | Retry через 1 сек | logs/s2-retry.json |

**Артефакты:**
```
convex/vkApi.ts
convex/vkApi.test.ts
convex/adAccounts.ts
convex/adAccounts.test.ts
src/pages/AccountsPage.tsx
src/components/AccountCard.tsx
src/components/AccountList.tsx
src/components/SyncButton.tsx
screenshots/s2-*.png (все)
logs/s2-*.json
```

---

### Sprint 3 — Лимиты тарифов для кабинетов

**Цель:** Проверка лимитов по тарифам

**User stories:** EPIC-2.US-5, EPIC-2.US-6, EPIC-2.US-7

**Scope:**
- Проверка лимита в connect
- UpgradeModal
- Downgrade handling

**Задачи:**
1. Обновить `adAccounts.connect` — проверка лимита
2. `UpgradeModal.tsx`
3. Обработка downgrade

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | Freemium + 1 кабинет | connect с tier=freemium, 0 существующих | Pass | logs/test.txt |
| 2 | Unit | Freemium + 2-й кабинет | connect с tier=freemium, 1 существующий | Error: ACCOUNT_LIMIT_REACHED | logs/test.txt |
| 3 | Unit | Start + 3 кабинета | connect с tier=start, 2 существующих | Pass | logs/test.txt |
| 4 | Unit | Start + 4-й кабинет | connect с tier=start, 3 существующих | Error: ACCOUNT_LIMIT_REACHED | logs/test.txt |
| 5 | Unit | Pro + 10 кабинетов | connect с tier=pro, 9 существующих | Pass | logs/test.txt |
| 6 | Browser | Freemium лимит | Freemium пытается добавить 2-й | Модалка появляется | screenshots/s3-freemium-limit.png |
| 7 | Browser | DOM модалки | querySelector('[data-testid="upgrade-modal"]') | Найден | screenshots/s3-modal-dom.png |
| 8 | Browser | Кнопка upgrade | В модалке | "Перейти на Start" видна | screenshots/s3-upgrade-btn.png |
| 9 | Browser | DOM кнопки | querySelector('[data-testid="upgrade-button"]') | Найден | screenshots/s3-btn-dom.png |
| 10 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s3-console.png |
| 11 | Edge | Downgrade с 3 кабинетами | Изменить tier start→freemium | Предупреждение показано | screenshots/s3-downgrade-warn.png |

---

### Sprint 4 — Создание и редактирование правил (CRUD)

**Цель:** CRUD для 4 типов правил

**User stories:** EPIC-3.US-1, EPIC-3.US-2, EPIC-3.US-3, EPIC-3.US-4, EPIC-3.US-5

**Scope:**
- convex/rules.ts
- Валидация
- UI списка и формы

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | Создать cpl_limit | create с type=cpl_limit, value=500 | Pass, ruleId | logs/test.txt |
| 2 | Unit | Создать min_ctr | create с type=min_ctr, value=1.5 | Pass, ruleId | logs/test.txt |
| 3 | Unit | Создать fast_spend | create с type=fast_spend, value=20 | Pass, ruleId | logs/test.txt |
| 4 | Unit | Создать spend_no_leads | create с type=spend_no_leads, value=1000 | Pass, ruleId | logs/test.txt |
| 5 | Unit | Валидация: value=0 | create с value=0 | Error: INVALID_VALUE | logs/test.txt |
| 6 | Unit | Валидация: value<0 | create с value=-100 | Error: INVALID_VALUE | logs/test.txt |
| 7 | Unit | Валидация: CTR>100 | create min_ctr с value=150 | Error: INVALID_VALUE | logs/test.txt |
| 8 | Unit | toggleActive | toggle isActive=true→false | Pass, isActive=false | logs/test.txt |
| 9 | Browser | Список правил | Открыть /rules | Список карточек | screenshots/s4-rules-list.png |
| 10 | Browser | DOM списка | querySelector('[data-testid="rules-list"]') | Найден | screenshots/s4-list-dom.png |
| 11 | Browser | Форма создания | Клик "+ Новое правило" | Форма открыта | screenshots/s4-rule-form.png |
| 12 | Browser | DOM формы | querySelector('[data-testid="rule-form"]') | Найден | screenshots/s4-form-dom.png |
| 13 | Browser | Конструктор условий | В форме | Dropdowns видны | screenshots/s4-condition-builder.png |
| 14 | Browser | DOM конструктора | querySelector('[data-testid="condition-builder"]') | Найден | screenshots/s4-builder-dom.png |
| 15 | Browser | Переключатель | Клик toggle | Статус меняется | screenshots/s4-toggle.png |
| 16 | Network | Сохранение | Network tab при сохранении | mutation успешен | logs/s4-network.json |
| 17 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s4-console.png |
| 18 | Edge | Пустое название | Сохранить без названия | Ошибка валидации | screenshots/s4-empty-name.png |
| 19 | Edge | Дубликат названия | Создать с существующим названием | Предупреждение | screenshots/s4-duplicate.png |

---

### Sprint 5 — Привязка правил и настройка действий

**Цель:** Target selector, action settings

**User stories:** EPIC-3.US-6, EPIC-3.US-7, EPIC-3.US-8, EPIC-3.US-9

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | targets на уровне аккаунта | create с targetAccountIds=[id1] | Pass | logs/test.txt |
| 2 | Unit | targets на уровне кампании | create с targetCampaignIds=[c1,c2] | Pass | logs/test.txt |
| 3 | Unit | targets на уровне объявления | create с targetAdIds=[a1,a2,a3] | Pass | logs/test.txt |
| 4 | Unit | пустые targets | create с targetAccountIds=[] | Error: EMPTY_TARGETS | logs/test.txt |
| 5 | Browser | Древовидный селектор | В форме правила | Дерево отображается | screenshots/s5-target-tree.png |
| 6 | Browser | DOM дерева | querySelector('[data-testid="target-tree"]') | Найден | screenshots/s5-tree-dom.png |
| 7 | Browser | Раскрытие кабинета | Клик на chevron | Кампании видны | screenshots/s5-tree-expanded.png |
| 8 | Browser | Выбор кампаний | Чекбоксы кампаний | Выбраны | screenshots/s5-campaigns-selected.png |
| 9 | Browser | Радио действий | В форме | 3 опции видны | screenshots/s5-action-radio.png |
| 10 | Browser | DOM радио | querySelector('[data-testid="action-radio"]') | Найден | screenshots/s5-radio-dom.png |
| 11 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s5-console.png |
| 12 | Edge | Выбор родителя | Клик на кабинет checkbox | Все кампании выбраны | screenshots/s5-cascade-select.png |
| 13 | Edge | Снятие родителя | Uncheck кабинет | Все дочерние сняты | screenshots/s5-cascade-uncheck.png |

---

### Sprint 6 — Лимиты тарифов для правил

**Цель:** Rule limits, auto-stop restriction

**User stories:** EPIC-3.US-10, EPIC-3.US-11, EPIC-3.US-12

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | Freemium + 2 правила | create 2 правила | Pass | logs/test.txt |
| 2 | Unit | Freemium + 3-е правило | create 3-е правило | Error: RULE_LIMIT | logs/test.txt |
| 3 | Unit | Freemium + stopAd=true | create с stopAd=true | Error: FEATURE_UNAVAILABLE | logs/test.txt |
| 4 | Unit | Start + 10 правил | create 10 правил | Pass | logs/test.txt |
| 5 | Unit | Start + 11-е правило | create 11-е | Error: RULE_LIMIT | logs/test.txt |
| 6 | Browser | Freemium: Остановить disabled | В форме | Опция серая | screenshots/s6-stop-disabled.png |
| 7 | Browser | DOM disabled | querySelector('[data-testid="stop-option"][disabled]') | Найден | screenshots/s6-disabled-dom.png |
| 8 | Browser | Tooltip на disabled | Hover на disabled | Tooltip "Недоступно на Freemium" | screenshots/s6-stop-tooltip.png |
| 9 | Browser | Freemium: 3-е правило | Попытка создать | Ошибка + upgrade | screenshots/s6-rule-limit.png |
| 10 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s6-console.png |
| 11 | Edge | Downgrade с 5 правилами | tier pro→freemium, 5 правил | Правила 3-5 isActive=false | screenshots/s6-downgrade.png |

---

### Sprint 7 — Синхронизация метрик (Cron)

**Цель:** Cron для метрик каждые 5 мин

**User stories:** EPIC-4.US-1

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | saveRealtime | mutation с метриками | Pass, saved | logs/test.txt |
| 2 | Unit | saveDaily | mutation агрегация | Pass, aggregated | logs/test.txt |
| 3 | Integration | ads.getStatistics | Mock VK | Метрики получены | logs/integration.txt |
| 4 | Integration | Cron execution | Ждать 5+ мин | Cron выполнился | logs/cron.txt |
| 5 | Browser | Convex Dashboard logs | Открыть dashboard.convex.dev | Записи cron видны | screenshots/s7-cron-logs.png |
| 6 | Browser | Данные в metricsRealtime | Dashboard → Data → metricsRealtime | Записи есть | screenshots/s7-metrics-data.png |
| 7 | Edge | VK API 500 | Mock error | Ошибка в логе, retry | screenshots/s7-api-error.png |
| 8 | Edge | Пустой ответ | Mock empty | Нет ошибки, skip | logs/s7-empty.txt |

---

### Sprint 8 — Rule Engine

**Цель:** Проверка правил, остановка, логирование

**User stories:** EPIC-4.US-2, EPIC-4.US-3, EPIC-4.US-4, EPIC-4.US-5

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | CPL > threshold | metrics.cpl=600, rule.value=500 | Срабатывает | logs/test.txt |
| 2 | Unit | CTR < threshold | metrics.ctr=0.5, rule.value=1.0 | Срабатывает | logs/test.txt |
| 3 | Unit | fast_spend | 25% за 15мин, rule.value=20 | Срабатывает | logs/test.txt |
| 4 | Unit | spend_no_leads | spent=1500, leads=0, rule.value=1000 | Срабатывает | logs/test.txt |
| 5 | Unit | calculateSavings | 100₽/мин, 18:00 | 360*100=36000₽ | logs/test.txt |
| 6 | Integration | ads.updateAds | Mock stop | Объявление stopped | logs/integration.txt |
| 7 | Integration | actionLogs создан | После срабатывания | Запись в БД | logs/integration.txt |
| 8 | Browser | actionLog в Dashboard | Dashboard → actionLogs | Запись видна | screenshots/s8-action-log.png |
| 9 | Browser | Статус объявления | VK mock | status=stopped | screenshots/s8-ad-stopped.png |
| 10 | Edge | isActive=false | Правило неактивно | Не проверяется | logs/s8-skip.txt |
| 11 | Edge | minSamples | samples=5, minSamples=10 | Не срабатывает | logs/s8-samples.txt |
| 12 | Edge | VK API error | Mock 500 при остановке | status=failed в логе | screenshots/s8-failed.png |

---

### Sprint 9 — Telegram Bot: подключение

**Цель:** Бот, webhook, /start

**User stories:** EPIC-5.US-1

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | handleWebhook /start | webhook с /start | chatId сохранён | logs/test.txt |
| 2 | Unit | sendMessage | send text | Запрос к TG API | logs/test.txt |
| 3 | Integration | Telegram webhook | POST /telegram | 200 OK | logs/integration.txt |
| 4 | Browser | Страница настроек | /settings/telegram | QR-код виден | screenshots/s9-telegram-qr.png |
| 5 | Browser | DOM QR | querySelector('[data-testid="telegram-qr"]') | Найден | screenshots/s9-qr-dom.png |
| 6 | Browser | Telegram /start | В Telegram | Сообщение "Подключено!" | screenshots/s9-tg-start.png |
| 7 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s9-console.png |
| 8 | Edge | Повторный /start | /start второй раз | chatId обновлён | logs/s9-restart.txt |

---

### Sprint 10 — Telegram: уведомления

**Цель:** Уведомления при срабатывании

**User stories:** EPIC-5.US-2, EPIC-5.US-3

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | sendRuleNotification | Формирование сообщения | Формат из PRD | logs/test.txt |
| 2 | Unit | Критическое уведомление | priority=critical | Мгновенная отправка | logs/test.txt |
| 3 | Unit | Группировка | 3 события за 5 мин | Одно сообщение | logs/test.txt |
| 4 | Integration | Telegram sendMessage | После срабатывания | Сообщение отправлено | logs/integration.txt |
| 5 | Browser | Telegram уведомление | В Telegram | Сообщение с эмодзи | screenshots/s10-notification.png |
| 6 | Edge | chatId отсутствует | Нет telegramChatId | Уведомление не отправлено | logs/s10-no-chat.txt |
| 7 | Edge | TG API 429 | Rate limit | Retry после Retry-After | logs/s10-retry.txt |

---

### Sprint 11 — Telegram: inline-кнопки и откат

**Цель:** Кнопки, callback, revert

**User stories:** EPIC-5.US-6, EPIC-5.US-7

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | inline_keyboard | Формирование reply_markup | 2 кнопки | logs/test.txt |
| 2 | Unit | callback revert | callback_data=revert:123 | actionLogs.status=reverted | logs/test.txt |
| 3 | Unit | revertAction | mutation revert | ads.updateAds(status=1) | logs/test.txt |
| 4 | Integration | callback_query | POST /telegram с callback | answerCallbackQuery | logs/integration.txt |
| 5 | Browser | Кнопки в Telegram | В сообщении | 2 кнопки видны | screenshots/s11-inline-buttons.png |
| 6 | Browser | Клик "Отменить" | Нажать кнопку | Сообщение "Отменено" | screenshots/s11-revert-success.png |
| 7 | Edge | > 5 минут | Клик через 6 мин | "Время истекло" | screenshots/s11-timeout.png |
| 8 | Edge | Повторный клик | Клик второй раз | "Уже отменено" | screenshots/s11-already.png |

---

### Sprint 12 — Telegram: дайджест и тихие часы

**Цель:** Дайджест 09:00, quiet hours

**User stories:** EPIC-5.US-4, EPIC-5.US-5

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | sendDailyDigest | Формирование дайджеста | Сводка за день | logs/test.txt |
| 2 | Unit | Тихие часы блокируют | 23:00-07:00, now=02:00 | Не отправляется | logs/test.txt |
| 3 | Integration | Cron daily-digest | Ждать 09:00 MSK (mock) | Дайджест отправлен | logs/integration.txt |
| 4 | Browser | UI тихих часов | /settings/telegram | Time pickers | screenshots/s12-quiet-hours.png |
| 5 | Browser | DOM time pickers | querySelector('[data-testid="quiet-hours-start"]') | Найден | screenshots/s12-quiet-dom.png |
| 6 | Browser | Дайджест в Telegram | В Telegram | Сводка видна | screenshots/s12-digest.png |
| 7 | Edge | Нет событий за день | 0 срабатываний | Дайджест не отправляется | logs/s12-no-events.txt |
| 8 | Edge | 00:00-00:00 | Пустые тихие часы | Отключены | logs/s12-disabled.txt |

---

### Sprint 13 — Дашборд: виджет экономии

**Цель:** Анимированная цифра, график

**User stories:** EPIC-6.US-1, EPIC-6.US-2, EPIC-6.US-3

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | getSavedToday | Query сумма за сегодня | Корректная сумма | logs/test.txt |
| 2 | Unit | getSavedHistory | Query за 7 дней | Массив 7 элементов | logs/test.txt |
| 3 | Browser | Виджет экономии | Открыть /dashboard | Анимированная цифра | screenshots/s13-savings-widget.png |
| 4 | Browser | DOM виджета | querySelector('[data-testid="savings-widget"]') | Найден | screenshots/s13-widget-dom.png |
| 5 | Browser | Мини-график | Под цифрой | График 7 дней | screenshots/s13-savings-chart.png |
| 6 | Browser | DOM графика | querySelector('[data-testid="savings-chart"]') | Найден | screenshots/s13-chart-dom.png |
| 7 | Browser | Real-time обновление | Создать actionLog | Цифра обновляется без reload | screenshots/s13-realtime.png |
| 8 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s13-console.png |
| 9 | Edge | Нет данных | Новый пользователь | "0 ₽" | screenshots/s13-zero.png |
| 10 | Edge | Предыдущий период = 0 | Прошлая неделя пустая | "+100%" или "—" | screenshots/s13-no-prev.png |

---

### Sprint 14 — Дашборд: активность и карточки

**Цель:** Activity block, account cards

**User stories:** EPIC-6.US-4, EPIC-6.US-5, EPIC-6.US-6

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | getActivityStats | Query counts | {triggers, stops, notifications} | logs/test.txt |
| 2 | Browser | Блок активности | На дашборде | 3 метрики видны | screenshots/s14-activity-block.png |
| 3 | Browser | DOM блока | querySelector('[data-testid="activity-block"]') | Найден | screenshots/s14-activity-dom.png |
| 4 | Browser | Карточки кабинетов | Горизонтальный список | Карточки видны | screenshots/s14-account-cards.png |
| 5 | Browser | DOM карточек | querySelector('[data-testid="account-cards"]') | Найден | screenshots/s14-cards-dom.png |
| 6 | Browser | Индикатор здоровья | На карточке | Цветной кружок | screenshots/s14-health-indicator.png |
| 7 | Browser | DOM индикатора | querySelector('[data-testid="health-indicator"]') | Найден | screenshots/s14-health-dom.png |
| 8 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s14-console.png |
| 9 | Edge | Нет кабинетов | 0 подключенных | "Подключите кабинет" | screenshots/s14-no-accounts.png |
| 10 | Edge | Ошибка синхронизации | status=error | Красный индикатор | screenshots/s14-health-red.png |

---

### Sprint 15 — Дашборд: лента событий

**Цель:** Event feed с фильтрами

**User stories:** EPIC-6.US-7, EPIC-6.US-8

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | getRecentEvents | Query limit=10 | Массив событий | logs/test.txt |
| 2 | Browser | Лента событий | На дашборде | Список событий | screenshots/s15-event-feed.png |
| 3 | Browser | DOM ленты | querySelector('[data-testid="event-feed"]') | Найден | screenshots/s15-feed-dom.png |
| 4 | Browser | Фильтры | Над лентой | Dropdowns видны | screenshots/s15-event-filters.png |
| 5 | Browser | DOM фильтров | querySelector('[data-testid="event-filters"]') | Найден | screenshots/s15-filters-dom.png |
| 6 | Browser | Фильтр по типу | Выбрать "Остановки" | Только остановки | screenshots/s15-filter-type.png |
| 7 | Browser | Фильтр по кабинету | Выбрать кабинет | Только его события | screenshots/s15-filter-account.png |
| 8 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s15-console.png |
| 9 | Edge | Нет событий | Пустая лента | "Пока нет событий" | screenshots/s15-empty.png |
| 10 | Edge | Фильтр без результатов | Комбинация фильтров | "Ничего не найдено" | screenshots/s15-no-results.png |

---

### Sprint 16 — Экран настройки правил (полный UI)

**Цель:** Полноценный UI правил

**User stories:** EPIC-7.US-1 — EPIC-7.US-7

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Browser | Полный экран правил | Открыть /rules | 2 колонки | screenshots/s16-rules-full.png |
| 2 | Browser | Список слева | Левая колонка | Карточки правил | screenshots/s16-rules-left.png |
| 3 | Browser | Редактор справа | Правая колонка | Форма | screenshots/s16-rules-right.png |
| 4 | Browser | Все поля формы | В редакторе | Все элементы | screenshots/s16-form-complete.png |
| 5 | Browser | Валидация realtime | Ввести -100 | Красная рамка мгновенно | screenshots/s16-validation.png |
| 6 | Browser | Сохранение | Клик "Сохранить" | Успех, карточка добавлена | screenshots/s16-save-success.png |
| 7 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s16-console.png |
| 8 | Edge | Нет правил | Новый пользователь | "Создайте первое правило" | screenshots/s16-empty.png |
| 9 | Edge | Лимит достигнут | Freemium + 2 | Кнопка disabled + tooltip | screenshots/s16-limit.png |

---

### Sprint 17 — Экран аналитики: графики

**Цель:** Графики с recharts

**User stories:** EPIC-8.US-1 — EPIC-8.US-4

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Browser | Экран аналитики | Открыть /analytics | Страница загружена | screenshots/s17-analytics.png |
| 2 | Browser | Селектор периода | Вверху страницы | 7/30/90 дней + custom | screenshots/s17-period-selector.png |
| 3 | Browser | Линейный график экономии | Блок 1 | График рендерится | screenshots/s17-line-chart.png |
| 4 | Browser | DOM линейного | querySelector('[data-testid="savings-line-chart"]') | Найден | screenshots/s17-line-dom.png |
| 5 | Browser | Столбчатая по типам | Блок 2 | 4 столбца | screenshots/s17-bar-chart.png |
| 6 | Browser | DOM столбчатой | querySelector('[data-testid="rules-bar-chart"]') | Найден | screenshots/s17-bar-dom.png |
| 7 | Browser | Круговая диаграмма | Блок 3 | Pie chart | screenshots/s17-pie-chart.png |
| 8 | Browser | DOM круговой | querySelector('[data-testid="triggers-pie-chart"]') | Найден | screenshots/s17-pie-dom.png |
| 9 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s17-console.png |
| 10 | Edge | Нет данных | Новый пользователь | "Нет данных за период" | screenshots/s17-no-data.png |
| 11 | Edge | Дата в будущем | Custom period > today | Ошибка валидации | screenshots/s17-future-date.png |

---

### Sprint 18 — Экран аналитики: таблицы и экспорт

**Цель:** Top-10, ROI, export

**User stories:** EPIC-8.US-5 — EPIC-8.US-8

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Browser | Топ-10 таблица | На странице аналитики | Таблица видна | screenshots/s18-top-ads.png |
| 2 | Browser | DOM таблицы | querySelector('[data-testid="top-ads-table"]') | Найден | screenshots/s18-table-dom.png |
| 3 | Browser | ROI виджет | Рядом с графиками | Расчёт виден | screenshots/s18-roi.png |
| 4 | Browser | DOM ROI | querySelector('[data-testid="roi-widget"]') | Найден | screenshots/s18-roi-dom.png |
| 5 | Browser | Кнопка PNG | Рядом с графиком | Кнопка видна | screenshots/s18-export-png-btn.png |
| 6 | Browser | DOM PNG | querySelector('[data-testid="export-png"]') | Найден | screenshots/s18-png-dom.png |
| 7 | Browser | Экспорт PNG | Клик | Файл скачан | artifacts/exported-chart.png |
| 8 | Browser | Кнопка CSV | Рядом с таблицей | Кнопка видна | screenshots/s18-export-csv-btn.png |
| 9 | Browser | Экспорт CSV | Клик | Файл скачан | artifacts/exported-table.csv |
| 10 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s18-console.png |
| 11 | Edge | Нет данных для CSV | Пустая таблица | Кнопка disabled | screenshots/s18-csv-disabled.png |
| 12 | Edge | Freemium ROI | Нет подписки | "Оформите подписку" | screenshots/s18-roi-freemium.png |

---

### Sprint 19 — Экран логов

**Цель:** Полноценный экран логов

**User stories:** EPIC-9.US-1 — EPIC-9.US-6

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Browser | Экран логов | Открыть /logs | Список событий | screenshots/s19-logs-page.png |
| 2 | Browser | DOM страницы | querySelector('[data-testid="logs-page"]') | Найден | screenshots/s19-page-dom.png |
| 3 | Browser | Timestamp | В каждой строке | Секунды видны | screenshots/s19-timestamp.png |
| 4 | Browser | Все фильтры | Панель фильтров | 4 фильтра | screenshots/s19-filters.png |
| 5 | Browser | DOM фильтров | querySelector('[data-testid="logs-filters"]') | Найден | screenshots/s19-filters-dom.png |
| 6 | Browser | Поиск | Search input | Поле видно | screenshots/s19-search.png |
| 7 | Browser | Результат поиска | Ввести "CPL" | Отфильтровано | screenshots/s19-search-result.png |
| 8 | Browser | Детальная панель | Клик на событие | Панель открылась | screenshots/s19-details-panel.png |
| 9 | Browser | DOM панели | querySelector('[data-testid="event-details"]') | Найден | screenshots/s19-details-dom.png |
| 10 | Browser | Кнопка отмены | В панели | Кнопка видна | screenshots/s19-revert-btn.png |
| 11 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s19-console.png |
| 12 | Edge | Нет событий | Пустой лог | "Нет событий" | screenshots/s19-empty.png |
| 13 | Edge | Поиск без результатов | Ввести "xyz123" | "Ничего не найдено" | screenshots/s19-no-results.png |
| 14 | Edge | > 5 мин | Старое событие | Кнопка disabled | screenshots/s19-revert-disabled.png |

---

### Sprint 20 — Настройки: профиль и подписка

**Цель:** Profile tab, subscription

**User stories:** EPIC-10.US-1 — EPIC-10.US-4

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Browser | Страница настроек | Открыть /settings | Табы видны | screenshots/s20-settings.png |
| 2 | Browser | DOM страницы | querySelector('[data-testid="settings-page"]') | Найден | screenshots/s20-page-dom.png |
| 3 | Browser | Таб профиля | Первый таб | Email, дата | screenshots/s20-profile-tab.png |
| 4 | Browser | DOM профиля | querySelector('[data-testid="profile-tab"]') | Найден | screenshots/s20-profile-dom.png |
| 5 | Browser | Форма смены пароля | В профиле | 3 поля | screenshots/s20-password-form.png |
| 6 | Browser | Информация о подписке | В профиле | Тариф, дата | screenshots/s20-subscription.png |
| 7 | Browser | DOM подписки | querySelector('[data-testid="subscription-info"]') | Найден | screenshots/s20-sub-dom.png |
| 8 | Browser | История платежей | В профиле | Таблица | screenshots/s20-payments.png |
| 9 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s20-console.png |
| 10 | Edge | Неверный пароль | Смена с неверным старым | Ошибка | screenshots/s20-wrong-password.png |
| 11 | Edge | Freemium | Нет платежей | "Нет платежей" | screenshots/s20-no-payments.png |

---

### Sprint 21 — Настройки: Telegram и API

**Цель:** Telegram tab, API tab

**User stories:** EPIC-10.US-5 — EPIC-10.US-8

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Browser | Таб Telegram | Клик на таб | QR и инструкция | screenshots/s21-telegram-tab.png |
| 2 | Browser | DOM таба | querySelector('[data-testid="telegram-tab"]') | Найден | screenshots/s21-tg-dom.png |
| 3 | Browser | QR-код | В табе | QR виден | screenshots/s21-qr-code.png |
| 4 | Browser | Тихие часы в табе | Настройки | Pickers видны | screenshots/s21-quiet-hours.png |
| 5 | Browser | Таб API | Клик на таб | Статус VK | screenshots/s21-api-tab.png |
| 6 | Browser | DOM API таба | querySelector('[data-testid="api-tab"]') | Найден | screenshots/s21-api-dom.png |
| 7 | Browser | Статус VK | В табе | "Активно" зелёный | screenshots/s21-vk-status.png |
| 8 | Browser | Лог ошибок | В табе | Таблица ошибок | screenshots/s21-sync-errors.png |
| 9 | Browser | DOM ошибок | querySelector('[data-testid="sync-errors"]') | Найден | screenshots/s21-errors-dom.png |
| 10 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s21-console.png |
| 11 | Edge | Уже подключен Telegram | chatId есть | "Подключено" + Disconnect | screenshots/s21-tg-connected.png |
| 12 | Edge | Нет ошибок синхронизации | Пустой лог | "Всё работает" | screenshots/s21-no-errors.png |
| 13 | Edge | Токен VK истёк | status=error | "Переавторизуйтесь" | screenshots/s21-vk-expired.png |

---

### Sprint 22 — Мобильная адаптация

**Цель:** Responsive, bottom nav

**User stories:** EPIC-11.US-1, EPIC-11.US-2

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Browser | Дашборд 375px | Viewport 375x667 | Вертикальный стек | screenshots/s22-mobile-dashboard.png |
| 2 | Browser | Правила 375px | Viewport 375x667 | Список карточек | screenshots/s22-mobile-rules.png |
| 3 | Browser | Нижнее меню | На мобильном | 5 иконок | screenshots/s22-bottom-nav.png |
| 4 | Browser | DOM навигации | querySelector('[data-testid="bottom-nav"]') | Найден | screenshots/s22-nav-dom.png |
| 5 | Browser | Планшет 768px | Viewport 768x1024 | 2 колонки | screenshots/s22-tablet.png |
| 6 | Browser | Desktop 1024px | Viewport 1024x768 | Полный layout | screenshots/s22-desktop.png |
| 7 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s22-console.png |
| 8 | Edge | 320px | Минимальный viewport | Корректное отображение | screenshots/s22-320px.png |

---

### Sprint 23 — PWA

**Цель:** Manifest, SW, push, offline

**User stories:** EPIC-11.US-3, EPIC-11.US-4

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Browser | Prompt установки | Chrome mobile | "Добавить на экран" | screenshots/s23-add-to-home.png |
| 2 | Browser | Иконка на экране | После установки | Иконка AdPilot | screenshots/s23-home-icon.png |
| 3 | Browser | Push-уведомление | Триггер срабатывания | Push показан | screenshots/s23-push.png |
| 4 | Browser | Offline режим | Отключить интернет | Данные из кэша | screenshots/s23-offline.png |
| 5 | Browser | Lighthouse PWA | DevTools Audit | Score > 90 | screenshots/s23-lighthouse-pwa.png |
| 6 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s23-console.png |
| 7 | Edge | SW не поддерживается | Старый браузер | Graceful degradation | screenshots/s23-no-sw.png |
| 8 | Edge | Нет кэша | Первый offline | "Подключитесь" | screenshots/s23-no-cache.png |

---

### Sprint 24 — Биллинг: оплата

**Цель:** Payment integration

**User stories:** EPIC-12.US-1, EPIC-12.US-2

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | handlePaymentWebhook | Webhook success | tier обновлён | logs/test.txt |
| 2 | Integration | Payment mock | Test card | Подписка активна | logs/integration.txt |
| 3 | Browser | Страница тарифов | Открыть /pricing | 3 карточки | screenshots/s24-pricing.png |
| 4 | Browser | DOM страницы | querySelector('[data-testid="pricing-page"]') | Найден | screenshots/s24-pricing-dom.png |
| 5 | Browser | Форма оплаты | Клик "Оформить Start" | Форма открыта | screenshots/s24-payment-form.png |
| 6 | Browser | DOM формы | querySelector('[data-testid="payment-form"]') | Найден | screenshots/s24-form-dom.png |
| 7 | Browser | Успешная оплата | Test card 4242... | Подтверждение | screenshots/s24-success.png |
| 8 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s24-console.png |
| 9 | Edge | Ошибка оплаты | Declined card | Сообщение об ошибке | screenshots/s24-payment-error.png |
| 10 | Edge | Уже есть подписка | Повторная оплата | Предупреждение | screenshots/s24-already-subscribed.png |

---

### Sprint 25 — Биллинг: уведомления и лимиты

**Цель:** Expiry notifications, limit updates

**User stories:** EPIC-12.US-3, EPIC-12.US-4

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Unit | sendExpiryNotification 7d | expiresAt - 7 days | Email/TG отправлен | logs/test.txt |
| 2 | Unit | sendExpiryNotification 1d | expiresAt - 1 day | Email/TG отправлен | logs/test.txt |
| 3 | Unit | updateLimitsOnDowngrade | start→freemium, 3 accounts | 2 деактивированы | logs/test.txt |
| 4 | Integration | Cron expiry check | Mock time | Уведомление отправлено | logs/integration.txt |
| 5 | Browser | Уведомление в Telegram | За 7 дней | Сообщение получено | screenshots/s25-expiry-tg.png |
| 6 | Browser | UI истекшей подписки | tier=expired | "Подписка истекла" | screenshots/s25-expired-ui.png |
| 7 | Console | Нет ошибок | DevTools | 0 errors | screenshots/s25-console.png |
| 8 | Edge | Downgrade с лишними | pro→freemium, 5 accounts | 4 деактивированы | screenshots/s25-downgrade.png |

---

### Sprint 26 — E2E тесты

**Цель:** Full user journey

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | E2E | Полный journey | Регистрация → кабинет → правило → срабатывание → TG | Весь flow работает | videos/e2e-journey.webm |
| 2 | E2E | Payment flow | Freemium → Start → использование | Апгрейд работает | videos/e2e-payment.webm |
| 3 | Browser | Screenshot серия | Каждый шаг journey | 10+ скриншотов | screenshots/s26-e2e-*.png |
| 4 | Console | Нет ошибок во flow | Весь journey | 0 errors | screenshots/s26-console.png |
| 5 | Edge | Прерывание на любом шаге | Закрыть браузер | Восстановление | logs/s26-recovery.txt |

---

### Sprint 27 — Docker и CI/CD

**Цель:** Containerization, automation

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Docker | Build | `docker build -t adpilot .` | Успех | logs/docker-build.txt |
| 2 | Docker | Run | `docker run -p 3000:3000` | App работает | logs/docker-run.txt |
| 3 | CI | PR trigger | Создать PR | Workflow запустился | screenshots/s27-pr-trigger.png |
| 4 | CI | All checks pass | Ждать завершения | Все зелёные | screenshots/s27-checks-pass.png |
| 5 | CD | Deploy on merge | Merge в main | Vercel deployed | screenshots/s27-vercel-deploy.png |
| 6 | Browser | GitHub Actions | Открыть Actions tab | Successful runs | screenshots/s27-actions.png |

---

### Sprint 28 — Smoke-тесты и мониторинг

**Цель:** Post-deploy verification

**DoD — Конкретные тестовые сценарии:**

| # | Категория | Сценарий | Действие | Ожидаемый результат | Артефакт |
|---|-----------|----------|----------|---------------------|----------|
| 1 | Smoke | Homepage load | curl + browser | 200 OK, < 2 сек | screenshots/s28-smoke-home.png |
| 2 | Smoke | Auth flow | VK OAuth | Успешный вход | screenshots/s28-smoke-auth.png |
| 3 | Smoke | Dashboard | После входа | Виджеты рендерятся | screenshots/s28-smoke-dashboard.png |
| 4 | Smoke | API health | GET /api/health | {"status":"ok"} | logs/s28-health.json |
| 5 | Monitoring | Sentry setup | Проверить dashboard | Интегрирован | screenshots/s28-sentry.png |
| 6 | Monitoring | UptimeRobot | Проверить dashboard | Monitor active | screenshots/s28-uptime.png |
| 7 | Monitoring | Telegram alert | Симулировать downtime | Алерт получен | screenshots/s28-alert.png |

---

## 5. Ralph Wiggum Loop Цикл

### 5.1 Вход спринта

1. Прочитать описание спринта
2. Проверить артефакты предыдущего спринта
3. Загрузить актуальный код
4. Проверить зависимости

### 5.2 Выход спринта — ОБЯЗАТЕЛЬНЫЕ КРИТЕРИИ

Спринт **ЗАВЕРШЁН** только если **ВСЕ** условия выполнены:

| # | Критерий | Проверка |
|---|----------|----------|
| 1 | Все задачи выполнены | Чеклист ✅ |
| 2 | Unit тесты: 0 failures | `npm run test:unit` |
| 3 | Integration тесты: 0 failures | `npm run test:integration` |
| 4 | ВСЕ скриншоты сделаны | `ls screenshots/sN-*.png` |
| 5 | ВСЕ DOM проверки пройдены | querySelector найдены |
| 6 | Network логи сохранены | `ls logs/sN-*.json` |
| 7 | Console без errors | Скриншот console |
| 8 | ВСЕ edge-cases проверены | Скриншоты edge-* |
| 9 | Артефакты созданы | Файлы существуют |

### 5.3 Критерий перехода

```
GOTO Sprint N+1 IF AND ONLY IF:
  unit_tests.pass == 100%
  AND integration_tests.pass == 100%
  AND screenshots.count >= expected
  AND dom_checks.pass == 100%
  AND console.errors == 0
  AND edge_cases.all_tested == true
  AND artifacts.all_exist == true
```

### 5.4 НЕДОПУСТИМЫЙ РЕЗУЛЬТАТ

Спринт **НЕ ЗАВЕРШЁН** если:

- ❌ Отсутствует ЛЮБОЙ браузерный артефакт (скриншот)
- ❌ Тест описан текстом без реального выполнения
- ❌ `npm run test` не запускался
- ❌ Есть хотя бы 1 test failure
- ❌ Артефакты не созданы как файлы
- ❌ Edge-case не проверен с доказательством
- ❌ Console содержит error
- ❌ Network запрос не залогирован

---

## 6. Релиз и деплой

### 6.1 CI-гейты (ВСЕ должны пройти)

```bash
# 1. Lint
npm run lint                    # 0 errors

# 2. Type check
npx tsc --noEmit               # 0 errors

# 3. Unit tests
npm run test:unit              # 100% pass

# 4. Integration tests
npm run test:integration       # 100% pass

# 5. Build
npm run build                  # success

# 6. E2E tests
npx playwright test            # 100% pass
```

### 6.2 Docker

```bash
# Build
docker build -t adpilot:latest .

# Run
docker run -p 3000:3000 -e CONVEX_URL=$CONVEX_URL adpilot:latest

# Verify
curl http://localhost:3000/api/health
# Expected: {"status":"ok"}
```

### 6.3 Smoke-тесты (после КАЖДОГО деплоя)

| # | Тест | Действие | Ожидание | Артефакт |
|---|------|----------|----------|----------|
| 1 | Homepage | Открыть URL | < 2 сек | smoke-home.png |
| 2 | Auth | VK OAuth | Успех | smoke-auth.png |
| 3 | Dashboard | Загрузить | Виджеты | smoke-dashboard.png |
| 4 | Real-time | Создать событие | Обновление | smoke-realtime.png |
| 5 | Telegram | Триггер | Сообщение | smoke-telegram.png |
| 6 | API | /api/health | 200 | smoke-api.json |

### 6.4 Проверка платных фич

```
# Freemium → Start
1. Freemium: подключить 1 кабинет → OK
2. Freemium: подключить 2-й → BLOCKED
3. Оплатить Start
4. Подключить 2-й, 3-й → OK

# Auto-stop
1. Freemium: "Остановить" → DISABLED
2. Start: "Остановить" → ENABLED
3. Создать правило → OK
4. Срабатывание → Объявление STOPPED
```

### 6.5 Edge-cases UI

| Кейс | Действие | Ожидание | Артефакт |
|------|----------|----------|----------|
| Пустые кабинеты | Новый юзер | "Подключите" | edge-empty-accounts.png |
| Пустые правила | Нет правил | "Создайте" | edge-empty-rules.png |
| VK API down | Mock 500 | Ошибка | edge-vk-error.png |
| Токен истёк | 401 | "Переавторизуйтесь" | edge-token-expired.png |
| Лимит кабинетов | Freemium+2 | Модалка | edge-account-limit.png |
| Лимит правил | Freemium+3 | Ошибка | edge-rule-limit.png |

### 6.6 Rollback

**Триггеры:**
- Error rate > 5% (Sentry)
- Downtime > 5 мин

**Процедура:**
```bash
# 1. Откат Vercel
vercel rollback [deployment-id]

# 2. Smoke
npm run test:smoke

# 3. Notify team
```

---

## 7. Чеклист Production-Ready

### Технический

- [ ] 28 спринтов завершены
- [ ] Unit coverage > 80%
- [ ] E2E full journey pass
- [ ] Docker build success
- [ ] CI/CD green
- [ ] Sentry configured
- [ ] UptimeRobot configured
- [ ] Lighthouse > 90

### Функциональный

- [ ] VK OAuth works
- [ ] VK Ads API works
- [ ] Telegram bot works
- [ ] 4 rule types work
- [ ] Auto-stop works
- [ ] Real-time works
- [ ] Billing works
- [ ] All edge-cases handled

---

*Документ: AdPilot_RalphWiggum_Plan_FULL.md*
*Версия: 2.1*
*Дата: 24 января 2026 г.*
*Источник: AdPilot_PRD_v1.0.md*
