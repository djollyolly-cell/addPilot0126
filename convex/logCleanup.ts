import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Ежедневная очистка старых логов.
 * systemLogs: 10 дней, auditLog: 10 дней, adminAlertDedup: 1 день,
 * vkApiLimits: 7 дней, healthCheckResults: 30 дней, expired sessions.
 */
export const runDaily = internalMutation({
  handler: async (ctx) => {
    const sys = await ctx.runMutation(internal.systemLogger.cleanupOld);
    const audit = await ctx.runMutation(internal.auditLog.cleanupOld);
    const dedup = await ctx.runMutation(internal.adminAlerts.cleanupDedup);
    const vkLimits = await ctx.runMutation(internal.logCleanup.cleanupOldVkApiLimits);
    const health = await ctx.runMutation(internal.logCleanup.cleanupOldHealthCheckResults);
    const sessions = await ctx.runMutation(internal.logCleanup.cleanupExpiredSessions);
    const actionLogs = await ctx.runMutation(internal.logCleanup.cleanupOldActionLogs);

    console.log(
      `[logCleanup] systemLogs: ${sys.deleted}, auditLog: ${audit.deleted}, dedup: ${dedup.deleted}, ` +
      `vkApiLimits: ${vkLimits.deleted}, healthCheck: ${health.deleted}, sessions: ${sessions.deleted}, ` +
      `actionLogs: ${actionLogs.deleted}`
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

// ─── Cleanup vkApiLimits (7 дней), batch 2000 ───

export const cleanupOldVkApiLimits = internalMutation({
  handler: async (ctx) => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("vkApiLimits")
      .withIndex("by_capturedAt", (q) => q.lt("capturedAt", sevenDaysAgo))
      .take(2000);
    for (const doc of old) {
      await ctx.db.delete(doc._id);
    }
    if (old.length > 0) {
      console.log(`[logCleanup] vkApiLimits: deleted ${old.length} records older than 7 days`);
    }
    return { deleted: old.length };
  },
});

// ─── Cleanup healthCheckResults (30 дней), batch 500 ───

export const cleanupOldHealthCheckResults = internalMutation({
  handler: async (ctx) => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("healthCheckResults")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", thirtyDaysAgo))
      .take(500);
    for (const doc of old) {
      await ctx.db.delete(doc._id);
    }
    if (old.length > 0) {
      console.log(`[logCleanup] healthCheckResults: deleted ${old.length} records older than 30 days`);
    }
    return { deleted: old.length };
  },
});

// ─── Cleanup expired sessions, batch 1000 ───

export const cleanupExpiredSessions = internalMutation({
  handler: async (ctx) => {
    const now = Date.now();
    // Sessions don't have a by_expiresAt index, scan and filter
    const all = await ctx.db.query("sessions").collect();
    const expired = all.filter((s) => s.expiresAt < now);
    const batch = expired.slice(0, 1000);
    for (const doc of batch) {
      await ctx.db.delete(doc._id);
    }
    if (batch.length > 0) {
      console.log(`[logCleanup] sessions: deleted ${batch.length} expired (of ${expired.length} total expired)`);
    }
    return { deleted: batch.length };
  },
});
