import { internalMutation } from "./_generated/server";

/**
 * One-time migration: set proAccountLimit=27 for all current active Pro users.
 * Run via Convex dashboard after deploy.
 *
 * These users had "unlimited" accounts before the limit was introduced.
 * They get a grandfathered limit of 27.
 */
export const setProAccountLimitForExistingUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();

    let updated = 0;
    for (const user of users) {
      if (
        user.subscriptionTier === "pro" &&
        !user.proAccountLimit
      ) {
        await ctx.db.patch(user._id, { proAccountLimit: 27 });
        updated++;
      }
    }

    return { updated, message: `Set proAccountLimit=27 for ${updated} existing Pro users` };
  },
});

/**
 * One-time fix: reset stuck "cleanup-realtime-metrics" heartbeat.
 * Run via Convex dashboard if heartbeat is stuck >12h with status="running".
 * Safe: only resets if currently running and started >12h ago.
 */
export const resetStuckCleanupHeartbeat = internalMutation({
  args: {},
  handler: async (ctx) => {
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    const hb = await ctx.db
      .query("cronHeartbeats")
      .withIndex("by_name", (q) => q.eq("name", "cleanup-realtime-metrics"))
      .first();

    if (!hb) {
      return { reset: false, reason: "no heartbeat found" };
    }
    if (hb.status !== "running") {
      return { reset: false, reason: `status is ${hb.status}, not running` };
    }
    if (Date.now() - hb.startedAt < TWELVE_HOURS_MS) {
      return { reset: false, reason: "heartbeat is recent (<12h)" };
    }

    await ctx.db.patch(hb._id, {
      status: "failed",
      finishedAt: Date.now(),
      error: "Manual reset: stuck >12h, presumed crashed",
    });
    return { reset: true, startedAt: hb.startedAt, ageMs: Date.now() - hb.startedAt };
  },
});
