# Аудит, мониторинг и админ-уведомления — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полная система аудита действий пользователей, логирования ошибок, гибких Telegram-уведомлений админу и дашборда здоровья.

**Architecture:** Две новые таблицы (`auditLog`, `adminAlertSettings` + `adminAlertDedup`), активация существующей `systemLogs`. Хелперы `auditLog.ts` и `systemLogger.ts` для записи. `adminAlerts.ts` для отправки уведомлений по настройкам. Две новые вкладки в админке (Аудит, Здоровье) + секция уведомлений в Инструментах.

**Tech Stack:** Convex (query/mutation/action/internalMutation), React, Tailwind, lucide-react

**Spec:** `docs/superpowers/specs/2026-04-12-audit-monitoring-design.md`

---

## Task 1: Схема — новые таблицы

**Files:**
- Modify: `convex/schema.ts:720` (перед закрывающей `}`)

- [ ] **Step 1: Добавить таблицы auditLog, adminAlertSettings, adminAlertDedup в schema.ts**

Вставить перед строкой 721 (`}, { schemaValidation: false });`):

```typescript
  // Audit log — все действия пользователей (успех + провал)
  auditLog: defineTable({
    userId: v.id("users"),
    category: v.union(
      v.literal("account"),
      v.literal("rule"),
      v.literal("payment"),
      v.literal("telegram"),
      v.literal("settings"),
      v.literal("auth"),
      v.literal("admin"),
    ),
    action: v.string(),
    status: v.union(v.literal("success"), v.literal("failed")),
    details: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_userId_createdAt", ["userId", "createdAt"])
    .index("by_category_createdAt", ["category", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // Настройки Telegram-уведомлений для админов
  adminAlertSettings: defineTable({
    userId: v.id("users"),
    payments: v.boolean(),
    criticalErrors: v.boolean(),
    accountConnections: v.boolean(),
    newUsers: v.boolean(),
    ruleErrors: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"]),

  // Дедупликация алертов (не спамить одну ошибку)
  adminAlertDedup: defineTable({
    key: v.string(),
    lastSentAt: v.number(),
  })
    .index("by_key", ["key"]),
```

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS (без ошибок)

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(audit): добавить таблицы auditLog, adminAlertSettings, adminAlertDedup"
```

---

## Task 2: Хелпер systemLogger.ts

**Files:**
- Create: `convex/systemLogger.ts`

- [ ] **Step 1: Создать convex/systemLogger.ts**

```typescript
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// ─── Запись системного лога ───

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
    // Обрезаем details если слишком большой (защита от bloat)
    let details = args.details;
    if (details) {
      const str = JSON.stringify(details);
      if (str.length > 50000) {
        details = { truncated: true, preview: str.slice(0, 500) };
      }
    }

    await ctx.db.insert("systemLogs", {
      userId: args.userId,
      accountId: args.accountId,
      level: args.level,
      source: args.source,
      message: args.message,
      details,
      createdAt: Date.now(),
    });
  },
});

// ─── Запросы для админки ───

export const getRecentByLevel = internalQuery({
  args: {
    level: v.union(v.literal("error"), v.literal("warn"), v.literal("info")),
    since: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("systemLogs")
      .withIndex("by_level_createdAt", (q) =>
        q.eq("level", args.level).gte("createdAt", args.since)
      )
      .order("desc")
      .take(args.limit);
  },
});

export const getRecent = internalQuery({
  args: { since: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("systemLogs")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", args.since))
      .order("desc")
      .take(args.limit);
  },
});

// ─── TTL-чистка (30 дней) ───

export const cleanupOld = internalMutation({
  handler: async (ctx) => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("systemLogs")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", thirtyDaysAgo))
      .take(500);
    for (const doc of old) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: old.length };
  },
});
```

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/systemLogger.ts
git commit -m "feat(audit): хелпер systemLogger для записи в systemLogs"
```

---

## Task 3: Хелпер auditLog.ts

**Files:**
- Create: `convex/auditLog.ts`

- [ ] **Step 1: Создать convex/auditLog.ts**

```typescript
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

// ─── Типы ───

export const AUDIT_CATEGORIES = [
  "account", "rule", "payment", "telegram", "settings", "auth", "admin",
] as const;

// ─── Запись аудит-лога ───

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
      userId: args.userId,
      category: args.category as typeof AUDIT_CATEGORIES[number],
      action: args.action,
      status: args.status,
      details: args.details,
      createdAt: Date.now(),
    });
  },
});

// ─── Запросы для админки ───

export const list = query({
  args: {
    sessionToken: v.string(),
    category: v.optional(v.string()),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Проверка админа — импортируем inline чтобы не создавать циклических зависимостей
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.sessionToken))
      .first();
    if (!session) throw new Error("Не авторизован");
    const user = await ctx.db.get(session.userId);
    const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];
    if (!user || (!user.isAdmin && !ADMIN_EMAILS.includes(user.email))) {
      throw new Error("Нет прав");
    }

    const since = args.since ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
    const limit = args.limit ?? 100;

    let logs;
    if (args.category) {
      logs = await ctx.db
        .query("auditLog")
        .withIndex("by_category_createdAt", (q) =>
          q.eq("category", args.category as typeof AUDIT_CATEGORIES[number]).gte("createdAt", since)
        )
        .order("desc")
        .take(limit);
    } else {
      logs = await ctx.db
        .query("auditLog")
        .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
        .order("desc")
        .take(limit);
    }

    // Обогащаем именами пользователей
    const userIds = [...new Set(logs.map((l) => l.userId))];
    const users = await Promise.all(userIds.map((id) => ctx.db.get(id)));
    const userMap = new Map(users.filter(Boolean).map((u) => [u!._id, u!]));

    return logs.map((log) => ({
      ...log,
      userName: userMap.get(log.userId)?.name ?? "—",
      userEmail: userMap.get(log.userId)?.email ?? "—",
    }));
  },
});

// ─── TTL-чистка (90 дней) ───

export const cleanupOld = internalMutation({
  handler: async (ctx) => {
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("auditLog")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", ninetyDaysAgo))
      .take(500);
    for (const doc of old) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: old.length };
  },
});
```

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/auditLog.ts
git commit -m "feat(audit): хелпер auditLog для записи действий пользователей"
```

---

## Task 4: Админ-уведомления — adminAlerts.ts

**Files:**
- Create: `convex/adminAlerts.ts`

- [ ] **Step 1: Создать convex/adminAlerts.ts**

```typescript
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";

const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 минут

// ─── Категории уведомлений ───

type AlertCategory = "payments" | "criticalErrors" | "accountConnections" | "newUsers" | "ruleErrors";

// ─── Получить настройки админа ───

export const getSettings = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.sessionToken))
      .first();
    if (!session) return null;
    const user = await ctx.db.get(session.userId);
    if (!user || (!user.isAdmin && !ADMIN_EMAILS.includes(user.email))) return null;

    const settings = await ctx.db
      .query("adminAlertSettings")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .first();

    return settings ?? {
      payments: false,
      criticalErrors: false,
      accountConnections: false,
      newUsers: false,
      ruleErrors: false,
    };
  },
});

// ─── Сохранить настройки ───

export const saveSettings = mutation({
  args: {
    sessionToken: v.string(),
    payments: v.boolean(),
    criticalErrors: v.boolean(),
    accountConnections: v.boolean(),
    newUsers: v.boolean(),
    ruleErrors: v.boolean(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.sessionToken))
      .first();
    if (!session) throw new Error("Не авторизован");
    const user = await ctx.db.get(session.userId);
    if (!user || (!user.isAdmin && !ADMIN_EMAILS.includes(user.email))) {
      throw new Error("Нет прав");
    }

    const existing = await ctx.db
      .query("adminAlertSettings")
      .withIndex("by_userId", (q) => q.eq("userId", session.userId))
      .first();

    const data = {
      userId: session.userId,
      payments: args.payments,
      criticalErrors: args.criticalErrors,
      accountConnections: args.accountConnections,
      newUsers: args.newUsers,
      ruleErrors: args.ruleErrors,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
    } else {
      await ctx.db.insert("adminAlertSettings", data);
    }
  },
});

// ─── Получить всех админов с включённой категорией ───

export const getEnabledAdmins = internalQuery({
  args: { category: v.string() },
  handler: async (ctx, args) => {
    const allSettings = await ctx.db.query("adminAlertSettings").collect();
    return allSettings.filter(
      (s) => s[args.category as AlertCategory] === true
    );
  },
});

// ─── Проверка дедупликации ───

export const checkDedup = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("adminAlertDedup")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    const now = Date.now();

    if (existing && now - existing.lastSentAt < DEDUP_WINDOW_MS) {
      return false; // Не отправлять — дубликат
    }

    if (existing) {
      await ctx.db.patch(existing._id, { lastSentAt: now });
    } else {
      await ctx.db.insert("adminAlertDedup", { key: args.key, lastSentAt: now });
    }
    return true; // Можно отправлять
  },
});

// ─── Отправка уведомления админам ───

export const notify = internalAction({
  args: {
    category: v.string(),
    dedupKey: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    // Дедупликация
    if (args.dedupKey) {
      const canSend = await ctx.runMutation(internal.adminAlerts.checkDedup, {
        key: args.dedupKey,
      });
      if (!canSend) return;
    }

    // Получить админов с включённой категорией
    const settings = await ctx.runQuery(internal.adminAlerts.getEnabledAdmins, {
      category: args.category,
    });

    for (const s of settings) {
      const user = await ctx.runQuery(internal.adminAlerts.getAdminUser, {
        userId: s.userId,
      });
      if (user?.telegramChatId) {
        try {
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId: user.telegramChatId,
            text: args.text,
          });
        } catch {
          // Не падаем если Telegram недоступен
        }
      }
    }
  },
});

// ─── Получить юзера для отправки ───

export const getAdminUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});

// ─── TTL-чистка dedup (1 день) ───

export const cleanupDedup = internalMutation({
  handler: async (ctx) => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const old = await ctx.db.query("adminAlertDedup").collect();
    let deleted = 0;
    for (const doc of old) {
      if (doc.lastSentAt < oneDayAgo) {
        await ctx.db.delete(doc._id);
        deleted++;
      }
    }
    return { deleted };
  },
});
```

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/adminAlerts.ts
git commit -m "feat(audit): adminAlerts — гибкие Telegram-уведомления админу по категориям"
```

---

## Task 5: TTL-чистка — logCleanup.ts + крон

**Files:**
- Create: `convex/logCleanup.ts`
- Modify: `convex/crons.ts:140` (перед `export default`)

- [ ] **Step 1: Создать convex/logCleanup.ts**

```typescript
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Ежедневная очистка старых логов.
 * systemLogs: 30 дней, auditLog: 90 дней, adminAlertDedup: 1 день.
 */
export const runDaily = internalMutation({
  handler: async (ctx) => {
    // Делегируем каждому модулю свою чистку
    const sys = await ctx.runMutation(internal.systemLogger.cleanupOld);
    const audit = await ctx.runMutation(internal.auditLog.cleanupOld);
    const dedup = await ctx.runMutation(internal.adminAlerts.cleanupDedup);

    console.log(
      `[logCleanup] systemLogs: ${sys.deleted}, auditLog: ${audit.deleted}, dedup: ${dedup.deleted}`
    );
  },
});
```

- [ ] **Step 2: Добавить крон в crons.ts**

В `convex/crons.ts` перед строкой `export default crons;` (строка 141) добавить:

```typescript
// Clean up old audit/system logs — daily at 02:00 UTC
crons.cron(
  "cleanup-old-logs",
  "0 2 * * *",
  internal.logCleanup.runDaily
);
```

- [ ] **Step 3: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add convex/logCleanup.ts convex/crons.ts
git commit -m "feat(audit): TTL-чистка логов — systemLogs 30д, auditLog 90д, dedup 1д"
```

---

## Task 6: Расстановка systemLogs по catch-блокам

**Files:**
- Modify: `convex/vkApi.ts` — финальная ошибка после retry
- Modify: `convex/syncMetrics.ts` — catch в syncAll / syncAccount
- Modify: `convex/ruleEngine.ts` — catch при проверке правил
- Modify: `convex/telegram.ts` — catch при отправке сообщений
- Modify: `convex/auth.ts` — catch при рефреше токенов
- Modify: `convex/billing.ts` — catch в webhook
- Modify: `convex/tokenRecovery.ts` — результат каскада

Это самый объёмный таск. Для каждого файла:

1. Найти все catch-блоки с `console.log`/`console.error` или где ошибка просто выбрасывается
2. Добавить `await ctx.runMutation(internal.systemLogger.log, { ... })` перед throw/return
3. Не менять логику — только добавить запись

**Общий паттерн вставки:**

```typescript
// В каждом catch-блоке ПЕРЕД throw или return error:
await ctx.runMutation(internal.systemLogger.log, {
  userId: userId,           // если доступен
  accountId: accountId,     // если доступен
  level: "error",           // или "warn" для некритичных
  source: "moduleName.functionName",
  message: `Краткое описание: ${err instanceof Error ? err.message : String(err)}`,
  details: { /* контекст ошибки */ },
});
```

**Важно:**
- В `vkApi.ts` функция `callMtApi` — это обычная async функция (не Convex mutation), поэтому в ней **нельзя** вызвать `ctx.runMutation`. Логирование VK API ошибок нужно делать на уровне вызывающих функций (syncMetrics, ruleEngine и т.д.), которые являются Convex action/mutation.
- Логируем только финальные ошибки (после всех retry), не каждую попытку
- Не логируем `info`-уровень при синке (слишком часто, каждые 5 мин)
- Добавить `import { internal } from "./_generated/api"` если ещё нет

- [ ] **Step 1: syncMetrics.ts — добавить systemLog в catch блоки syncAll и syncAccount**

В функции `syncAll` / отдельные `syncAccount`:
- Найти все `catch (err)` блоки
- Добавить `await ctx.runMutation(internal.systemLogger.log, { ... })` с level `"error"`, source `"syncMetrics"`, и деталями (accountId, accountName, error message)

- [ ] **Step 2: ruleEngine.ts — добавить systemLog при ошибках проверки правил**

В функции `checkAllRules` / `evaluateRule`:
- Найти catch-блоки
- Добавить systemLog с level `"error"`, source `"ruleEngine"`, details: ruleId, adId, error

Также: при `status: "failed"` в createActionLog — отправить admin alert:
```typescript
if (args.status === "failed") {
  await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
    category: "ruleErrors",
    dedupKey: `ruleEngine:${args.ruleId}:${args.adId}`,
    text: `⚠️ <b>Ошибка правила</b>\n\nПравило: ${args.reason}\nОбъявление: ${args.adName}\nОшибка: ${args.errorMessage ?? "неизвестно"}`,
  });
}
```

- [ ] **Step 3: telegram.ts — добавить systemLog при ошибках отправки**

В функциях `sendMessage`, `sendMessageWithRetry`:
- В catch-блоках добавить systemLog с level `"error"`, source `"telegram"`, details: chatId (masked), error

- [ ] **Step 4: auth.ts — добавить systemLog при ошибках рефреша**

В функциях `refreshVkToken`, `proactiveTokenRefresh`:
- В catch-блоках добавить systemLog с level `"error"`, source `"auth"`, details: userId, error

- [ ] **Step 5: billing.ts — добавить systemLog в webhook обработке**

В `handleBepaidWebhook`:
- При `status !== "successful"`: systemLog level `"warn"`, source `"billing"`, details: orderId, status, message
- При ошибках обработки: systemLog level `"error"`

- [ ] **Step 6: tokenRecovery.ts — добавить systemLog при результате каскада**

- При успешном восстановлении: systemLog level `"info"`, source `"tokenRecovery"`
- При неудаче: systemLog level `"error"`, source `"tokenRecovery"`, details: accountId, attempts, error

- [ ] **Step 7: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add convex/syncMetrics.ts convex/ruleEngine.ts convex/telegram.ts convex/auth.ts convex/billing.ts convex/tokenRecovery.ts
git commit -m "feat(audit): расстановка systemLogs по catch-блокам (6 файлов)"
```

---

## Task 7: Расстановка auditLog по действиям пользователей

**Files:**
- Modify: `convex/adAccounts.ts` — подключение/отключение кабинетов
- Modify: `convex/rules.ts` — CRUD правил
- Modify: `convex/billing.ts` — оплаты
- Modify: `convex/telegram.ts` — привязка/отвязка бота
- Modify: `convex/authEmail.ts` — вход по email
- Modify: `convex/auth.ts` — VK OAuth вход
- Modify: `convex/admin.ts` — действия админа

**Общий паттерн:**

```typescript
// После успешного действия:
await ctx.runMutation(internal.auditLog.log, {
  userId,
  category: "account",
  action: "connect_success",
  status: "success",
  details: { accountName, vkAccountId },
});

// В catch-блоке:
await ctx.runMutation(internal.auditLog.log, {
  userId,
  category: "account",
  action: "connect_failed",
  status: "failed",
  details: { error: err.message },
});
```

- [ ] **Step 1: adAccounts.ts — логировать подключение/отключение кабинетов**

| Функция | action | status |
|---------|--------|--------|
| connectAccount (успех) | `connect_success` | `success` |
| connectAccount (ошибка) | `connect_failed` | `failed` |
| disconnectAccount | `disconnect` | `success` |

- [ ] **Step 2: rules.ts — логировать CRUD правил**

| Функция | action | status |
|---------|--------|--------|
| create | `rule_created` | `success` |
| update | `rule_updated` | `success` |
| deleteRule | `rule_deleted` | `success` |
| toggleActive | `rule_toggled` | `success` |

details: `{ ruleName, ruleType, isActive }`

- [ ] **Step 3: billing.ts — логировать оплаты + отправить admin alert**

В `handleBepaidWebhook`:

При `status === "successful"`:
```typescript
await ctx.runMutation(internal.auditLog.log, {
  userId: payment.userId,
  category: "payment",
  action: "payment_completed",
  status: "success",
  details: { tier: payment.tier, amount: payment.amount, promoCode: payment.promoCode },
});

// Уведомление админу
const user = await ctx.db.get(payment.userId);
await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
  category: "payments",
  text: `💰 <b>Оплата</b>\n\nПользователь: ${user?.name ?? "—"}\nТариф: ${payment.tier}\nСумма: ${payment.amount} BYN${payment.promoCode ? `\nПромокод: ${payment.promoCode}` : ""}`,
});
```

При неуспешном статусе:
```typescript
await ctx.runMutation(internal.auditLog.log, {
  userId: payment.userId,
  category: "payment",
  action: "payment_failed",
  status: "failed",
  details: { status: args.status, message: args.message },
});
```

- [ ] **Step 4: telegram.ts — логировать привязку бота**

В обработке команды `/start` с токеном:

При успехе:
```typescript
await ctx.runMutation(internal.auditLog.log, {
  userId,
  category: "telegram",
  action: "bot_connected",
  status: "success",
});
```

При ошибке (невалидный/истекший токен):
```typescript
await ctx.runMutation(internal.auditLog.log, {
  userId, // может быть null если токен невалидный
  category: "telegram",
  action: "bot_connect_failed",
  status: "failed",
  details: { error: "invalid_token" },
});
```

- [ ] **Step 5: authEmail.ts — логировать вход по email**

В `loginWithEmail`:

При успехе:
```typescript
await ctx.runMutation(internal.auditLog.log, {
  userId,
  category: "auth",
  action: "login",
  status: "success",
  details: { method: "email" },
});
```

При ошибке:
```typescript
// userId может быть недоступен — логируем через systemLogger вместо auditLog
await ctx.runMutation(internal.systemLogger.log, {
  level: "warn",
  source: "authEmail.login",
  message: `Login failed: ${error}`,
  details: { email: args.email },
});
```

- [ ] **Step 6: auth.ts — логировать VK OAuth вход**

В callback после успешного обмена кода на токен:
```typescript
await ctx.runMutation(internal.auditLog.log, {
  userId,
  category: "auth",
  action: "login",
  status: "success",
  details: { method: "vk_oauth" },
});
```

- [ ] **Step 7: admin.ts — логировать действия админа**

| Функция | action | details |
|---------|--------|---------|
| updateUserTier | `tier_changed` | `{ targetUserId, oldTier, newTier }` |
| updateUserExpiry | `expiry_changed` | `{ targetUserId, newExpiry }` |
| toggleAdmin | `admin_toggled` | `{ targetUserId, isAdmin }` |
| broadcastTelegram | `broadcast_sent` | `{ recipientCount, message: text.slice(0,100) }` |

- [ ] **Step 8: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add convex/adAccounts.ts convex/rules.ts convex/billing.ts convex/telegram.ts convex/authEmail.ts convex/auth.ts convex/admin.ts
git commit -m "feat(audit): расстановка auditLog по действиям пользователей (7 файлов)"
```

---

## Task 8: Дашборд здоровья — бэкенд

**Files:**
- Create: `convex/adminHealth.ts`

- [ ] **Step 1: Создать convex/adminHealth.ts**

```typescript
import { v } from "convex/values";
import { query } from "./_generated/server";

const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];

async function assertAdmin(ctx: any, sessionToken: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", sessionToken))
    .first();
  if (!session) throw new Error("Не авторизован");
  const user = await ctx.db.get(session.userId);
  if (!user || (!user.isAdmin && !ADMIN_EMAILS.includes(user.email))) {
    throw new Error("Нет прав");
  }
  return user;
}

// ─── Сводка здоровья за период ───

export const getSummary = query({
  args: { sessionToken: v.string(), hours: v.number() },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const since = Date.now() - args.hours * 60 * 60 * 1000;

    const errors = await ctx.db
      .query("systemLogs")
      .withIndex("by_level_createdAt", (q) =>
        q.eq("level", "error").gte("createdAt", since)
      )
      .collect();

    const warnings = await ctx.db
      .query("systemLogs")
      .withIndex("by_level_createdAt", (q) =>
        q.eq("level", "warn").gte("createdAt", since)
      )
      .collect();

    // Группировка по source
    const bySource: Record<string, number> = {};
    for (const e of errors) {
      bySource[e.source] = (bySource[e.source] || 0) + 1;
    }

    // Последний синк
    const lastHeartbeat = await ctx.db
      .query("cronHeartbeats")
      .withIndex("by_name", (q) => q.eq("name", "syncAll"))
      .first();

    return {
      errorCount: errors.length,
      warningCount: warnings.length,
      bySource,
      syncStatus: lastHeartbeat?.status ?? "unknown",
      syncLastRun: lastHeartbeat?.finishedAt ?? lastHeartbeat?.startedAt,
      recentErrors: errors.slice(0, 20).map((e) => ({
        _id: e._id,
        source: e.source,
        message: e.message,
        details: e.details,
        createdAt: e.createdAt,
      })),
      recentWarnings: warnings.slice(0, 10).map((w) => ({
        _id: w._id,
        source: w.source,
        message: w.message,
        createdAt: w.createdAt,
      })),
    };
  },
});

// ─── Детальные логи с фильтрами ───

export const getLogs = query({
  args: {
    sessionToken: v.string(),
    level: v.optional(v.string()),
    hours: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const since = Date.now() - args.hours * 60 * 60 * 1000;
    const limit = args.limit ?? 100;

    if (args.level && (args.level === "error" || args.level === "warn" || args.level === "info")) {
      return await ctx.db
        .query("systemLogs")
        .withIndex("by_level_createdAt", (q) =>
          q.eq("level", args.level as "error" | "warn" | "info").gte("createdAt", since)
        )
        .order("desc")
        .take(limit);
    }

    return await ctx.db
      .query("systemLogs")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .order("desc")
      .take(limit);
  },
});
```

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/adminHealth.ts
git commit -m "feat(audit): adminHealth — запросы для дашборда здоровья"
```

---

## Task 9: UI — секция уведомлений в AdminToolsTab

**Files:**
- Create: `src/pages/admin/sections/AlertSettingsSection.tsx`
- Modify: `src/pages/admin/AdminToolsTab.tsx`

- [ ] **Step 1: Создать AlertSettingsSection.tsx**

```tsx
import { useState, useEffect } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Button } from '../../../components/ui/button';
import { Loader2, Check } from 'lucide-react';

interface Props {
  sessionToken: string;
}

const ALERT_OPTIONS = [
  { key: 'payments', label: 'Оплаты', desc: 'Уведомление при каждой оплате' },
  { key: 'criticalErrors', label: 'Критические ошибки', desc: 'TOKEN_EXPIRED, синк упал, Telegram не работает' },
  { key: 'accountConnections', label: 'Подключения кабинетов', desc: 'Подключение, отключение, ошибки' },
  { key: 'newUsers', label: 'Новые пользователи', desc: 'Регистрация новых юзеров' },
  { key: 'ruleErrors', label: 'Ошибки правил', desc: 'Правило не сработало из-за ошибки' },
] as const;

type AlertKey = typeof ALERT_OPTIONS[number]['key'];

export function AlertSettingsSection({ sessionToken }: Props) {
  const settings = useQuery(api.adminAlerts.getSettings, { sessionToken });
  const saveSettings = useMutation(api.adminAlerts.saveSettings);
  const [local, setLocal] = useState<Record<AlertKey, boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings && !local) {
      setLocal({
        payments: settings.payments,
        criticalErrors: settings.criticalErrors,
        accountConnections: settings.accountConnections,
        newUsers: settings.newUsers,
        ruleErrors: settings.ruleErrors,
      });
    }
  }, [settings, local]);

  if (!local) {
    return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  }

  const toggle = (key: AlertKey) => {
    setLocal((prev) => prev ? { ...prev, [key]: !prev[key] } : prev);
    setSaved(false);
  };

  const handleSave = async () => {
    if (!local) return;
    setSaving(true);
    try {
      await saveSettings({ sessionToken, ...local });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Получать в Telegram уведомления по выбранным категориям:
      </p>

      <div className="space-y-3">
        {ALERT_OPTIONS.map((opt) => (
          <label
            key={opt.key}
            className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-muted/30 cursor-pointer transition-colors"
          >
            <input
              type="checkbox"
              checked={local[opt.key]}
              onChange={() => toggle(opt.key)}
              className="mt-0.5 h-4 w-4 rounded border-border"
            />
            <div>
              <div className="text-sm font-medium">{opt.label}</div>
              <div className="text-xs text-muted-foreground">{opt.desc}</div>
            </div>
          </label>
        ))}
      </div>

      <Button onClick={handleSave} disabled={saving} size="sm">
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
        ) : saved ? (
          <Check className="w-4 h-4 mr-2" />
        ) : null}
        {saved ? 'Сохранено' : 'Сохранить'}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Добавить секцию в AdminToolsTab.tsx**

В `convex/AdminToolsTab.tsx`:

Добавить импорт:
```typescript
import { Bell } from 'lucide-react';
import { AlertSettingsSection } from './sections/AlertSettingsSection';
```

Добавить в массив `SECTIONS` (после `diagnostic`):
```typescript
  { id: 'alerts', label: 'Уведомления', icon: Bell },
```

Обновить тип:
```typescript
type SectionId = (typeof SECTIONS)[number]['id'];
```

Добавить рендер в JSX (после `{section.id === 'diagnostic' && <DiagnosticSection />}`):
```typescript
                {section.id === 'alerts' && <AlertSettingsSection sessionToken={sessionToken} />}
```

- [ ] **Step 3: Проверить typecheck и lint**

Run: `npx tsc --noEmit -p convex/tsconfig.json && npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pages/admin/sections/AlertSettingsSection.tsx src/pages/admin/AdminToolsTab.tsx
git commit -m "feat(audit): UI настроек Telegram-уведомлений в AdminToolsTab"
```

---

## Task 10: UI — вкладка «Здоровье»

**Files:**
- Create: `src/pages/admin/AdminHealthTab.tsx`
- Modify: `src/pages/admin/AdminPage.tsx`

- [ ] **Step 1: Создать AdminHealthTab.tsx**

```tsx
import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Activity,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

interface Props {
  sessionToken: string;
}

export function AdminHealthTab({ sessionToken }: Props) {
  const [hours, setHours] = useState(24);
  const summary = useQuery(api.adminHealth.getSummary, { sessionToken, hours });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!summary) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="space-y-6">
      {/* Период */}
      <div className="flex gap-2">
        {[
          { h: 1, label: '1ч' },
          { h: 6, label: '6ч' },
          { h: 24, label: '24ч' },
          { h: 168, label: '7д' },
          { h: 720, label: '30д' },
        ].map((p) => (
          <Button
            key={p.h}
            size="sm"
            variant={hours === p.h ? 'default' : 'outline'}
            className="text-xs h-7"
            onClick={() => setHours(p.h)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {/* Виджеты */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6 text-center">
            <AlertCircle className={`w-8 h-8 mx-auto mb-2 ${summary.errorCount > 0 ? 'text-destructive' : 'text-muted-foreground'}`} />
            <div className="text-2xl font-bold">{summary.errorCount}</div>
            <p className="text-xs text-muted-foreground">Ошибок</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <AlertTriangle className={`w-8 h-8 mx-auto mb-2 ${summary.warningCount > 0 ? 'text-warning' : 'text-muted-foreground'}`} />
            <div className="text-2xl font-bold">{summary.warningCount}</div>
            <p className="text-xs text-muted-foreground">Предупреждений</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            {summary.syncStatus === 'completed' ? (
              <CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-500" />
            ) : summary.syncStatus === 'failed' ? (
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-destructive" />
            ) : (
              <Activity className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
            )}
            <div className="text-sm font-bold">
              {summary.syncStatus === 'completed' ? 'ОК' : summary.syncStatus === 'failed' ? 'Ошибка' : summary.syncStatus}
            </div>
            <p className="text-xs text-muted-foreground">Синк метрик</p>
            {summary.syncLastRun && (
              <p className="text-[10px] text-muted-foreground mt-1">{formatTime(summary.syncLastRun)}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <div className="text-2xl font-bold">{Object.keys(summary.bySource).length}</div>
            <p className="text-xs text-muted-foreground">Источников ошибок</p>
          </CardContent>
        </Card>
      </div>

      {/* По источникам */}
      {Object.keys(summary.bySource).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Ошибки по источникам</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(summary.bySource)
                .sort((a, b) => b[1] - a[1])
                .map(([source, count]) => (
                  <Badge key={source} variant="destructive" className="text-xs">
                    {source}: {count}
                  </Badge>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Последние ошибки */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Последние ошибки ({summary.recentErrors.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {summary.recentErrors.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Ошибок нет за выбранный период
            </p>
          ) : (
            <div className="space-y-1">
              {summary.recentErrors.map((log) => (
                <div key={log._id}>
                  <div
                    className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/30 cursor-pointer text-sm"
                    onClick={() => setExpandedId(expandedId === log._id ? null : log._id)}
                  >
                    {expandedId === log._id ? (
                      <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
                    <span className="text-xs text-muted-foreground w-[90px] shrink-0">
                      {formatTime(log.createdAt)}
                    </span>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {log.source}
                    </Badge>
                    <span className="truncate">{log.message}</span>
                  </div>
                  {expandedId === log._id && log.details && (
                    <div className="ml-8 mb-2 p-3 rounded-lg bg-muted/30 text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                      {JSON.stringify(log.details, null, 2)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Добавить вкладку в AdminPage.tsx**

Добавить импорт:
```typescript
import { AdminHealthTab } from './AdminHealthTab';
import { Activity } from 'lucide-react';
```

Изменить `TABS`:
```typescript
const TABS = [
  { id: 'users', label: 'Пользователи', icon: Users },
  { id: 'metrics', label: 'Метрики', icon: BarChart3 },
  { id: 'tools', label: 'Инструменты', icon: Wrench },
  { id: 'logs', label: 'Логи', icon: ScrollText },
  { id: 'health', label: 'Здоровье', icon: Activity },
] as const;
```

Добавить рендер (после строки с logs):
```tsx
      {activeTab === 'health' && <AdminHealthTab sessionToken={sessionToken} />}
```

- [ ] **Step 3: Проверить lint и build**

Run: `npm run lint && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pages/admin/AdminHealthTab.tsx src/pages/admin/AdminPage.tsx
git commit -m "feat(audit): вкладка «Здоровье» в админке — виджеты + список ошибок"
```

---

## Task 11: UI — вкладка «Аудит»

**Files:**
- Create: `src/pages/admin/AdminAuditTab.tsx`
- Modify: `src/pages/admin/AdminPage.tsx`

- [ ] **Step 1: Создать AdminAuditTab.tsx**

```tsx
import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  Building2,
  ListChecks,
  CreditCard,
  Bot,
  Settings,
  LogIn,
  Shield,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

interface Props {
  sessionToken: string;
}

const CATEGORIES = [
  { id: 'all', label: 'Все', icon: null },
  { id: 'account', label: 'Кабинеты', icon: Building2 },
  { id: 'rule', label: 'Правила', icon: ListChecks },
  { id: 'payment', label: 'Оплаты', icon: CreditCard },
  { id: 'telegram', label: 'Telegram', icon: Bot },
  { id: 'settings', label: 'Настройки', icon: Settings },
  { id: 'auth', label: 'Авторизация', icon: LogIn },
  { id: 'admin', label: 'Админ', icon: Shield },
] as const;

const ACTION_LABELS: Record<string, string> = {
  connect_success: 'Подключение кабинета',
  connect_failed: 'Ошибка подключения',
  disconnect: 'Отключение кабинета',
  rule_created: 'Создание правила',
  rule_updated: 'Изменение правила',
  rule_deleted: 'Удаление правила',
  rule_toggled: 'Вкл/Выкл правила',
  payment_started: 'Начало оплаты',
  payment_completed: 'Оплата',
  payment_failed: 'Ошибка оплаты',
  bot_connected: 'Привязка бота',
  bot_connect_failed: 'Ошибка привязки',
  bot_disconnected: 'Отвязка бота',
  settings_updated: 'Изменение настроек',
  login: 'Вход',
  login_failed: 'Неудачный вход',
  vk_reauth: 'Переавторизация VK',
  tier_changed: 'Изменение тарифа',
  expiry_changed: 'Изменение срока',
  admin_toggled: 'Изменение прав',
  broadcast_sent: 'Рассылка',
};

export function AdminAuditTab({ sessionToken }: Props) {
  const [category, setCategory] = useState<string>('all');
  const [hours, setHours] = useState(168); // 7 дней
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const logs = useQuery(api.auditLog.list, {
    sessionToken,
    category: category === 'all' ? undefined : category,
    since: Date.now() - hours * 60 * 60 * 1000,
    limit: 200,
  });

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="space-y-6">
      {/* Фильтры */}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((cat) => (
          <Button
            key={cat.id}
            size="sm"
            variant={category === cat.id ? 'default' : 'outline'}
            className="text-xs h-7"
            onClick={() => setCategory(cat.id)}
          >
            {cat.icon && <cat.icon className="w-3 h-3 mr-1" />}
            {cat.label}
          </Button>
        ))}
      </div>

      {/* Период */}
      <div className="flex gap-2">
        {[
          { h: 24, label: '24ч' },
          { h: 168, label: '7д' },
          { h: 720, label: '30д' },
          { h: 2160, label: '90д' },
        ].map((p) => (
          <Button
            key={p.h}
            size="sm"
            variant={hours === p.h ? 'default' : 'outline'}
            className="text-xs h-7"
            onClick={() => setHours(p.h)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {/* Результаты */}
      {!logs ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>Нет записей за выбранный период</p>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {logs.length} записей
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {logs.map((log) => (
                <div key={log._id}>
                  <div
                    className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/30 cursor-pointer text-sm"
                    onClick={() => setExpandedId(expandedId === log._id ? null : log._id)}
                  >
                    {expandedId === log._id ? (
                      <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                    )}
                    {log.status === 'success' ? (
                      <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
                    )}
                    <span className="text-xs text-muted-foreground w-[90px] shrink-0">
                      {formatTime(log.createdAt)}
                    </span>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {log.category}
                    </Badge>
                    <span className="truncate">
                      {ACTION_LABELS[log.action] ?? log.action}
                    </span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">
                      {log.userName}
                    </span>
                  </div>
                  {expandedId === log._id && log.details && (
                    <div className="ml-8 mb-2 p-3 rounded-lg bg-muted/30 text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                      {JSON.stringify(log.details, null, 2)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Добавить вкладку в AdminPage.tsx**

Добавить импорт:
```typescript
import { AdminAuditTab } from './AdminAuditTab';
import { ClipboardList } from 'lucide-react';
```

Добавить в `TABS` (после `health`):
```typescript
  { id: 'audit', label: 'Аудит', icon: ClipboardList },
```

Добавить рендер:
```tsx
      {activeTab === 'audit' && <AdminAuditTab sessionToken={sessionToken} />}
```

- [ ] **Step 3: Проверить lint и build**

Run: `npm run lint && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pages/admin/AdminAuditTab.tsx src/pages/admin/AdminPage.tsx
git commit -m "feat(audit): вкладка «Аудит» в админке — действия пользователей с фильтрами"
```

---

## Task 12: Критические Telegram-алерты из systemLogger

**Files:**
- Modify: `convex/systemLogger.ts` — добавить авто-отправку алерта при level "error"

- [ ] **Step 1: Добавить scheduler в systemLogger.log**

В `convex/systemLogger.ts`, в функции `log`, после `ctx.db.insert(...)` добавить:

```typescript
    // Авто-алерт админам при критических ошибках
    if (args.level === "error") {
      await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
        category: "criticalErrors",
        dedupKey: `${args.source}:${args.message.slice(0, 50)}`,
        text: [
          `🚨 <b>Ошибка</b>`,
          ``,
          `<b>Источник:</b> <code>${args.source}</code>`,
          `<b>Сообщение:</b> ${args.message}`,
          args.details ? `<pre>${JSON.stringify(args.details, null, 2).slice(0, 300)}</pre>` : '',
        ].filter(Boolean).join('\n'),
      });
    }
```

Добавить импорт в начало файла:
```typescript
import { internal } from "./_generated/api";
```

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/systemLogger.ts
git commit -m "feat(audit): авто-Telegram-алерт админу при level=error в systemLogs"
```

---

## Task 13: Финальная проверка

**Files:** все изменённые

- [ ] **Step 1: Полный typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS (max 50 warnings)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Юнит-тесты**

Run: `npm run test`
Expected: PASS

- [ ] **Step 5: Проверить что существующий AdminLogsTab не сломался**

Существующая вкладка «Логи» (`AdminLogsTab.tsx`) использует `api.adminLogs.getLogs` — этот файл и запрос мы НЕ трогаем. Убедиться что импорт не конфликтует с новыми файлами.

- [ ] **Step 6: Финальный commit (если были fixup'ы)**

```bash
git add -A
git commit -m "fix(audit): финальные правки после проверки"
```
