import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query, action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { checkOrgWritable, checkFeaturesDisabled } from "./loadUnits";

const VK_ADS_API_BASE = "https://target.my.com";

/**
 * Groups banners under ad_plan_ids using ad_group mapping.
 * banner.campaign_id = ad_group_id, NOT ad_plan_id.
 * ad_groups provide the mapping: ad_group_id → ad_plan_id.
 */
export function groupBannersByAdPlan<T extends { campaign_id: number }>(
  adGroups: { id: number; ad_plan_id: number }[],
  banners: T[]
): Map<number, T[]> {
  const adGroupToAdPlan = new Map<number, number>();
  for (const g of adGroups) {
    adGroupToAdPlan.set(g.id, g.ad_plan_id);
  }

  const bannersByAdPlan = new Map<number, T[]>();
  for (const b of banners) {
    const adPlanId = adGroupToAdPlan.get(b.campaign_id);
    if (adPlanId === undefined) continue;
    const list = bannersByAdPlan.get(adPlanId) || [];
    list.push(b);
    bannersByAdPlan.set(adPlanId, list);
  }

  return bannersByAdPlan;
}

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

// List all ad accounts accessible to a user (personal + org)
export const list = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return [];

    // Individual user — only personal accounts
    if (!user.organizationId) {
      return await ctx.db
        .query("adAccounts")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .collect();
    }

    // Org member — org accounts + personal accounts without orgId
    const membership = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", user.organizationId!).eq("userId", args.userId)
      )
      .first();
    if (!membership || membership.status !== "active") return [];

    // 1. Org accounts
    let orgAccounts;
    if (membership.role === "owner") {
      orgAccounts = await ctx.db
        .query("adAccounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.organizationId!))
        .collect();
    } else {
      // Manager: fetch only assigned accounts
      orgAccounts = [];
      for (const accId of membership.assignedAccountIds) {
        const acc = await ctx.db.get(accId);
        if (acc) orgAccounts.push(acc);
      }
    }

    // 2. Personal accounts not transferred to org
    const personalAccounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const personalOnly = personalAccounts.filter((a) => !a.orgId);

    // 3. Union (deduplicate by _id)
    const seen = new Set(orgAccounts.map((a) => a._id.toString()));
    const result = [...orgAccounts];
    for (const a of personalOnly) {
      if (!seen.has(a._id.toString())) {
        result.push(a);
      }
    }
    return result;
  },
});


/** Find existing adAccount by userId + agencyCabinetId (or vitaminCabinetId).
 *  Used to prevent duplicates on reconnection — cabinetId is stable, vkAccountId is not. */
export const findByAgencyCabinetId = internalQuery({
  args: {
    userId: v.id("users"),
    agencyCabinetId: v.string(),
  },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    return accounts.find(
      (a) => a.agencyCabinetId === args.agencyCabinetId || a.vitaminCabinetId === args.agencyCabinetId
    ) ?? null;
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
    // Org grace check: read_only/frozen blocks add_accounts
    const writable = await checkOrgWritable(ctx, args.userId);
    if (!writable.writable) {
      throw new Error(writable.reason ?? "Доступ запрещён");
    }

    // Overage: add_accounts is a premium feature, blocked when featuresDisabled
    const featuresOff = await checkFeaturesDisabled(ctx, args.userId);
    if (featuresOff) {
      throw new Error("Превышен лимит пакета. Добавление кабинетов недоступно.");
    }

    // Check if account already connected
    const existing = await ctx.db
      .query("adAccounts")
      .withIndex("by_vkAccountId", (q) => q.eq("vkAccountId", args.vkAccountId))
      .first();

    if (existing && existing.userId === args.userId) {
      // Audit log credential changes
      const credChanges: Record<string, { old: string | undefined; new: string | undefined }> = {};
      if (args.accessToken !== existing.accessToken) {
        credChanges.accessToken = { old: existing.accessToken, new: args.accessToken };
      }
      if (args.refreshToken !== undefined && args.refreshToken !== existing.refreshToken) {
        credChanges.refreshToken = { old: existing.refreshToken, new: args.refreshToken };
      }
      if (args.clientId !== undefined && args.clientId !== existing.clientId) {
        credChanges.clientId = { old: existing.clientId, new: args.clientId };
      }
      if (args.clientSecret !== undefined && args.clientSecret !== existing.clientSecret) {
        credChanges.clientSecret = { old: existing.clientSecret, new: args.clientSecret };
      }
      for (const [field, vals] of Object.entries(credChanges)) {
        const mask = (val: string | undefined) => {
          if (!val) return undefined;
          if (field !== "clientId" && val.length > 8) return val.slice(0, 4) + "..." + val.slice(-4);
          return val;
        };
        await ctx.db.insert("credentialHistory", {
          accountId: existing._id,
          field,
          oldValue: mask(vals.old),
          newValue: mask(vals.new),
          changedAt: Date.now(),
          changedBy: "connect",
        });
      }

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
      if (args.clientId !== undefined) {
        patch.clientId = args.clientId;
      }
      if (args.clientSecret !== undefined) {
        patch.clientSecret = args.clientSecret;
      }
      // Ensure credentials are never left empty — fill from user-level if missing
      if (!patch.clientId && !existing.clientId) {
        const owner = await ctx.db.get(args.userId);
        if (owner?.vkAdsClientId) patch.clientId = owner.vkAdsClientId;
        if (owner?.vkAdsClientSecret) patch.clientSecret = owner.vkAdsClientSecret;
      }
      await ctx.db.patch(existing._id, patch);

      // Audit log: account reconnected/updated
      try { await ctx.runMutation(internal.auditLog.log, {
        userId: args.userId,
        category: "account",
        action: "connect_success",
        status: "success",
        details: { accountName: args.name, vkAccountId: args.vkAccountId },
      }); } catch { /* non-critical */ }

      return existing._id;
    }

    if (existing) {
      throw new Error("Этот кабинет уже подключён другим пользователем");
    }

    // Check tier limits
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("Пользователь не найден");

    // Agency tiers: unlimited accounts (limit checked via load units, not count)
    const effectiveTier = user.organizationId
      ? (await ctx.db.get(user.organizationId))?.subscriptionTier
      : (user.subscriptionTier ?? "freemium");

    const isAgency = effectiveTier?.startsWith("agency_");

    if (!isAgency) {
      const accounts = await ctx.db
        .query("adAccounts")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .collect();

      const tier = user.subscriptionTier ?? "freemium";
      let limit: number;
      if (tier === "pro") {
        limit = user.proAccountLimit ?? 20;
      } else {
        const tierLimits: Record<string, number> = { freemium: 1, start: 3 };
        limit = tierLimits[tier] ?? 1;
      }

      if (accounts.length >= limit) {
        throw new Error(`Лимит кабинетов для тарифа "${user.subscriptionTier}" исчерпан (${limit})`);
      }
    }

    // If clientId/clientSecret not passed, try user-level credentials
    let finalClientId = args.clientId;
    let finalClientSecret = args.clientSecret;
    if (!finalClientId || !finalClientSecret) {
      if (user.vkAdsClientId && user.vkAdsClientSecret) {
        finalClientId = finalClientId || user.vkAdsClientId;
        finalClientSecret = finalClientSecret || user.vkAdsClientSecret;
      }
    }

    const accountId = await ctx.db.insert("adAccounts", {
      userId: args.userId,
      orgId: user.organizationId,
      vkAccountId: args.vkAccountId,
      name: args.name,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: args.tokenExpiresAt,
      clientId: finalClientId,
      clientSecret: finalClientSecret,
      status: "active",
      createdAt: Date.now(),
    });

    // Audit log: new account connected
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: args.userId,
      category: "account",
      action: "connect_success",
      status: "success",
      details: { accountName: args.name, vkAccountId: args.vkAccountId },
    }); } catch { /* non-critical */ }
    try { await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
      category: "accountConnections",
      text: `🔗 <b>Подключён кабинет</b>\n\nПользователь: ${user.name || user.email || "—"}\nКабинет: ${args.name}\nVK ID: ${args.vkAccountId}`,
    }); } catch { /* non-critical */ }

    return accountId;
  },
});

// Set mtAdvertiserId on an account (internal, used by fetchAndConnect auto-discovery)
export const setMtAdvertiserId = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    mtAdvertiserId: v.string(),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (account && !account.mtAdvertiserId) {
      await ctx.db.patch(args.accountId, {
        mtAdvertiserId: args.mtAdvertiserId,
      });
    }
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
    // Allow: account owner OR org owner
    let hasAccess = account.userId === args.userId;
    if (!hasAccess && account.orgId) {
      const user = await ctx.db.get(args.userId);
      if (user?.organizationId?.toString() === account.orgId.toString()) {
        const membership = await ctx.db
          .query("orgMembers")
          .withIndex("by_orgId_userId", (q) =>
            q.eq("orgId", account.orgId!).eq("userId", args.userId)
          )
          .first();
        if (membership?.role === "owner" && membership.status === "active") {
          hasAccess = true;
        }
      }
    }
    if (!hasAccess) {
      throw new Error("Нет доступа к этому кабинету");
    }
    if (account.status === "deleting") {
      throw new Error("Кабинет уже удаляется");
    }

    // Phase 1: Mark as deleting
    await ctx.db.patch(args.accountId, { status: "deleting" as const });

    // Clean up rules referencing this account
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    const campaignIds = new Set(campaigns.map((c) => c._id as string));

    // Collect ad IDs for rule cleanup (not deleting here — deleteBatch handles that)
    const adIds = new Set<string>();
    for (const campaign of campaigns) {
      const ads = await ctx.db
        .query("ads")
        .withIndex("by_campaignId", (q) => q.eq("campaignId", campaign._id))
        .take(500);
      for (const ad of ads) {
        adIds.add(ad._id as string);
      }
    }

    const userRules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    for (const rule of userRules) {
      if (!rule.targetAccountIds.includes(args.accountId)) continue;

      const newAccountIds = rule.targetAccountIds.filter(
        (id) => id !== args.accountId
      );
      const newCampaignIds = (rule.targetCampaignIds || []).filter(
        (id) => !campaignIds.has(id)
      );
      const newAdIds = (rule.targetAdIds || []).filter(
        (id) => !adIds.has(id)
      );

      if (newAccountIds.length === 0) {
        await ctx.db.patch(rule._id, {
          targetAccountIds: newAccountIds,
          targetCampaignIds: newCampaignIds,
          targetAdIds: newAdIds,
          isActive: false,
        });
      } else {
        await ctx.db.patch(rule._id, {
          targetAccountIds: newAccountIds,
          targetCampaignIds: newCampaignIds,
          targetAdIds: newAdIds,
        });
      }
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

    // Audit log + admin alert
    const disconnectUser = await ctx.db.get(args.userId);
    const disconnectUserName = disconnectUser?.name || disconnectUser?.email || "—";
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: args.userId,
      category: "account",
      action: "disconnect",
      status: "success",
      details: { accountName: account.name },
    }); } catch { /* non-critical */ }
    try { await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
      category: "accountConnections",
      text: `🔌 <b>Отключён кабинет</b>\n\nПользователь: ${disconnectUserName}\nКабинет: ${account.name}`,
    }); } catch { /* non-critical */ }

    // Phase 2: Schedule async batch deletion
    await ctx.scheduler.runAfter(0, internal.adAccounts.deleteBatch, {
      accountId: args.accountId,
    });

    return { success: true };
  },
});

/**
 * @deprecated No longer used — syncNow uses paginated stale cleanup instead.
 * Kept temporarily for API compatibility. Will be removed in a future cleanup.
 */
export const clearAccountData = mutation({
  args: {
    accountId: v.id("adAccounts"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== args.userId) return;
    if (account.status === "deleting") return;

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

const DELETE_BATCH_SIZE = 200;
const DELETE_MAX_RETRIES = 10;

/** Batched async deletion of account data. Schedules itself until everything is deleted. */
export const deleteBatch = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    retryCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return; // Already deleted

    const retries = args.retryCount ?? 0;
    if (retries >= DELETE_MAX_RETRIES) {
      console.error(`deleteBatch: max retries (${DELETE_MAX_RETRIES}) reached for account ${args.accountId}`);
      return;
    }

    const reschedule = async () => {
      await ctx.scheduler.runAfter(0, internal.adAccounts.deleteBatch, {
        accountId: args.accountId,
        retryCount: 0,
      });
    };

    // 1. Delete ads
    const ads = await ctx.db
      .query("ads")
      .withIndex("by_accountId_vkAdId", (q) => q.eq("accountId", args.accountId))
      .take(DELETE_BATCH_SIZE);
    if (ads.length > 0) {
      for (const ad of ads) await ctx.db.delete(ad._id);
      await reschedule();
      return;
    }

    // 2. Delete campaigns
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(DELETE_BATCH_SIZE);
    if (campaigns.length > 0) {
      for (const c of campaigns) await ctx.db.delete(c._id);
      await reschedule();
      return;
    }

    // 3. Delete metricsRealtime
    const realtime = await ctx.db
      .query("metricsRealtime")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(DELETE_BATCH_SIZE);
    if (realtime.length > 0) {
      for (const m of realtime) await ctx.db.delete(m._id);
      await reschedule();
      return;
    }

    // 4. Delete metricsDaily
    const daily = await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) => q.eq("accountId", args.accountId))
      .take(DELETE_BATCH_SIZE);
    if (daily.length > 0) {
      for (const m of daily) await ctx.db.delete(m._id);
      await reschedule();
      return;
    }

    // 5. Delete actionLogs
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(DELETE_BATCH_SIZE);
    if (logs.length > 0) {
      for (const l of logs) await ctx.db.delete(l._id);
      await reschedule();
      return;
    }

    // 6. All data deleted — delete the account itself
    await ctx.db.delete(args.accountId);
  },
});

const DELETE_BY_IDS_LIMIT = 200;

/** Paginated list of campaigns for an account. Used by syncNow action for stale cleanup. */
export const listCampaignPage = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .paginate(args.paginationOpts);
  },
});

/** Paginated list of ads for an account. Used by syncNow action for stale cleanup. */
export const listAdPage = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ads")
      .withIndex("by_accountId_vkAdId", (q) => q.eq("accountId", args.accountId))
      .paginate(args.paginationOpts);
  },
});

/** Delete stale campaigns by _id array. Max 200 per call. */
export const deleteStaleCampaigns = internalMutation({
  args: {
    ids: v.array(v.id("campaigns")),
  },
  handler: async (ctx, args) => {
    if (args.ids.length > DELETE_BY_IDS_LIMIT) {
      throw new Error(`deleteStaleCampaigns: max ${DELETE_BY_IDS_LIMIT} IDs per call`);
    }
    let deleted = 0;
    for (const id of args.ids) {
      const doc = await ctx.db.get(id);
      if (doc) {
        await ctx.db.delete(id);
        deleted++;
      }
    }
    return { deleted };
  },
});

/** Delete stale ads by _id array. Max 200 per call. */
export const deleteStaleAds = internalMutation({
  args: {
    ids: v.array(v.id("ads")),
  },
  handler: async (ctx, args) => {
    if (args.ids.length > DELETE_BY_IDS_LIMIT) {
      throw new Error(`deleteStaleAds: max ${DELETE_BY_IDS_LIMIT} IDs per call`);
    }
    let deleted = 0;
    for (const id of args.ids) {
      const doc = await ctx.db.get(id);
      if (doc) {
        await ctx.db.delete(id);
        deleted++;
      }
    }
    return { deleted };
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
    // Get credentials — prefer passed args, fallback to user record, then existing accounts
    let clientId = args.clientId;
    let clientSecret = args.clientSecret;

    if (!clientId || !clientSecret) {
      const creds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
        userId: args.userId,
      });
      clientId = clientId || creds?.clientId;
      clientSecret = clientSecret || creds?.clientSecret;
    }

    // Fallback: check existing adAccounts for this user
    if (!clientId || !clientSecret) {
      const accounts = await ctx.runQuery(api.adAccounts.list, {
        userId: args.userId,
      });
      for (const acc of accounts) {
        if (acc.clientId && acc.clientSecret) {
          clientId = clientId || acc.clientId;
          clientSecret = clientSecret || acc.clientSecret;
          break;
        }
      }
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

// Rename an ad account
export const rename = mutation({
  args: {
    accountId: v.id("adAccounts"),
    userId: v.id("users"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("Введите название кабинета");

    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== args.userId) {
      throw new Error("Кабинет не найден");
    }

    await ctx.db.patch(args.accountId, { name });
  },
});

// Connect an agency account with a manually provided API key
export const connectAgencyAccount = action({
  args: {
    userId: v.id("users"),
    accessToken: v.string(),
    name: v.string(),
    agencyProviderId: v.optional(v.id("agencyProviders")),
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

    // Set agency provider link if provided
    if (accountId && args.agencyProviderId) {
      await ctx.runMutation(internal.adAccounts.patchAccount, {
        accountId,
        agencyProviderId: args.agencyProviderId,
      });
    }

    // Auto-discover advertiser ID for agency token
    if (accountId) {
      try {
        // For agency tokens, agency/clients.json returns client accounts
        const clientsResp = await fetch("https://target.my.com/api/v2/agency/clients.json", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (clientsResp.ok) {
          const clients = await clientsResp.json();
          if (Array.isArray(clients) && clients.length > 0) {
            const clientId = String(clients[0].id);
            await ctx.runMutation(internal.adAccounts.setMtAdvertiserId, {
              accountId,
              mtAdvertiserId: clientId,
            });
            console.log(`[connectAgency] Set mtAdvertiserId=${clientId} from agency/clients`);
          }
        } else {
          // Not an agency token — try manager/clients
          const mgrResp = await fetch("https://target.my.com/api/v2/manager/clients.json", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (mgrResp.ok) {
            const mgrClients = await mgrResp.json();
            if (Array.isArray(mgrClients) && mgrClients.length > 0) {
              await ctx.runMutation(internal.adAccounts.setMtAdvertiserId, {
                accountId,
                mtAdvertiserId: String(mgrClients[0].id),
              });
              console.log(`[connectAgency] Set mtAdvertiserId from manager/clients`);
            }
          }
        }
      } catch (e) {
        console.log(`[connectAgency] Advertiser ID discovery failed (non-critical): ${e}`);
      }
    }

    // Check if user has OAuth credentials — if not, warn about token expiry
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const hasOAuth = !!(user?.vkAdsClientId && user?.vkAdsClientSecret && user?.vkAdsRefreshToken);

    if (!hasOAuth) {
      // Immediate in-app notification
      await ctx.runMutation(api.userNotifications.sendSystemNotification, {
        userId: args.userId,
        title: "Подключите VK Ads API для автообновления токенов",
        message: "Агентский кабинет подключён через API-ключ — он имеет ограниченный срок действия. Зайдите в Настройки → VK Ads API → Подключить, введите Client ID и Client Secret рекламного кабинета. После этого токены будут продлеваться автоматически.",
        type: "warning",
      });

      // Schedule reminder in 2 hours (via mutation, since scheduler needs mutation ctx)
      await ctx.runMutation(internal.adAccounts.scheduleOAuthReminder, {
        userId: args.userId,
      });
    }

    return { accountId: accountId as string };
  },
});

/** Internal version of connectAgencyAccount — callable from other actions (e.g. getuniqConnectAccount) */
export const connectAgencyAccountInternal = internalAction({
  args: {
    userId: v.id("users"),
    accessToken: v.string(),
    name: v.string(),
    agencyProviderId: v.optional(v.id("agencyProviders")),
    agencyCabinetId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ accountId: string }> => {
    const token = args.accessToken.trim();
    const name = args.name.trim();

    if (!token) throw new Error("Пустой токен");
    if (!name) throw new Error("Пустое название");

    // Validate token
    try {
      await ctx.runAction(api.vkApi.getMtCampaigns, { accessToken: token });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("TOKEN_EXPIRED") || msg.includes("401")) {
        throw new Error("Токен VK Ads недействителен или истёк.");
      }
      throw new Error("Не удалось проверить токен: " + msg);
    }

    const vkAccountId = `agency_${token.slice(0, 16)}`;

    const accountId = await ctx.runMutation(api.adAccounts.connect, {
      userId: args.userId,
      vkAccountId,
      name,
      accessToken: token,
    });

    // Set agency provider link if provided
    if (accountId && (args.agencyProviderId || args.agencyCabinetId)) {
      await ctx.runMutation(internal.adAccounts.patchAccount, {
        accountId,
        agencyProviderId: args.agencyProviderId,
        agencyCabinetId: args.agencyCabinetId,
      });
    }

    // Auto-discover mtAdvertiserId
    if (accountId) {
      try {
        const clientsResp = await fetch("https://target.my.com/api/v2/agency/clients.json", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (clientsResp.ok) {
          const clients = await clientsResp.json();
          if (Array.isArray(clients) && clients.length > 0) {
            await ctx.runMutation(internal.adAccounts.setMtAdvertiserId, {
              accountId,
              mtAdvertiserId: String(clients[0].id),
            });
          }
        }
      } catch (e) {
        console.log(`[connectAgencyInternal] Advertiser ID discovery failed: ${e}`);
      }
    }

    return { accountId: accountId as string };
  },
});

/** Internal mutation: update token + status on existing account (for Vitamin reconnection) */
export const updateAccountToken = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    accessToken: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Аккаунт не найден");

    // Audit credential change
    if (args.accessToken !== account.accessToken) {
      const mask = (val: string) => val.length > 8 ? val.slice(0, 4) + "..." + val.slice(-4) : val;
      await ctx.db.insert("credentialHistory", {
        accountId: args.accountId,
        field: "accessToken",
        oldValue: mask(account.accessToken),
        newValue: mask(args.accessToken),
        changedAt: Date.now(),
        changedBy: "vitamin_reconnect",
      });
    }

    const patch: Record<string, unknown> = {
      accessToken: args.accessToken,
      status: "active",
      lastError: undefined,
      tokenErrorSince: undefined,
      tokenRecoveryAttempts: undefined,
    };
    if (args.name) patch.name = args.name;

    await ctx.db.patch(args.accountId, patch);
  },
});

/** Internal mutation: patch adAccount fields */
export const patchAccount = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    agencyProviderId: v.optional(v.id("agencyProviders")),
    agencyCabinetId: v.optional(v.string()),
    vitaminCabinetId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.agencyProviderId) patch.agencyProviderId = args.agencyProviderId;
    if (args.agencyCabinetId) patch.agencyCabinetId = args.agencyCabinetId;
    if (args.vitaminCabinetId) patch.vitaminCabinetId = args.vitaminCabinetId;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.accountId, patch);
    }
  },
});

// Internal mutation: schedule OAuth reminder via scheduler
export const scheduleOAuthReminder = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      2 * 60 * 60 * 1000,
      internal.adAccounts.remindOAuthConnect,
      { userId: args.userId }
    );
  },
});

// Internal: remind user to connect OAuth if still not connected after 2h
export const remindOAuthConnect = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    if (!user) return;

    // Check if OAuth was connected in the meantime
    const hasOAuth = !!(user.vkAdsClientId && user.vkAdsClientSecret && user.vkAdsRefreshToken);
    if (hasOAuth) {
      console.log(`[remindOAuth] User ${user.name || user.email}: already connected OAuth, skipping`);
      return;
    }

    // In-app notification (urgent)
    await ctx.runMutation(api.userNotifications.sendSystemNotification, {
      userId: args.userId,
      title: "⚠️ Срочно: подключите VK Ads API",
      message: "Ваши агентские кабинеты работают без автообновления токенов. Когда токен истечёт, мониторинг и правила перестанут работать. Зайдите в Настройки → VK Ads API → Подключить.",
      type: "warning",
    });

    // Telegram notification (if connected)
    if (user.telegramChatId) {
      try {
        await ctx.runAction(internal.telegram.sendMessage, {
          chatId: user.telegramChatId,
          text: `⚠️ <b>Срочно: подключите VK Ads API</b>\n\nВаши агентские кабинеты работают без автообновления токенов. Когда API-ключ истечёт, мониторинг и правила перестанут работать.\n\n<b>Что нужно сделать:</b>\n1. Зайдите в AdPilot → Настройки\n2. В разделе «VK Ads API» нажмите «Подключить»\n3. Введите Client ID и Client Secret рекламного кабинета\n4. Пройдите авторизацию`,
        });
      } catch (e) {
        console.log(`[remindOAuth] Failed to send Telegram to ${user.name}: ${e}`);
      }
    }

    console.log(`[remindOAuth] User ${user.name || user.email}: reminded to connect OAuth`);
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
    // Get credentials — prefer passed args, fallback to user record, then existing accounts
    let clientId = args.clientId;
    let clientSecret = args.clientSecret;

    if (!clientId || !clientSecret) {
      const creds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
        userId: args.userId,
      });
      clientId = clientId || creds?.clientId;
      clientSecret = clientSecret || creds?.clientSecret;
    }

    // Fallback: check existing adAccounts for this user
    if (!clientId || !clientSecret) {
      const accounts = await ctx.runQuery(api.adAccounts.list, {
        userId: args.userId,
      });
      for (const acc of accounts) {
        if (acc.clientId && acc.clientSecret) {
          clientId = clientId || acc.clientId;
          clientSecret = clientSecret || acc.clientSecret;
          break;
        }
      }
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

    let accountId;
    try {
      accountId = await ctx.runMutation(api.adAccounts.connect, {
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

    // Auto-set mtAdvertiserId from user's saved vkAdsCabinetId (discovered at login)
    if (accountId) {
      try {
        const userRecord = await ctx.runQuery(internal.users.getById, { userId: args.userId });
        if (userRecord?.vkAdsCabinetId) {
          await ctx.runMutation(internal.adAccounts.setMtAdvertiserId, {
            accountId,
            mtAdvertiserId: userRecord.vkAdsCabinetId,
          });
          console.log(`[fetchAndConnect] Set mtAdvertiserId=${userRecord.vkAdsCabinetId} from user record`);
        } else {
          // Fallback: try ads.getAccounts with VK token (may work if token is fresh)
          const vkTokens = await ctx.runQuery(internal.users.getVkTokens, {
            userId: args.userId,
          });
          if (vkTokens?.accessToken) {
            const adsResp = await fetch("https://api.vk.com/method/ads.getAccounts?v=5.131", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: `access_token=${vkTokens.accessToken}`,
            });
            const adsData = await adsResp.json();
            console.log(`[fetchAndConnect] ads.getAccounts: ${JSON.stringify(adsData).substring(0, 200)}`);
            if (adsData.response && Array.isArray(adsData.response) && adsData.response.length > 0) {
              const cabinetId = String(adsData.response[0].account_id);
              await ctx.runMutation(internal.adAccounts.setMtAdvertiserId, {
                accountId,
                mtAdvertiserId: cabinetId,
              });
              // Also save on user for future accounts
              await ctx.runMutation(internal.auth.saveVkAdsCabinetId, {
                userId: args.userId,
                vkAdsCabinetId: cabinetId,
              });
              console.log(`[fetchAndConnect] Auto-discovered mtAdvertiserId=${cabinetId}`);
            }
          }
        }
      } catch (e) {
        console.log(`[fetchAndConnect] mtAdvertiserId discovery failed (non-critical): ${e}`);
      }
    }

    return {
      connected: 1,
      accounts: [{ account_id: vkAccountId, account_name: displayName }],
    };
  },
});

// List campaigns for an account (from local DB — used by rule engine)
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

// Fetch live campaigns from VK API (ad_plans.json) with banners
// Returns current data without delay — no local DB dependency
export const fetchLiveCampaigns = action({
  args: {
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args): Promise<{
    campaigns: {
      id: number;
      name: string;
      status: string;
      objective: string;
      dailyLimit: number | null;
      allLimit: number | null;
      banners: {
        id: number;
        name: string;
        status: string;
        moderationStatus: string;
      }[];
    }[];
  }> => {
    const accessToken = await ctx.runAction(internal.auth.getValidTokenForAccount, {
      accountId: args.accountId,
    });

    // Fetch ad_plans + ad_groups + banners in parallel
    const [adPlans, adGroups, banners] = await Promise.all([
      ctx.runAction(api.vkApi.getMtAdPlans, { accessToken }),
      ctx.runAction(internal.vkApi.getMtAdGroups, { accessToken }),
      ctx.runAction(api.vkApi.getMtBanners, { accessToken }),
    ]);

    // Group banners by ad_plan_id (via ad_group mapping)
    const bannersByAdPlan = groupBannersByAdPlan(adGroups, banners);

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      campaigns: adPlans.map((plan: any) => ({
        id: plan.id,
        name: plan.name,
        status: plan.status,
        objective: plan.objective,
        dailyLimit: plan.budget_limit_day,
        allLimit: plan.budget_limit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        banners: (bannersByAdPlan.get(plan.id) || []).map((b: any) => ({
          id: b.id,
          name: b.textblocks?.title?.text || `Баннер ${b.id}`,
          status: b.status,
          moderationStatus: b.moderation_status,
        })),
      })),
    };
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

/**
 * Сброс tokenExpiresAt при реальном TOKEN_EXPIRED от VK API (401).
 * После сброса getValidTokenForAccount запустит полный цикл рефреша
 * (refresh_token → agency_client_credentials → Vitamin API fallback).
 * Не затрагивает работающие кабинеты — вызывается ТОЛЬКО после 401.
 */
export const invalidateAccountToken = internalMutation({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;
    await ctx.db.patch(args.accountId, {
      tokenExpiresAt: 0,
    });
    console.log(
      `[invalidateAccountToken] «${account.name}» (${args.accountId}): tokenExpiresAt reset to 0, next call will trigger refresh`
    );
  },
});

// ─── Transient Sync Error Tracking ────────────────────────────────

/** Increment consecutive sync error counter (for transient, non-TOKEN_EXPIRED errors) */
export const incrementSyncErrors = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;
    const current = account.consecutiveSyncErrors ?? 0;
    await ctx.db.patch(args.accountId, {
      consecutiveSyncErrors: current + 1,
      lastSyncError: args.error.slice(0, 500),
    });
  },
});

/** Clear consecutive sync error counter (called on successful sync) */
export const clearSyncErrors = internalMutation({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;
    if (account.consecutiveSyncErrors || account.lastSyncError) {
      await ctx.db.patch(args.accountId, {
        consecutiveSyncErrors: undefined,
        lastSyncError: undefined,
      });
    }
  },
});

export const incrementEmptySyncs = internalMutation({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;
    await ctx.db.patch(args.accountId, {
      consecutiveEmptySyncs: (account.consecutiveEmptySyncs ?? 0) + 1,
    });
  },
});

// Update account status
export const updateStatus = mutation({
  args: {
    accountId: v.id("adAccounts"),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("error"), v.literal("archived")),
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

      // Fetch ALL campaigns from myTarget API (with pagination, up to 250/page)
      const mtCampaigns = await ctx.runAction(internal.vkApi.getCampaignsForAccount, {
        accessToken,
      });

      // Upsert campaigns and collect valid VK IDs for stale cleanup
      const validCampaignIds = new Set<string>();
      for (const campaign of mtCampaigns) {
        const vkCampaignId = String(campaign.id);
        validCampaignIds.add(vkCampaignId);
        await ctx.runMutation(api.adAccounts.upsertCampaign, {
          accountId: args.accountId,
          vkCampaignId,
          adPlanId: campaign.ad_plan_id ? String(campaign.ad_plan_id) : undefined,
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

      // Upsert ads (banners) and collect valid VK IDs
      const validAdIds = new Set<string>();
      let adsCount = 0;
      for (const banner of mtBanners) {
        const campaign = await ctx.runQuery(api.adAccounts.getCampaignByVkId, {
          accountId: args.accountId,
          vkCampaignId: String(banner.campaign_id),
        });

        if (campaign) {
          const vkAdId = String(banner.id);
          validAdIds.add(vkAdId);
          const bannerName = banner.textblocks?.title?.text || `Баннер ${banner.id}`;
          await ctx.runMutation(api.adAccounts.upsertAd, {
            accountId: args.accountId,
            campaignId: campaign._id,
            vkAdId,
            name: bannerName,
            status: banner.status,
            approved: banner.moderation_status,
          });
          adsCount++;
        }
      }

      // --- Stale cleanup: paginate DB records (each query < 4096 reads), delete stale ones ---
      // Each ctx.runQuery() is a separate transaction with its own 4096 read limit.
      // At 500 records/page, each query uses ~500 reads — well under the limit.

      // 1. Paginate all ads in DB, find stale _ids
      const staleAdDocIds: Array<any> = []; // Id<"ads">[] — typed at call site
      {
        let done = false;
        let cursor: string | null = null;
        while (!done) {
          const paginationOpts = { numItems: 500, cursor } as { numItems: number; cursor: string | null };
          const page: { page: Array<{ _id: any; vkAdId: string }>; isDone: boolean; continueCursor: string } =
            await ctx.runQuery(internal.adAccounts.listAdPage, {
              accountId: args.accountId,
              paginationOpts,
            });
          for (const ad of page.page) {
            if (!validAdIds.has(ad.vkAdId)) {
              staleAdDocIds.push(ad._id);
            }
          }
          done = page.isDone;
          cursor = page.continueCursor;
        }
      }

      // 2. Paginate all campaigns in DB, find stale _ids
      const staleCampaignDocIds: Array<any> = []; // Id<"campaigns">[] — typed at call site
      {
        let done = false;
        let cursor: string | null = null;
        while (!done) {
          const paginationOpts = { numItems: 500, cursor } as { numItems: number; cursor: string | null };
          const page: { page: Array<{ _id: any; vkCampaignId: string }>; isDone: boolean; continueCursor: string } =
            await ctx.runQuery(internal.adAccounts.listCampaignPage, {
              accountId: args.accountId,
              paginationOpts,
            });
          for (const c of page.page) {
            if (!validCampaignIds.has(c.vkCampaignId)) {
              staleCampaignDocIds.push(c._id);
            }
          }
          done = page.isDone;
          cursor = page.continueCursor;
        }
      }

      // 3. Delete stale ads first (prevents orphans), then campaigns
      for (let i = 0; i < staleAdDocIds.length; i += 200) {
        await ctx.runMutation(internal.adAccounts.deleteStaleAds, {
          ids: staleAdDocIds.slice(i, i + 200),
        });
      }
      for (let i = 0; i < staleCampaignDocIds.length; i += 200) {
        await ctx.runMutation(internal.adAccounts.deleteStaleCampaigns, {
          ids: staleCampaignDocIds.slice(i, i + 200),
        });
      }

      // Update sync timestamp and clear any previous error
      await ctx.runMutation(api.adAccounts.updateSyncTime, {
        accountId: args.accountId,
      });
      await ctx.runMutation(api.adAccounts.updateStatus, {
        accountId: args.accountId,
        status: "active",
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
    adPlanId: v.optional(v.string()),
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
      if (args.adPlanId !== undefined) {
        patch.adPlanId = args.adPlanId;
      }
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
      adPlanId: args.adPlanId,
      name: args.name,
      status: args.status,
      dailyLimit: args.dailyLimit,
      allLimit: args.allLimit,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** Batch upsert campaigns — one mutation instead of N individual calls */
export const upsertCampaignsBatch = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    campaigns: v.array(v.object({
      vkCampaignId: v.string(),
      adPlanId: v.optional(v.string()),
      name: v.string(),
      status: v.string(),
      dailyLimit: v.optional(v.number()),
      allLimit: v.optional(v.number()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const c of args.campaigns) {
      const existing = await ctx.db
        .query("campaigns")
        .withIndex("by_accountId_vkCampaignId", (q) =>
          q.eq("accountId", args.accountId).eq("vkCampaignId", c.vkCampaignId)
        )
        .first();

      if (existing) {
        const patch: Record<string, unknown> = {
          name: c.name,
          status: c.status,
          updatedAt: now,
        };
        if (c.adPlanId !== undefined) patch.adPlanId = c.adPlanId;
        if (c.dailyLimit !== undefined) patch.dailyLimit = c.dailyLimit;
        if (c.allLimit !== undefined) patch.allLimit = c.allLimit;
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert("campaigns", {
          accountId: args.accountId,
          vkCampaignId: c.vkCampaignId,
          adPlanId: c.adPlanId,
          name: c.name,
          status: c.status,
          dailyLimit: c.dailyLimit,
          allLimit: c.allLimit,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
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
      .withIndex("by_accountId_vkCampaignId", (q) =>
        q.eq("accountId", args.accountId).eq("vkCampaignId", args.vkCampaignId)
      )
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

/** Batch upsert ads — includes campaign lookup inside mutation to eliminate separate queries */
export const upsertAdsBatch = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    ads: v.array(v.object({
      vkAdId: v.string(),
      campaignVkId: v.string(),
      name: v.string(),
      status: v.string(),
      approved: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Cache campaign lookups within this batch (many ads share the same campaign)
    const campaignCache = new Map<string, string | null>();

    for (const ad of args.ads) {
      // Lookup campaign (with cache)
      let campaignId = campaignCache.get(ad.campaignVkId);
      if (campaignId === undefined) {
        const campaign = await ctx.db
          .query("campaigns")
          .withIndex("by_accountId_vkCampaignId", (q) =>
            q.eq("accountId", args.accountId).eq("vkCampaignId", ad.campaignVkId)
          )
          .first();
        campaignId = campaign?._id ?? null;
        campaignCache.set(ad.campaignVkId, campaignId);
      }
      if (!campaignId) continue;

      const existing = await ctx.db
        .query("ads")
        .withIndex("by_accountId_vkAdId", (q) =>
          q.eq("accountId", args.accountId).eq("vkAdId", ad.vkAdId)
        )
        .first();

      if (existing) {
        const patch: Record<string, unknown> = {
          name: ad.name,
          status: ad.status,
          updatedAt: now,
        };
        if (ad.approved !== undefined) patch.approved = ad.approved;
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert("ads", {
          accountId: args.accountId,
          campaignId: campaignId as any,
          vkAdId: ad.vkAdId,
          name: ad.name,
          status: ad.status,
          approved: ad.approved,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
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
      lastError: undefined,
      consecutiveSyncErrors: undefined,
      lastSyncError: undefined,
      consecutiveEmptySyncs: undefined,
    });
  },
});

// Update business profile fields
export const updateBusinessProfile = mutation({
  args: {
    accountId: v.id("adAccounts"),
    companyName: v.optional(v.string()),
    industry: v.optional(v.string()),
    tone: v.optional(v.string()),
    website: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { accountId, ...updates } = args;
    const filtered: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(updates)) {
      if (val !== undefined) filtered[k] = val;
    }
    if (Object.keys(filtered).length > 0) {
      await ctx.db.patch(accountId, filtered);
    }
  },
});

// Get account business profile (for AI prompts)
export const getBusinessProfile = query({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    return {
      companyName: account.companyName,
      industry: account.industry,
      tone: account.tone,
      website: account.website,
    };
  },
});

// Internal get (for AI prompts in actions)
export const getInternal = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.accountId);
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

/** Get VK API status for user — checks account-level tokens (used for sync) */
export const getVkApiStatus = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { connected: false, expired: false };

    // Check account-level tokens (these are what sync actually uses)
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    if (accounts.length > 0) {
      const activeAccounts = accounts.filter((a) => a.status === "active");
      const hasErrors = accounts.some((a) => a.status === "error");
      const lastSync = accounts.reduce(
        (max, a) => Math.max(max, a.lastSyncAt ?? 0),
        0
      );

      return {
        connected: true,
        expired: activeAccounts.length === 0 && hasErrors,
        tokenExpiresAt: user.vkAdsTokenExpiresAt,
        lastSyncAt: lastSync || undefined,
      };
    }

    // Fallback: no accounts — check user-level token
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

// Clear per-account credentials (with audit log + force protection)
export const fixAccountCredentials = mutation({
  args: {
    accountId: v.id("adAccounts"),
    userId: v.id("users"),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== args.userId) {
      throw new Error("Кабинет не найден");
    }

    // Protection: refuse to wipe credentials without force flag
    if ((account.clientId || account.clientSecret) && !args.force) {
      throw new Error("Нельзя очистить credentials без force:true. clientId и clientSecret будут утеряны безвозвратно.");
    }

    // Audit log before wiping
    for (const field of ["clientId", "clientSecret"] as const) {
      const oldValue = account[field];
      if (!oldValue) continue;
      await ctx.db.insert("credentialHistory", {
        accountId: args.accountId,
        field,
        oldValue: field === "clientSecret" && oldValue.length > 8
          ? oldValue.slice(0, 4) + "..." + oldValue.slice(-4)
          : oldValue,
        newValue: undefined,
        changedAt: Date.now(),
        changedBy: "fixAccountCredentials",
      });
    }

    await ctx.db.patch(args.accountId, {
      clientId: undefined,
      clientSecret: undefined,
      status: "active",
      lastError: undefined,
    });
    return { cleared: true, name: account.name };
  },
});

// TEMP: check what credentials are in env vars
export const checkEnvCredentials = action({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args): Promise<{
    envClientId: string | null;
    envSecret: boolean;
    userCreds: { clientId: string | null; hasSecret: boolean };
    accounts: Array<{
      id: string;
      name: string;
      vkAccountId: string;
      hasClientId: boolean;
      clientId: string | null;
      hasClientSecret: boolean;
      hasAccessToken: boolean;
      hasRefreshToken: boolean;
      tokenExpiresAt: number | null;
      status: string;
    }>;
  }> => {
    const envClientId = process.env.VK_ADS_CLIENT_ID || null;
    const envSecret = !!process.env.VK_ADS_CLIENT_SECRET;

    // Get user-level credentials
    const creds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
      userId: args.userId,
    });

    // Get all accounts for this user
    const accounts = await ctx.runQuery(api.adAccounts.list, {
      userId: args.userId,
    });

    return {
      envClientId,
      envSecret,
      userCreds: {
        clientId: creds?.clientId || null,
        hasSecret: !!(creds?.clientSecret),
      },
      accounts: accounts.map((a: any) => ({
        id: a._id,
        name: a.name,
        vkAccountId: a.vkAccountId,
        hasClientId: !!a.clientId,
        clientId: a.clientId || null,
        hasClientSecret: !!a.clientSecret,
        hasAccessToken: !!a.accessToken,
        hasRefreshToken: !!a.refreshToken,
        tokenExpiresAt: a.tokenExpiresAt || null,
        status: a.status,
      })),
    };
  },
});

// TEMP: reconnect an account with its own clientId/clientSecret
export const reconnectAccount = action({
  args: {
    accountId: v.id("adAccounts"),
    userId: v.id("users"),
    clientId: v.string(),
    clientSecret: v.string(),
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    myTargetId?: number;
    username?: string;
    error?: string;
  }> => {
    try {
      // Validate: get account and check ownership
      const account = await ctx.runQuery(api.adAccounts.get, {
        accountId: args.accountId,
      });
      if (!account || account.userId !== args.userId) {
        return { success: false, error: "Кабинет не найден" };
      }

      // Get fresh token for these credentials
      const tokenData = await ctx.runAction(
        internal.adAccounts.getTokenDataForCredentials,
        {
          clientId: args.clientId,
          clientSecret: args.clientSecret,
        }
      );

      // Check which myTarget account this token belongs to
      const userResp = await fetch("https://target.my.com/api/v2/user.json", {
        headers: { Authorization: `Bearer ${tokenData.accessToken}` },
      });
      const userData = await userResp.json();

      // Save credentials + fresh token to the account
      await ctx.runMutation(internal.adAccounts.updateAccountCredentials, {
        accountId: args.accountId,
        clientId: args.clientId,
        clientSecret: args.clientSecret,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        tokenExpiresAt: tokenData.tokenExpiresAt,
      });

      return {
        success: true,
        myTargetId: userData.id,
        username: userData.username,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  },
});

// TEMP: refresh token using specific credentials
export const refreshUserToken = action({
  args: {
    userId: v.id("users"),
    clientId: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ success: boolean; myTargetId?: number; username?: string; error?: string }> => {
    try {
      // Use provided credentials, or user-level, or env vars
      let clientId = args.clientId;
      let clientSecret = args.clientSecret;

      if (!clientId || !clientSecret) {
        const creds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
          userId: args.userId,
        });
        clientId = clientId || creds?.clientId;
        clientSecret = clientSecret || creds?.clientSecret;
      }

      // Check env vars
      const envClientId = process.env.VK_ADS_CLIENT_ID;
      const envClientSecret = process.env.VK_ADS_CLIENT_SECRET;

      // Return diagnostic info about what credentials are available
      if (!clientId || !clientSecret) {
        return {
          success: false,
          error: `No credentials found. env VK_ADS_CLIENT_ID=${envClientId ? 'SET' : 'NOT SET'}, VK_ADS_CLIENT_SECRET=${envClientSecret ? 'SET' : 'NOT SET'}`,
        };
      }

      // Get fresh token via client_credentials (no scope = full access)
      const tokenData = await ctx.runAction(internal.adAccounts.getTokenDataForCredentials, {
        clientId,
        clientSecret,
      });

      // Check which myTarget account this token belongs to
      const userResp = await fetch("https://target.my.com/api/v2/user.json", {
        headers: { Authorization: `Bearer ${tokenData.accessToken}` },
      });
      const userData = await userResp.json();

      // Save to user record
      await ctx.runMutation(internal.users.updateVkAdsTokens, {
        userId: args.userId,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        expiresIn: Math.floor((tokenData.tokenExpiresAt - Date.now()) / 1000),
      });

      return {
        success: true,
        myTargetId: userData.id,
        username: userData.username,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
    }
  },
});

// Internal mutation: save per-account credentials + token (with audit log)
export const updateAccountCredentials = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    clientId: v.string(),
    clientSecret: v.string(),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Аккаунт не найден");

    // Audit log: track all credential changes
    const tracked = { clientId: args.clientId, clientSecret: args.clientSecret, accessToken: args.accessToken, refreshToken: args.refreshToken };
    for (const [field, newValue] of Object.entries(tracked)) {
      const oldValue = (account as Record<string, unknown>)[field] as string | undefined;
      if (oldValue === newValue) continue;
      const mask = (val: string | undefined) => {
        if (!val) return undefined;
        if (field !== "clientId" && val.length > 8) return val.slice(0, 4) + "..." + val.slice(-4);
        return val;
      };
      await ctx.db.insert("credentialHistory", {
        accountId: args.accountId,
        field,
        oldValue: mask(oldValue),
        newValue: mask(newValue),
        changedAt: Date.now(),
        changedBy: "updateAccountCredentials",
      });
    }

    await ctx.db.patch(args.accountId, {
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: args.tokenExpiresAt,
      status: "active",
      lastError: undefined,
    });
  },
});

// TEMP: diagnose all agency accounts — check credentials for auto-refresh
export const diagnosAgencyAccounts = query({
  args: {},
  handler: async (ctx) => {
    const allAccounts = await ctx.db.query("adAccounts").collect();
    const agencyAccounts = allAccounts.filter(a => a.vkAccountId.startsWith("agency_"));

    const results = [];
    for (const acc of agencyAccounts) {
      const user = await ctx.db.get(acc.userId);
      results.push({
        accountId: acc._id,
        name: acc.name,
        vkAccountId: acc.vkAccountId,
        userId: acc.userId,
        userName: user?.name || user?.email || "unknown",
        hasAccessToken: !!acc.accessToken,
        hasRefreshToken: !!acc.refreshToken,
        hasClientId: !!acc.clientId,
        hasClientSecret: !!acc.clientSecret,
        tokenExpiresAt: acc.tokenExpiresAt,
        tokenExpired: acc.tokenExpiresAt ? acc.tokenExpiresAt < Date.now() : null,
        status: acc.status,
        lastError: acc.lastError,
        // User-level fallback available?
        userHasRefreshToken: !!user?.vkAdsRefreshToken,
        userHasClientId: !!user?.vkAdsClientId,
        userHasClientSecret: !!user?.vkAdsClientSecret,
        userVkAdsTokenExpiresAt: user?.vkAdsTokenExpiresAt,
      });
    }
    return results;
  },
});

// TEMP: migrate agency accounts — copy user-level OAuth creds to agency accounts
export const migrateAgencyCredentials = internalMutation({
  args: {},
  handler: async (ctx) => {
    const allAccounts = await ctx.db.query("adAccounts").collect();
    const agencyAccounts = allAccounts.filter(a => a.vkAccountId.startsWith("agency_"));

    const results = [];
    for (const acc of agencyAccounts) {
      const user = await ctx.db.get(acc.userId);
      if (!user) continue;

      const patch: Record<string, unknown> = {};

      if (!acc.clientId && user.vkAdsClientId) {
        patch.clientId = user.vkAdsClientId;
      }
      if (!acc.clientSecret && user.vkAdsClientSecret) {
        patch.clientSecret = user.vkAdsClientSecret;
      }
      if (!acc.refreshToken && user.vkAdsRefreshToken) {
        patch.refreshToken = user.vkAdsRefreshToken;
      }
      if (!acc.tokenExpiresAt && user.vkAdsTokenExpiresAt) {
        patch.tokenExpiresAt = user.vkAdsTokenExpiresAt;
      }

      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(acc._id, patch);
        results.push({
          accountId: acc._id,
          name: acc.name,
          patched: Object.keys(patch),
        });
      } else {
        results.push({
          accountId: acc._id,
          name: acc.name,
          patched: [],
          note: "already has all credentials or user has none",
        });
      }
    }
    return results;
  },
});

// ─── AGENCY TOKEN HEALTH CHECK ──────────────────────────────────

// Internal query: get all agency accounts for health check
export const getAgencyAccountsForHealthCheck = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allAccounts = await ctx.db.query("adAccounts").collect();
    return allAccounts
      .filter(a => a.vkAccountId.startsWith("agency_"))
      .map(a => ({
        _id: a._id,
        name: a.name,
        userId: a.userId,
        accessToken: a.accessToken,
        status: a.status,
        lastError: a.lastError,
        hasRefreshToken: !!a.refreshToken,
        hasClientId: !!a.clientId,
      }));
  },
});

// Internal mutation: update account status after health check
export const updateAccountHealth = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    status: v.string(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      status: args.status as "active" | "paused" | "error",
      lastError: args.lastError,
    });
  },
});

// Action: check all agency tokens health, notify on failure
export const checkAgencyTokenHealth = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.adAccounts.getAgencyAccountsForHealthCheck, {});

    let checked = 0;
    let healthy = 0;
    let failed = 0;

    for (const acc of accounts) {
      if (!acc.accessToken) continue;
      checked++;

      try {
        // Lightweight API call to test token
        const resp = await fetch(`https://target.my.com/api/v2/user.json`, {
          headers: { Authorization: `Bearer ${acc.accessToken}` },
        });

        if (resp.ok) {
          healthy++;
          // If was in error state, restore to active
          if (acc.status === "error") {
            await ctx.runMutation(internal.adAccounts.updateAccountHealth, {
              accountId: acc._id,
              status: "active",
              lastError: undefined,
            });
            console.log(`[tokenHealth] ${acc.name}: restored to active`);
          }
        } else if (resp.status === 401 || resp.status === 403) {
          // Try proactive refresh before marking as error
          let refreshed = false;
          try {
            const newToken = await ctx.runAction(
              internal.auth.getValidTokenForAccount,
              { accountId: acc._id }
            );
            if (newToken) {
              // Verify the new token works
              const verifyResp = await fetch(`https://target.my.com/api/v2/user.json`, {
                headers: { Authorization: `Bearer ${newToken}` },
              });
              if (verifyResp.ok) {
                refreshed = true;
                healthy++;
                if (acc.status === "error") {
                  await ctx.runMutation(internal.adAccounts.updateAccountHealth, {
                    accountId: acc._id,
                    status: "active",
                    lastError: undefined,
                  });
                }
                console.log(`[tokenHealth] ${acc.name}: auto-refreshed successfully`);
              }
            }
          } catch (refreshErr) {
            console.log(`[tokenHealth] ${acc.name}: auto-refresh failed: ${refreshErr}`);
          }

          if (refreshed) continue;

          failed++;
          const wasAlreadyError = acc.status === "error";

          // Mark as error
          await ctx.runMutation(internal.adAccounts.updateAccountHealth, {
            accountId: acc._id,
            status: "error",
            lastError: `TOKEN_EXPIRED (${resp.status}) — обнаружено ${new Date().toISOString().slice(0, 10)}`,
          });

          // Notify user via Telegram (only on first failure, not repeated)
          if (!wasAlreadyError) {
            const user = await ctx.runQuery(internal.users.getById, { userId: acc.userId });
            if (user?.telegramChatId) {
              const canRefresh = acc.hasRefreshToken && acc.hasClientId;
              const message = canRefresh
                ? `⚠️ <b>Токен кабинета «${acc.name}» истёк</b>\n\nПопытка автоматического обновления при следующем запросе. Если не удастся — потребуется переподключить кабинет.`
                : `⚠️ <b>Токен кабинета «${acc.name}» истёк</b>\n\nЭтот кабинет подключён через API-ключ без возможности автообновления.\n\n<b>Что делать:</b>\n1. Запросите новый API-ключ у сервиса (Vitamin.tools, eLama и т.д.)\n2. Удалите кабинет в настройках AdPilot\n3. Подключите заново с новым ключом\n\nПока токен не обновлён, мониторинг и правила для этого кабинета приостановлены.`;

              try {
                await ctx.runAction(internal.telegram.sendMessage, {
                  chatId: user.telegramChatId,
                  text: message,
                });
                console.log(`[tokenHealth] ${acc.name}: notified user ${user.name || user.email}`);
              } catch (e) {
                console.log(`[tokenHealth] ${acc.name}: failed to notify: ${e}`);
              }
            }
          }

          console.log(`[tokenHealth] ${acc.name}: TOKEN EXPIRED (${resp.status})`);
        }
        // Other errors (500, etc.) — skip, might be temporary
      } catch (e) {
        console.log(`[tokenHealth] ${acc.name}: network error: ${e}`);
      }
    }

    console.log(`[tokenHealth] Checked ${checked}: ${healthy} healthy, ${failed} failed`);
  },
});

// TEMP: save refresh token to an agency account (one-time use, remove after)
export const saveAgencyRefreshToken = mutation({
  args: {
    accountId: v.id("adAccounts"),
    refreshToken: v.string(),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Account not found");
    await ctx.db.patch(args.accountId, {
      refreshToken: args.refreshToken,
    });
    return { success: true, accountName: account.name };
  },
});

// TEMP: audit agency advertiser IDs — check which clients the token sees and match with rules
export const auditAgencyAdvertiserIds = action({
  args: {},
  handler: async (ctx): Promise<Array<Record<string, unknown>>> => {
    const allAccounts: Array<{
      _id: string; name: string; vkAccountId: string; userId: string;
      userName: string; accessToken: string; mtAdvertiserId?: string; status: string;
    }> = await ctx.runQuery(internal.adAccounts.getAllAccountsInternal, {});
    const agencyAccounts = allAccounts.filter((a) => a.vkAccountId.startsWith("agency_"));

    const allRules: Array<{
      _id: string; name: string; type: string; targetAccountIds: string[]; targetCampaignIds: string[];
    }> = await ctx.runQuery(internal.adAccounts.getAllActiveRulesInternal, {});

    const results = [];

    for (const acc of agencyAccounts) {
      const accountRules = allRules.filter((r: { targetAccountIds: string[] }) =>
        r.targetAccountIds.includes(acc._id)
      );

      const ruleInfo = accountRules.map((r: { _id: string; name: string; type: string; targetCampaignIds?: string[] }) => ({
        ruleId: r._id,
        name: r.name,
        type: r.type,
        targetCampaignIds: r.targetCampaignIds || [],
      }));

      // Collect all targeted campaign IDs from rules
      const allTargetCampaignIds = new Set<string>();
      for (const r of ruleInfo) {
        for (const cid of r.targetCampaignIds) {
          allTargetCampaignIds.add(String(cid));
        }
      }

      let agencyClients: Array<{ id: number; username: string; status: string }> = [];
      const campaignsNoFilter: Array<{ id: number; name: string; status: string }> = [];
      const clientCampaignMatch: Array<{ clientId: number; clientUsername: string; matchedCampaigns: number[] }> = [];
      let tokenError = "";

      try {
        // 1. Get ALL campaigns with pagination
        let offset = 0;
        const LIMIT = 250;
        while (true) {
          const campResp = await fetch(
            `https://target.my.com/api/v2/campaigns.json?fields=id,name,status&limit=${LIMIT}&offset=${offset}`,
            { headers: { Authorization: `Bearer ${acc.accessToken}` } }
          );
          if (!campResp.ok) {
            tokenError = `campaigns.json: ${campResp.status}`;
            break;
          }
          const campData = await campResp.json();
          const items = (campData.items || campData || []) as Array<{ id: number; name: string; status: string }>;
          campaignsNoFilter.push(...items.map((c) => ({ id: c.id, name: c.name, status: c.status })));
          if (items.length < LIMIT) break;
          offset += LIMIT;
        }
        // 2. Get agency clients
        const clientsResp = await fetch(
          `https://target.my.com/api/v2/agency/clients.json`,
          { headers: { Authorization: `Bearer ${acc.accessToken}` } }
        );
        if (clientsResp.ok) {
          const clientsData = await clientsResp.json();
          if (Array.isArray(clientsData)) {
            agencyClients = clientsData.map((c: { id: number; username: string; status: string }) => ({
              id: c.id, username: c.username || "", status: c.status || "",
            }));
          }
        }

        // 3. For each client, check if targeted campaigns belong to them
        if (allTargetCampaignIds.size > 0 && agencyClients.length > 0) {
          for (const client of agencyClients.slice(0, 10)) {
            try {
              const cResp = await fetch(
                `https://target.my.com/api/v2/campaigns.json?fields=id,name,status&limit=250&_user_id=${client.id}`,
                { headers: { Authorization: `Bearer ${acc.accessToken}` } }
              );
              if (cResp.ok) {
                const cData = await cResp.json();
                const clientCamps = (cData.items || cData || []) as Array<{ id: number }>;
                const matched = clientCamps
                  .filter((c) => allTargetCampaignIds.has(String(c.id)))
                  .map((c) => c.id);
                if (matched.length > 0) {
                  clientCampaignMatch.push({
                    clientId: client.id,
                    clientUsername: client.username,
                    matchedCampaigns: matched,
                  });
                }
              }
            } catch {
              // skip client
            }
          }
        }
      } catch (err) {
        tokenError = String(err);
      }

      // Check if default campaigns contain targeted ones
      const defaultCampaignIds = new Set(campaignsNoFilter.map((c) => String(c.id)));
      const targetedFoundInDefault = [...allTargetCampaignIds].filter((id) => defaultCampaignIds.has(id));

      results.push({
        accountId: acc._id,
        accountName: acc.name,
        userId: acc.userId,
        userName: acc.userName,
        storedMtAdvertiserId: acc.mtAdvertiserId || "MISSING",
        status: acc.status,
        tokenError: tokenError || null,
        agencyClientsCount: agencyClients.length,
        agencyClients: agencyClients.slice(0, 10),
        campaignsWithoutFilter: campaignsNoFilter.length,
        campaignsSample: campaignsNoFilter.slice(0, 5),
        activeRules: ruleInfo,
        targetCampaignIds: [...allTargetCampaignIds],
        targetedFoundInDefault: targetedFoundInDefault,
        targetedMissedInDefault: [...allTargetCampaignIds].filter((id) => !defaultCampaignIds.has(id)),
        clientCampaignMatch,
      });
    }

    return results;
  },
});

// Internal helpers for audit
export const getAllAccountsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    return accounts.map((a) => ({
      _id: a._id,
      name: a.name,
      vkAccountId: a.vkAccountId,
      userId: a.userId,
      userName: "",
      accessToken: a.accessToken,
      mtAdvertiserId: (a as Record<string, unknown>).mtAdvertiserId as string | undefined,
      status: a.status,
    }));
  },
});

export const getAllActiveRulesInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rules = await ctx.db.query("rules").collect();
    return rules
      .filter((r) => r.isActive)
      .map((r) => ({
        _id: r._id,
        name: r.name,
        type: r.type,
        targetAccountIds: r.targetAccountIds,
        targetCampaignIds: r.targetCampaignIds || [],
      }));
  },
});

/**
 * TEMP — Clear stale OAuth credentials from an agency account
 * that was reconnected with a different token (different VK user).
 */
export const clearAgencyCredentials = internalMutation({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Account not found");
    await ctx.db.patch(args.accountId, {
      clientId: undefined,
      clientSecret: undefined,
      refreshToken: undefined,
      tokenExpiresAt: undefined,
    });
  },
});

// Set vitaminCabinetId for agency_client accounts (Vitamin.tools token refresh)
export const setVitaminCabinetId = mutation({
  args: {
    accountId: v.id("adAccounts"),
    vitaminCabinetId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Аккаунт не найден");
    await ctx.db.patch(args.accountId, {
      vitaminCabinetId: args.vitaminCabinetId,
    });
  },
});

// TEMP: Audit all account tokens — remove after use
export const auditTokenHealth = action({
  args: { adminUserId: v.string() },
  handler: async (ctx, args): Promise<unknown> => {
    // Only admin can run this
    if (args.adminUserId !== "kx7djrrpr67bry6zxehzx0e65x8141ct") {
      throw new Error("Unauthorized");
    }
    const users: unknown = await ctx.runQuery(internal.adAccounts.auditTokenHealthQuery);
    return users;
  },
});

export const auditTokenHealthQuery = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const accounts = await ctx.db.query("adAccounts").collect();
    const now = Date.now();

    const result: {
      userId: string;
      userName: string;
      email: string;
      vkTokenExpired: boolean;
      vkAdsTokenExpired: boolean;
      vkTokenExpiresAt: number | null;
      vkAdsTokenExpiresAt: number | null;
      hasVkRefresh: boolean;
      hasVkAdsRefresh: boolean;
      accounts: {
        id: string;
        name: string;
        status: string;
        tokenExpiresAt: number | null;
        tokenExpired: boolean;
        hasRefresh: boolean;
        isAgency: boolean;
      }[];
    }[] = [];

    for (const u of users) {
      const userAccounts = accounts.filter((a) => a.userId === u._id);
      if (userAccounts.length === 0) continue;

      result.push({
        userId: u._id,
        userName: u.name || "",
        email: u.email || "",
        vkTokenExpired: !!(u.vkTokenExpiresAt && u.vkTokenExpiresAt < now),
        vkAdsTokenExpired: !!(u.vkAdsTokenExpiresAt && u.vkAdsTokenExpiresAt < now),
        vkTokenExpiresAt: u.vkTokenExpiresAt || null,
        vkAdsTokenExpiresAt: u.vkAdsTokenExpiresAt || null,
        hasVkRefresh: !!u.vkRefreshToken,
        hasVkAdsRefresh: !!u.vkAdsRefreshToken,
        accounts: userAccounts.map((a) => ({
          id: a._id,
          name: a.name,
          status: a.status,
          tokenExpiresAt: a.tokenExpiresAt || null,
          tokenExpired: !!(a.tokenExpiresAt && a.tokenExpiresAt < now),
          hasRefresh: !!a.refreshToken,
          isAgency: a.vkAccountId.startsWith("agency_"),
        })),
      });
    }
    return result;
  },
});

/**
 * TEMP — Diagnose campaign count: VK API (real) vs DB (saved).
 * For each active account, fetches all campaigns from VK with pagination
 * and compares to what's in our campaigns table.
 * Remove after use.
 */
export const diagnoseCampaignCounts = action({
  args: {},
  handler: async (ctx): Promise<unknown> => {
    const accounts: Array<{
      _id: string; name: string; userId: string; status: string;
      accessToken: string; vkAccountId: string;
    }> = await ctx.runQuery(internal.adAccounts.getAllAccountsInternal) as never;

    const activeAccounts = accounts.filter((a) => a.status === "active");
    console.log(`[diagnoseCampaignCounts] ${activeAccounts.length} active accounts out of ${accounts.length} total`);

    const results: Array<{
      accountName: string;
      accountId: string;
      userId: string;
      vkApiCount: number;
      dbCount: number;
      diff: number;
      missingInDb: string[];
      error?: string;
    }> = [];

    for (const acc of activeAccounts) {
      try {
        // Get valid token
        let token: string;
        try {
          token = await ctx.runAction(internal.auth.getValidTokenForAccount, {
            accountId: acc._id as never,
          });
        } catch {
          results.push({
            accountName: acc.name, accountId: acc._id, userId: acc.userId,
            vkApiCount: -1, dbCount: -1, diff: 0, missingInDb: [],
            error: "TOKEN_ERROR",
          });
          continue;
        }

        // Fetch ALL campaigns from VK API with pagination
        const vkCampaigns = await ctx.runAction(
          internal.vkApi.getCampaignsForAccount,
          { accessToken: token }
        ) as Array<{ id: number; name: string; status: string }>;

        // Count campaigns in our DB for this account
        const dbCampaigns: Array<{ vkCampaignId: string }> = await ctx.runQuery(
          internal.adAccounts.getCampaignsForAccountDiag,
          { accountId: acc._id as never }
        ) as never;

        const dbIds = new Set(dbCampaigns.map((c) => c.vkCampaignId));
        const missingInDb = vkCampaigns
          .filter((c) => !dbIds.has(String(c.id)))
          .map((c) => `${c.id} (${c.name || "?"}, ${c.status})`);

        results.push({
          accountName: acc.name,
          accountId: acc._id,
          userId: acc.userId,
          vkApiCount: vkCampaigns.length,
          dbCount: dbCampaigns.length,
          diff: vkCampaigns.length - dbCampaigns.length,
          missingInDb: missingInDb.slice(0, 20), // cap output
        });
      } catch (err) {
        results.push({
          accountName: acc.name, accountId: acc._id, userId: acc.userId,
          vkApiCount: -1, dbCount: -1, diff: 0, missingInDb: [],
          error: String(err),
        });
      }
    }

    // Sort: biggest diff first
    results.sort((a, b) => b.diff - a.diff);
    return results;
  },
});

/** TEMP — helper for diagnoseCampaignCounts */
export const getCampaignsForAccountDiag = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
});
