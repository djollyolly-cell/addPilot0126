import { v } from "convex/values";
import { query, internalQuery, internalMutation } from "./_generated/server";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// Generation limits per tier per month
export const GENERATION_LIMITS: Record<string, Record<string, number>> = {
  freemium: { text: 5, image: 2, analysis: 0 },
  start: { text: 50, image: 20, analysis: 5 },
  pro: { text: 200, image: 50, analysis: 20 },
};

// Record a generation (internal — called after successful generation)
export const recordGeneration = internalMutation({
  args: {
    userId: v.id("users"),
    type: v.union(v.literal("text"), v.literal("image"), v.literal("analysis")),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("aiGenerations", {
      userId: args.userId,
      type: args.type,
      createdAt: Date.now(),
    });
  },
});

// Get usage count this month (internal — for limit checks in actions)
export const getUsageInternal = internalQuery({
  args: {
    userId: v.id("users"),
    type: v.union(v.literal("text"), v.literal("image"), v.literal("analysis")),
  },
  handler: async (ctx, args) => {
    const monthAgo = Date.now() - MONTH_MS;
    const records = await ctx.db
      .query("aiGenerations")
      .withIndex("by_userId_type", (q) =>
        q.eq("userId", args.userId).eq("type", args.type)
      )
      .collect();
    return records.filter((r) => r.createdAt >= monthAgo).length;
  },
});

// Get all usage for display in frontend
export const getUsage = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const monthAgo = Date.now() - MONTH_MS;
    const all = await ctx.db
      .query("aiGenerations")
      .withIndex("by_userId_type", (q) => q.eq("userId", args.userId))
      .collect();
    const thisMonth = all.filter((r) => r.createdAt >= monthAgo);

    return {
      text: thisMonth.filter((r) => r.type === "text").length,
      image: thisMonth.filter((r) => r.type === "image").length,
      analysis: thisMonth.filter((r) => r.type === "analysis").length,
    };
  },
});

// Cleanup old records (older than 35 days — must cover 30-day usage window)
export const cleanupOldRecords = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("aiGenerations")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(500);
    for (const record of old) {
      await ctx.db.delete(record._id);
    }
    if (old.length > 0) {
      console.log(`[aiLimits cleanup] Deleted ${old.length} old generation records`);
    }
  },
});
