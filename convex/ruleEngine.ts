import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// ═══════════════════════════════════════════════════════════
// Pure functions — exported for direct unit testing
// ═══════════════════════════════════════════════════════════

export interface MetricsSnapshot {
  spent: number;
  leads: number;
  impressions: number;
  clicks: number;
  cpl?: number;
  ctr?: number;
}

export interface RuleCondition {
  metric: string;
  operator: string;
  value: number;
  minSamples?: number;
  timeWindow?: "daily" | "since_launch" | "24h";
}

export interface SpendSnapshot {
  spent: number;
  timestamp: number;
}

/**
 * Evaluate whether a rule condition is met.
 * Returns true if the rule should trigger (ad should be stopped/notified).
 */
export function evaluateCondition(
  ruleType: string,
  condition: RuleCondition,
  metrics: MetricsSnapshot,
  context?: {
    spendHistory?: SpendSnapshot[];
    dailyBudget?: number;
  }
): boolean {
  switch (ruleType) {
    case "cpl_limit": {
      const cpl =
        metrics.leads > 0 ? metrics.spent / metrics.leads : undefined;
      if (cpl === undefined) return false;
      return cpl > condition.value;
    }

    case "min_ctr": {
      const ctr =
        metrics.impressions > 0
          ? (metrics.clicks / metrics.impressions) * 100
          : undefined;
      if (ctr === undefined) return false;
      return ctr < condition.value;
    }

    case "fast_spend": {
      if (!context?.spendHistory || context.spendHistory.length < 2)
        return false;
      const sorted = [...context.spendHistory].sort(
        (a, b) => a.timestamp - b.timestamp
      );
      const oldest = sorted[0];
      const newest = sorted[sorted.length - 1];
      const spentDiff = newest.spent - oldest.spent;
      const budget = context.dailyBudget;
      if (!budget || budget <= 0) return false;
      const percentSpent = (spentDiff / budget) * 100;
      return percentSpent > condition.value;
    }

    case "spend_no_leads": {
      return metrics.spent > condition.value && metrics.leads === 0;
    }

    case "budget_limit": {
      return metrics.spent > condition.value;
    }

    case "low_impressions": {
      return metrics.impressions < condition.value;
    }

    case "clicks_no_leads": {
      return metrics.clicks >= condition.value && metrics.leads === 0;
    }

    default:
      return false;
  }
}

/**
 * Calculate projected savings if ad is stopped now.
 * @param spentPerMinute - current spending rate (rub/min)
 * @param minutesRemaining - minutes until end of work day
 */
export function calculateSavings(
  spentPerMinute: number,
  minutesRemaining: number
): number {
  if (spentPerMinute <= 0 || minutesRemaining <= 0) return 0;
  return spentPerMinute * minutesRemaining;
}

/**
 * Get minutes remaining until 18:00 today.
 */
export function minutesUntilEndOfDay(now: Date = new Date()): number {
  const endOfDay = new Date(now);
  endOfDay.setHours(18, 0, 0, 0);
  if (now >= endOfDay) return 0;
  return Math.floor((endOfDay.getTime() - now.getTime()) / (1000 * 60));
}

// ═══════════════════════════════════════════════════════════
// Convex queries & mutations for the rule engine
// ═══════════════════════════════════════════════════════════

/** Get all active rules for a user */
export const listActiveRules = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("rules")
      .withIndex("by_userId_active", (q) =>
        q.eq("userId", args.userId).eq("isActive", true)
      )
      .collect();
  },
});

/** Get today's daily metrics for an account */
export const getAccountTodayMetrics = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    date: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId).eq("date", args.date)
      )
      .collect();
  },
});

/** Get aggregated metrics for an ad across all dates (since launch) or last 24h */
export const getAdAggregatedMetrics = internalQuery({
  args: {
    adId: v.string(),
    sinceDate: v.optional(v.string()), // "YYYY-MM-DD" — if set, only sum from this date
  },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("metricsDaily")
      .withIndex("by_adId_date", (q) => q.eq("adId", args.adId))
      .collect();

    const filtered = args.sinceDate
      ? records.filter((r) => r.date >= args.sinceDate!)
      : records;

    let clicks = 0;
    let leads = 0;
    let spent = 0;
    let impressions = 0;
    for (const r of filtered) {
      clicks += r.clicks;
      leads += r.leads;
      spent += r.spent;
      impressions += r.impressions;
    }

    return { clicks, leads, spent, impressions, daysCount: filtered.length };
  },
});

/** Get realtime history for an ad (for fast_spend detection) */
export const getRealtimeHistory = internalQuery({
  args: {
    adId: v.string(),
    sinceTimestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("metricsRealtime")
      .withIndex("by_adId", (q) => q.eq("adId", args.adId))
      .collect();
    return records.filter((r) => r.timestamp >= args.sinceTimestamp);
  },
});

/** Get campaign daily limit for fast_spend calculation */
export const getCampaignDailyLimit = internalQuery({
  args: { adId: v.string() },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ads")
      .withIndex("by_vkAdId", (q) => q.eq("vkAdId", args.adId))
      .first();
    if (!ad) return null;
    const campaign = await ctx.db.get(ad.campaignId);
    return campaign?.dailyLimit ?? null;
  },
});

/** Create an action log entry (internal) */
export const createActionLog = internalMutation({
  args: {
    userId: v.id("users"),
    ruleId: v.id("rules"),
    accountId: v.id("adAccounts"),
    adId: v.string(),
    adName: v.string(),
    campaignName: v.optional(v.string()),
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
      impressions: v.optional(v.number()),
      clicks: v.optional(v.number()),
    }),
    savedAmount: v.number(),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("reverted")
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("actionLogs", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

/** Create action log — public mutation for testing */
export const createActionLogPublic = mutation({
  args: {
    userId: v.id("users"),
    ruleId: v.id("rules"),
    accountId: v.id("adAccounts"),
    adId: v.string(),
    adName: v.string(),
    campaignName: v.optional(v.string()),
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
      impressions: v.optional(v.number()),
      clicks: v.optional(v.number()),
    }),
    savedAmount: v.number(),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("reverted")
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("actionLogs", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

/** Update rule trigger count */
export const incrementTriggerCount = internalMutation({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return;
    await ctx.db.patch(args.ruleId, {
      triggerCount: rule.triggerCount + 1,
      lastTriggeredAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** Query action logs for a user */
export const listActionLogs = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("actionLogs")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
  },
});

/** Get action logs by rule */
export const getActionLogsByRule = query({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .order("desc")
      .collect();
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 13 — Savings Widget Queries
// ═══════════════════════════════════════════════════════════

/** Get total saved amount for today (since midnight UTC) */
export const getSavedToday = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", args.userId).gte("createdAt", startOfDay)
      )
      .collect();

    return logs.reduce((sum, log) => sum + log.savedAmount, 0);
  },
});

/**
 * Get saved amounts per day for the last N days (default 7).
 * Returns array of { date: "YYYY-MM-DD", amount: number } sorted oldest-first.
 */
export const getSavedHistory = query({
  args: {
    userId: v.id("users"),
    days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numDays = args.days ?? 7;
    const now = new Date();
    const startDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - numDays + 1
    );
    const since = startDate.getTime();

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", args.userId).gte("createdAt", since)
      )
      .collect();

    // Group by date
    const byDate: Record<string, number> = {};
    for (let i = 0; i < numDays; i++) {
      const d = new Date(
        startDate.getFullYear(),
        startDate.getMonth(),
        startDate.getDate() + i
      );
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      byDate[key] = 0;
    }

    for (const log of logs) {
      const d = new Date(log.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (key in byDate) {
        byDate[key] += log.savedAmount;
      }
    }

    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, amount]) => ({ date, amount }));
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 14 — Activity Stats
// ═══════════════════════════════════════════════════════════

/** Get activity stats: count of triggers, stops, notifications for today */
export const getActivityStats = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", args.userId).gte("createdAt", startOfDay)
      )
      .collect();

    const triggers = logs.length;
    const stops = logs.filter(
      (l) => l.actionType === "stopped" || l.actionType === "stopped_and_notified"
    ).length;
    const notifications = logs.filter(
      (l) => l.actionType === "notified" || l.actionType === "stopped_and_notified"
    ).length;

    return { triggers, stops, notifications };
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 15 — Recent Events (Event Feed)
// ═══════════════════════════════════════════════════════════

/** Get recent action log events with optional filters */
export const getRecentEvents = query({
  args: {
    userId: v.id("users"),
    actionType: v.optional(
      v.union(
        v.literal("stopped"),
        v.literal("notified"),
        v.literal("stopped_and_notified")
      )
    ),
    accountId: v.optional(v.id("adAccounts")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;

    let logs;
    if (args.accountId) {
      logs = await ctx.db
        .query("actionLogs")
        .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId!))
        .order("desc")
        .collect();
      // Filter by userId (accountId index doesn't include userId)
      logs = logs.filter((l) => l.userId === args.userId);
    } else {
      logs = await ctx.db
        .query("actionLogs")
        .withIndex("by_userId_date", (q) => q.eq("userId", args.userId))
        .order("desc")
        .collect();
    }

    // Apply actionType filter
    if (args.actionType) {
      logs = logs.filter((l) => l.actionType === args.actionType);
    }

    // Apply limit
    return logs.slice(0, limit);
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 17 — Analytics queries
// ═══════════════════════════════════════════════════════════

/** Get daily savings data for line chart (within a date range) */
export const getAnalyticsSavings = query({
  args: {
    userId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q
          .eq("userId", args.userId)
          .gte("createdAt", args.startDate)
          .lte("createdAt", args.endDate)
      )
      .collect();

    // Group by date
    const byDate: Record<string, number> = {};
    for (const log of logs) {
      const date = new Date(log.createdAt).toISOString().slice(0, 10);
      byDate[date] = (byDate[date] ?? 0) + log.savedAmount;
    }

    // Fill all dates in range
    const result: { date: string; amount: number }[] = [];
    const current = new Date(args.startDate);
    const end = new Date(args.endDate);
    while (current <= end) {
      const dateStr = current.toISOString().slice(0, 10);
      result.push({ date: dateStr, amount: byDate[dateStr] ?? 0 });
      current.setDate(current.getDate() + 1);
    }

    return result;
  },
});

/** Get action type breakdown for bar chart */
export const getAnalyticsByType = query({
  args: {
    userId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q
          .eq("userId", args.userId)
          .gte("createdAt", args.startDate)
          .lte("createdAt", args.endDate)
      )
      .collect();

    const counts: Record<string, number> = {
      stopped: 0,
      notified: 0,
      stopped_and_notified: 0,
    };

    for (const log of logs) {
      counts[log.actionType] = (counts[log.actionType] ?? 0) + 1;
    }

    return [
      { type: "stopped", label: "Остановки", count: counts.stopped },
      { type: "notified", label: "Уведомления", count: counts.notified },
      {
        type: "stopped_and_notified",
        label: "Стоп + увед.",
        count: counts.stopped_and_notified,
      },
    ];
  },
});

/** Get triggers per rule for pie chart */
export const getAnalyticsTriggersByRule = query({
  args: {
    userId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q
          .eq("userId", args.userId)
          .gte("createdAt", args.startDate)
          .lte("createdAt", args.endDate)
      )
      .collect();

    // Group by ruleId
    const byRule: Record<string, number> = {};
    for (const log of logs) {
      const key = log.ruleId as string;
      byRule[key] = (byRule[key] ?? 0) + 1;
    }

    // Fetch rule names
    const result: { ruleId: string; name: string; count: number }[] = [];
    for (const [ruleId, count] of Object.entries(byRule)) {
      const ruleDoc = await ctx.db.get(ruleId as Id<"rules">);
      const ruleName =
        ruleDoc && "name" in ruleDoc ? ruleDoc.name : "Удалённое правило";
      result.push({
        ruleId,
        name: ruleName as string,
        count,
      });
    }

    return result.sort((a, b) => b.count - a.count);
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 18 — Top-10 Ads & ROI
// ═══════════════════════════════════════════════════════════

/** Get top N ads by savedAmount within date range */
export const getTopAds = query({
  args: {
    userId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q
          .eq("userId", args.userId)
          .gte("createdAt", args.startDate)
          .lte("createdAt", args.endDate)
      )
      .collect();

    // Aggregate by adId
    const byAd: Record<
      string,
      { adName: string; totalSaved: number; totalSpent: number; triggers: number }
    > = {};

    for (const log of logs) {
      if (!byAd[log.adId]) {
        byAd[log.adId] = {
          adName: log.adName,
          totalSaved: 0,
          totalSpent: 0,
          triggers: 0,
        };
      }
      byAd[log.adId].totalSaved += log.savedAmount;
      byAd[log.adId].totalSpent += log.metricsSnapshot.spent;
      byAd[log.adId].triggers += 1;
    }

    return Object.entries(byAd)
      .map(([adId, data]) => ({ adId, ...data }))
      .sort((a, b) => b.totalSaved - a.totalSaved)
      .slice(0, limit);
  },
});

/** Get ROI metrics: total saved, total spent, ratio */
export const getROI = query({
  args: {
    userId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q
          .eq("userId", args.userId)
          .gte("createdAt", args.startDate)
          .lte("createdAt", args.endDate)
      )
      .collect();

    let totalSaved = 0;
    let totalSpent = 0;
    for (const log of logs) {
      totalSaved += log.savedAmount;
      totalSpent += log.metricsSnapshot.spent;
    }

    const roi = totalSpent > 0 ? (totalSaved / totalSpent) * 100 : 0;

    return {
      totalSaved,
      totalSpent,
      roi: Math.round(roi * 100) / 100,
      totalEvents: logs.length,
    };
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 19 — Logs page queries
// ═══════════════════════════════════════════════════════════

/** Full logs query with 4 filters + text search */
export const getLogs = query({
  args: {
    userId: v.id("users"),
    actionType: v.optional(
      v.union(
        v.literal("stopped"),
        v.literal("notified"),
        v.literal("stopped_and_notified")
      )
    ),
    accountId: v.optional(v.id("adAccounts")),
    ruleId: v.optional(v.id("rules")),
    status: v.optional(
      v.union(
        v.literal("success"),
        v.literal("failed"),
        v.literal("reverted")
      )
    ),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    let logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();

    if (args.actionType) {
      logs = logs.filter((l) => l.actionType === args.actionType);
    }
    if (args.accountId) {
      logs = logs.filter((l) => l.accountId === args.accountId);
    }
    if (args.ruleId) {
      logs = logs.filter((l) => l.ruleId === args.ruleId);
    }
    if (args.status) {
      logs = logs.filter((l) => l.status === args.status);
    }
    if (args.search) {
      const q = args.search.toLowerCase();
      logs = logs.filter(
        (l) =>
          l.adName.toLowerCase().includes(q) ||
          l.reason.toLowerCase().includes(q) ||
          (l.campaignName && l.campaignName.toLowerCase().includes(q))
      );
    }

    return logs.slice(0, limit);
  },
});

/** Public mutation to revert a stopped ad action */
export const revertActionPublic = mutation({
  args: {
    actionLogId: v.id("actionLogs"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const log = await ctx.db.get(args.actionLogId);
    if (!log) {
      return { success: false, reason: "not_found" };
    }
    if (log.userId !== args.userId) {
      return { success: false, reason: "forbidden" };
    }
    if (log.status === "reverted") {
      return { success: false, reason: "already_reverted" };
    }
    const elapsed = Date.now() - log.createdAt;
    if (elapsed > 5 * 60 * 1000) {
      return { success: false, reason: "timeout" };
    }
    if (log.actionType !== "stopped" && log.actionType !== "stopped_and_notified") {
      return { success: false, reason: "not_stoppable" };
    }
    await ctx.db.patch(args.actionLogId, {
      status: "reverted",
      revertedAt: Date.now(),
      revertedBy: "user",
    });
    return { success: true, reason: "ok" };
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 11 — Revert action
// ═══════════════════════════════════════════════════════════

/** Revert timeout in milliseconds (5 minutes) */
export const REVERT_TIMEOUT_MS = 5 * 60 * 1000;

/** Get an action log by ID (internal, for callback processing) */
export const getActionLog = internalQuery({
  args: { actionLogId: v.id("actionLogs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.actionLogId);
  },
});

/**
 * Revert a stopped ad — mark actionLog as reverted.
 * Returns { success, reason } with reason for failure.
 */
export const revertAction = internalMutation({
  args: {
    actionLogId: v.id("actionLogs"),
    revertedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const log = await ctx.db.get(args.actionLogId);
    if (!log) {
      return { success: false, reason: "not_found" };
    }

    // Already reverted?
    if (log.status === "reverted") {
      return { success: false, reason: "already_reverted" };
    }

    // Timeout check (>5 minutes since creation)
    const elapsed = Date.now() - log.createdAt;
    if (elapsed > REVERT_TIMEOUT_MS) {
      return { success: false, reason: "timeout" };
    }

    // Only revert "stopped" or "stopped_and_notified" actions
    if (log.actionType !== "stopped" && log.actionType !== "stopped_and_notified") {
      return { success: false, reason: "not_stoppable" };
    }

    await ctx.db.patch(args.actionLogId, {
      status: "reverted",
      revertedAt: Date.now(),
      revertedBy: args.revertedBy,
    });

    return { success: true, reason: "ok" };
  },
});

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildReason(
  ruleType: string,
  condition: RuleCondition,
  metrics: MetricsSnapshot,
  timeWindow?: string
): string {
  switch (ruleType) {
    case "cpl_limit": {
      const cpl = metrics.leads > 0 ? metrics.spent / metrics.leads : 0;
      return `CPL ${cpl.toFixed(0)}\u20BD \u043F\u0440\u0435\u0432\u044B\u0441\u0438\u043B \u043B\u0438\u043C\u0438\u0442 ${condition.value}\u20BD`;
    }
    case "min_ctr": {
      const ctr =
        metrics.impressions > 0
          ? (metrics.clicks / metrics.impressions) * 100
          : 0;
      return `CTR ${ctr.toFixed(2)}% \u043D\u0438\u0436\u0435 \u043C\u0438\u043D\u0438\u043C\u0443\u043C\u0430 ${condition.value}%`;
    }
    case "fast_spend":
      return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u044B\u0441\u0442\u0440\u044B\u0439 \u0440\u0430\u0441\u0445\u043E\u0434 \u0431\u044E\u0434\u0436\u0435\u0442\u0430 (\u043F\u043E\u0440\u043E\u0433 ${condition.value}%)`;
    case "spend_no_leads":
      return `\u041F\u043E\u0442\u0440\u0430\u0447\u0435\u043D\u043E ${metrics.spent}\u20BD \u0431\u0435\u0437 \u043B\u0438\u0434\u043E\u0432 (\u043B\u0438\u043C\u0438\u0442 ${condition.value}\u20BD)`;
    case "budget_limit":
      return `\u0420\u0430\u0441\u0445\u043E\u0434 ${metrics.spent}\u20BD \u043F\u0440\u0435\u0432\u044B\u0441\u0438\u043B \u0431\u044E\u0434\u0436\u0435\u0442 ${condition.value}\u20BD`;
    case "low_impressions":
      return `\u041F\u043E\u043A\u0430\u0437\u043E\u0432 ${metrics.impressions} \u043C\u0435\u043D\u044C\u0448\u0435 \u043C\u0438\u043D\u0438\u043C\u0443\u043C\u0430 ${condition.value}`;
    case "clicks_no_leads": {
      const windowLabel =
        timeWindow === "since_launch" ? " с запуска" :
        timeWindow === "24h" ? " за 24ч" : " за день";
      return `${metrics.clicks} кликов без лидов${windowLabel} (порог ${condition.value})`;
    }
    default:
      return `\u041F\u0440\u0430\u0432\u0438\u043B\u043E ${ruleType} \u0441\u0440\u0430\u0431\u043E\u0442\u0430\u043B\u043E`;
  }
}

// ═══════════════════════════════════════════════════════════
// Main orchestrator — called after metrics sync
// ═══════════════════════════════════════════════════════════

export const checkAllRules = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(
      internal.syncMetrics.listActiveAccounts
    );
    if (accounts.length === 0) return;

    const date = todayStr();
    const processedUsers = new Set<string>();
    let totalTriggered = 0;

    for (const account of accounts) {
      const userIdStr = account.userId as string;
      if (processedUsers.has(userIdStr)) continue;
      processedUsers.add(userIdStr);

      try {
        const rules = await ctx.runQuery(
          internal.ruleEngine.listActiveRules,
          { userId: account.userId }
        );

        if (rules.length === 0) continue;

        for (const rule of rules) {
          for (const targetAccountId of rule.targetAccountIds) {
            // Get today's metrics for all ads in this account
            const dailyMetrics = await ctx.runQuery(
              internal.ruleEngine.getAccountTodayMetrics,
              { accountId: targetAccountId, date }
            );

            for (const metric of dailyMetrics) {
              // Filter by targeted ads if specified
              if (rule.targetAdIds && rule.targetAdIds.length > 0) {
                if (!rule.targetAdIds.includes(metric.adId)) continue;
              }

              // Check minSamples requirement
              if (rule.conditions.minSamples) {
                const history = await ctx.runQuery(
                  internal.ruleEngine.getRealtimeHistory,
                  {
                    adId: metric.adId,
                    sinceTimestamp: Date.now() - 24 * 60 * 60 * 1000,
                  }
                );
                if (history.length < rule.conditions.minSamples) continue;
              }

              // Build context for fast_spend
              let context:
                | {
                    spendHistory?: SpendSnapshot[];
                    dailyBudget?: number;
                  }
                | undefined;

              if (rule.type === "fast_spend") {
                const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
                const history = await ctx.runQuery(
                  internal.ruleEngine.getRealtimeHistory,
                  { adId: metric.adId, sinceTimestamp: fifteenMinAgo }
                );
                const dailyBudget = await ctx.runQuery(
                  internal.ruleEngine.getCampaignDailyLimit,
                  { adId: metric.adId }
                );
                context = {
                  spendHistory: history.map((h: { spent: number; timestamp: number }) => ({
                    spent: h.spent,
                    timestamp: h.timestamp,
                  })),
                  dailyBudget: dailyBudget ?? undefined,
                };
              }

              // Build metrics snapshot (may be aggregated for clicks_no_leads)
              let metricsSnapshot: MetricsSnapshot = {
                spent: metric.spent,
                leads: metric.leads,
                impressions: metric.impressions,
                clicks: metric.clicks,
                cpl: metric.cpl ?? undefined,
                ctr: metric.ctr ?? undefined,
              };

              const timeWindow = rule.conditions.timeWindow;

              // For clicks_no_leads with timeWindow, use aggregated metrics
              if (
                rule.type === "clicks_no_leads" &&
                timeWindow &&
                timeWindow !== "daily"
              ) {
                let sinceDate: string | undefined;
                if (timeWindow === "24h") {
                  const yesterday = new Date();
                  yesterday.setDate(yesterday.getDate() - 1);
                  sinceDate = yesterday.toISOString().slice(0, 10);
                }
                // since_launch: sinceDate = undefined → all dates

                const aggregated = await ctx.runQuery(
                  internal.ruleEngine.getAdAggregatedMetrics,
                  { adId: metric.adId, sinceDate }
                );

                metricsSnapshot = {
                  spent: aggregated.spent,
                  leads: aggregated.leads,
                  impressions: aggregated.impressions,
                  clicks: aggregated.clicks,
                };
              }

              // Evaluate condition
              const triggered = evaluateCondition(
                rule.type,
                rule.conditions,
                metricsSnapshot,
                context
              );

              if (!triggered) continue;

              // Calculate savings
              const now = new Date();
              const minsLeft = minutesUntilEndOfDay(now);
              const hoursElapsed =
                now.getHours() + now.getMinutes() / 60;
              const spentPerMinute =
                hoursElapsed > 0
                  ? metric.spent / (hoursElapsed * 60)
                  : 0;
              const savedAmount = calculateSavings(
                spentPerMinute,
                minsLeft
              );

              // Determine action type
              const actionType:
                | "stopped"
                | "notified"
                | "stopped_and_notified" =
                rule.actions.stopAd && rule.actions.notify
                  ? "stopped_and_notified"
                  : rule.actions.stopAd
                    ? "stopped"
                    : "notified";

              const reason = buildReason(
                rule.type,
                rule.conditions,
                metricsSnapshot,
                timeWindow
              );

              // Try to stop the ad via VK API
              let status: "success" | "failed" = "success";
              let errorMessage: string | undefined;

              if (rule.actions.stopAd) {
                try {
                  const accessToken = await ctx.runAction(
                    internal.auth.getValidVkAdsToken,
                    { userId: account.userId }
                  );
                  await ctx.runAction(api.vkApi.stopAd, {
                    accessToken,
                    adId: metric.adId,
                    accountId: targetAccountId,
                  });
                } catch (err) {
                  status = "failed";
                  errorMessage =
                    err instanceof Error
                      ? err.message
                      : "Unknown error";
                }
              }

              // Create action log
              const actionLogId = await ctx.runMutation(
                internal.ruleEngine.createActionLog,
                {
                  userId: account.userId,
                  ruleId: rule._id,
                  accountId: targetAccountId,
                  adId: metric.adId,
                  adName: `Ad ${metric.adId}`,
                  actionType,
                  reason,
                  metricsSnapshot: {
                    spent: metric.spent,
                    leads: metric.leads,
                    impressions: metric.impressions,
                    clicks: metric.clicks,
                    cpl: metric.cpl ?? undefined,
                    ctr: metric.ctr ?? undefined,
                  },
                  savedAmount,
                  status,
                  errorMessage,
                }
              );

              // Update rule trigger count
              await ctx.runMutation(
                internal.ruleEngine.incrementTriggerCount,
                { ruleId: rule._id }
              );

              // Send Telegram notification if notify is enabled
              if (rule.actions.notify) {
                try {
                  await ctx.runAction(
                    internal.telegram.sendRuleNotification,
                    {
                      userId: account.userId,
                      event: {
                        ruleName: rule.name,
                        adName: `Ad ${metric.adId}`,
                        reason,
                        actionType,
                        savedAmount,
                        metrics: {
                          spent: metric.spent,
                          leads: metric.leads,
                          cpl: metric.cpl ?? undefined,
                          ctr: metric.ctr ?? undefined,
                        },
                      },
                      priority: rule.actions.stopAd ? "critical" : "standard",
                      actionLogId: actionLogId as string,
                    }
                  );
                } catch (notifErr) {
                  console.error(
                    `[ruleEngine] Failed to send TG notification for rule ${rule._id}:`,
                    notifErr instanceof Error ? notifErr.message : notifErr
                  );
                }
              }

              totalTriggered++;
            }
          }
        }
      } catch (error) {
        console.error(
          `[ruleEngine] Error checking rules for user ${userIdStr}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    if (totalTriggered > 0) {
      console.log(`[ruleEngine] ${totalTriggered} rules triggered`);
    }
  },
});
