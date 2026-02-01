import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";

// Save a realtime metrics snapshot for a single ad
export const saveRealtime = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    adId: v.string(),
    spent: v.number(),
    leads: v.number(),
    impressions: v.number(),
    clicks: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("metricsRealtime", {
      accountId: args.accountId,
      adId: args.adId,
      timestamp: Date.now(),
      spent: args.spent,
      leads: args.leads,
      impressions: args.impressions,
      clicks: args.clicks,
    });
  },
});

// Save / upsert daily aggregated metrics for a single ad
export const saveDaily = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    adId: v.string(),
    date: v.string(), // "YYYY-MM-DD"
    impressions: v.number(),
    clicks: v.number(),
    spent: v.number(),
    leads: v.number(),
    reach: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Calculate derived metrics
    const cpl = args.leads > 0 ? args.spent / args.leads : undefined;
    const ctr = args.impressions > 0 ? (args.clicks / args.impressions) * 100 : undefined;
    const cpc = args.clicks > 0 ? args.spent / args.clicks : undefined;

    // Check if daily record already exists
    const existing = await ctx.db
      .query("metricsDaily")
      .withIndex("by_adId_date", (q) =>
        q.eq("adId", args.adId).eq("date", args.date)
      )
      .first();

    if (existing) {
      // Update existing record (overwrite with latest API data)
      const patch: Record<string, unknown> = {
        impressions: args.impressions,
        clicks: args.clicks,
        spent: args.spent,
        leads: args.leads,
      };
      if (args.reach !== undefined) patch.reach = args.reach;
      if (cpl !== undefined) patch.cpl = cpl;
      if (ctr !== undefined) patch.ctr = ctr;
      if (cpc !== undefined) patch.cpc = cpc;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("metricsDaily", {
      accountId: args.accountId,
      adId: args.adId,
      date: args.date,
      impressions: args.impressions,
      clicks: args.clicks,
      spent: args.spent,
      leads: args.leads,
      reach: args.reach,
      cpl,
      ctr,
      cpc,
    });
  },
});

// Public mutation wrappers for testing (delegate to internal)
export const saveRealtimePublic = mutation({
  args: {
    accountId: v.id("adAccounts"),
    adId: v.string(),
    spent: v.number(),
    leads: v.number(),
    impressions: v.number(),
    clicks: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("metricsRealtime", {
      accountId: args.accountId,
      adId: args.adId,
      timestamp: Date.now(),
      spent: args.spent,
      leads: args.leads,
      impressions: args.impressions,
      clicks: args.clicks,
    });
  },
});

export const saveDailyPublic = mutation({
  args: {
    accountId: v.id("adAccounts"),
    adId: v.string(),
    date: v.string(),
    impressions: v.number(),
    clicks: v.number(),
    spent: v.number(),
    leads: v.number(),
    reach: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cpl = args.leads > 0 ? args.spent / args.leads : undefined;
    const ctr = args.impressions > 0 ? (args.clicks / args.impressions) * 100 : undefined;
    const cpc = args.clicks > 0 ? args.spent / args.clicks : undefined;

    const existing = await ctx.db
      .query("metricsDaily")
      .withIndex("by_adId_date", (q) =>
        q.eq("adId", args.adId).eq("date", args.date)
      )
      .first();

    if (existing) {
      const patch: Record<string, unknown> = {
        impressions: args.impressions,
        clicks: args.clicks,
        spent: args.spent,
        leads: args.leads,
      };
      if (args.reach !== undefined) patch.reach = args.reach;
      if (cpl !== undefined) patch.cpl = cpl;
      if (ctr !== undefined) patch.ctr = ctr;
      if (cpc !== undefined) patch.cpc = cpc;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("metricsDaily", {
      accountId: args.accountId,
      adId: args.adId,
      date: args.date,
      impressions: args.impressions,
      clicks: args.clicks,
      spent: args.spent,
      leads: args.leads,
      reach: args.reach,
      cpl,
      ctr,
      cpc,
    });
  },
});

// Query: latest realtime metrics for an ad
export const getRealtimeByAd = query({
  args: {
    adId: v.string(),
  },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("metricsRealtime")
      .withIndex("by_adId", (q) => q.eq("adId", args.adId))
      .order("desc")
      .take(1);
    return records[0] ?? null;
  },
});

// Query: daily metrics for an ad by date range
export const getDailyByAd = query({
  args: {
    adId: v.string(),
    dateFrom: v.optional(v.string()),
    dateTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const q = ctx.db
      .query("metricsDaily")
      .withIndex("by_adId_date", (q) => q.eq("adId", args.adId));

    const results = await q.collect();

    // Filter by date range if specified
    return results.filter((r) => {
      if (args.dateFrom && r.date < args.dateFrom) return false;
      if (args.dateTo && r.date > args.dateTo) return false;
      return true;
    });
  },
});

// Query: daily metrics for an account by date
export const getDailyByAccount = query({
  args: {
    accountId: v.id("adAccounts"),
    date: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId).eq("date", args.date)
      )
      .collect();
  },
});
