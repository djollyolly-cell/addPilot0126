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
      await ctx.db.patch(existing._id, {
        ...(args.apiKey !== undefined && { apiKey: args.apiKey }),
        ...(args.oauthClientId !== undefined && { oauthClientId: args.oauthClientId }),
        ...(args.oauthClientSecret !== undefined && { oauthClientSecret: args.oauthClientSecret }),
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

// ---- Vitamin flow ----

/** Connect a Vitamin cabinet: user provides VK token from Vitamin support + cabinet ID */
export const vitaminConnectAccount = action({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    accessToken: v.string(),
    cabinetId: v.string(),
    accountName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ accountId: string }> => {
    const accessToken = args.accessToken.trim();
    const cabinetId = args.cabinetId.trim();
    if (!accessToken) throw new Error("Введите токен от Витамин");
    if (!cabinetId) throw new Error("Введите ID кабинета");

    const name = args.accountName?.trim() || `Витамин #${cabinetId}`;

    // Connect directly with the VK token from Vitamin support
    const result: { accountId: string } = await ctx.runAction(
      internal.adAccounts.connectAgencyAccountInternal,
      {
        userId: args.userId,
        accessToken,
        name,
        agencyProviderId: args.providerId,
        agencyCabinetId: cabinetId,
      }
    );

    // Set vitaminCabinetId for future auto-refresh via server VITAMIN_API_KEY
    await ctx.runMutation(internal.adAccounts.patchAccount, {
      accountId: result.accountId as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      vitaminCabinetId: cabinetId,
    });

    // Save credentials (no user API key needed — refresh uses server env var)
    await ctx.runMutation(selfInternal.agencyProviders.saveCredentialsInternal, {
      userId: args.userId,
      providerId: args.providerId,
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
          { key: "accessToken", label: "Токен от Витамин", placeholder: "Токен из поддержки Витамин", type: "password" },
          { key: "cabinetId", label: "ID кабинета в Витамин", placeholder: "Например: 26530229", type: "text" },
        ],
        notes: "Токен получить в поддержке Витамин. ID кабинета — из раздела Реклама → Рекламные аккаунты",
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
        notes: "API нет. Токен получается вручную через agency.cerebroapps.ru",
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
