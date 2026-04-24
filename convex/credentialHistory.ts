import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Fields that can NEVER be set to empty/undefined once they have a value
const PROTECTED_FIELDS = ["clientId", "clientSecret"] as const;

// All tracked credential fields
const TRACKED_FIELDS = ["clientId", "clientSecret", "accessToken", "refreshToken"] as const;

/**
 * Log credential changes before they happen.
 * Call this BEFORE patching the account.
 */
export const logChanges = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    changes: v.any(), // Record<string, string | undefined>
    changedBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;

    const changes = args.changes as Record<string, string | undefined>;

    for (const field of TRACKED_FIELDS) {
      if (!(field in changes)) continue;

      const oldValue = (account as Record<string, unknown>)[field] as string | undefined;
      const newValue = changes[field];

      // Skip if no actual change
      if (oldValue === newValue) continue;

      // Mask secrets — store only first 4 + last 4 chars
      const maskValue = (val: string | undefined) => {
        if (!val) return undefined;
        if (field === "accessToken" || field === "refreshToken" || field === "clientSecret") {
          if (val.length <= 8) return "***";
          return val.slice(0, 4) + "..." + val.slice(-4);
        }
        return val;
      };

      await ctx.db.insert("credentialHistory", {
        accountId: args.accountId,
        field,
        oldValue: maskValue(oldValue),
        newValue: maskValue(newValue),
        changedAt: Date.now(),
        changedBy: args.changedBy,
      });
    }
  },
});

/**
 * Validate that protected fields (clientId, clientSecret) are not being wiped.
 * Returns an error message if validation fails, or null if OK.
 */
export const validateCredentialChange = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    changes: v.any(),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<string | null> => {
    if (args.force) return null;

    const account = await ctx.db.get(args.accountId);
    if (!account) return null;

    const changes = args.changes as Record<string, string | undefined>;

    for (const field of PROTECTED_FIELDS) {
      if (!(field in changes)) continue;

      const oldValue = (account as Record<string, unknown>)[field] as string | undefined;
      const newValue = changes[field];

      // Block: has value → setting to empty/undefined
      if (oldValue && !newValue) {
        return `Нельзя очистить ${field} — используйте force:true если уверены`;
      }
    }

    return null;
  },
});

/**
 * Clean up token history older than 10 days.
 * clientId/clientSecret records are kept forever.
 */
export const cleanupOldTokenHistory = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    let deleted = 0;

    // Only delete accessToken and refreshToken records, batch 500 per field
    for (const field of ["accessToken", "refreshToken"] as const) {
      const old = await ctx.db
        .query("credentialHistory")
        .withIndex("by_field_changedAt", (q) =>
          q.eq("field", field).lt("changedAt", tenDaysAgo)
        )
        .take(500);

      for (const record of old) {
        await ctx.db.delete(record._id);
        deleted++;
      }
    }

    if (deleted > 0) {
      console.log(`[credentialHistory] Cleaned up ${deleted} old token records`);
    }
    return { deleted };
  },
});

/**
 * Get credential history for an account (for diagnostics/recovery).
 */
export const getHistory = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("credentialHistory")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .order("desc")
      .take(50);
  },
});
