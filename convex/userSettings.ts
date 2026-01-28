import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

// Get user settings by userId
export const get = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
  },
});

// Set the active ad account for a user
export const setActiveAccount = mutation({
  args: {
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    // Validate account belongs to user
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== args.userId) {
      throw new Error("Кабинет не найден или не принадлежит пользователю");
    }

    const settings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (!settings) {
      throw new Error("Настройки пользователя не найдены");
    }

    await ctx.db.patch(settings._id, {
      activeAccountId: args.accountId,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});
