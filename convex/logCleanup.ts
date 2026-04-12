import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Ежедневная очистка старых логов.
 * systemLogs: 30 дней, auditLog: 90 дней, adminAlertDedup: 1 день.
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
