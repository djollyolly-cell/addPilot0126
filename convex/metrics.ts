import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import { mutation, query, internalMutation, internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

// ── Cleanup constants ──
const RETENTION_DAYS = 2;
const CLEANUP_MAX_RUNNING_MS = 12 * 60 * 60 * 1000; // 12h zombie threshold
const METRICS_REALTIME_CLEANUP_V2_NAME = "metrics-realtime-v2";
const METRICS_REALTIME_CLEANUP_V2_CUTOFF_MS = RETENTION_DAYS * 86_400_000;
type CleanupRunStateV2 = Doc<"cleanupRunState">;
type DeleteRealtimeBatchResult = { deleted: number; hasMore: boolean };
type RecordBatchProgressV2Result = {
  batchesRun: number;
  deletedCount: number;
  lastBatchAt: number;
  hasMore: boolean;
} | null;
type ManualMassCleanupV2Result =
  | { status: "disabled_mid_chain" }
  | { status: "noop" }
  | { status: "schedule" | "complete"; deleted: number; hasMore: boolean }
  | { status: "failed"; error: string };
type CleanupWorkerV2Ref = FunctionReference<"action", "internal", { runId: string }, unknown>;
type CleanupStateQueryV2Ref = FunctionReference<"query", "internal", { runId: string }, CleanupRunStateV2 | null>;
type MarkRunningV2Ref = FunctionReference<"mutation", "internal", { runId: string; lastBatchAt: number }, unknown>;
type DeleteRealtimeBatchRef = FunctionReference<"mutation", "internal", { batchSize: number; cutoffMs?: number }, DeleteRealtimeBatchResult>;
type RecordBatchProgressV2Ref = FunctionReference<"mutation", "internal", { runId: string; deleted: number; hasMore: boolean }, RecordBatchProgressV2Result>;
type ScheduleNextChunkV2Ref = FunctionReference<"mutation", "internal", { runId: string }, unknown>;
type MarkCompletedV2Ref = FunctionReference<"mutation", "internal", { runId: string }, unknown>;
type MarkFailedV2Ref = FunctionReference<"mutation", "internal", { runId: string; error: string }, unknown>;
type TriggerMassCleanupV2Result =
  | { status: "disabled" }
  | { status: "already-running"; runId: string }
  | { status: "scheduled"; runId: string };
type TriggerMassCleanupV2Ref = FunctionReference<
  "mutation",
  "internal",
  { batchSize: number; timeBudgetMs: number; restMs: number; maxRuns: number },
  TriggerMassCleanupV2Result
>;

function isMetricsRealtimeCleanupV2Enabled(): boolean {
  return process.env.METRICS_REALTIME_CLEANUP_V2_ENABLED === "1";
}

function makeCleanupRunId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const randomHex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${Date.now()}-${randomHex}`;
}

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

      // Metrics changed: update with latest API data
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
    let inserted = 0, patched = 0, skipped = 0;
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

        if (!metricsChanged) { skipped++; continue; }

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
        patched++;
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
        inserted++;
      }
    }
    return { inserted, patched, skipped };
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
  args: {
    batchSize: v.number(),
    cutoffMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cutoff = args.cutoffMs ?? Date.now() - METRICS_REALTIME_CLEANUP_V2_CUTOFF_MS;
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

// ── Storage Cleanup V2: bounded metricsRealtime cleanup (env-gated, cron disabled) ──

export const triggerMassCleanupV2 = internalMutation({
  args: {
    batchSize: v.number(),
    timeBudgetMs: v.number(),
    restMs: v.number(),
    maxRuns: v.number(),
  },
  handler: async (ctx, args) => {
    if (!isMetricsRealtimeCleanupV2Enabled()) {
      console.log("[cleanup-v2] skip reason=disabled");
      return { status: "disabled" as const };
    }

    const active = await ctx.db
      .query("cleanupRunState")
      .withIndex("by_cleanupName_isActive", (q) =>
        q.eq("cleanupName", METRICS_REALTIME_CLEANUP_V2_NAME).eq("isActive", true)
      )
      .first();
    if (active) {
      return { status: "already-running" as const, runId: active.runId };
    }

    const now = Date.now();
    const runId = makeCleanupRunId();
    await ctx.db.insert("cleanupRunState", {
      cleanupName: METRICS_REALTIME_CLEANUP_V2_NAME,
      runId,
      state: "claimed",
      isActive: true,
      startedAt: now,
      batchesRun: 0,
      maxRuns: args.maxRuns,
      cutoffUsed: now - METRICS_REALTIME_CLEANUP_V2_CUTOFF_MS,
      deletedCount: 0,
      batchSize: args.batchSize,
      timeBudgetMs: args.timeBudgetMs,
      restMs: args.restMs,
    });
    await ctx.scheduler.runAfter(0, internal.metrics.manualMassCleanupV2 as CleanupWorkerV2Ref, { runId });
    return { status: "scheduled" as const, runId };
  },
});

export const getCleanupRunStateV2 = internalQuery({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cleanupRunState")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .first();
  },
});

export const markRunningV2 = internalMutation({
  args: { runId: v.string(), lastBatchAt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cleanupRunState")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .first();
    if (!row || !row.isActive) return { status: "noop" as const };
    await ctx.db.patch(row._id, {
      state: "running",
      lastBatchAt: args.lastBatchAt,
    });
    return { status: "running" as const };
  },
});

export const recordBatchProgressV2 = internalMutation({
  args: {
    runId: v.string(),
    deleted: v.number(),
    hasMore: v.boolean(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cleanupRunState")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .first();
    if (!row || !row.isActive) return null;

    const now = Date.now();
    const batchesRun = row.batchesRun + 1;
    const deletedCount = row.deletedCount + args.deleted;
    await ctx.db.patch(row._id, {
      batchesRun,
      deletedCount,
      lastBatchAt: now,
    });
    return {
      batchesRun,
      deletedCount,
      lastBatchAt: now,
      hasMore: args.hasMore,
    };
  },
});

export const scheduleNextChunkV2 = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cleanupRunState")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .first();
    if (!row || !row.isActive) return { scheduled: false };

    await ctx.scheduler.runAfter(row.restMs, internal.metrics.manualMassCleanupV2 as CleanupWorkerV2Ref, {
      runId: args.runId,
    });
    return { scheduled: true };
  },
});

export const markCompletedV2 = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cleanupRunState")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .first();
    if (!row || !row.isActive) return { status: "noop" as const };

    const oldestRemaining = await ctx.db
      .query("metricsRealtime")
      .withIndex("by_timestamp")
      .order("asc")
      .first();

    const patch: {
      state: "completed";
      isActive: false;
      durationMs: number;
      oldestRemainingTimestamp?: number;
    } = {
      state: "completed",
      isActive: false,
      durationMs: Date.now() - row.startedAt,
    };
    if (oldestRemaining) {
      patch.oldestRemainingTimestamp = oldestRemaining.timestamp;
    }
    await ctx.db.patch(row._id, patch);
    return { status: "completed" as const };
  },
});

export const markFailedV2 = internalMutation({
  args: { runId: v.string(), error: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cleanupRunState")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .first();
    if (!row || !row.isActive) return { status: "noop" as const };

    await ctx.db.patch(row._id, {
      state: "failed",
      isActive: false,
      error: args.error,
      durationMs: Date.now() - row.startedAt,
    });
    return { status: "failed" as const };
  },
});

export const cleanupOldRealtimeMetricsV2 = internalAction({
  args: {
    batchSize: v.number(),
    timeBudgetMs: v.number(),
    restMs: v.number(),
    maxRuns: v.number(),
  },
  handler: async (ctx, args): Promise<TriggerMassCleanupV2Result> => {
    const env = isMetricsRealtimeCleanupV2Enabled() ? "1" : "0";
    const tickAt = new Date().toISOString();
    console.log(`[cleanup-v2] cron tick at ${tickAt}; env=${env}`);

    const result = await ctx.runMutation(internal.metrics.triggerMassCleanupV2 as TriggerMassCleanupV2Ref, args);

    if (result.status === "already-running") {
      console.log(`[cleanup-v2] cron tick at ${tickAt}; skipped, run ${result.runId} still active`);
    } else {
      console.log(`[cleanup-v2] cron tick at ${tickAt}; result=${result.status}`);
    }
    return result;
  },
});

export const manualMassCleanupV2 = internalAction({
  args: { runId: v.string() },
  handler: async (ctx, args): Promise<ManualMassCleanupV2Result> => {
    if (!isMetricsRealtimeCleanupV2Enabled()) {
      await ctx.runMutation(internal.metrics.markFailedV2 as MarkFailedV2Ref, {
        runId: args.runId,
        error: "disabled_mid_chain",
      });
      console.log(`[cleanup-v2] runId=${args.runId} skip reason=disabled_mid_chain`);
      return { status: "disabled_mid_chain" as const };
    }

    const startedAt = Date.now();
    try {
      const state = await ctx.runQuery(internal.metrics.getCleanupRunStateV2 as CleanupStateQueryV2Ref, {
        runId: args.runId,
      });
      if (!state || !state.isActive || state.state === "completed" || state.state === "failed") {
        return { status: "noop" as const };
      }

      console.log(
        `[cleanup-v2] start runId=${args.runId} batchesRun_pre=${state.batchesRun} cutoffUsed=${state.cutoffUsed} batchSize=${state.batchSize}`
      );
      await ctx.runMutation(internal.metrics.markRunningV2 as MarkRunningV2Ref, {
        runId: args.runId,
        lastBatchAt: startedAt,
      });

      const result = await ctx.runMutation(internal.metrics.deleteRealtimeBatch as DeleteRealtimeBatchRef, {
        batchSize: state.batchSize,
        cutoffMs: state.cutoffUsed,
      });
      const updated = await ctx.runMutation(internal.metrics.recordBatchProgressV2 as RecordBatchProgressV2Ref, {
        runId: args.runId,
        deleted: result.deleted,
        hasMore: result.hasMore,
      });

      if (!updated) {
        return { status: "noop" as const };
      }

      const shouldSchedule = updated.batchesRun < state.maxRuns && result.hasMore;
      if (shouldSchedule) {
        await ctx.runMutation(internal.metrics.scheduleNextChunkV2 as ScheduleNextChunkV2Ref, { runId: args.runId });
      } else {
        await ctx.runMutation(internal.metrics.markCompletedV2 as MarkCompletedV2Ref, { runId: args.runId });
      }

      const decision = shouldSchedule ? "schedule" : "complete";
      console.log(
        `[cleanup-v2] end runId=${args.runId} deleted=${result.deleted} durationMs=${Date.now() - startedAt} hasMore=${result.hasMore} decision=${decision}`
      );
      return {
        status: decision as "schedule" | "complete",
        deleted: result.deleted,
        hasMore: result.hasMore,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.metrics.markFailedV2 as MarkFailedV2Ref, {
        runId: args.runId,
        error: message,
      });
      console.log(
        `[cleanup-v2] end runId=${args.runId} deleted=0 durationMs=${Date.now() - startedAt} hasMore=false decision=failed`
      );
      return { status: "failed" as const, error: message };
    }
  },
});

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
  handler: async (_ctx, _args) => {
    // EMERGENCY DRAIN MODE: permanent no-op. The V1 cleanup body is abandoned;
    // Storage Cleanup V2 owns all future metricsRealtime cleanup work.
    return;
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
