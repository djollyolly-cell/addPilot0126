import { v } from "convex/values";
import { mutation, query, internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// ── Cleanup constants ──
const RETENTION_DAYS = 4;
const DEFAULT_BATCH_SIZE = 500;
const BATCH_DELAY_MS = 100;
const LOG_EVERY_N_BATCHES = 100;
const CLEANUP_MAX_RUNNING_MS = 12 * 60 * 60 * 1000; // 12h zombie threshold

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Save a realtime metrics snapshot for a single ad
export const saveRealtime = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    adId: v.string(),
    spent: v.number(),
    leads: v.number(),
    impressions: v.number(),
    clicks: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("metricsRealtime", {
      accountId: args.accountId,
      adId: args.adId,
      timestamp: Date.now(),
      spent: args.spent,
      leads: args.leads,
      impressions: args.impressions,
      clicks: args.clicks,
    });
  },
});

// Save / upsert daily aggregated metrics for a single ad
export const saveDaily = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    adId: v.string(),
    campaignId: v.optional(v.string()),
    date: v.string(), // "YYYY-MM-DD"
    impressions: v.number(),
    clicks: v.number(),
    spent: v.number(),
    leads: v.number(),
    vkResult: v.optional(v.number()),
    reach: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Calculate derived metrics
    const cpl = args.leads > 0 ? args.spent / args.leads : undefined;
    const ctr = args.impressions > 0 ? (args.clicks / args.impressions) * 100 : undefined;
    const cpc = args.clicks > 0 ? args.spent / args.clicks : undefined;

    // Check if daily record already exists
    const existing = await ctx.db
      .query("metricsDaily")
      .withIndex("by_adId_date", (q) =>
        q.eq("adId", args.adId).eq("date", args.date)
      )
      .first();

    if (existing) {
      // Update existing record (overwrite with latest API data)
      const patch: Record<string, unknown> = {
        impressions: args.impressions,
        clicks: args.clicks,
        spent: args.spent,
        leads: args.leads,
      };
      if (args.vkResult !== undefined) patch.vkResult = args.vkResult;
      if (args.campaignId !== undefined) patch.campaignId = args.campaignId;
      if (args.reach !== undefined) patch.reach = args.reach;
      if (cpl !== undefined) patch.cpl = cpl;
      if (ctr !== undefined) patch.ctr = ctr;
      if (cpc !== undefined) patch.cpc = cpc;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("metricsDaily", {
      accountId: args.accountId,
      adId: args.adId,
      campaignId: args.campaignId,
      date: args.date,
      impressions: args.impressions,
      clicks: args.clicks,
      spent: args.spent,
      leads: args.leads,
      vkResult: args.vkResult,
      reach: args.reach,
      cpl,
      ctr,
      cpc,
    });
  },
});

// Public mutation wrappers for testing (delegate to internal)
export const saveRealtimePublic = mutation({
  args: {
    accountId: v.id("adAccounts"),
    adId: v.string(),
    spent: v.number(),
    leads: v.number(),
    impressions: v.number(),
    clicks: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("metricsRealtime", {
      accountId: args.accountId,
      adId: args.adId,
      timestamp: Date.now(),
      spent: args.spent,
      leads: args.leads,
      impressions: args.impressions,
      clicks: args.clicks,
    });
  },
});

export const saveDailyPublic = mutation({
  args: {
    accountId: v.id("adAccounts"),
    adId: v.string(),
    date: v.string(),
    impressions: v.number(),
    clicks: v.number(),
    spent: v.number(),
    leads: v.number(),
    reach: v.optional(v.number()),
    vkResult: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cpl = args.leads > 0 ? args.spent / args.leads : undefined;
    const ctr = args.impressions > 0 ? (args.clicks / args.impressions) * 100 : undefined;
    const cpc = args.clicks > 0 ? args.spent / args.clicks : undefined;

    const existing = await ctx.db
      .query("metricsDaily")
      .withIndex("by_adId_date", (q) =>
        q.eq("adId", args.adId).eq("date", args.date)
      )
      .first();

    if (existing) {
      const patch: Record<string, unknown> = {
        impressions: args.impressions,
        clicks: args.clicks,
        spent: args.spent,
        leads: args.leads,
      };
      if (args.reach !== undefined) patch.reach = args.reach;
      if (args.vkResult !== undefined) patch.vkResult = args.vkResult;
      if (cpl !== undefined) patch.cpl = cpl;
      if (ctr !== undefined) patch.ctr = ctr;
      if (cpc !== undefined) patch.cpc = cpc;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("metricsDaily", {
      accountId: args.accountId,
      adId: args.adId,
      date: args.date,
      impressions: args.impressions,
      clicks: args.clicks,
      spent: args.spent,
      leads: args.leads,
      reach: args.reach,
      vkResult: args.vkResult,
      cpl,
      ctr,
      cpc,
    });
  },
});

// Query: latest realtime metrics for an ad
export const getRealtimeByAd = query({
  args: {
    adId: v.string(),
  },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("metricsRealtime")
      .withIndex("by_adId", (q) => q.eq("adId", args.adId))
      .order("desc")
      .take(1);
    return records[0] ?? null;
  },
});

// Query: daily metrics for an ad by date range
export const getDailyByAd = query({
  args: {
    adId: v.string(),
    dateFrom: v.optional(v.string()),
    dateTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const q = ctx.db
      .query("metricsDaily")
      .withIndex("by_adId_date", (q) => q.eq("adId", args.adId));

    const results = await q.collect();

    // Filter by date range if specified
    return results.filter((r) => {
      if (args.dateFrom && r.date < args.dateFrom) return false;
      if (args.dateTo && r.date > args.dateTo) return false;
      return true;
    });
  },
});

// Query: daily metrics for an account by date
export const getDailyByAccount = query({
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

// ── Cleanup: batch delete old metricsRealtime records ──

export const deleteRealtimeBatch = internalMutation({
  args: { batchSize: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const records = await ctx.db
      .query("metricsRealtime")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", cutoff))
      .take(args.batchSize);
    for (const record of records) {
      await ctx.db.delete(record._id);
    }
    return { deleted: records.length, hasMore: records.length === args.batchSize };
  },
});

export const cleanupOldRealtimeMetrics = internalAction({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

    // Guard: skip if already running, override if zombie (>12h)
    const hb = await ctx.runQuery(internal.syncMetrics.getCronHeartbeat, {
      name: "cleanup-realtime-metrics",
    });
    if (hb?.status === "running") {
      const elapsed = Date.now() - hb.startedAt;
      const minutesAgo = Math.round(elapsed / 60_000);
      if (elapsed < CLEANUP_MAX_RUNNING_MS) {
        console.log(
          `[cleanup-realtime] Already running (started ${minutesAgo}min ago), skipping`
        );
        return;
      }
      console.warn(
        `[cleanup-realtime] Previous run STUCK (${minutesAgo}min ago, >720min). Overriding.`
      );
    }

    await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
      name: "cleanup-realtime-metrics",
      status: "running",
    });

    let runningTotal = 0;
    let batchCount = 0;
    const startedAt = Date.now();

    try {
      while (true) {
        const batch = await ctx.runMutation(internal.metrics.deleteRealtimeBatch, {
          batchSize,
        });
        runningTotal += batch.deleted;
        batchCount++;

        if (batchCount % LOG_EVERY_N_BATCHES === 0) {
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = Math.round(runningTotal / (elapsed / 60));
          console.log(
            `[cleanup-realtime] Progress: deleted ${runningTotal}, rate ~${rate}/min, elapsed ${Math.round(elapsed)}s`
          );
        }

        if (!batch.hasMore) break;
        await sleep(BATCH_DELAY_MS);
      }

      const elapsed = (Date.now() - startedAt) / 1000;
      console.log(
        `[cleanup-realtime] Complete. Deleted ${runningTotal} records in ${Math.round(elapsed)}s (~${Math.round(elapsed / 60)} min)`
      );

      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "cleanup-realtime-metrics",
        status: "completed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[cleanup-realtime] ERROR: ${message}. Stopped at ${runningTotal} deleted. Will retry next cron cycle.`
      );
      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "cleanup-realtime-metrics",
        status: "failed",
        error: message,
      });
    }
  },
});
