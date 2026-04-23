import { v } from "convex/values";
import { internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ежедневная очистка старых логов.
 * systemLogs: 10 дней, auditLog: 10 дней, adminAlertDedup: 1 день.
 */
export const runDaily = internalMutation({
  handler: async (ctx) => {
    const sys = await ctx.runMutation(internal.systemLogger.cleanupOld);
    const audit = await ctx.runMutation(internal.auditLog.cleanupOld);
    const dedup = await ctx.runMutation(internal.adminAlerts.cleanupDedup);

    console.log(
      `[logCleanup] systemLogs: ${sys.deleted}, auditLog: ${audit.deleted}, dedup: ${dedup.deleted}`
    );
  },
});

// ─── Cleanup actionLogs (90 дней) ───

export const cleanupOldActionLogs = internalMutation({
  handler: async (ctx) => {
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("actionLogs")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", ninetyDaysAgo))
      .take(500);
    for (const doc of old) {
      await ctx.db.delete(doc._id);
    }
    if (old.length > 0) {
      console.log(`[logCleanup] actionLogs: deleted ${old.length} records older than 90 days`);
    }
    return { deleted: old.length };
  },
});

// ─── Cleanup metricsDaily (90 дней) ───
// Batch mutation: deletes up to batchSize records older than 90 days

export const deleteMetricsDailyBatch = internalMutation({
  args: { batchSize: v.number() },
  handler: async (ctx, args) => {
    const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    const old = await ctx.db
      .query("metricsDaily")
      .withIndex("by_date", (q) => q.lt("date", cutoffStr))
      .take(args.batchSize);
    for (const doc of old) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: old.length, hasMore: old.length === args.batchSize };
  },
});

// Mass cleanup: self-scheduling action for large backlog (~720K records)
// 3000 records/batch, 25s work per run, 30s rest between runs
const MASS_BATCH_SIZE = 3000;
const MASS_TIME_BUDGET_MS = 25 * 1000;
const MASS_BATCH_DELAY_MS = 500;
const MASS_REST_BETWEEN_RUNS_MS = 30 * 1000;

export const massCleanupMetricsDaily = internalAction({
  args: { runNumber: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const run = args.runNumber ?? 1;
    const startedAt = Date.now();
    let totalDeleted = 0;
    let occErrors = 0;

    while (Date.now() - startedAt < MASS_TIME_BUDGET_MS) {
      try {
        const batch = await ctx.runMutation(internal.logCleanup.deleteMetricsDailyBatch, {
          batchSize: MASS_BATCH_SIZE,
        });
        totalDeleted += batch.deleted;

        if (!batch.hasMore) {
          console.log(`[metricsDaily-cleanup] DONE! Run #${run}: deleted ${totalDeleted} total.`);
          return;
        }
        await sleep(MASS_BATCH_DELAY_MS);
      } catch {
        occErrors++;
        if (occErrors > 5) {
          console.warn(`[metricsDaily-cleanup] Run #${run}: too many OCC errors (${occErrors}), pausing. Deleted ${totalDeleted}.`);
          break;
        }
        await sleep(3000);
      }
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[metricsDaily-cleanup] Run #${run}: deleted ${totalDeleted} in ${elapsed}s. Next run in 30s...`);

    await ctx.scheduler.runAfter(MASS_REST_BETWEEN_RUNS_MS, internal.logCleanup.massCleanupMetricsDaily, {
      runNumber: run + 1,
    });
  },
});

// Trigger mass cleanup (internal — call from Dashboard or other internal functions)
export const triggerMetricsDailyCleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.logCleanup.massCleanupMetricsDaily, { runNumber: 1 });
    return "metricsDaily mass cleanup scheduled. Check logs for progress.";
  },
});

// Cron entry: runs daily, deletes 500 per run (maintenance after initial mass cleanup)
export const cleanupOldMetricsDaily = internalMutation({
  handler: async (ctx) => {
    const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    const old = await ctx.db
      .query("metricsDaily")
      .withIndex("by_date", (q) => q.lt("date", cutoffStr))
      .take(500);
    for (const doc of old) {
      await ctx.db.delete(doc._id);
    }
    if (old.length > 0) {
      console.log(`[logCleanup] metricsDaily: deleted ${old.length} records before ${cutoffStr}`);
    }
    return { deleted: old.length };
  },
});
