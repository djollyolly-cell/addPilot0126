import { query, mutation, action, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const selfInternal = internal as any;

// ---- Queries ----

/** List all agency providers (for UI dropdown) */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("agencyProviders").collect();
  },
});

/** Get provider by name (internal) */
export const getByName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agencyProviders")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
  },
});

/** Get credentials for a user + provider (secrets filtered) */
export const getCredentials = query({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
  },
  handler: async (ctx, args) => {
    const creds = await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId_provider", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();
    if (!creds) return null;
    // Never expose secrets to frontend
    return {
      _id: creds._id,
      userId: creds.userId,
      providerId: creds.providerId,
      isActive: creds.isActive,
      hasApiKey: !!creds.apiKey,
      hasOauthClientId: !!creds.oauthClientId,
      hasOauthToken: !!creds.oauthAccessToken,
      oauthTokenExpiresAt: creds.oauthTokenExpiresAt,
      createdAt: creds.createdAt,
      lastUsedAt: (creds as Record<string, unknown>).lastUsedAt as number | undefined,
    };
  },
});

/** Get all credentials for a user */
export const getUserCredentials = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

// ---- Internal queries ----

export const getCredentialsInternal = internalQuery({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId_provider", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();
  },
});

// ---- Mutations ----

/** Save or update credentials for a user + provider */
export const saveCredentials = mutation({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    apiKey: v.optional(v.string()),
    oauthClientId: v.optional(v.string()),
    oauthClientSecret: v.optional(v.string()),
    oauthAccessToken: v.optional(v.string()),
    oauthRefreshToken: v.optional(v.string()),
    oauthTokenExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId_provider", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...(args.apiKey !== undefined && { apiKey: args.apiKey }),
        ...(args.oauthClientId !== undefined && { oauthClientId: args.oauthClientId }),
        ...(args.oauthClientSecret !== undefined && { oauthClientSecret: args.oauthClientSecret }),
        ...(args.oauthAccessToken !== undefined && { oauthAccessToken: args.oauthAccessToken }),
        ...(args.oauthRefreshToken !== undefined && { oauthRefreshToken: args.oauthRefreshToken }),
        ...(args.oauthTokenExpiresAt !== undefined && { oauthTokenExpiresAt: args.oauthTokenExpiresAt }),
        lastUsedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("agencyCredentials", {
      userId: args.userId,
      providerId: args.providerId,
      apiKey: args.apiKey,
      oauthClientId: args.oauthClientId,
      oauthClientSecret: args.oauthClientSecret,
      oauthAccessToken: args.oauthAccessToken,
      oauthRefreshToken: args.oauthRefreshToken,
      oauthTokenExpiresAt: args.oauthTokenExpiresAt,
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

/** Internal: save credentials (callable from actions) */
export const saveCredentialsInternal = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    apiKey: v.optional(v.string()),
    oauthClientId: v.optional(v.string()),
    oauthClientSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId_provider", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();

    if (existing) {
      // Save previous apiKey before overwriting (for audit trail)
      const patchData: Record<string, unknown> = { lastUsedAt: Date.now() };
      if (args.apiKey !== undefined) {
        if (existing.apiKey && existing.apiKey !== args.apiKey) {
          patchData.previousApiKey = existing.apiKey;
        }
        patchData.apiKey = args.apiKey;
      }
      if (args.oauthClientId !== undefined) patchData.oauthClientId = args.oauthClientId;
      if (args.oauthClientSecret !== undefined) patchData.oauthClientSecret = args.oauthClientSecret;
      await ctx.db.patch(existing._id, patchData);
      return existing._id;
    }

    return await ctx.db.insert("agencyCredentials", {
      userId: args.userId,
      providerId: args.providerId,
      apiKey: args.apiKey,
      oauthClientId: args.oauthClientId,
      oauthClientSecret: args.oauthClientSecret,
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

// ---- GetUNIQ OAuth2 flow ----

const GETUNIQ_AUTH_URL = "https://getuniq.me/oauth/v2/auth";
const GETUNIQ_TOKEN_URL = "https://getuniq.me/oauth/v2/token";
const GETUNIQ_API_BASE = "https://getuniq.me/api/v1";

/** Build GetUNIQ OAuth URL for user to authorize */
export const getuniqStartAuth = action({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    redirectUri: v.string(),
  },
  handler: async (ctx, args) => {
    const creds = await ctx.runQuery(selfInternal.agencyProviders.getCredentialsInternal, {
      userId: args.userId,
      providerId: args.providerId,
    });
    if (!creds?.oauthClientId) {
      throw new Error("Сначала сохраните Client ID и Client Secret");
    }

    const params = new URLSearchParams({
      client_id: creds.oauthClientId,
      redirect_uri: args.redirectUri,
      response_type: "code",
      scope: "user_accounts",
    });

    return { authUrl: `${GETUNIQ_AUTH_URL}?${params.toString()}` };
  },
});

/** Exchange GetUNIQ authorization code for access_token + refresh_token */
export const getuniqExchangeCode = action({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    code: v.string(),
    redirectUri: v.string(),
  },
  handler: async (ctx, args) => {
    const creds = await ctx.runQuery(selfInternal.agencyProviders.getCredentialsInternal, {
      userId: args.userId,
      providerId: args.providerId,
    });
    if (!creds?.oauthClientId || !creds?.oauthClientSecret) {
      throw new Error("Нет Client ID / Client Secret для GetUNIQ");
    }

    const params = new URLSearchParams({
      client_id: creds.oauthClientId,
      client_secret: creds.oauthClientSecret,
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
    });

    const resp = await fetch(`${GETUNIQ_TOKEN_URL}?${params.toString()}`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GetUNIQ token exchange failed: ${resp.status} ${text}`);
    }

    const data = await resp.json();
    // data: { access_token, refresh_token, expires_in, token_type }
    const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;

    await ctx.runMutation(selfInternal.agencyProviders.updateCredentialsTokens, {
      userId: args.userId,
      providerId: args.providerId,
      oauthAccessToken: data.access_token,
      oauthRefreshToken: data.refresh_token,
      oauthTokenExpiresAt: expiresAt,
    });

    return { success: true };
  },
});

/** Refresh GetUNIQ access_token using refresh_token */
async function refreshGetuniqToken(
  creds: { oauthClientId?: string; oauthClientSecret?: string; oauthRefreshToken?: string },
): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
  if (!creds.oauthClientId || !creds.oauthClientSecret || !creds.oauthRefreshToken) return null;

  const params = new URLSearchParams({
    client_id: creds.oauthClientId,
    client_secret: creds.oauthClientSecret,
    grant_type: "refresh_token",
    refresh_token: creds.oauthRefreshToken,
  });

  const resp = await fetch(`${GETUNIQ_TOKEN_URL}?${params.toString()}`);
  if (!resp.ok) return null;
  return await resp.json();
}

/** List available accounts from GetUNIQ (auto-refreshes token if needed) */
export const getuniqListAccounts = action({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
  },
  handler: async (ctx, args) => {
    let creds = await ctx.runQuery(selfInternal.agencyProviders.getCredentialsInternal, {
      userId: args.userId,
      providerId: args.providerId,
    });

    if (!creds?.oauthAccessToken) {
      throw new Error("Необходима авторизация в GetUNIQ");
    }

    // Refresh if expired
    if (creds.oauthTokenExpiresAt && creds.oauthTokenExpiresAt < Date.now() + 60000) {
      const refreshed = await refreshGetuniqToken(creds);
      if (!refreshed) throw new Error("Не удалось обновить токен GetUNIQ. Авторизуйтесь заново.");

      const expiresAt = Date.now() + (refreshed.expires_in || 3600) * 1000;
      await ctx.runMutation(selfInternal.agencyProviders.updateCredentialsTokens, {
        userId: args.userId,
        providerId: args.providerId,
        oauthAccessToken: refreshed.access_token,
        oauthRefreshToken: refreshed.refresh_token,
        oauthTokenExpiresAt: expiresAt,
      });
      creds = { ...creds, oauthAccessToken: refreshed.access_token };
    }

    const resp = await fetch(`${GETUNIQ_API_BASE}/accounts?status=verified`, {
      headers: { Authorization: `Bearer ${creds.oauthAccessToken}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GetUNIQ accounts fetch failed: ${resp.status} ${text}`);
    }

    const data = await resp.json();
    // Expect array of accounts with id, name, status, type, etc.
    const accounts = Array.isArray(data) ? data : data.data || data.items || [];
    return { accounts };
  },
});

/** Get VK Ads token for a specific GetUNIQ account and connect it */
export const getuniqConnectAccount = action({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    getuniqAccountId: v.string(),
    accountName: v.string(),
  },
  handler: async (ctx, args): Promise<{ accountId: string }> => {
    let creds = await ctx.runQuery(selfInternal.agencyProviders.getCredentialsInternal, {
      userId: args.userId,
      providerId: args.providerId,
    });

    if (!creds?.oauthAccessToken) {
      throw new Error("Необходима авторизация в GetUNIQ");
    }

    // Refresh if expired
    if (creds.oauthTokenExpiresAt && creds.oauthTokenExpiresAt < Date.now() + 60000) {
      const refreshed = await refreshGetuniqToken(creds);
      if (!refreshed) throw new Error("Не удалось обновить токен GetUNIQ");

      const expiresAt = Date.now() + (refreshed.expires_in || 3600) * 1000;
      await ctx.runMutation(selfInternal.agencyProviders.updateCredentialsTokens, {
        userId: args.userId,
        providerId: args.providerId,
        oauthAccessToken: refreshed.access_token,
        oauthRefreshToken: refreshed.refresh_token,
        oauthTokenExpiresAt: expiresAt,
      });
      creds = { ...creds, oauthAccessToken: refreshed.access_token };
    }

    // Fetch VK Ads token for this account
    const tokenResp = await fetch(
      `${GETUNIQ_API_BASE}/accounts/vk-ads/${args.getuniqAccountId}/token`,
      { headers: { Authorization: `Bearer ${creds.oauthAccessToken}` } },
    );

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      throw new Error(`Не удалось получить токен VK Ads: ${tokenResp.status} ${text}`);
    }

    const tokenData = await tokenResp.json();
    const vkToken = tokenData.token || tokenData.access_token;
    if (!vkToken) throw new Error("GetUNIQ не вернул токен VK Ads");

    // Connect via existing connectAgencyAccount flow
    const result: { accountId: string } = await ctx.runAction(internal.adAccounts.connectAgencyAccountInternal, {
      userId: args.userId,
      accessToken: vkToken,
      name: args.accountName,
      agencyProviderId: args.providerId,
      agencyCabinetId: args.getuniqAccountId,
    });

    return result;
  },
});

// ---- Click.ru flow ----

const CLICKRU_API_BASE = "https://api.click.ru/V0";

/** List available accounts from Click.ru */
export const clickruListAccounts = action({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
  },
  handler: async (ctx, args) => {
    const creds = await ctx.runQuery(selfInternal.agencyProviders.getCredentialsInternal, {
      userId: args.userId,
      providerId: args.providerId,
    });

    if (!creds?.apiKey) {
      throw new Error("Сначала сохраните API-токен Click.ru");
    }

    const resp = await fetch(`${CLICKRU_API_BASE}/accounts`, {
      headers: {
        "Accept": "application/json",
        "X-Auth-Token": creds.apiKey,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 401 || resp.status === 403) {
        throw new Error("API-токен Click.ru недействителен. Проверьте токен в профиле Click.ru.");
      }
      throw new Error(`Click.ru API: ${resp.status} ${text}`);
    }

    const data = await resp.json();
    const accounts = Array.isArray(data) ? data : data.data || data.items || [];
    return { accounts };
  },
});

/** Get VK Ads token for a Click.ru account and connect it */
export const clickruConnectAccount = action({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    clickruAccountId: v.string(),
    accountName: v.string(),
  },
  handler: async (ctx, args): Promise<{ accountId: string }> => {
    const creds = await ctx.runQuery(selfInternal.agencyProviders.getCredentialsInternal, {
      userId: args.userId,
      providerId: args.providerId,
    });

    if (!creds?.apiKey) {
      throw new Error("Нет API-токена Click.ru");
    }

    // Get VK Ads token for this account
    const tokenResp = await fetch(
      `${CLICKRU_API_BASE}/accounts/${args.clickruAccountId}/access_token/vk_ads/`,
      {
        headers: {
          "Accept": "application/json",
          "X-Auth-Token": creds.apiKey,
        },
      },
    );

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      throw new Error(`Не удалось получить VK-токен: ${tokenResp.status} ${text}`);
    }

    const tokenData = await tokenResp.json();
    const vkToken = tokenData.token || tokenData.access_token || tokenData.data?.token || tokenData.data?.access_token;
    if (!vkToken) throw new Error("Click.ru не вернул VK-токен");

    const result: { accountId: string } = await ctx.runAction(internal.adAccounts.connectAgencyAccountInternal, {
      userId: args.userId,
      accessToken: vkToken,
      name: args.accountName,
      agencyProviderId: args.providerId,
      agencyCabinetId: args.clickruAccountId,
    });

    return result;
  },
});

// ---- ZaleyCash flow ----

const ZALEYCASH_API_BASE = "https://zaleycash.com/api/v2";

/** Exchange ZaleyCash secret key for a session access token */
async function getZaleycashSessionToken(secretKey: string): Promise<{ accessToken: string; expiresAt: number }> {
  const resp = await fetch(`${ZALEYCASH_API_BASE}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      throw new Error("Секретный ключ ZaleyCash недействителен. Проверьте ключ в профиле ZaleyCash.");
    }
    throw new Error(`ZaleyCash token error: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return {
    accessToken: data.access_token || data.accessToken || data.token,
    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + 3600 * 1000,
  };
}

/** List available accounts from ZaleyCash */
export const zaleycashListAccounts = action({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
  },
  handler: async (ctx, args) => {
    const creds = await ctx.runQuery(selfInternal.agencyProviders.getCredentialsInternal, {
      userId: args.userId,
      providerId: args.providerId,
    });

    if (!creds?.apiKey) {
      throw new Error("Сначала сохраните секретный ключ ZaleyCash");
    }

    // Get session token from secret key
    const session = await getZaleycashSessionToken(creds.apiKey);

    // Save session token for future use
    await ctx.runMutation(selfInternal.agencyProviders.updateCredentialsTokens, {
      userId: args.userId,
      providerId: args.providerId,
      oauthAccessToken: session.accessToken,
      oauthTokenExpiresAt: session.expiresAt,
    });

    const resp = await fetch(`${ZALEYCASH_API_BASE}/user/accounts/list`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`ZaleyCash accounts error: ${resp.status} ${text}`);
    }

    const data = await resp.json();
    const accounts = Array.isArray(data) ? data : data.data || data.items || data.accounts || [];
    return { accounts };
  },
});

/** Get VK Ads token for a ZaleyCash account and connect it */
export const zaleycashConnectAccount = action({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    zaleycashAccountId: v.string(),
    accountName: v.string(),
  },
  handler: async (ctx, args): Promise<{ accountId: string }> => {
    const creds = await ctx.runQuery(selfInternal.agencyProviders.getCredentialsInternal, {
      userId: args.userId,
      providerId: args.providerId,
    });

    if (!creds?.apiKey) {
      throw new Error("Нет секретного ключа ZaleyCash");
    }

    // Get fresh session token
    const session = await getZaleycashSessionToken(creds.apiKey);

    // Save refreshed session token
    await ctx.runMutation(selfInternal.agencyProviders.updateCredentialsTokens, {
      userId: args.userId,
      providerId: args.providerId,
      oauthAccessToken: session.accessToken,
      oauthTokenExpiresAt: session.expiresAt,
    });

    // Get myTarget/VK Ads token for this account
    const tokenResp = await fetch(`${ZALEYCASH_API_BASE}/my_target/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ account_id: args.zaleycashAccountId }),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      throw new Error(`Не удалось получить VK-токен: ${tokenResp.status} ${text}`);
    }

    const tokenData = await tokenResp.json();
    const vkToken = tokenData.accessToken || tokenData.access_token || tokenData.token;
    if (!vkToken) throw new Error("ZaleyCash не вернул VK-токен");

    const result: { accountId: string } = await ctx.runAction(internal.adAccounts.connectAgencyAccountInternal, {
      userId: args.userId,
      accessToken: vkToken,
      name: args.accountName,
      agencyProviderId: args.providerId,
      agencyCabinetId: args.zaleycashAccountId,
    });

    return result;
  },
});

// ---- Vitamin flow ----

const VITAMIN_API_URL = "https://app.vitamin.tools/ext/api/v1/external_account/account/get-token-list-by-clients";

/** Connect a Vitamin cabinet: user provides VK token + API key + cabinet ID */
export const vitaminConnectAccount = action({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    accessToken: v.string(),
    apiKey: v.string(),
    cabinetId: v.string(),
    accountName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ accountId: string }> => {
    const vkToken = args.accessToken.replace(/\s+/g, "").trim();
    const apiKey = args.apiKey.trim();
    const cabinetId = args.cabinetId.trim();

    if (!vkToken) throw new Error("Вставьте токен от Витамин");
    if (!apiKey) throw new Error("Введите API-ключ Витамин");
    if (!cabinetId) throw new Error("Введите ID кабинета");

    // Verify API key + cabinet ID work with Vitamin API
    const verifyResp = await fetch(VITAMIN_API_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: [parseInt(cabinetId)] }),
    });

    if (!verifyResp.ok) {
      const text = await verifyResp.text();
      if (verifyResp.status === 401 || verifyResp.status === 403) {
        throw new Error("API-ключ Витамин недействителен. Проверьте ключ.");
      }
      throw new Error(`Ошибка проверки Vitamin API: ${verifyResp.status} ${text}`);
    }

    const verifyData = await verifyResp.json();
    if (verifyData.is_ok === false || verifyData.error) {
      const errMsg = verifyData.error?.message || JSON.stringify(verifyData.error) || "Неизвестная ошибка";
      throw new Error(`Vitamin API: ${errMsg}`);
    }

    const name = args.accountName?.trim() || `Витамин #${cabinetId}`;

    // Find existing account by stable vitaminCabinetId to prevent duplicates on reconnection.
    // Old accounts have vkAccountId=agency_{token[0:16]} which changes with each new token.
    // By finding the existing record first, we reuse its vkAccountId so connect() matches and updates it.
    const existingAccount = await ctx.runQuery(internal.adAccounts.findByAgencyCabinetId, {
      userId: args.userId,
      agencyCabinetId: cabinetId,
    });

    let result: { accountId: string };
    if (existingAccount) {
      // Reconnection: update existing account via connect() using its original vkAccountId
      result = { accountId: existingAccount._id };
      await ctx.runMutation(internal.adAccounts.updateAccountToken, {
        accountId: existingAccount._id,
        accessToken: vkToken,
        name,
      });
    } else {
      // First connection: use stable vkAccountId based on cabinetId (not token)
      result = await ctx.runAction(
        internal.adAccounts.connectAgencyAccountInternal,
        {
          userId: args.userId,
          accessToken: vkToken,
          name,
          agencyProviderId: args.providerId,
          agencyCabinetId: cabinetId,
        }
      );
    }

    // Save cabinet ID for auto-refresh
    await ctx.runMutation(internal.adAccounts.patchAccount, {
      accountId: result.accountId as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      vitaminCabinetId: cabinetId,
    });

    // Save API key for auto-refresh
    await ctx.runMutation(selfInternal.agencyProviders.saveCredentialsInternal, {
      userId: args.userId,
      providerId: args.providerId,
      apiKey,
    });

    return result;
  },
});

/** Internal mutation to update OAuth tokens in credentials */
export const updateCredentialsTokens = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    oauthAccessToken: v.string(),
    oauthRefreshToken: v.optional(v.string()),
    oauthTokenExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId_provider", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();

    if (!existing) throw new Error("Credentials not found");

    await ctx.db.patch(existing._id, {
      oauthAccessToken: args.oauthAccessToken,
      ...(args.oauthRefreshToken !== undefined && { oauthRefreshToken: args.oauthRefreshToken }),
      ...(args.oauthTokenExpiresAt !== undefined && { oauthTokenExpiresAt: args.oauthTokenExpiresAt }),
      lastUsedAt: Date.now(),
    });
  },
});

/** Update provider record in DB (for fixing seed data) */
export const updateProvider = internalMutation({
  args: {
    name: v.string(),
    requiredFields: v.optional(v.array(v.object({
      key: v.string(),
      label: v.string(),
      placeholder: v.optional(v.string()),
      type: v.optional(v.string()),
    }))),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const provider = await ctx.db
      .query("agencyProviders")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
    if (!provider) throw new Error(`Provider ${args.name} not found`);

    const patch: Record<string, unknown> = {};
    if (args.requiredFields !== undefined) patch.requiredFields = args.requiredFields;
    if (args.notes !== undefined) patch.notes = args.notes;

    await ctx.db.patch(provider._id, patch);
    return provider._id;
  },
});

// ---- Seed providers ----

/** Seed all 4 agency providers. Safe to run multiple times — skips existing. */
export const seedProviders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const PROVIDERS = [
      {
        name: "vitamin",
        displayName: "Витамин",
        hasApi: true,
        authMethod: "api_key",
        requiredFields: [
          { key: "accessToken", label: "Токен от Витамин", placeholder: "Вставьте токен, полученный от Витамин", type: "textarea" },
          { key: "apiKey", label: "API-ключ Витамин", placeholder: "Выдаётся Витамин вместе с токеном", type: "password" },
          { key: "cabinetId", label: "ID кабинета в Витамин", placeholder: "Из ЛК Витамин → Реклама → Рекламные аккаунты, столбец ID", type: "text" },
          { key: "accountName", label: "Название кабинета", placeholder: "Например: Клиент Иванов", type: "text" },
        ],
        notes: "Все данные предоставляет Витамин: токен, API-ключ и ID кабинета.",
      },
      {
        name: "getuniq",
        displayName: "GetUNIQ",
        hasApi: true,
        authMethod: "oauth2",
        requiredFields: [
          { key: "clientId", label: "Client ID", placeholder: "70_...", type: "text" },
          { key: "clientSecret", label: "Client Secret", placeholder: "Секретный ключ приложения", type: "password" },
        ],
        notes: "Введите данные приложения GetUNIQ, затем авторизуйтесь для получения списка кабинетов.",
        docsUrl: "https://dev.getuniq.me/",
      },
      {
        name: "clickru",
        displayName: "Click.ru",
        hasApi: true,
        authMethod: "api_key",
        requiredFields: [
          { key: "apiKey", label: "API-токен Click.ru", placeholder: "Токен из профиля Click.ru", type: "password" },
        ],
        notes: "Токен получить в профиле Click.ru → раздел API Token. После ввода загрузится список кабинетов.",
        docsUrl: "https://api.click.ru/",
      },
      {
        name: "targethunter",
        displayName: "TargetHunter",
        hasApi: false,
        requiredFields: [
          { key: "accessToken", label: "Токен доступа", placeholder: "Бессрочный токен из lead.targethunter.ru", type: "textarea" },
          { key: "accountName", label: "Название кабинета", placeholder: "Например: Клиент Иванов", type: "text" },
        ],
        notes: "Токены бессрочные. Получить в настройках кабинета LeadHunter.",
      },
      {
        name: "cerebro",
        displayName: "Церебро",
        hasApi: false,
        requiredFields: [
          { key: "accessToken", label: "Токен доступа", placeholder: "Токен из agency.cerebroapps.ru", type: "textarea" },
          { key: "accountName", label: "Название кабинета", placeholder: "Например: Клиент Петров", type: "text" },
        ],
        notes: "Токен получается через agency.cerebroapps.ru",
      },
      {
        name: "zaleycash",
        displayName: "ZaleyCash",
        hasApi: true,
        authMethod: "api_key",
        requiredFields: [
          { key: "apiKey", label: "Секретный ключ ZaleyCash", placeholder: "Ключ из профиля ZaleyCash", type: "password" },
        ],
        notes: "Секретный ключ получить в профиле ZaleyCash. После ввода загрузится список кабинетов.",
      },
      {
        name: "kotbot",
        displayName: "Кот Бот",
        hasApi: false,
        requiredFields: [
          { key: "accessToken", label: "Токен доступа", placeholder: "access_token из JSON-файла от Кот Бот", type: "textarea" },
          { key: "accountName", label: "Название кабинета", placeholder: "Например: Клиент Сидоров", type: "text" },
        ],
        notes: "Токен запросить у поддержки Кот Бот. Бессрочный, автообновление не требуется.",
      },
      {
        name: "elama",
        displayName: "eLama",
        hasApi: false,
        requiredFields: [
          { key: "accessToken", label: "Токен доступа", placeholder: "Токен из eLama", type: "textarea" },
          { key: "accountName", label: "Название кабинета", placeholder: "Например: Клиент Иванов", type: "text" },
        ],
        notes: "Токен получается через личный кабинет eLama.",
      },
    ];

    const seeded: string[] = [];
    for (const p of PROVIDERS) {
      const existing = await ctx.db
        .query("agencyProviders")
        .withIndex("by_name", (q) => q.eq("name", p.name))
        .first();
      if (!existing) {
        await ctx.db.insert("agencyProviders", {
          ...p,
          createdAt: Date.now(),
        });
        seeded.push(p.name);
      } else {
        // Update existing provider with latest fields
        await ctx.db.patch(existing._id, {
          displayName: p.displayName,
          hasApi: p.hasApi,
          authMethod: p.authMethod,
          requiredFields: p.requiredFields,
          notes: p.notes,
          docsUrl: (p as Record<string, unknown>).docsUrl as string | undefined,
        });
        seeded.push(`${p.name}(updated)`);
      }
    }
    return { seeded };
  },
});

// ---- TEMP: one-time migration for Vitamin accounts where API key was saved as accessToken ----

/** Migrate Vitamin API key from adAccounts.accessToken → agencyCredentials.apiKey,
 *  then call Vitamin API to get real VK token and save it back. */
export const migrateVitaminApiKeys = action({
  args: {
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args): Promise<{ migrated: boolean; apiKeySaved: boolean; vkTokenObtained: boolean; error?: string; accountName?: string }> => {
    // 1. Get account
    const account: Record<string, unknown> | null = await ctx.runQuery(internal.auth.getAccountWithCredentials, {
      accountId: args.accountId,
    });
    if (!account) throw new Error("Аккаунт не найден");
    if (!account.vitaminCabinetId) throw new Error("Нет vitaminCabinetId");
    if (!account.agencyProviderId) throw new Error("Нет agencyProviderId");

    const vitaminApiKey: string = account.accessToken as string;
    if (!vitaminApiKey) throw new Error("Нет accessToken для миграции");

    // 2. Save API key to agencyCredentials
    await ctx.runMutation(selfInternal.agencyProviders.saveCredentialsInternal, {
      userId: account.userId as string,
      providerId: account.agencyProviderId as string,
      apiKey: vitaminApiKey,
    });

    // 3. Call Vitamin API with this key to get real VK token
    const resp: Response = await fetch(VITAMIN_API_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": vitaminApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: [parseInt(account.vitaminCabinetId as string)] }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { migrated: true, apiKeySaved: true, vkTokenObtained: false, error: `Vitamin API ${resp.status}: ${text}` };
    }

    const data = await resp.json();

    if (data.is_ok === false || data.error) {
      const errMsg = data.error?.message || JSON.stringify(data.error) || "Неизвестная ошибка";
      return { migrated: true, apiKeySaved: true, vkTokenObtained: false, error: `Vitamin API: ${errMsg}` };
    }

    // Extract VK token
    let vkToken: string | null = null;
    if (Array.isArray(data)) {
      vkToken = data[0]?.token || data[0]?.access_token || null;
    } else if (data.data && Array.isArray(data.data)) {
      vkToken = data.data[0]?.token || data.data[0]?.access_token || null;
    } else if (data.token) {
      vkToken = data.token;
    } else if (data.access_token) {
      vkToken = data.access_token;
    }

    if (!vkToken) {
      return { migrated: true, apiKeySaved: true, vkTokenObtained: false, error: `Нет токена в ответе: ${JSON.stringify(data).slice(0, 200)}` };
    }

    // 4. Save real VK token to adAccount
    await ctx.runMutation(internal.auth.updateVitaminToken, {
      accountId: args.accountId,
      accessToken: vkToken,
    });

    return { migrated: true, apiKeySaved: true, vkTokenObtained: true, accountName: account.name as string | undefined };
  },
});
