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
