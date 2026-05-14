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

// ─── Получить юзера для отправки ───

export const getAdminUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
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
    // Дедупликация (опциональная): explicit callers передают dedupKey и пройдут
    // через checkDedup. systemLogger path (D1a) намеренно НЕ передаёт dedupKey,
    // поскольку inline dedup-before-schedule уже сработал в systemLogger.log;
    // повторный checkDedup здесь привёл бы к silent suppression.
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

// ─── TTL-чистка dedup (1 день) ───

export const cleanupDedup = internalMutation({
  handler: async (ctx) => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const all = await ctx.db.query("adminAlertDedup").collect();
    let deleted = 0;
    for (const doc of all) {
      if (doc.lastSentAt < oneDayAgo) {
        await ctx.db.delete(doc._id);
        deleted++;
      }
    }
    return { deleted };
  },
});
