import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";

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

// Internal: get user settings (for cron/internal use)
export const getInternal = internalQuery({
  args: { userId: v.id("users") },
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

// Set quiet hours for a user
export const setQuietHours = mutation({
  args: {
    userId: v.id("users"),
    enabled: v.boolean(),
    start: v.optional(v.string()), // "HH:MM" format
    end: v.optional(v.string()),   // "HH:MM" format
  },
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (!settings) {
      // Create default settings with quiet hours
      await ctx.db.insert("userSettings", {
        userId: args.userId,
        quietHoursEnabled: args.enabled,
        quietHoursStart: args.start,
        quietHoursEnd: args.end,
        timezone: "Europe/Moscow",
        digestEnabled: true,
        digestTime: "09:00",
        language: "ru",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { success: true };
    }

    await ctx.db.patch(settings._id, {
      quietHoursEnabled: args.enabled,
      quietHoursStart: args.start,
      quietHoursEnd: args.end,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

// Set digest preferences for a user
export const setDigestEnabled = mutation({
  args: {
    userId: v.id("users"),
    enabled: v.boolean(),
    time: v.optional(v.string()), // "HH:MM" format
  },
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (!settings) {
      await ctx.db.insert("userSettings", {
        userId: args.userId,
        quietHoursEnabled: false,
        timezone: "Europe/Moscow",
        digestEnabled: args.enabled,
        digestTime: args.time ?? "09:00",
        language: "ru",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { success: true };
    }

    const patch: Record<string, unknown> = {
      digestEnabled: args.enabled,
      updatedAt: Date.now(),
    };
    if (args.time) patch.digestTime = args.time;

    await ctx.db.patch(settings._id, patch);
    return { success: true };
  },
});
