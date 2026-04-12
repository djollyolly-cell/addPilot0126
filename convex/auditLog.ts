import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

// ─── Типы ───

type AuditCategory = "account" | "rule" | "payment" | "telegram" | "settings" | "auth" | "admin";

const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];

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
      category: args.category as AuditCategory,
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
    // Проверка админа
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.sessionToken))
      .first();
    if (!session) throw new Error("Не авторизован");
    const adminUser = await ctx.db.get(session.userId);
    if (!adminUser || (!adminUser.isAdmin && !ADMIN_EMAILS.includes(adminUser.email))) {
      throw new Error("Нет прав");
    }

    const since = args.since ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
    const limit = args.limit ?? 100;

    let logs;
    if (args.category) {
      logs = await ctx.db
        .query("auditLog")
        .withIndex("by_category_createdAt", (q) =>
          q.eq("category", args.category as AuditCategory).gte("createdAt", since)
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
    const userMap = new Map(
      users.filter((u): u is NonNullable<typeof u> => u !== null).map((u) => [u._id, u])
    );

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
