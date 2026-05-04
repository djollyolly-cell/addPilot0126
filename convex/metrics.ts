import { v } from "convex/values";
import { mutation, query, internalMutation, internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// ── Cleanup constants ──
const RETENTION_DAYS = 2;
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
    campaignType: v.optional(v.string()),
    formEvents: v.optional(v.number()),
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
      const metricsChanged =
        existing.impressions !== args.impressions ||
        existing.clicks !== args.clicks ||
        existing.spent !== args.spent ||
        existing.leads !== args.leads ||
        (args.vkResult !== undefined && existing.vkResult !== args.vkResult) ||
        (args.reach !== undefined && existing.reach !== args.reach) ||
        (args.campaignType !== undefined && existing.campaignType !== args.campaignType) ||
        (args.formEvents !== undefined && existing.formEvents !== args.formEvents) ||
        (args.campaignId !== undefined && existing.campaignId !== args.campaignId);

      if (!metricsChanged) return existing._id;

      // Update existing record (overwrite with latest API data)
      const patch: Record<string, unknown> = {
        impressions: args.impressions,
        clicks: args.clicks,
        spent: args.spent,
        leads: args.leads,
      };
      if (args.vkResult !== undefined) patch.vkResult = args.vkResult;
      if (args.campaignType !== undefined) patch.campaignType = args.campaignType;
      if (args.formEvents !== undefined) patch.formEvents = args.formEvents;
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
      campaignType: args.campaignType,
      formEvents: args.formEvents,
      reach: args.reach,
      cpl,
      ctr,
      cpc,
    });
  },
});

/** Batch save realtime metrics — one mutation for all ads in an account */
export const saveRealtimeBatch = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    items: v.array(v.object({
      adId: v.string(),
      spent: v.number(),
      leads: v.number(),
      impressions: v.number(),
      clicks: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const item of args.items) {
      await ctx.db.insert("metricsRealtime", {
        accountId: args.accountId,
        adId: item.adId,
        timestamp: now,
        spent: item.spent,
        leads: item.leads,
        impressions: item.impressions,
        clicks: item.clicks,
      });
    }
  },
});

/** Batch save daily metrics — one mutation for all ads in an account */
export const saveDailyBatch = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    items: v.array(v.object({
      adId: v.string(),
      campaignId: v.optional(v.string()),
      date: v.string(),
      impressions: v.number(),
      clicks: v.number(),
      spent: v.number(),
      leads: v.number(),
      vkResult: v.optional(v.number()),
      campaignType: v.optional(v.string()),
      formEvents: v.optional(v.number()),
      reach: v.optional(v.number()),
    })),
  },
  handler: async (ctx, args) => {
    for (const item of args.items) {
      const cpl = item.leads > 0 ? item.spent / item.leads : undefined;
      const ctr = item.impressions > 0 ? (item.clicks / item.impressions) * 100 : undefined;
      const cpc = item.clicks > 0 ? item.spent / item.clicks : undefined;

      const existing = await ctx.db
        .query("metricsDaily")
        .withIndex("by_adId_date", (q) =>
          q.eq("adId", item.adId).eq("date", item.date)
        )
        .first();

      if (existing) {
        const metricsChanged =
          existing.impressions !== item.impressions ||
          existing.clicks !== item.clicks ||
          existing.spent !== item.spent ||
          existing.leads !== item.leads ||
          (item.vkResult !== undefined && existing.vkResult !== item.vkResult) ||
          (item.reach !== undefined && existing.reach !== item.reach) ||
          (item.campaignType !== undefined && existing.campaignType !== item.campaignType) ||
          (item.formEvents !== undefined && existing.formEvents !== item.formEvents) ||
          (item.campaignId !== undefined && existing.campaignId !== item.campaignId);

        if (!metricsChanged) continue;

        const patch: Record<string, unknown> = {
          impressions: item.impressions,
          clicks: item.clicks,
          spent: item.spent,
          leads: item.leads,
        };
        if (item.vkResult !== undefined) patch.vkResult = item.vkResult;
        if (item.campaignType !== undefined) patch.campaignType = item.campaignType;
        if (item.formEvents !== undefined) patch.formEvents = item.formEvents;
        if (item.campaignId !== undefined) patch.campaignId = item.campaignId;
        if (item.reach !== undefined) patch.reach = item.reach;
        if (cpl !== undefined) patch.cpl = cpl;
        if (ctr !== undefined) patch.ctr = ctr;
        if (cpc !== undefined) patch.cpc = cpc;
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert("metricsDaily", {
          accountId: args.accountId,
          adId: item.adId,
          campaignId: item.campaignId,
          date: item.date,
          impressions: item.impressions,
          clicks: item.clicks,
          spent: item.spent,
          leads: item.leads,
          vkResult: item.vkResult,
          campaignType: item.campaignType,
          formEvents: item.formEvents,
          reach: item.reach,
          cpl,
          ctr,
          cpc,
        });
      }
    }
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
      const metricsChanged =
        existing.impressions !== args.impressions ||
        existing.clicks !== args.clicks ||
        existing.spent !== args.spent ||
        existing.leads !== args.leads ||
        (args.reach !== undefined && existing.reach !== args.reach) ||
        (args.vkResult !== undefined && existing.vkResult !== args.vkResult);

      if (!metricsChanged) return existing._id;

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
      .withIndex("by_adId_timestamp", (q) => q.eq("adId", args.adId))
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

// ── Mass cleanup: self-scheduling action for large backlogs ──
// Aggressive mode: 3000 records/batch, 500ms between batches, 25s work, 30s rest
// Server has 99% CPU free and 82% RAM free — safe to be aggressive
const MASS_BATCH_SIZE = 3000;
const MASS_TIME_BUDGET_MS = 25 * 1000; // 25s work per run
const MASS_BATCH_DELAY_MS = 500; // 500ms pause between batches
const MASS_REST_BETWEEN_RUNS_MS = 30 * 1000; // 30s rest between runs
const MASS_OCC_RETRY_DELAY_MS = 3000;

// Trigger: schedule mass cleanup and return immediately (won't timeout CLI)
export const triggerMassCleanup = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.metrics.manualMassCleanup, { runNumber: 1 });
    return "Mass cleanup scheduled (gentle mode). Check logs for progress.";
  },
});

export const manualMassCleanup = internalAction({
  args: { runNumber: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const run = args.runNumber ?? 1;
    const startedAt = Date.now();
    let totalDeleted = 0;
    let occErrors = 0;

    // Reset heartbeat on first run
    if (run === 1) {
      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "cleanup-realtime-metrics",
        status: "running",
      });
    }

    while (Date.now() - startedAt < MASS_TIME_BUDGET_MS) {
      try {
        const batch = await ctx.runMutation(internal.metrics.deleteRealtimeBatch, {
          batchSize: MASS_BATCH_SIZE,
        });
        totalDeleted += batch.deleted;

        if (!batch.hasMore) {
          console.log(`[mass-cleanup] DONE! Run #${run}: deleted ${totalDeleted} total. Table is clean.`);
          await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
            name: "cleanup-realtime-metrics",
            status: "completed",
          });
          return;
        }
        // 2s pause between batches — gentle on server
        await sleep(MASS_BATCH_DELAY_MS);
      } catch {
        occErrors++;
        if (occErrors > 5) {
          console.warn(`[mass-cleanup] Run #${run}: too many OCC errors (${occErrors}), pausing. Deleted ${totalDeleted}.`);
          break;
        }
        await sleep(MASS_OCC_RETRY_DELAY_MS);
      }
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[mass-cleanup] Run #${run}: deleted ${totalDeleted} in ${elapsed}s. Next run in 60s...`);

    // 60s rest before next run
    await ctx.scheduler.runAfter(MASS_REST_BETWEEN_RUNS_MS, internal.metrics.manualMassCleanup, {
      runNumber: run + 1,
    });
  },
});

// Cron cleanup: uses self-scheduling via manualMassCleanup to avoid timeout issues.
// Previous approach (infinite while loop) would exceed Convex action timeout on large backlogs,
// leaving heartbeat stuck in "running" state and blocking subsequent cron runs.
export const cleanupOldRealtimeMetrics = internalAction({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx) => {
    // Guard: skip if mass cleanup is already running
    const hb = await ctx.runQuery(internal.syncMetrics.getCronHeartbeat, {
      name: "cleanup-realtime-metrics",
    });
    if (hb?.status === "running") {
      const elapsed = Date.now() - hb.startedAt;
      const minutesAgo = Math.round(elapsed / 60_000);
      if (elapsed < CLEANUP_MAX_RUNNING_MS) {
        console.log(
          `[cleanup-realtime] Mass cleanup already running (started ${minutesAgo}min ago), skipping`
        );
        return;
      }
      console.warn(
        `[cleanup-realtime] Previous run STUCK (${minutesAgo}min ago, >720min). Restarting.`
      );
    }

    // Delegate to self-scheduling mass cleanup — won't timeout
    await ctx.runMutation(internal.metrics.scheduleMassCleanup, {});
    console.log("[cleanup-realtime] Delegated to mass cleanup (self-scheduling mode).");
  },
});

// Helper mutation to schedule mass cleanup (callable from actions)
export const scheduleMassCleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.metrics.manualMassCleanup, { runNumber: 1 });
  },
});

/** Fetch metricsDaily for an account across a date range. Filters out rows with null campaignId. */
export const getByAccountDateRange = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    fromDate: v.string(),
    toDate: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId)
          .gte("date", args.fromDate)
          .lte("date", args.toDate)
      )
      .filter((q) => q.neq(q.field("campaignId"), undefined))
      .collect();
  },
});
