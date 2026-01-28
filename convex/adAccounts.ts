import { v } from "convex/values";
import { mutation, query, action } from "./_generated/server";
import { api, internal } from "./_generated/api";

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

    // Clear activeAccountId if this was the active account
    const settings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (settings && settings.activeAccountId === args.accountId) {
      await ctx.db.patch(settings._id, {
        activeAccountId: undefined,
        updatedAt: Date.now(),
      });
    }

    // Delete the account itself
    await ctx.db.delete(args.accountId);

    return { success: true };
  },
});

// Fetch available accounts: own account + agency clients
export const fetchAvailableAccounts = action({
  args: {
    userId: v.id("users"),
    clientId: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    accounts: Array<{
      id: string;
      name: string;
      type: "own" | "agency_client";
      username: string;
    }>;
  }> => {
    // Step 1: Get token (connectVkAds handles credential priority)
    await ctx.runAction(api.auth.connectVkAds, {
      userId: args.userId,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
    });

    // Step 2: Get valid token
    const accessToken = await ctx.runAction(internal.auth.getValidVkAdsToken, {
      userId: args.userId,
    });

    const accounts: Array<{
      id: string;
      name: string;
      type: "own" | "agency_client";
      username: string;
    }> = [];

    // Step 3: Get own account
    try {
      const user = await ctx.runAction(api.vkApi.getMtUser, { accessToken });
      accounts.push({
        id: `mt_${user.id}`,
        name: user.username || `Аккаунт ${user.id}`,
        type: "own",
        username: user.username,
      });
    } catch {
      // If user endpoint fails, add a generic own account
      accounts.push({
        id: "vk_ads_main",
        name: "Мой кабинет VK Ads",
        type: "own",
        username: "",
      });
    }

    // Step 4: Get agency clients (empty if not agency)
    try {
      const clients = await ctx.runAction(api.vkApi.getMtAgencyClients, { accessToken });
      for (const client of clients) {
        accounts.push({
          id: `mt_client_${client.user.id}`,
          name: client.user.username || `Клиент ${client.user.id}`,
          type: "agency_client",
          username: client.user.username,
        });
      }
    } catch {
      // Silently ignore — not an agency or API error
    }

    return { accounts };
  },
});

// Connect selected accounts from the wizard
export const connectSelectedAccounts = action({
  args: {
    userId: v.id("users"),
    accounts: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
      })
    ),
  },
  handler: async (ctx, args): Promise<{ connected: number }> => {
    // Get valid token
    const accessToken = await ctx.runAction(internal.auth.getValidVkAdsToken, {
      userId: args.userId,
    });

    let connected = 0;
    for (const account of args.accounts) {
      try {
        await ctx.runMutation(api.adAccounts.connect, {
          userId: args.userId,
          vkAccountId: account.id,
          name: account.name,
          accessToken,
        });
        connected++;
      } catch (err) {
        // Skip accounts that are already connected by another user
        if (err instanceof Error && err.message.includes("другим пользователем")) {
          continue;
        }
        // Re-throw limit errors
        if (err instanceof Error && err.message.includes("Лимит")) {
          throw err;
        }
      }
    }

    return { connected };
  },
});

// Fetch VK ad accounts/campaigns using user's stored VK Ads token and connect
export const fetchAndConnect = action({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args): Promise<{ connected: number; accounts: Array<{ account_id: string; account_name: string }> }> => {
    // Get valid VK Ads API token (myTarget)
    const accessToken = await ctx.runAction(internal.auth.getValidVkAdsToken, {
      userId: args.userId,
    });

    // In myTarget API, the token IS the account — no separate accounts list.
    // We create one adAccount entry representing the user's VK Ads cabinet.
    // Then fetch campaigns to verify the token works.
    const campaigns = await ctx.runAction(api.vkApi.getMtCampaigns, {
      accessToken,
    });

    // Connect as a single "VK Ads" account
    const accountName = `VK Ads (${campaigns.length} кампаний)`;
    const accountId = "vk_ads_main";

    try {
      await ctx.runMutation(api.adAccounts.connect, {
        userId: args.userId,
        vkAccountId: accountId,
        name: accountName,
        accessToken,
      });
    } catch (err) {
      // If already connected, update the name
      if (err instanceof Error && err.message.includes("уже подключён")) {
        // Different user owns it — rethrow
        throw err;
      }
    }

    return {
      connected: 1,
      accounts: [{ account_id: accountId, account_name: accountName }],
    };
  },
});

// List campaigns for an account
export const listCampaigns = query({
  args: {
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
});

// List ads for a campaign
export const listAds = query({
  args: {
    campaignId: v.id("campaigns"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ads")
      .withIndex("by_campaignId", (q) => q.eq("campaignId", args.campaignId))
      .collect();
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

// Sync account data from VK Ads API v2 (myTarget)
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
      // Get a valid VK Ads token (myTarget, auto-refreshes if needed)
      const accessToken = await ctx.runAction(internal.auth.getValidVkAdsToken, {
        userId: args.userId,
      });

      // Fetch campaigns from myTarget API
      const mtCampaigns = await ctx.runAction(api.vkApi.getMtCampaigns, {
        accessToken,
      });

      // Upsert campaigns
      for (const campaign of mtCampaigns) {
        await ctx.runMutation(api.adAccounts.upsertCampaign, {
          accountId: args.accountId,
          vkCampaignId: String(campaign.id),
          name: campaign.name || `Кампания ${campaign.id}`,
          status: campaign.status,
          dailyLimit: parseFloat(campaign.budget_limit_day) || undefined,
          allLimit: parseFloat(campaign.budget_limit) || undefined,
        });
      }

      // Fetch banners (ads) from myTarget API
      const mtBanners = await ctx.runAction(api.vkApi.getMtBanners, {
        accessToken,
      });

      // Upsert ads (banners)
      let adsCount = 0;
      for (const banner of mtBanners) {
        // Find the campaign in our DB
        const campaign = await ctx.runQuery(api.adAccounts.getCampaignByVkId, {
          accountId: args.accountId,
          vkCampaignId: String(banner.campaign_id),
        });

        if (campaign) {
          // Extract banner name from textblocks or use id
          const bannerName = banner.textblocks?.title?.text || `Баннер ${banner.id}`;
          await ctx.runMutation(api.adAccounts.upsertAd, {
            accountId: args.accountId,
            campaignId: campaign._id,
            vkAdId: String(banner.id),
            name: bannerName,
            status: banner.status,
            approved: banner.moderation_status,
          });
          adsCount++;
        }
      }

      // Update sync timestamp
      await ctx.runMutation(api.adAccounts.updateSyncTime, {
        accountId: args.accountId,
      });

      return { success: true, campaigns: mtCampaigns.length, ads: adsCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Неизвестная ошибка";

      if (message === "TOKEN_EXPIRED") {
        await ctx.runMutation(api.adAccounts.updateStatus, {
          accountId: args.accountId,
          status: "error",
          lastError: "Токен VK Ads истёк. Подключите VK Ads заново.",
        });
        throw new Error("Токен VK Ads истёк. Подключите VK Ads заново.");
      }

      await ctx.runMutation(api.adAccounts.updateStatus, {
        accountId: args.accountId,
        status: "error",
        lastError: message,
      });
      throw new Error(`Ошибка VK Ads API: ${message}`);
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
