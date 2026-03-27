import { v } from "convex/values";
import { mutation, query, action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const VK_ADS_API_BASE = "https://target.my.com";

// Internal: get a fresh access token for given clientId/clientSecret
export const getTokenForCredentials = internalAction({
  args: {
    clientId: v.string(),
    clientSecret: v.string(),
  },
  handler: async (_ctx, args): Promise<string> => {
    const data = await requestClientCredentials(args.clientId, args.clientSecret);
    return data.access_token;
  },
});

// Internal: get full token data (access + refresh + expiry) for given credentials
export const getTokenDataForCredentials = internalAction({
  args: {
    clientId: v.string(),
    clientSecret: v.string(),
  },
  handler: async (_ctx, args): Promise<{
    accessToken: string;
    refreshToken: string | undefined;
    tokenExpiresAt: number;
  }> => {
    const data = await requestClientCredentials(args.clientId, args.clientSecret);
    const expiresIn = data.expires_in || 86400;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiresAt: Date.now() + expiresIn * 1000,
    };
  },
});

// Helper: request token via client_credentials grant, with token-limit cleanup
async function requestClientCredentials(clientId: string, clientSecret: string) {
  const doRequest = async () => {
    const resp = await fetch(`${VK_ADS_API_BASE}/api/v2/oauth2/token.json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "create_ads",
      }).toString(),
    });
    return resp.json();
  };

  let data = await doRequest();

  // If token limit reached, purge all app tokens and retry once
  if (data.error) {
    const errMsg = (data.error_description || data.error || "").toLowerCase();
    if (errMsg.includes("token limit") || errMsg.includes("limit reached")) {
      try {
        await fetch(`${VK_ADS_API_BASE}/api/v2/oauth2/token/delete.json`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
          }).toString(),
        });
      } catch {
        // Ignore
      }
      data = await doRequest();
    }
  }

  if (data.error) {
    const errorMsg = data.error_description || data.error || "";
    if (errorMsg.toLowerCase().includes("invalid client")) {
      throw new Error("Неверный Client ID или Client Secret. Проверьте данные в настройках VK Ads.");
    }
    throw new Error(errorMsg || "Не удалось получить токен VK Ads API");
  }

  return data;
}

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
    clientId: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
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
        lastError: undefined,
      };
      if (args.refreshToken !== undefined) {
        patch.refreshToken = args.refreshToken;
      }
      if (args.tokenExpiresAt !== undefined) {
        patch.tokenExpiresAt = args.tokenExpiresAt;
      }
      if (args.clientId !== undefined) {
        patch.clientId = args.clientId;
      }
      if (args.clientSecret !== undefined) {
        patch.clientSecret = args.clientSecret;
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

    const limit = tierLimits[user.subscriptionTier ?? "freemium"] ?? 1;
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
      clientId: args.clientId,
      clientSecret: args.clientSecret,
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

// Clear all campaigns and ads for an account (used before re-sync of agency accounts)
export const clearAccountData = mutation({
  args: {
    accountId: v.id("adAccounts"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== args.userId) return;

    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();

    for (const campaign of campaigns) {
      const ads = await ctx.db
        .query("ads")
        .withIndex("by_campaignId", (q) => q.eq("campaignId", campaign._id))
        .collect();
      for (const ad of ads) {
        await ctx.db.delete(ad._id);
      }
      await ctx.db.delete(campaign._id);
    }
  },
});

// Fetch available accounts: own account + agency clients
// Uses provided clientId/clientSecret to get a fresh token (not user-level)
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
    // Get credentials — prefer passed args, fallback to user record (for pre-fill)
    let clientId = args.clientId;
    let clientSecret = args.clientSecret;

    if (!clientId || !clientSecret) {
      const creds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
        userId: args.userId,
      });
      clientId = clientId || creds?.clientId;
      clientSecret = clientSecret || creds?.clientSecret;
    }

    if (!clientId || !clientSecret) {
      throw new Error("Не указаны Client ID / Client Secret");
    }

    // Get a fresh token directly using client_credentials grant
    const accessToken = await ctx.runAction(internal.adAccounts.getTokenForCredentials, {
      clientId,
      clientSecret,
    });

    const accounts: Array<{
      id: string;
      name: string;
      type: "own" | "agency_client";
      username: string;
    }> = [];

    // Get own account
    try {
      const user = await ctx.runAction(api.vkApi.getMtUser, { accessToken });
      accounts.push({
        id: `mt_${user.id}`,
        name: user.username || `Аккаунт ${user.id}`,
        type: "own",
        username: user.username,
      });
    } catch {
      accounts.push({
        id: "vk_ads_main",
        name: "Мой кабинет VK Ads",
        type: "own",
        username: "",
      });
    }

    // Get agency clients (empty if not agency)
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
// Stores clientId/clientSecret per-account for independent token management
export const connectSelectedAccounts = action({
  args: {
    userId: v.id("users"),
    clientId: v.string(),
    clientSecret: v.string(),
    accounts: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
      })
    ),
  },
  handler: async (ctx, args): Promise<{ connected: number }> => {
    // Get a fresh token using provided credentials
    const tokenData = await ctx.runAction(internal.adAccounts.getTokenDataForCredentials, {
      clientId: args.clientId,
      clientSecret: args.clientSecret,
    });

    let connected = 0;
    for (const account of args.accounts) {
      try {
        await ctx.runMutation(api.adAccounts.connect, {
          userId: args.userId,
          vkAccountId: account.id,
          name: account.name,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          tokenExpiresAt: tokenData.tokenExpiresAt,
          clientId: args.clientId,
          clientSecret: args.clientSecret,
        });
        connected++;
      } catch (err) {
        if (err instanceof Error && err.message.includes("другим пользователем")) {
          continue;
        }
        if (err instanceof Error && err.message.includes("Лимит")) {
          throw err;
        }
      }
    }

    return { connected };
  },
});

// Connect an agency account with a manually provided API key
export const connectAgencyAccount = action({
  args: {
    userId: v.id("users"),
    accessToken: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args): Promise<{ accountId: string }> => {
    const token = args.accessToken.trim();
    const name = args.name.trim();

    if (!token) throw new Error("Введите API-ключ");
    if (!name) throw new Error("Введите название кабинета");

    // Validate token by fetching campaigns from VK API
    try {
      await ctx.runAction(api.vkApi.getMtCampaigns, { accessToken: token });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("TOKEN_EXPIRED") || msg.includes("401")) {
        throw new Error("API-ключ недействителен или истёк. Запросите новый у сервиса.");
      }
      throw new Error("Не удалось проверить API-ключ: " + msg);
    }

    // Use a hash of token prefix as vkAccountId for uniqueness
    const vkAccountId = `agency_${token.slice(0, 16)}`;

    const accountId = await ctx.runMutation(api.adAccounts.connect, {
      userId: args.userId,
      vkAccountId,
      name,
      accessToken: token,
    });

    return { accountId: accountId as string };
  },
});

// Fetch VK ad accounts/campaigns using user's stored VK Ads token and connect
export const fetchAndConnect = action({
  args: {
    userId: v.id("users"),
    clientId: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ connected: number; accounts: Array<{ account_id: string; account_name: string }> }> => {
    // Get credentials — prefer passed args, fallback to user record
    let clientId = args.clientId;
    let clientSecret = args.clientSecret;

    if (!clientId || !clientSecret) {
      const creds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
        userId: args.userId,
      });
      clientId = clientId || creds?.clientId;
      clientSecret = clientSecret || creds?.clientSecret;
    }

    if (!clientId || !clientSecret) {
      throw new Error("Не указаны Client ID / Client Secret");
    }

    // Get valid token
    const accessToken = await ctx.runAction(internal.auth.getValidVkAdsToken, {
      userId: args.userId,
    });

    // Get real account info from myTarget API
    const userResp = await fetch("https://target.my.com/api/v2/user.json", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userData = await userResp.json();

    // Use real myTarget user ID instead of hardcoded "vk_ads_main"
    const mtUserId = userData.id ? String(userData.id) : "unknown";
    const vkAccountId = `mt_${mtUserId}`;
    const accountName = userData.username || `VK Ads (${mtUserId})`;

    // Fetch campaigns to verify token works
    const campaigns = await ctx.runAction(api.vkApi.getMtCampaigns, {
      accessToken,
    });

    const displayName = `${accountName} (${campaigns.length} кампаний)`;

    try {
      await ctx.runMutation(api.adAccounts.connect, {
        userId: args.userId,
        vkAccountId,
        name: displayName,
        accessToken,
        clientId,
        clientSecret,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("уже подключён")) {
        throw err;
      }
    }

    return {
      connected: 1,
      accounts: [{ account_id: vkAccountId, account_name: displayName }],
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
      // Use per-account token (with fallback to user-level for old accounts)
      const accessToken = await ctx.runAction(internal.auth.getValidTokenForAccount, {
        accountId: args.accountId,
      });

      // For agency accounts, clear old data before re-sync
      // (prevents stale campaigns from a previously used wrong token)
      if (account.vkAccountId.startsWith("agency_")) {
        await ctx.runMutation(api.adAccounts.clearAccountData, {
          accountId: args.accountId,
          userId: args.userId,
        });
      }

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
    // Find campaign by accountId + vkCampaignId (not just vkCampaignId)
    // to keep campaigns properly isolated between accounts
    const existing = await ctx.db
      .query("campaigns")
      .withIndex("by_accountId_vkCampaignId", (q) =>
        q.eq("accountId", args.accountId).eq("vkCampaignId", args.vkCampaignId)
      )
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
    // Find ad by accountId + vkAdId (not just vkAdId)
    // to keep ads properly isolated between accounts
    const existing = await ctx.db
      .query("ads")
      .withIndex("by_accountId_vkAdId", (q) =>
        q.eq("accountId", args.accountId).eq("vkAdId", args.vkAdId)
      )
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

// ═══════════════════════════════════════════════════════════
// Sprint 21 — Settings: API tab queries
// ═══════════════════════════════════════════════════════════

/** Get sync errors — accounts with lastError set */
export const getSyncErrors = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    return accounts
      .filter((a) => a.lastError)
      .map((a) => ({
        _id: a._id,
        name: a.name,
        status: a.status,
        lastError: a.lastError!,
        lastSyncAt: a.lastSyncAt,
      }));
  },
});

/** Get VK API status for user */
export const getVkApiStatus = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { connected: false, expired: false };

    const hasToken = !!user.vkAdsAccessToken;
    const expired = user.vkAdsTokenExpiresAt
      ? user.vkAdsTokenExpiresAt < Date.now()
      : false;

    return {
      connected: hasToken,
      expired: hasToken && expired,
      tokenExpiresAt: user.vkAdsTokenExpiresAt,
      lastSyncAt: undefined as number | undefined,
    };
  },
});

// TEMP migration: backfill existing accounts with user-level credentials
import { internalMutation } from "./_generated/server";

export const backfillAccountCredentials = internalMutation({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    let updated = 0;

    for (const account of accounts) {
      // Skip accounts that already have their own credentials
      if (account.clientId && account.clientSecret) continue;

      // Get user-level credentials
      const user = await ctx.db.get(account.userId);
      if (!user) continue;

      const clientId = (user as any).vkAdsClientId;
      const clientSecret = (user as any).vkAdsClientSecret;

      if (clientId && clientSecret) {
        await ctx.db.patch(account._id, {
          clientId,
          clientSecret,
        });
        updated++;
        console.log(`[backfill] Account ${account._id} (${account.name}): set clientId=${clientId}`);
      }
    }

    console.log(`[backfill] Done. Updated ${updated} accounts.`);
    return { updated };
  },
});

