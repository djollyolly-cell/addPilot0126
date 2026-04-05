# Спринты: Подключение платёжной системы bePaid + Сборка сайта

> Документ описывает реальный порядок работ, как всё устроено сейчас в проде.
> Предназначен для переиспользования на другом сервисе.
> Блоки `⚡ ИЗМЕНИТЬ` — то, что нужно адаптировать под новый проект.

---

## Оглавление

1. [Спринт 1 — Инфраструктура проекта](#спринт-1--инфраструктура-проекта)
2. [Спринт 2 — База данных и схема](#спринт-2--база-данных-и-схема)
3. [Спринт 3 — Аутентификация](#спринт-3--аутентификация)
4. [Спринт 4 — Лендинг и страницы сайта](#спринт-4--лендинг-и-страницы-сайта)
5. [Спринт 5 — Тарифная система и подписки](#спринт-5--тарифная-система-и-подписки)
6. [Спринт 6 — Интеграция bePaid (платёжный шлюз)](#спринт-6--интеграция-bepaid-платёжный-шлюз)
7. [Спринт 7 — Webhook обработка платежей](#спринт-7--webhook-обработка-платежей)
8. [Спринт 8 — Фронтенд оплаты (PaymentModal)](#спринт-8--фронтенд-оплаты-paymentmodal)
9. [Спринт 9 — Управление подписками и истечение](#спринт-9--управление-подписками-и-истечение)
10. [Спринт 10 — Админ-панель](#спринт-10--админ-панель)
11. [Спринт 11 — Безопасность](#спринт-11--безопасность)
12. [Спринт 12 — CI/CD и деплой](#спринт-12--cicd-и-деплой)
13. [Спринт 13 — Тестирование](#спринт-13--тестирование)
14. [Сводная таблица переменных окружения](#сводная-таблица-переменных-окружения)
15. [Чеклист адаптации для нового сервиса](#чеклист-адаптации-для-нового-сервиса)

---

## Спринт 1 — Инфраструктура проекта

### Цель
Развернуть стек: React + Vite + Convex + TailwindCSS + TypeScript.

### Что делаем

| Шаг | Описание |
|-----|----------|
| 1.1 | Инициализация проекта: `npm create vite@latest -- --template react-ts` |
| 1.2 | Установка зависимостей (см. ниже) |
| 1.3 | Настройка Vite (`vite.config.ts`) — code splitting, vendor chunks, source maps |
| 1.4 | Настройка TailwindCSS + PostCSS |
| 1.5 | Настройка TypeScript (`tsconfig.json`) — ES2020, strict mode, path aliases `@/` |
| 1.6 | Настройка ESLint + Prettier |
| 1.7 | Инициализация Convex: `npx convex init` |
| 1.8 | Создание `.env.example` со всеми переменными |

### Ключевые зависимости

```json
{
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0",
    "convex": "^1.31.6",
    "@tanstack/react-query": "^5.51.0",
    "recharts": "^2.12.7",
    "zod": "^3.23.8",
    "date-fns": "^3.6.0",
    "lucide-react": "^0.424.0",
    "tailwindcss": "^3.4.7"
  },
  "devDependencies": {
    "vite": "^7.3.1",
    "vitest": "^4.0.18",
    "@playwright/test": "^1.45.3",
    "typescript": "^5.5.4",
    "@testing-library/react": "^16.0.0"
  }
}
```

### Структура каталогов

```
project/
├── src/
│   ├── components/     # UI-компоненты
│   ├── pages/          # Страницы (маршруты)
│   ├── lib/            # Утилиты, хуки, auth context
│   └── main.tsx        # Точка входа
├── convex/             # Бэкенд (serverless функции)
├── tests/
│   ├── e2e/            # Playwright
│   ├── unit/           # Vitest
│   └── security/       # Тесты безопасности
├── public/             # Статика
├── docker/             # Docker конфиги
├── .github/workflows/  # CI/CD
└── dist/               # Билд (генерируется)
```

### Проверка
- [ ] `npm run dev` запускает dev-сервер на :5173
- [ ] `npm run build` собирает без ошибок
- [ ] `npx convex dev` подключается к Convex

### ⚡ ИЗМЕНИТЬ
- Название проекта в `package.json`
- `VITE_CONVEX_URL` — URL вашего Convex deployment
- Vendor chunks в `vite.config.ts` — под ваши зависимости

---

## Спринт 2 — База данных и схема

### Цель
Определить все таблицы в Convex schema.

### Файл: `convex/schema.ts`

### Таблицы, связанные с платежами

```typescript
// Таблица пользователей (поля подписки)
users: defineTable({
  email: v.string(),
  // ... остальные поля пользователя
  subscriptionTier: v.optional(v.union(
    v.literal("freemium"),
    v.literal("start"),
    v.literal("pro")
  )),
  subscriptionExpiresAt: v.optional(v.number()), // timestamp в мс
  updatedAt: v.optional(v.number()),
})
  .index("by_email", ["email"]),

// Таблица платежей
payments: defineTable({
  userId: v.id("users"),
  tier: v.union(v.literal("start"), v.literal("pro")),
  orderId: v.string(),         // "order_{userId}_{tier}_{timestamp}"
  token: v.string(),           // Checkout token от bePaid
  amount: v.number(),          // Сумма в BYN
  currency: v.string(),        // "BYN"
  status: v.union(
    v.literal("pending"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("refunded")
  ),
  bepaidUid: v.optional(v.string()),    // UID транзакции от bePaid
  errorMessage: v.optional(v.string()),
  createdAt: v.number(),
  completedAt: v.optional(v.number()),
})
  .index("by_userId", ["userId"])
  .index("by_orderId", ["orderId"])
  .index("by_token", ["token"]),

// Уведомления (для expiry notifications)
notifications: defineTable({
  userId: v.id("users"),
  type: v.union(v.literal("critical"), v.literal("standard"), v.literal("digest")),
  channel: v.union(v.literal("telegram"), v.literal("email"), v.literal("push")),
  title: v.string(),
  message: v.string(),
  status: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
  sentAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_userId", ["userId"])
  .index("by_status", ["status"]),
```

### Важно
- Схема используется с `{ schemaValidation: false }` для dev-совместимости — в проде можно включить strict
- Все поля подписки у `users` — `v.optional()`, т.к. юзер начинает без подписки

### Проверка
- [ ] `npx convex dev` применяет схему без ошибок
- [ ] Индексы создаются корректно

### ⚡ ИЗМЕНИТЬ
- Названия тарифов (`"freemium"`, `"start"`, `"pro"`) — под ваши тарифы
- Поля пользователя — под вашу бизнес-логику
- Таблицы, не связанные с платежами (adAccounts, rules и т.д.) — заменить на свои

---

## Спринт 3 — Аутентификация

### Цель
Настроить вход через OAuth и/или email.

### Реализовано

| Компонент | Файл | Описание |
|-----------|------|----------|
| VK OAuth 2.1 | `convex/auth.ts` | PKCE flow, endpoint `id.vk.com/authorize` |
| Email/Password | `convex/authEmail.ts` | Кастомная auth по email |
| Сессии | `convex/schema.ts` → `sessions` | Token в localStorage, 30 дней |
| Auth Context | `src/lib/useAuth.tsx` | React Context с хуками |
| PKCE | `src/lib/pkce.ts` | Code challenge/verifier |
| Rate Limiting | `convex/rateLimit.ts` | Защита от брутфорса |
| Login Attempts | `convex/schema.ts` → `loginAttempts` | Трекинг попыток входа |

### Flow аутентификации

```
1. Юзер → LoginPage → нажимает "Войти через VK"
2. Генерируется PKCE code_verifier + code_challenge
3. Редирект на id.vk.com/authorize с state, scope=email
4. VK возвращает code → AuthCallback.tsx
5. Бэкенд обменивает code на access_token (rate limited: 5/мин)
6. Создаётся/обновляется юзер в DB
7. Генерируется session token → localStorage "adpilot_session"
8. Редирект на dashboard
```

### Проверка
- [ ] OAuth flow работает от начала до конца
- [ ] Session сохраняется при перезагрузке
- [ ] Rate limiting блокирует после 5 попыток
- [ ] Невалидный state отклоняется

### ⚡ ИЗМЕНИТЬ
- OAuth провайдер (VK → ваш провайдер)
- `VITE_REDIRECT_URI` — callback URL
- Ключ localStorage (`"adpilot_session"` → ваш ключ)
- Admin email список: `['13632013@vk.com']` → ваши admin emails

---

## Спринт 4 — Лендинг и страницы сайта

### Цель
Создать все публичные и защищённые страницы.

### Страницы

| Страница | Файл | Тип | Описание |
|----------|------|-----|----------|
| Лендинг | `LandingPage.tsx` | Public | Маркетинговая страница |
| Вход | `LoginPage.tsx` | Public | OAuth + Email login |
| OAuth callback | `AuthCallback.tsx` | Public | Обработка VK redirect |
| Тарифы | `PricingPage.tsx` | Public | Таблица тарифов, кнопки оплаты |
| Приватность | `PrivacyPage.tsx` | Public | Политика конфиденциальности |
| Условия | `TermsPage.tsx` | Public | Условия использования |
| Дашборд | `DashboardPage.tsx` | Protected | Главная панель |
| Профиль | `ProfilePage.tsx` | Protected | Настройки профиля |
| Настройки | `SettingsPage.tsx` | Protected | Пользовательские настройки |
| Админка | `AdminPage.tsx` | Admin | Управление юзерами |

### Маршрутизация (`App.tsx`)

```tsx
<Routes>
  {/* Public */}
  <Route path="/" element={<LandingPage />} />
  <Route path="/login" element={<LoginPage />} />
  <Route path="/auth/callback" element={<AuthCallback />} />
  <Route path="/pricing" element={<PricingPage />} />
  <Route path="/privacy" element={<PrivacyPage />} />
  <Route path="/terms" element={<TermsPage />} />

  {/* Protected */}
  <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
  <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
  <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />

  {/* Admin */}
  <Route path="/admin" element={<ProtectedRoute admin><AdminPage /></ProtectedRoute>} />
</Routes>
```

### Компоненты

| Компонент | Описание |
|-----------|----------|
| `Layout.tsx` | Обёртка: header, навигация, sidebar |
| `PaymentModal.tsx` | Модал оплаты (подробно в Спринте 8) |
| `UpgradeModal.tsx` | Промпт для апгрейда тарифа |
| `ui/*` | Shadcn/ui примитивы (card, button, badge, input, label) |

### Security Headers (`serve.json` + `vercel.json`)

```json
{
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
}
```

### Проверка
- [ ] Все страницы открываются, роутинг работает
- [ ] Protected routes редиректят на /login без сессии
- [ ] Admin route доступен только admin-юзерам
- [ ] Security headers присутствуют в ответах

### ⚡ ИЗМЕНИТЬ
- Контент лендинга и всех страниц
- Маршруты под ваш проект
- Список защищённых/публичных страниц
- Юридические страницы (PrivacyPage, TermsPage)
- Домен в CSP-заголовках

---

## Спринт 5 — Тарифная система и подписки

### Цель
Настроить тарифы с ценами и лимитами.

### Файл: `convex/billing.ts`

### Конфигурация тарифов

```typescript
export const TIERS = {
  freemium: {
    name: "Freemium",
    price: 0,           // Базовая цена в RUB
    accountsLimit: 1,
    rulesLimit: 3,
    features: ["1 рекламный кабинет", "3 правила автоматизации", "Telegram-уведомления"],
  },
  start: {
    name: "Start",
    price: 990,          // 990 RUB ≈ 35 BYN
    accountsLimit: 3,
    rulesLimit: 10,
    features: ["3 рекламных кабинета", "10 правил автоматизации", "Telegram-уведомления", "Базовая аналитика"],
  },
  pro: {
    name: "Pro",
    price: 2490,         // 2490 RUB ≈ 88 BYN
    accountsLimit: 10,
    rulesLimit: -1,      // unlimited
    features: ["10 рекламных кабинетов", "Неограниченные правила", "Приоритетная поддержка", "Расширенная аналитика"],
  },
} as const;
```

### Функции подписок

| Функция | Тип | Описание |
|---------|-----|----------|
| `getSubscription(userId)` | query | Текущий статус подписки, expired ли |
| `getTiers()` | query | Все тарифы с ценами и фичами |
| `cancelSubscription(userId)` | mutation | Даунгрейд до freemium |
| `getPaymentHistory(userId)` | query | Последние 20 платежей |
| `isBepaidConfigured()` | action | Проверка наличия ключей bePaid |

### Логика подписки
- Подписка **30 дней** от момента оплаты
- `subscriptionExpiresAt` = `Date.now() + 30 * 24 * 60 * 60 * 1000`
- `isExpired` = `expiresAt < Date.now()`
- `isActive` = `!isExpired && tier !== "freemium"`

### Проверка
- [ ] `getSubscription` возвращает корректный tier и expiry
- [ ] `cancelSubscription` сбрасывает на freemium
- [ ] `getPaymentHistory` возвращает список платежей
- [ ] `getTiers` возвращает все тарифы

### ⚡ ИЗМЕНИТЬ
- Названия, цены и лимиты тарифов
- Длительность подписки (30 дней → ваша)
- Базовая валюта (RUB → ваша)
- Фичи каждого тарифа
- Лимиты (accountsLimit, rulesLimit → ваши лимиты)

---

## Спринт 6 — Интеграция bePaid (платёжный шлюз)

### Цель
Подключить bePaid Checkout API для приёма платежей.

### Файл: `convex/billing.ts` → `createBepaidCheckout`

### bePaid API

| Параметр | Значение |
|----------|----------|
| Endpoint | `https://checkout.bepaid.by/ctp/api/checkouts` |
| Auth | Basic Auth: `base64(shopId:secretKey)` |
| API Version | `X-API-Version: 2` |
| Content-Type | `application/json` |

### Формат запроса к bePaid

```typescript
const checkoutRequest = {
  checkout: {
    test: isTestMode,              // true для тестового режима
    transaction_type: "payment",
    attempts: 3,                   // Максимум попыток ввода карты
    settings: {
      success_url: `${returnUrl}?status=success&tier=${tier}`,
      fail_url: `${returnUrl}?status=failed`,
      notification_url: `${CONVEX_SITE_URL}/api/bepaid-webhook`,
      language: "ru",
    },
    order: {
      amount: amountInCents,       // Сумма в КОПЕЙКАХ (BYN * 100)
      currency: "BYN",
      description: `AddPilot ${tierName}`,
      tracking_id: orderId,        // "order_{userId}_{tier}_{timestamp}"
    },
    customer: {
      email: userEmail,
    },
  },
};
```

### Формат ответа от bePaid

```json
{
  "checkout": {
    "token": "abc123...",
    "redirect_url": "https://checkout.bepaid.by/v2/checkout?token=abc123..."
  }
}
```

### Flow создания платежа

```
1. Юзер нажимает "Оплатить" на фронте
2. Фронт вызывает createBepaidCheckout(userId, tier, returnUrl, amountBYN)
3. Бэкенд:
   a. Проверяет наличие BEPAID_SHOP_ID / BEPAID_SECRET_KEY
   b. Если не настроено → возвращает mockMode: true
   c. Получает юзера из DB
   d. Формирует orderId: "order_{userId}_{tier}_{timestamp}"
   e. Делает POST на bePaid Checkout API
   f. Сохраняет pending payment в таблицу payments
   g. Возвращает { token, redirectUrl }
4. Фронт делает window.location.href = redirectUrl
5. Юзер вводит карту на странице bePaid
6. bePaid шлёт webhook (см. Спринт 7)
7. Юзер возвращается на returnUrl с ?status=success/failed
```

### Mock-режим (когда bePaid не настроен)

```typescript
// Тестовые карты
const TEST_CARDS = {
  success: "4242 4242 4242 4242",
  decline: "4000 0000 0000 0002",
};

// processPayment — mock mutation для тестов
// Принимает cardNumber, проверяет:
// - "4242..." → success, активирует подписку
// - "4000...0002" → declined
// - любой другой → invalid card
```

### Проверка
- [ ] С настроенными ключами → редирект на bePaid checkout
- [ ] Без ключей → возврат mockMode, работает тестовая форма
- [ ] Pending payment создаётся в DB перед редиректом
- [ ] orderId уникален (содержит timestamp)
- [ ] amount передаётся в копейках (×100)
- [ ] Тестовая карта `4242...` → success
- [ ] Тестовая карта `4000...0002` → decline

### ⚡ ИЗМЕНИТЬ
- `BEPAID_SHOP_ID`, `BEPAID_SECRET_KEY` — получить в ЛК bePaid
- `BEPAID_TEST_MODE` — `true` для тестов, `false` для прода
- `CONVEX_SITE_URL` — URL вашего Convex HTTP endpoint
- `description` в order — название вашего сервиса
- Валюту (BYN → если другая)
- `returnUrl` — URL страницы возврата после оплаты

---

## Спринт 7 — Webhook обработка платежей

### Цель
Принимать уведомления от bePaid о статусе платежа.

### Файл: `convex/http.ts` + `convex/billing.ts` → `handleBepaidWebhook`

### Endpoint

```
POST /api/bepaid-webhook
```

### Безопасность webhook

1. bePaid отправляет `Authorization: Basic base64(shopId:secretKey)` в заголовке
2. Бэкенд проверяет:
   - Наличие заголовка Authorization
   - Префикс "Basic "
   - Декодирование base64 → сравнение с `BEPAID_SHOP_ID:BEPAID_SECRET_KEY`
3. При несовпадении → 401 Unauthorized
4. При ошибках → всегда 200 (чтобы bePaid не ретраил)

### Формат webhook от bePaid

```json
{
  "transaction": {
    "uid": "txn-uuid-from-bepaid",
    "status": "successful",        // "successful" | "failed" | "declined"
    "type": "payment",
    "tracking_id": "order_xxx_start_1234567890",
    "amount": 3500,                // В копейках (35.00 BYN = 3500)
    "currency": "BYN",
    "message": "Successfully processed"
  }
}
```

### Обработка webhook

```typescript
// convex/http.ts
http.route({
  path: "/api/bepaid-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // 1. Верификация Basic Auth
    // 2. Парсинг body.transaction
    // 3. Вызов handleBepaidWebhook mutation
    // 4. Всегда return 200
  }),
});

// convex/billing.ts → handleBepaidWebhook
// При status === "successful":
//   - payment.status = "completed"
//   - payment.bepaidUid = transaction.uid
//   - user.subscriptionTier = payment.tier
//   - user.subscriptionExpiresAt = now + 30 дней
//
// При status === "failed" | "declined":
//   - payment.status = "failed"
//   - payment.errorMessage = transaction.message
```

### Важные детали
- `tracking_id` = наш `orderId` → по нему находим payment в DB
- `amount` приходит в **копейках** → делим на 100
- Всегда отвечаем **200**, даже при ошибках → иначе bePaid будет ретраить
- Webhook может прийти **раньше**, чем юзер вернётся на сайт

### Проверка
- [ ] Webhook без Authorization → 401
- [ ] Webhook с неверными credentials → 401
- [ ] Webhook с корректными credentials → 200
- [ ] status=successful → payment.status = completed, подписка активирована
- [ ] status=failed → payment.status = failed, errorMessage сохранён
- [ ] Несуществующий tracking_id → логируется, 200 (не ретраить)
- [ ] Повторный webhook (идемпотентность) → не ломает данные

### ⚡ ИЗМЕНИТЬ
- Path webhook (`/api/bepaid-webhook`) — должен совпадать с `notification_url` в спринте 6
- Зарегистрировать webhook URL в ЛК bePaid
- `CONVEX_SITE_URL` — полный URL вашего HTTP endpoint

---

## Спринт 8 — Фронтенд оплаты (PaymentModal)

### Цель
Создать UI для оплаты с выбором страны/валюты.

### Файл: `src/components/PaymentModal.tsx`

### Двухшаговый flow

```
Step 1: Выбор страны/валюты
  ├── 🇷🇺 Россия (RUB) → локальная форма карты (mock)
  └── 🇧🇾 Беларусь (BYN) → редирект на bePaid

Step 2a (BYN): Кнопка "Перейти к оплате" → bePaid checkout
Step 2b (RUB): Форма карты → mock processPayment
```

### Конвертация валют (НБРБ API)

```typescript
// При открытии модала — запрос курса RUB→BYN
const response = await fetch('https://api.nbrb.by/exrates/rates/RUB?parammode=2');
const data = await response.json();
// data.Cur_OfficialRate = 3.4567 (курс за Cur_Scale единиц)
// data.Cur_Scale = 100

// Формула: BYN = RUB * (rate / scale)
// 990 RUB * (3.4567 / 100) = 34.20 BYN → Math.ceil → 35 BYN

// Fallback при ошибке API:
const FALLBACK_BYN_PRICES = { start: 35, pro: 88 };
```

### Базовые цены

```typescript
const PRICES_RUB = {
  start: 990,
  pro: 2490,
};
```

### Интеграция с PricingPage

```typescript
// PricingPage.tsx обрабатывает return от bePaid:
// URL: /pricing?status=success&tier=start
// URL: /pricing?status=failed

// Также поддерживает deep link:
// /pricing?plan=start → автоматически открывает PaymentModal
```

### UI States

| State | Описание |
|-------|----------|
| `select-country` | Выбор 🇷🇺/🇧🇾, показ цен в обеих валютах |
| `payment` (BYN) | Кнопка "Перейти к оплате" + лого bePaid |
| `payment` (RUB) | Форма: номер карты, срок, CVC |
| `success` | Зелёная галочка, "Тариф активирован" |
| `error` | Красный блок с сообщением об ошибке |
| `loading` | Spinner при обработке |

### Проверка
- [ ] Модал открывается, показывает цены
- [ ] Курс НБРБ загружается, цена BYN корректна
- [ ] При ошибке НБРБ → fallback цены
- [ ] BYN → редирект на bePaid
- [ ] RUB → форма карты работает с тестовыми картами
- [ ] Success/error states отображаются
- [ ] Возврат с bePaid (?status=success) → уведомление на PricingPage
- [ ] Deep link (?plan=start) → модал открывается

### ⚡ ИЗМЕНИТЬ
- Цены `PRICES_RUB` и `FALLBACK_BYN_PRICES`
- Страны (если не RU/BY)
- API конвертации (НБРБ → ваш ЦБ)
- Формулу конвертации
- URL возврата (`/pricing` → ваша страница)
- Если не нужен RUB — убрать mock форму и оставить только bePaid

---

## Спринт 9 — Управление подписками и истечение

### Цель
Автоматическое истечение подписок, уведомления, даунгрейд лимитов.

### Файл: `convex/crons.ts` + `convex/billing.ts`

### Cron Jobs

```typescript
// 1. Проверка истекающих подписок — ежедневно 08:00 UTC (11:00 MSK)
crons.cron("check-expiring-subscriptions", "0 8 * * *",
  internal.billing.checkExpiringSubscriptions
);

// 2. Обработка истёкших подписок — каждый час
crons.interval("process-expired-subscriptions", { hours: 1 },
  internal.billing.processExpiredSubscriptions
);
```

### Уведомления об истечении

| Когда | Тип | Канал | Сообщение |
|-------|-----|-------|-----------|
| За 7 дней | standard | Telegram | "⚠️ Подписка заканчивается через 7 дней" + ссылка на продление |
| За 1 день | critical | Telegram | "🔴 Подписка истекает завтра!" + предупреждение о деактивации |

### Логика определения "истекающих"

```typescript
// Окно поиска: targetDate ± 12 часов
const targetDate = now + daysAhead * dayMs;
const windowStart = targetDate - dayMs / 2;
const windowEnd = targetDate + dayMs / 2;
// Юзер попадает, если expiresAt в этом окне
```

### Даунгрейд при истечении

```
processExpiredSubscriptions (каждый час):
  1. Найти всех юзеров с subscriptionExpiresAt < now и tier != freemium
  2. Установить subscriptionTier = "freemium"
  3. Вызвать updateLimitsOnDowngrade для каждого:
     - Деактивировать лишние аккаунты (оставить oldest до лимита)
     - Деактивировать лишние правила (оставить oldest до лимита)
```

### Лимиты при даунгрейде

| Тариф | Аккаунтов | Правил |
|-------|-----------|--------|
| Freemium | 1 | 3 |
| Start | 3 | 10 |
| Pro | 10 | ∞ |

### Проверка
- [ ] Cron "check-expiring" отправляет TG за 7 дней
- [ ] Cron "check-expiring" отправляет TG за 1 день
- [ ] Cron "process-expired" даунгрейдит истёкшие подписки
- [ ] Лишние аккаунты деактивируются (status → paused)
- [ ] Лишние правила деактивируются (isActive → false)
- [ ] Notification record сохраняется в DB
- [ ] Юзер без Telegram — уведомление не отправляется, но записывается

### ⚡ ИЗМЕНИТЬ
- Время cron (08:00 UTC → ваш часовой пояс)
- Текст уведомлений
- Ссылка на продление (`https://adpilot.ru/pricing` → ваш URL)
- Каналы уведомлений (Telegram → ваш канал: email, push и т.д.)
- Лимиты тарифов
- Логику "что деактивировать" при даунгрейде

---

## Спринт 10 — Админ-панель

### Цель
Панель управления юзерами и статистикой.

### Файлы: `src/pages/AdminPage.tsx` + `convex/admin.ts`

### Статистика (dashboard)

```typescript
getStats() → {
  totalUsers: number,
  freemiumCount: number,
  startCount: number,
  proCount: number,
  totalRevenue: number,        // Сумма всех completed payments
  recentRevenue: number,       // Сумма за последние 30 дней
  telegramConnected: number,   // Юзеры с Telegram
  withAccounts: number,        // Юзеры с рекламными аккаунтами
}
```

### Управление юзерами

| Функция | Описание |
|---------|----------|
| `listUsers(sessionToken)` | Список всех юзеров с фильтрацией |
| `updateUserTier(userId, tier)` | Ручная смена тарифа (с даунгрейд-логикой) |

### UI админки

- Поиск по имени/email
- Фильтр по тарифу
- Таблица: имя, email, тариф, аккаунты, правила, Telegram, дата регистрации
- Inline dropdown для смены тарифа
- Responsive (скрытые колонки на мобильных)

### Доступ

```typescript
// В AuthContext:
const ADMIN_EMAILS = ['13632013@vk.com'];
const isAdmin = user && ADMIN_EMAILS.includes(user.email);

// Route protection:
<Route path="/admin" element={<ProtectedRoute admin><AdminPage /></ProtectedRoute>} />
```

### Проверка
- [ ] Только admin может открыть /admin
- [ ] Статистика считается корректно
- [ ] Смена тарифа работает из UI
- [ ] При даунгрейде лишние ресурсы деактивируются
- [ ] Поиск и фильтрация работают

### ⚡ ИЗМЕНИТЬ
- Admin emails
- Метрики статистики под ваш проект
- Колонки таблицы юзеров
- Действия над юзерами

---

## Спринт 11 — Безопасность

### Цель
Защита всех эндпоинтов и данных.

### Реализовано

| Мера | Где | Как |
|------|-----|-----|
| Webhook auth (bePaid) | `http.ts` | Basic Auth, проверка credentials |
| Webhook auth (Telegram) | `http.ts` | Secret Token в заголовке |
| PKCE flow | `auth.ts` + `pkce.ts` | Code challenge/verifier |
| Rate limiting | `rateLimit.ts` + `rateLimits` table | 5 попыток/мин на OAuth |
| Brute force protection | `loginAttempts` table | Блокировка после N попыток |
| Security headers | `serve.json` | X-Frame-Options, CSP, etc. |
| CORS | Convex HTTP | Ограничен доменами |
| Input validation | `zod` + Convex validators | Валидация на входе |

### Тестирование безопасности

Файл: `tests/security/webhook-signature.test.ts`

```
✓ Telegram webhook проверяет X-Telegram-Bot-Api-Secret-Token
✓ Telegram webhook читает TELEGRAM_WEBHOOK_SECRET из env
✓ Возвращает 401 для невалидного токена
✓ bePaid webhook проверяет Authorization header
✓ bePaid webhook верифицирует Basic Auth credentials
✓ bePaid webhook читает BEPAID_SHOP_ID из env
✓ bePaid webhook читает BEPAID_SECRET_KEY из env
✓ Возвращает 401 для невалидных credentials
✓ Оба webhook возвращают 200 для валидных запросов
```

Файл: `tests/security/rate-limiting.test.ts`
```
✓ Rate limiting блокирует после превышения лимита
✓ Блокировка снимается по истечении времени
```

Файл: `tests/security/audit.test.ts`
```
✓ Общий аудит безопасности
```

### Проверка
- [ ] Все webhook-и защищены (401 без credentials)
- [ ] Rate limiting работает
- [ ] Security headers присутствуют
- [ ] PKCE защищает OAuth flow
- [ ] Нет утечки секретов в клиентский код

### ⚡ ИЗМЕНИТЬ
- Webhook secrets под ваш проект
- Rate limit значения (5/мин → ваши)
- CSP домены
- Список разрешённых origins

---

## Спринт 12 — CI/CD и деплой

### Цель
Автоматическая сборка, тесты и деплой.

### CI Pipeline (`.github/workflows/ci.yml`)

```yaml
trigger: push/PR на main, develop

jobs:
  1. lint        — ESLint + TypeScript check
  2. test-unit   — Vitest + coverage upload
  3. build       — Production build (needs: lint, test-unit)
  4. docker      — Docker build + health check (needs: build)
  5. test-e2e    — Playwright chromium (only on main)
  6. ci-success  — Aggregation gate (needs: all above)
```

### CD Pipeline (`.github/workflows/deploy.yml`)

```yaml
trigger: push на main, manual dispatch

jobs:
  1. build-image     — Docker build → push ghcr.io/{owner}/addpilot-frontend:latest
  2. deploy-convex   — npx convex deploy (self-hosted)
  3. trigger-dokploy — Webhook для Dokploy auto-pull
```

### Docker

| Файл | Назначение |
|------|------------|
| `Dockerfile` | Dev образ — Node 20 Alpine, 3-stage build, non-root user |
| `Dockerfile.prod` | Prod образ — с build args для VITE_* переменных |
| `docker-compose.yml` | Frontend + Traefik для aipilot.by |
| `dokploy.yml` | Self-hosted: Convex backend + WebSocket + Dashboard + Frontend |

### Build Args (передаются при сборке Docker)

```
VITE_CONVEX_URL
VITE_REDIRECT_URI
VITE_TELEGRAM_BOT_USERNAME
VITE_CONVEX_SITE_URL
```

### Деплой инфраструктура

```
GitHub → ghcr.io (Docker Registry)
  → Dokploy (self-hosted на 178.172.235.49)
    → Frontend: serve.js на :3000
    → Convex Backend: self-hosted на :3220
    → Traefik: HTTPS + домен aipilot.by
```

### Проверка
- [ ] CI проходит на каждый push/PR
- [ ] Lint + Type Check не ломаются
- [ ] Unit tests проходят
- [ ] Docker образ собирается и health check проходит
- [ ] CD пушит образ в ghcr.io
- [ ] Convex deploy работает
- [ ] Dokploy подхватывает новый образ

### ⚡ ИЗМЕНИТЬ
- Image name в ghcr.io (`addpilot-frontend` → ваш)
- Домен (`aipilot.by` → ваш)
- Convex self-hosted URL и admin key
- Dokploy webhook URL
- Build args — ваши VITE_* переменные
- Repository name в deploy workflow

---

## Спринт 13 — Тестирование

### Цель
Полное покрытие тестами.

### Unit Tests (Vitest)

| Файл | Что тестирует |
|------|---------------|
| `convex/adAccounts.test.ts` | CRUD аккаунтов |
| `convex/authEmail.test.ts` | Email аутентификация |
| `convex/metrics.test.ts` | Расчёт метрик |
| `convex/ruleEngine.test.ts` | Движок правил |
| `convex/rules.test.ts` | CRUD правил |
| `convex/telegram.test.ts` | Telegram интеграция |
| `convex/users.test.ts` | Управление юзерами |
| `convex/vkApi.test.ts` | VK API интеграция |
| `tests/unit/ci-cd.test.ts` | CI/CD конфигурация |
| `tests/unit/ruleEngine.test.ts` | Логика правил |

### Security Tests (Vitest)

| Файл | Что тестирует |
|------|---------------|
| `tests/security/webhook-signature.test.ts` | Защита webhook bePaid + Telegram |
| `tests/security/rate-limiting.test.ts` | Rate limiting |
| `tests/security/audit.test.ts` | Общий аудит |

### E2E Tests (Playwright)

| Файл | Что тестирует |
|------|---------------|
| `tests/e2e/smoke.spec.ts` | Базовый smoke test |
| `tests/e2e/dashboard-login.spec.ts` | Flow логина |
| `tests/e2e/frontend-auth.spec.ts` | Auth states UI |
| `tests/e2e/frontend-convex.spec.ts` | Convex интеграция |
| `tests/e2e/frontend-check.spec.ts` | Проверка UI элементов |
| `tests/e2e/oauth-url-check.spec.ts` | Валидация OAuth URL |
| `tests/e2e/full-journey.spec.ts` | Полный user journey |

### Конфигурация тестов

**Vitest** (`vitest.config.ts`):
- Среда: jsdom
- Coverage threshold: 80%
- Timeout: 30 сек

**Playwright** (`playwright.config.ts`):
- 5 проектов: chromium, firefox, webkit, mobile chrome, mobile safari
- Base URL: http://localhost:5173
- Скриншоты при failure, видео при retry
- Timeout: 60 сек

### Команды

```bash
npm run test          # Все тесты (unit + integration)
npm run test:unit     # Только Vitest
npm run test:e2e      # Только Playwright
npm run test:coverage # Coverage отчёт
```

### Проверка
- [ ] `npm run test:unit` — все тесты зелёные
- [ ] `npm run test:e2e` — smoke test проходит
- [ ] Security тесты проходят
- [ ] Coverage ≥ 80%

### ⚡ ИЗМЕНИТЬ
- Тесты под вашу бизнес-логику
- E2E сценарии под ваши страницы
- Security тесты — проверять ваши endpoints
- Threshold coverage при необходимости

---

## Сводная таблица переменных окружения

### Frontend (VITE_*)

| Переменная | Описание | Пример |
|------------|----------|--------|
| `VITE_CONVEX_URL` | URL Convex deployment | `https://your-project.convex.cloud` |
| `VITE_REDIRECT_URI` | OAuth callback URL | `https://yoursite.com/auth/callback` |
| `VITE_TELEGRAM_BOT_USERNAME` | Username Telegram бота | `your_bot` |
| `VITE_CONVEX_SITE_URL` | URL Convex HTTP actions | `https://your-project.convex.site` |

### Backend (Convex Environment Variables)

| Переменная | Описание | Где получить |
|------------|----------|--------------|
| `BEPAID_SHOP_ID` | ID магазина bePaid | ЛК bePaid → Настройки |
| `BEPAID_SECRET_KEY` | Секретный ключ bePaid | ЛК bePaid → Настройки |
| `BEPAID_TEST_MODE` | Тестовый режим | `true` / `false` |
| `VK_CLIENT_ID` | ID приложения VK | ЛК VK → Приложения |
| `VK_CLIENT_SECRET` | Секрет приложения VK | ЛК VK → Приложения |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram бота | @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Секрет для webhook | Генерировать самостоятельно (32+ символов) |
| `YANDEX_EMAIL` | Email отправителя | Yandex почта |
| `YANDEX_APP_PASSWORD` | Пароль приложения | Yandex → Безопасность |

### CI/CD Secrets (GitHub)

| Secret | Описание |
|--------|----------|
| `VITE_CONVEX_URL` | Convex URL для билда |
| `VITE_REDIRECT_URI` | OAuth callback |
| `VITE_TELEGRAM_BOT_USERNAME` | Telegram bot |
| `VITE_CONVEX_SITE_URL` | Convex HTTP URL |
| `CONVEX_SELF_HOSTED_URL` | URL self-hosted Convex |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | Admin key для deploy |
| `DOKPLOY_WEBHOOK_URL` | Webhook для auto-deploy |

---

## Чеклист адаптации для нового сервиса

### Обязательно заменить

- [ ] **Название проекта** — package.json, index.html, лендинг, meta tags
- [ ] **Домен** — aipilot.by → ваш домен (CSP, CORS, OAuth redirect, Docker)
- [ ] **bePaid credentials** — новый SHOP_ID + SECRET_KEY
- [ ] **OAuth провайдер** — VK ID → ваш (или убрать если не нужен)
- [ ] **Тарифы** — названия, цены, лимиты, фичи
- [ ] **Валюта** — BYN/RUB → ваши валюты
- [ ] **API конвертации** — НБРБ → ваш ЦБ (или убрать если одна валюта)
- [ ] **Admin emails** — список администраторов
- [ ] **Telegram бот** — новый бот или убрать интеграцию
- [ ] **Docker image name** — ghcr.io path
- [ ] **Webhook URL** — зарегистрировать в ЛК bePaid
- [ ] **GitHub Secrets** — все переменные окружения
- [ ] **Dokploy/хостинг** — конфигурация деплоя

### Можно оставить как есть

- [ ] Архитектура (React + Vite + Convex + Tailwind)
- [ ] Структура каталогов
- [ ] Security headers
- [ ] CI/CD pipeline структура
- [ ] Тестовый фреймворк (Vitest + Playwright)
- [ ] Payment flow (bePaid API формат)
- [ ] Webhook verification logic
- [ ] Subscription expiry cron logic
- [ ] Rate limiting implementation
- [ ] Docker multi-stage build

### Можно убрать (если не нужно)

- [ ] VK Ads API интеграция (adAccounts, campaigns, ads, metrics, rules)
- [ ] Mock RUB payment form (если только bePaid)
- [ ] НБРБ конвертация (если одна валюта)
- [ ] Telegram уведомления (если другой канал)
- [ ] Rule engine и автоматизация (специфика AdPilot)

---

## Тестовые карты bePaid

| Карта | Результат |
|-------|-----------|
| `4242 4242 4242 4242` | Успешная оплата |
| `4000 0000 0000 0002` | Отклонённая карта |

> Работают только при `BEPAID_TEST_MODE=true`

---

*Документ создан на основе проекта AddPilot. Актуален на март 2026.*
