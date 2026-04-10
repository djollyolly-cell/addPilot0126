import { v } from "convex/values";
import { query } from "./_generated/server";

const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];

async function assertAdmin(ctx: any, sessionToken: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", sessionToken))
    .first();
  if (!session || session.expiresAt < Date.now()) {
    throw new Error("Unauthorized: invalid session");
  }
  const user = await ctx.db.get(session.userId);
  if (!user) throw new Error("Forbidden: admin access required");
  if (user.isAdmin !== true && !ADMIN_EMAILS.includes(user.email)) {
    throw new Error("Forbidden: admin access required");
  }
  return user;
}

// Fetch logs for selected users within a date range
export const getLogs = query({
  args: {
    sessionToken: v.string(),
    userIds: v.array(v.id("users")),
    from: v.number(),
    to: v.number(),
    types: v.array(v.string()), // "budget", "stopped", "error", "sync"
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);

    const maxResults = args.limit || 500;
    const wantBudget = args.types.includes("budget");
    const wantStopped = args.types.includes("stopped");
    const wantErrors = args.types.includes("error");

    type LogEntry = {
      _id: string;
      type: string;
      userId: string;
      userName: string;
      timestamp: number;
      message: string;
      details: Record<string, unknown> | null;
    };

    const results: LogEntry[] = [];

    // Build user name map
    const userMap = new Map<string, string>();
    for (const uid of args.userIds) {
      const user = await ctx.db.get(uid);
      userMap.set(uid as string, user?.name || user?.email || "—");
    }

    // 1. actionLogs (budget_increased, budget_reset, stopped, notified)
    if (wantBudget || wantStopped) {
      for (const uid of args.userIds) {
        const logs = await ctx.db
          .query("actionLogs")
          .withIndex("by_userId_date", (q) =>
            q.eq("userId", uid).gte("createdAt", args.from)
          )
          .filter((q) => q.lt(q.field("createdAt"), args.to))
          .collect();

        for (const log of logs) {
          const isBudget = log.actionType === "budget_increased" || log.actionType === "budget_reset";
          const isStopped = log.actionType === "stopped" || log.actionType === "stopped_and_notified" || log.actionType === "notified";

          if ((wantBudget && isBudget) || (wantStopped && isStopped)) {
            const actionLabels: Record<string, string> = {
              budget_increased: "Повышение бюджета",
              budget_reset: "Сброс бюджета",
              stopped: "Остановка",
              stopped_and_notified: "Остановка + уведомление",
              notified: "Уведомление",
            };
            results.push({
              _id: log._id as string,
              type: isBudget ? "budget" : "stopped",
              userId: uid as string,
              userName: userMap.get(uid as string) || "—",
              timestamp: log.createdAt,
              message: `${actionLabels[log.actionType] || log.actionType}: ${log.adName}`,
              details: {
                actionType: log.actionType,
                campaignName: log.campaignName,
                adName: log.adName,
                reason: log.reason,
                metricsSnapshot: log.metricsSnapshot,
                status: log.status,
                errorMessage: log.errorMessage,
              },
            });
          }
          if (results.length >= maxResults) break;
        }
        if (results.length >= maxResults) break;
      }
    }

    // 2. systemLogs (errors, warnings)
    if (wantErrors) {
      for (const uid of args.userIds) {
        const sysLogs = await ctx.db
          .query("systemLogs")
          .withIndex("by_userId_createdAt", (q) =>
            q.eq("userId", uid).gte("createdAt", args.from)
          )
          .filter((q) => q.lt(q.field("createdAt"), args.to))
          .collect();

        for (const log of sysLogs) {
          results.push({
            _id: log._id as string,
            type: "error",
            userId: uid as string,
            userName: userMap.get(uid as string) || "—",
            timestamp: log.createdAt,
            message: `[${log.level}] ${log.source}: ${log.message}`,
            details: log.details as Record<string, unknown> | null,
          });
          if (results.length >= maxResults) break;
        }
        if (results.length >= maxResults) break;
      }
    }

    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp - a.timestamp);

    // Summary counts
    const summary = {
      budget: results.filter((r) => r.type === "budget").length,
      stopped: results.filter((r) => r.type === "stopped").length,
      error: results.filter((r) => r.type === "error").length,
      total: results.length,
    };

    return { logs: results.slice(0, maxResults), summary };
  },
});

// List all users (lightweight, for the user picker in Logs tab)
export const listUsersLight = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const users = await ctx.db.query("users").collect();
    return users
      .map((u) => ({
        _id: u._id,
        name: u.name || u.email,
        email: u.email,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
