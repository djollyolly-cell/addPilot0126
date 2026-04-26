import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

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

    // Авто-алерт админам при критических ошибках
    if (args.level === "error") {
      try { await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
        category: "criticalErrors",
        dedupKey: `${args.source}:${args.accountId ?? "global"}:${args.message.slice(0, 50)}`,
        text: [
          `🚨 <b>Ошибка</b>`,
          ``,
          `<b>Источник:</b> <code>${args.source}</code>`,
          `<b>Сообщение:</b> ${args.message}`,
          details ? `<pre>${JSON.stringify(details, null, 2).slice(0, 300)}</pre>` : '',
        ].filter(Boolean).join('\n'),
      }); } catch { /* non-critical */ }
    }
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

// ─── TTL-чистка (10 дней), batch 2000 ───

export const cleanupOld = internalMutation({
  handler: async (ctx) => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("systemLogs")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", tenDaysAgo))
      .take(2000);
    for (const doc of old) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: old.length };
  },
});
