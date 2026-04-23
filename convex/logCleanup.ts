import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

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

// ─── Cleanup actionLogs (90 дней), batch 500, cron ежедневно ───

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

// ─── Cleanup metricsDaily (90 дней), batch 500, cron каждые 15 мин ───
// Постепенная очистка: 500 × 96/день = ~48 000/день (3% от metricsRealtime churn).
// При бэклоге ~720K записей — очистка за ~15 дней.

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
