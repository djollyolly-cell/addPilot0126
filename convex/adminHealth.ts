import { v } from "convex/values";
import { query } from "./_generated/server";

const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertAdmin(ctx: any, sessionToken: string) {
  const session = await ctx.db
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .query("sessions")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
