# Аудит, мониторинг и админ-уведомления — Design Spec

**Дата:** 2026-04-12
**Статус:** Draft

## Проблема

1. Ошибки VK API, Telegram, синка, токенов логируются в console.log и **теряются**
2. Действия пользователей (подключение кабинета, создание правила, привязка бота) **не трекаются** — если что-то не сработало, никто не узнает
3. Таблица `systemLogs` существует в схеме, но **ни одного insert в коде**
4. Админ не получает уведомлений об оплатах и не может гибко выбирать какие алерты получать
5. Нет дашборда здоровья системы в админке

## Решение

Три слоя:

```
Слой 1: Сбор данных
  auditLog (новая таблица) ← действия пользователей
  systemLogs (существующая) ← ошибки системы

Слой 2: Отображение
  Админка → вкладка "Аудит" (auditLog)
  Админка → вкладка "Здоровье" (systemLogs + агрегация)
  Существующая вкладка "Логи" — без изменений

Слой 3: Уведомления
  Telegram-алерты админу ← настраиваемые по категориям
  TTL-чистка ← крон удаляет старые записи
```

**Существующие таблицы (`actionLogs`, `credentialHistory`, `payments`) не трогаем.**

---

## 1. Таблица `auditLog` (новая)

Трекает все осознанные действия пользователей — успешные и неуспешные.

### Схема

```typescript
auditLog: defineTable({
  userId: v.id("users"),
  category: v.union(
    v.literal("account"),      // подключение/отключение кабинетов
    v.literal("rule"),         // создание/изменение/удаление правил
    v.literal("payment"),      // оплаты
    v.literal("telegram"),     // привязка/отвязка бота
    v.literal("settings"),     // изменение настроек
    v.literal("auth"),         // вход/выход/переавторизация
    v.literal("admin"),        // действия админа
  ),
  action: v.string(),          // connect_success, connect_failed, rule_created, etc.
  status: v.union(v.literal("success"), v.literal("failed")),
  details: v.optional(v.any()), // { accountName, tier, amount, errorMessage, ... }
  createdAt: v.number(),
})
  .index("by_userId_createdAt", ["userId", "createdAt"])
  .index("by_category_createdAt", ["category", "createdAt"])
  .index("by_createdAt", ["createdAt"])
```

### Какие действия логируются

| Категория | action | Когда |
|-----------|--------|-------|
| `account` | `connect_success` | Кабинет успешно подключён |
| `account` | `connect_failed` | Ошибка при подключении (невалидный токен, API ошибка) |
| `account` | `disconnect` | Кабинет отключён пользователем |
| `account` | `token_refresh_success` | Токен успешно обновлён |
| `account` | `token_refresh_failed` | Не удалось обновить токен |
| `rule` | `rule_created` | Правило создано |
| `rule` | `rule_updated` | Правило изменено |
| `rule` | `rule_deleted` | Правило удалено |
| `rule` | `rule_toggled` | Правило вкл/выкл |
| `payment` | `payment_started` | Пользователь начал оплату |
| `payment` | `payment_completed` | Оплата прошла |
| `payment` | `payment_failed` | Оплата не прошла |
| `telegram` | `bot_connected` | Бот привязан |
| `telegram` | `bot_connect_failed` | Ошибка привязки бота |
| `telegram` | `bot_disconnected` | Бот отвязан |
| `settings` | `settings_updated` | Настройки изменены |
| `auth` | `login` | Вход в систему |
| `auth` | `login_failed` | Неудачный вход |
| `auth` | `vk_reauth` | Переавторизация VK |
| `admin` | `tier_changed` | Админ изменил тариф юзера |
| `admin` | `expiry_changed` | Админ изменил срок подписки |
| `admin` | `admin_toggled` | Админ дал/забрал права |
| `admin` | `broadcast_sent` | Админ отправил рассылку |

### Хелпер

```typescript
// convex/auditLog.ts
export const log = internalMutation({
  args: {
    userId: v.id("users"),
    category: v.string(),
    action: v.string(),
    status: v.union(v.literal("success"), v.literal("failed")),
    details: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auditLog", {
      ...args,
      category: args.category as any,
      createdAt: Date.now(),
    });
  },
});
```

Вызов из любой функции:
```typescript
await ctx.runMutation(internal.auditLog.log, {
  userId,
  category: "account",
  action: "connect_success",
  status: "success",
  details: { accountName: "Витамин", vkAccountId: "12345" },
});
```

---

## 2. Активация `systemLogs`

Таблица уже существует. Добавляем хелпер и расставляем вызовы по catch-блокам.

### Хелпер

```typescript
// convex/systemLogger.ts
export const log = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    accountId: v.optional(v.id("adAccounts")),
    level: v.union(v.literal("error"), v.literal("warn"), v.literal("info")),
    source: v.string(),
    message: v.string(),
    details: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("systemLogs", {
      ...args,
      createdAt: Date.now(),
    });
  },
});
```

### Где расставляем

| Файл | Что логируем | level |
|------|-------------|-------|
| `convex/syncMetrics.ts` | VK API ошибки при синке | error |
| `convex/syncMetrics.ts` | Успешный синк (summary) | info (опционально, по флагу) |
| `convex/ruleEngine.ts` | Ошибка при проверке правила | error |
| `convex/telegram.ts` | Ошибка отправки сообщения | error |
| `convex/auth.ts` | Ошибка рефреша токена | error |
| `convex/billing.ts` | Ошибка webhook обработки | error |
| `convex/vkApi.ts` | Финальная ошибка после 3 retry | error |
| `convex/adAccounts.ts` | Ошибка проверки токена агентства | warn |
| `convex/tokenRecovery.ts` | Каскад восстановления — результат | error/info |

**Важно:** логируем только финальные ошибки (после всех retry), не каждую попытку. Это ключевое для нагрузки.

---

## 3. Админ-уведомления с гибкими настройками

### Таблица `adminAlertSettings`

```typescript
adminAlertSettings: defineTable({
  userId: v.id("users"),  // админ
  payments: v.boolean(),           // оплаты
  criticalErrors: v.boolean(),     // критические ошибки (токен протух, синк полностью упал)
  accountConnections: v.boolean(), // подключения/отключения кабинетов
  newUsers: v.boolean(),           // регистрация новых юзеров
  ruleErrors: v.boolean(),         // ошибки при работе правил
  updatedAt: v.number(),
})
  .index("by_userId", ["userId"])
```

### UI в админке

В существующей вкладке **«Инструменты»** добавляем секцию **«Уведомления»** (как PromoCodesSection, BroadcastSection и т.д.):

```
┌─────────────────────────────────────────┐
│ 🔔 Уведомления                         │
│                                         │
│ Получать в Telegram:                    │
│                                         │
│ ☑ Оплаты              (вкл/выкл)       │
│ ☑ Критические ошибки   (вкл/выкл)       │
│ ☐ Подключения кабинетов (вкл/выкл)      │
│ ☐ Новые пользователи   (вкл/выкл)       │
│ ☐ Ошибки правил        (вкл/выкл)       │
│                                         │
│ [Сохранить]                             │
└─────────────────────────────────────────┘
```

Каждый toggle — отдельная категория. По умолчанию всё выключено (opt-in).

### Логика отправки

```typescript
// convex/adminAlerts.ts
export const notify = internalAction({
  args: {
    category: v.string(), // "payments" | "criticalErrors" | "accountConnections" | ...
    text: v.string(),     // HTML-formatted message
  },
  handler: async (ctx, args) => {
    // 1. Получить всех админов с включённой категорией
    const settings = await ctx.runQuery(internal.adminAlerts.getEnabledAdmins, {
      category: args.category,
    });

    // 2. Для каждого — отправить Telegram
    for (const s of settings) {
      const user = await ctx.runQuery(internal.adminAlerts.getAdminUser, { userId: s.userId });
      if (user?.telegramChatId) {
        await ctx.runAction(internal.telegram.sendMessage, {
          chatId: user.telegramChatId,
          text: args.text,
        });
      }
    }
  },
});
```

### Пример сообщения об оплате

```
💰 Оплата

Пользователь: Иван Петров
Тариф: Pro
Сумма: 29.00 BYN
Промокод: SPRING20 (−20%)
Реферал: —
Дата: 12.04.2026 14:35

Всего активных подписок: 12
```

### Пример критической ошибки

```
🚨 Критическая ошибка

Источник: syncMetrics
Аккаунт: Витамин (id: 12345)
Ошибка: VK API 401 — TOKEN_EXPIRED
Время: 12.04.2026 14:35

Токен аккаунта истёк. Автоматическое восстановление не удалось.
```

### Дедупликация

Чтобы не спамить одну и ту же ошибку:
- Перед отправкой проверяем: была ли отправка по этому `source + message` за последние 30 минут?
- Если да — пропускаем
- Реализация: поле `lastAlertKey` + `lastAlertAt` в `adminAlertSettings`, или отдельная мини-таблица `adminAlertDedup`

```typescript
adminAlertDedup: defineTable({
  key: v.string(),        // hash: "syncMetrics:TOKEN_EXPIRED:accountId"
  lastSentAt: v.number(),
})
  .index("by_key", ["key"])
```

---

## 4. Дашборд здоровья (новая вкладка в админке)

### Вкладка «Здоровье»

Считается на лету при открытии (без фонового крона — минимальная нагрузка).

```
┌──────────────────────────────────────────────────────┐
│ 🏥 Здоровье системы                                  │
│                                                      │
│ ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ │
│ │ Ошибки  │ │ Предупр. │ │ Синк     │ │ Telegram  │ │
│ │ за 24ч  │ │ за 24ч   │ │ статус   │ │ статус    │ │
│ │   3     │ │   7      │ │  ✅ ОК   │ │  ✅ ОК    │ │
│ └─────────┘ └──────────┘ └──────────┘ └───────────┘ │
│                                                      │
│ Последние ошибки:                                    │
│ ┌────────────────────────────────────────────────┐   │
│ │ 14:35  syncMetrics  TOKEN_EXPIRED  Витамин     │   │
│ │ 13:20  telegram     HTTP 403       user:abc    │   │
│ │ 12:05  ruleEngine   timeout        rule:xyz    │   │
│ └────────────────────────────────────────────────┘   │
│                                                      │
│ Фильтры: [level ▾] [source ▾] [24ч | 7д | 30д]     │
└──────────────────────────────────────────────────────┘
```

### Бэкенд-запросы

```typescript
// convex/adminHealth.ts

// Агрегация ошибок за период
export const getHealthSummary = query({
  args: { sessionToken: v.string(), hours: v.number() },
  handler: async (ctx, args) => {
    assertAdmin(ctx, args.sessionToken);
    const since = Date.now() - args.hours * 60 * 60 * 1000;

    const errors = await ctx.db
      .query("systemLogs")
      .withIndex("by_level_createdAt", q => q.eq("level", "error").gte("createdAt", since))
      .collect();

    const warnings = await ctx.db
      .query("systemLogs")
      .withIndex("by_level_createdAt", q => q.eq("level", "warn").gte("createdAt", since))
      .collect();

    // Группировка по source
    const bySource = {};
    for (const e of errors) {
      bySource[e.source] = (bySource[e.source] || 0) + 1;
    }

    return {
      errorCount: errors.length,
      warningCount: warnings.length,
      bySource,
      recentErrors: errors.slice(0, 20),
    };
  },
});

// Список systemLogs с фильтрами
export const getSystemLogs = query({
  args: {
    sessionToken: v.string(),
    level: v.optional(v.string()),
    source: v.optional(v.string()),
    hours: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => { ... },
});
```

---

## 5. TTL-чистка

Крон раз в сутки удаляет старые записи.

### Сроки хранения

| Таблица | TTL | Обоснование |
|---------|-----|-------------|
| `systemLogs` | 30 дней | Ошибки старше месяца неактуальны |
| `auditLog` | 90 дней | История действий нужна дольше |
| `adminAlertDedup` | 1 день | Техническая таблица |

### Реализация

```typescript
// convex/logCleanup.ts
export const cleanupOldLogs = internalMutation({
  handler: async (ctx) => {
    const now = Date.now();

    // systemLogs: 30 дней
    const sysExpiry = now - 30 * 24 * 60 * 60 * 1000;
    const oldSys = await ctx.db
      .query("systemLogs")
      .withIndex("by_createdAt", q => q.lt("createdAt", sysExpiry))
      .take(500); // пачками, чтобы не перегружать
    for (const doc of oldSys) await ctx.db.delete(doc._id);

    // auditLog: 90 дней
    const auditExpiry = now - 90 * 24 * 60 * 60 * 1000;
    const oldAudit = await ctx.db
      .query("auditLog")
      .withIndex("by_createdAt", q => q.lt("createdAt", auditExpiry))
      .take(500);
    for (const doc of oldAudit) await ctx.db.delete(doc._id);

    // adminAlertDedup: 1 день
    const dedupExpiry = now - 24 * 60 * 60 * 1000;
    const oldDedup = await ctx.db
      .query("adminAlertDedup")
      .withIndex("by_key") // scan all
      .collect();
    for (const doc of oldDedup) {
      if (doc.lastSentAt < dedupExpiry) await ctx.db.delete(doc._id);
    }
  },
});
```

### Крон

```typescript
// в crons.ts
crons.cron(
  "cleanup-old-logs",
  "0 2 * * *",  // 02:00 UTC ежедневно
  internal.logCleanup.cleanupOldLogs
);
```

---

## 6. Вкладка «Аудит» в админке

### UI

```
┌──────────────────────────────────────────────────────────┐
│ 📋 Аудит действий                                        │
│                                                          │
│ Фильтры: [Категория ▾] [Статус ▾] [Юзер 🔍] [Период ▾] │
│                                                          │
│ ┌─────────┬──────────┬────────────┬────────┬──────────┐  │
│ │ Время   │ Юзер     │ Действие   │ Статус │ Детали   │  │
│ ├─────────┼──────────┼────────────┼────────┼──────────┤  │
│ │ 14:35   │ Иван П.  │ Оплата Pro │  ✅    │ 29 BYN   │  │
│ │ 14:20   │ Мария С. │ Подкл. каб │  ❌    │ 401 err  │  │
│ │ 13:50   │ Иван П.  │ Правило    │  ✅    │ CPL > 50 │  │
│ │ 13:15   │ Алексей  │ Привязка   │  ✅    │ Telegram │  │
│ └─────────┴──────────┴────────────┴────────┴──────────┘  │
│                                                          │
│ Показано 20 из 156  [← Назад] [Далее →]                 │
└──────────────────────────────────────────────────────────┘
```

### Бэкенд

```typescript
// convex/adminAudit.ts
export const getAuditLogs = query({
  args: {
    sessionToken: v.string(),
    category: v.optional(v.string()),
    status: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    hours: v.optional(v.number()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertAdmin(...);
    // Выборка по индексам с фильтрацией
    // Пагинация через cursor
  },
});
```

---

## 7. Точки интеграции (где расставляем логирование)

### auditLog — действия пользователей

| Файл | Функция | Что логируем |
|------|---------|-------------|
| `convex/adAccounts.ts` | `connectAccount` | account / connect_success или connect_failed |
| `convex/adAccounts.ts` | `disconnectAccount` | account / disconnect |
| `convex/rules.ts` | `create` | rule / rule_created |
| `convex/rules.ts` | `update` | rule / rule_updated |
| `convex/rules.ts` | `deleteRule` | rule / rule_deleted |
| `convex/rules.ts` | `toggleActive` | rule / rule_toggled |
| `convex/billing.ts` | `createBepaidCheckout` | payment / payment_started |
| `convex/billing.ts` | `handleBepaidWebhook` | payment / payment_completed или payment_failed |
| `convex/telegram.ts` | обработка `/start` с токеном | telegram / bot_connected или bot_connect_failed |
| `convex/telegram.ts` | команда отвязки | telegram / bot_disconnected |
| `convex/authEmail.ts` | `login` | auth / login или login_failed |
| `convex/auth.ts` | VK OAuth callback | auth / login или vk_reauth |
| `convex/admin.ts` | `updateUserTier` | admin / tier_changed |
| `convex/admin.ts` | `updateUserExpiry` | admin / expiry_changed |
| `convex/admin.ts` | `toggleAdmin` | admin / admin_toggled |
| `convex/admin.ts` | `broadcastTelegram` | admin / broadcast_sent |

### systemLogs — ошибки системы

| Файл | Где именно | source |
|------|-----------|--------|
| `convex/vkApi.ts` | после 3 неудачных retry | `vkApi` |
| `convex/syncMetrics.ts` | catch в syncAll / syncAccount | `syncMetrics` |
| `convex/ruleEngine.ts` | catch при evaluateCondition | `ruleEngine` |
| `convex/telegram.ts` | catch при sendMessage | `telegram` |
| `convex/auth.ts` | catch при refreshToken | `auth` |
| `convex/billing.ts` | catch в webhook handler | `billing` |
| `convex/tokenRecovery.ts` | финальный результат каскада | `tokenRecovery` |
| `convex/adAccounts.ts` | checkAgencyTokenHealth ошибки | `agencyToken` |

### adminAlerts — Telegram уведомления админу

| Событие | Категория настройки | Когда отправляем |
|---------|-------------------|-----------------|
| Оплата прошла | `payments` | После payment_completed |
| Оплата не прошла | `payments` | После payment_failed |
| TOKEN_EXPIRED | `criticalErrors` | После финальной ошибки vkApi |
| Синк полностью упал | `criticalErrors` | Все аккаунты юзера в ошибке |
| Telegram не отправляется | `criticalErrors` | 3 неудачных попытки подряд |
| Кабинет подключён/отключён | `accountConnections` | После connect_success / disconnect |
| Кабинет не подключился | `accountConnections` | После connect_failed |
| Новый юзер | `newUsers` | После первого login |
| Правило упало при проверке | `ruleErrors` | После ошибки в ruleEngine |

---

## 8. Нагрузка

| Компонент | Записей/день (при ~50 юзерах) | Тип нагрузки |
|-----------|-------------------------------|-------------|
| `auditLog` | 20–100 (ручные действия) | Запись: пренебрежимо |
| `systemLogs` | 0–50 (только ошибки) | Запись: пренебрежимо |
| `adminAlertDedup` | 0–20 | Запись: пренебрежимо |
| Дашборд здоровья | 1 запрос при открытии | Чтение: пренебрежимо |
| Аудит-таблица | 1 запрос при открытии | Чтение: пренебрежимо |
| TTL-чистка | 1 раз/сутки, до 500 записей | Запись: лёгкая |
| Telegram-алерты | 0–10 HTTP-запросов/день | Сеть: пренебрежимо |

**Итого:** незаметно на фоне синка метрик (сотни VK API запросов каждые 5 минут).

---

## 9. Новые файлы

| Файл | Назначение |
|------|-----------|
| `convex/auditLog.ts` | Хелпер `log` — запись в auditLog |
| `convex/systemLogger.ts` | Хелпер `log` — запись в systemLogs |
| `convex/adminAlerts.ts` | Отправка Telegram-уведомлений админам по настройкам |
| `convex/adminAudit.ts` | Запросы для вкладки Аудит (getAuditLogs) |
| `convex/adminHealth.ts` | Запросы для дашборда здоровья (getHealthSummary, getSystemLogs) |
| `convex/logCleanup.ts` | TTL-чистка старых записей |
| `src/pages/admin/AdminAuditTab.tsx` | Вкладка «Аудит» в админке |
| `src/pages/admin/AdminHealthTab.tsx` | Вкладка «Здоровье» в админке |
| `src/components/admin/AlertSettingsSection.tsx` | Секция настроек уведомлений в «Инструменты» |

---

## 10. Изменения в существующих файлах

| Файл | Изменение |
|------|----------|
| `convex/schema.ts` | Добавить таблицы: `auditLog`, `adminAlertSettings`, `adminAlertDedup` |
| `convex/crons.ts` | Добавить крон `cleanup-old-logs` |
| `convex/billing.ts` | Добавить auditLog + adminAlert при оплате |
| `convex/adAccounts.ts` | Добавить auditLog при подключении/отключении |
| `convex/rules.ts` | Добавить auditLog при CRUD правил |
| `convex/telegram.ts` | Добавить auditLog привязки бота + systemLog ошибок |
| `convex/auth.ts` | Добавить auditLog входа + systemLog ошибок |
| `convex/authEmail.ts` | Добавить auditLog входа |
| `convex/admin.ts` | Добавить auditLog действий админа |
| `convex/syncMetrics.ts` | Добавить systemLog ошибок |
| `convex/ruleEngine.ts` | Добавить systemLog ошибок |
| `convex/vkApi.ts` | Добавить systemLog после финального retry failure |
| `convex/tokenRecovery.ts` | Добавить systemLog результата каскада |
| `src/pages/admin/AdminPage.tsx` | Добавить вкладки «Аудит» и «Здоровье» |
| `src/pages/admin/AdminToolsTab.tsx` | Добавить секцию «Уведомления» |

---

## 11. Порядок реализации

1. **Схема** — новые таблицы в schema.ts
2. **Хелперы** — auditLog.ts, systemLogger.ts, adminAlerts.ts
3. **Расстановка systemLogs** — catch-блоки в vkApi, syncMetrics, ruleEngine, telegram, auth, billing
4. **Расстановка auditLog** — CRUD функции в adAccounts, rules, billing, telegram, auth, admin
5. **Админ-уведомления** — adminAlertSettings + UI toggle + отправка при событиях
6. **TTL-чистка** — logCleanup.ts + крон
7. **Вкладка «Здоровье»** — adminHealth.ts + AdminHealthTab.tsx
8. **Вкладка «Аудит»** — adminAudit.ts + AdminAuditTab.tsx
9. **Тесты** — юнит-тесты хелперов + E2E проверка вкладок
