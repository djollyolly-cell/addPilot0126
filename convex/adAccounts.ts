import { v } from "convex/values";
import { mutation, query, action } from "./_generated/server";
import { api } from "./_generated/api";

// List all ad accounts for a user
export const list = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

// Get a single ad account by ID
export const get = query({
  args: {
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.accountId);
  },
});

// Connect a new ad account
export const connect = mutation({
  args: {
    userId: v.id("users"),
    vkAccountId: v.string(),
    name: v.string(),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Check if account already connected
    const existing = await ctx.db
      .query("adAccounts")
      .withIndex("by_vkAccountId", (q) => q.eq("vkAccountId", args.vkAccountId))
      .first();

    if (existing && existing.userId === args.userId) {
      // Update existing account
      const patch: Record<string, unknown> = {
        name: args.name,
        accessToken: args.accessToken,
        status: "active" as const,
      };
      if (args.refreshToken !== undefined) {
        patch.refreshToken = args.refreshToken;
      }
      if (args.tokenExpiresAt !== undefined) {
        patch.tokenExpiresAt = args.tokenExpiresAt;
      }
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    if (existing) {
      throw new Error("Этот кабинет уже подключён другим пользователем");
    }

    // Check tier limits
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("Пользователь не найден");

    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const tierLimits: Record<string, number> = {
      freemium: 1,
      start: 3,
      pro: Infinity,
    };

    const limit = tierLimits[user.subscriptionTier] ?? 1;
    if (accounts.length >= limit) {
      throw new Error(`Лимит кабинетов для тарифа "${user.subscriptionTier}" исчерпан (${limit})`);
    }

    const accountId = await ctx.db.insert("adAccounts", {
      userId: args.userId,
      vkAccountId: args.vkAccountId,
      name: args.name,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: args.tokenExpiresAt,
      status: "active",
      createdAt: Date.now(),
    });

    return accountId;
  },
});

// Disconnect (delete) an ad account and its related data
export const disconnect = mutation({
  args: {
    accountId: v.id("adAccounts"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) {
      throw new Error("Кабинет не найден");
    }
    if (account.userId !== args.userId) {
      throw new Error("Нет доступа к этому кабинету");
    }

    // Delete related campaigns
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();

    for (const campaign of campaigns) {
      // Delete ads for each campaign
      const ads = await ctx.db
        .query("ads")
        .withIndex("by_campaignId", (q) => q.eq("campaignId", campaign._id))
        .collect();
      for (const ad of ads) {
        await ctx.db.delete(ad._id);
      }
      await ctx.db.delete(campaign._id);
    }

    // Delete the account itself
    await ctx.db.delete(args.accountId);

    return { success: true };
  },
});

// Update account status
export const updateStatus = mutation({
  args: {
    accountId: v.id("adAccounts"),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("error")),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      status: args.status,
      lastError: args.lastError,
    });
  },
});

// Sync account data from VK API
export const syncNow = action({
  args: {
    accountId: v.id("adAccounts"),
    userId: v.id("users"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; campaigns: number; ads: number }> => {
    // Get the account
    const account = await ctx.runQuery(api.adAccounts.get, {
      accountId: args.accountId,
    });

    if (!account) {
      throw new Error("Кабинет не найден");
    }

    if (account.userId !== args.userId) {
      throw new Error("Нет доступа к этому кабинету");
    }

    try {
      // Fetch campaigns from VK API
      const vkCampaigns: Array<{ id: number; name: string; status: number; day_limit: string; all_limit: string }> =
        await ctx.runAction(api.vkApi.getCampaigns, {
          accessToken: account.accessToken,
          accountId: account.vkAccountId,
        });

      // Upsert campaigns
      for (const vkCampaign of vkCampaigns) {
        await ctx.runMutation(api.adAccounts.upsertCampaign, {
          accountId: args.accountId,
          vkCampaignId: String(vkCampaign.id),
          name: vkCampaign.name,
          status: String(vkCampaign.status),
          dailyLimit: parseFloat(vkCampaign.day_limit) || undefined,
          allLimit: parseFloat(vkCampaign.all_limit) || undefined,
        });
      }

      // Fetch ads from VK API
      const vkAds: Array<{ id: number; campaign_id: number; name: string; status: number; approved: string }> =
        await ctx.runAction(api.vkApi.getAds, {
          accessToken: account.accessToken,
          accountId: account.vkAccountId,
        });

      // Upsert ads
      for (const vkAd of vkAds) {
        // Find the campaign in our DB
        const campaign = await ctx.runQuery(api.adAccounts.getCampaignByVkId, {
          accountId: args.accountId,
          vkCampaignId: String(vkAd.campaign_id),
        });

        if (campaign) {
          await ctx.runMutation(api.adAccounts.upsertAd, {
            accountId: args.accountId,
            campaignId: campaign._id,
            vkAdId: String(vkAd.id),
            name: vkAd.name,
            status: String(vkAd.status),
            approved: vkAd.approved,
          });
        }
      }

      // Update sync timestamp
      await ctx.runMutation(api.adAccounts.updateSyncTime, {
        accountId: args.accountId,
      });

      return { success: true, campaigns: vkCampaigns.length, ads: vkAds.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Неизвестная ошибка";

      if (message === "TOKEN_EXPIRED") {
        await ctx.runMutation(api.adAccounts.updateStatus, {
          accountId: args.accountId,
          status: "error",
          lastError: "Токен истёк. Переавторизуйтесь.",
        });
        throw new Error("Токен истёк. Переавторизуйтесь.");
      }

      await ctx.runMutation(api.adAccounts.updateStatus, {
        accountId: args.accountId,
        status: "error",
        lastError: message,
      });
      throw new Error(`Ошибка VK API: ${message}`);
    }
  },
});

// Helper mutations for sync

export const upsertCampaign = mutation({
  args: {
    accountId: v.id("adAccounts"),
    vkCampaignId: v.string(),
    name: v.string(),
    status: v.string(),
    dailyLimit: v.optional(v.number()),
    allLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("campaigns")
      .withIndex("by_vkCampaignId", (q) => q.eq("vkCampaignId", args.vkCampaignId))
      .first();

    if (existing) {
      const patch: Record<string, unknown> = {
        name: args.name,
        status: args.status,
        updatedAt: Date.now(),
      };
      if (args.dailyLimit !== undefined) {
        patch.dailyLimit = args.dailyLimit;
      }
      if (args.allLimit !== undefined) {
        patch.allLimit = args.allLimit;
      }
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("campaigns", {
      accountId: args.accountId,
      vkCampaignId: args.vkCampaignId,
      name: args.name,
      status: args.status,
      dailyLimit: args.dailyLimit,
      allLimit: args.allLimit,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const getCampaignByVkId = query({
  args: {
    accountId: v.id("adAccounts"),
    vkCampaignId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("campaigns")
      .withIndex("by_vkCampaignId", (q) => q.eq("vkCampaignId", args.vkCampaignId))
      .first();
  },
});

export const upsertAd = mutation({
  args: {
    accountId: v.id("adAccounts"),
    campaignId: v.id("campaigns"),
    vkAdId: v.string(),
    name: v.string(),
    status: v.string(),
    approved: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("ads")
      .withIndex("by_vkAdId", (q) => q.eq("vkAdId", args.vkAdId))
      .first();

    if (existing) {
      const patch: Record<string, unknown> = {
        name: args.name,
        status: args.status,
        updatedAt: Date.now(),
      };
      if (args.approved !== undefined) {
        patch.approved = args.approved;
      }
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("ads", {
      accountId: args.accountId,
      campaignId: args.campaignId,
      vkAdId: args.vkAdId,
      name: args.name,
      status: args.status,
      approved: args.approved,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const updateSyncTime = mutation({
  args: {
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      lastSyncAt: Date.now(),
      status: "active" as const,
    });
  },
});
