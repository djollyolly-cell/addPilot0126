import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { quickTokenCheck } from "./tokenRecovery";
import { Id } from "./_generated/dataModel";

// VK ID OAuth 2.1 (login — id.vk.com)
const VK_API_VERSION = "5.131";
const VK_ID_AUTHORIZE_URL = "https://id.vk.com/authorize";
const VK_ID_TOKEN_URL = "https://id.vk.com/oauth2/auth";
const VK_API_URL = "https://api.vk.com/method";



// ─── LOGIN via VK ID OAuth 2.1 ───────────────────────────────────

// Generate VK ID OAuth 2.1 authorization URL with PKCE
export const getVkAuthUrl = action({
  args: {
    redirectUri: v.string(),
    codeChallenge: v.string(),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    // Rate limiting by state (unique per request)
    const rateLimitKey = `oauth_auth:${args.state.slice(0, 16)}`;
    const rateCheck = await ctx.runQuery(internal.rateLimit.checkRateLimit, {
      key: rateLimitKey,
      type: "oauth_auth_url",
    });

    if (!rateCheck.allowed) {
      throw new Error(
        `Rate limit exceeded. Try again in ${Math.ceil((rateCheck.retryAfterMs || 60000) / 1000)} seconds.`
      );
    }

    await ctx.runMutation(internal.rateLimit.recordAttempt, {
      key: rateLimitKey,
      type: "oauth_auth_url",
    });

    const clientId = process.env.VK_CLIENT_ID;
    if (!clientId) {
      throw new Error("VK_CLIENT_ID is not configured");
    }

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: args.redirectUri,
      scope: "email ads",
      state: args.state,
      code_challenge: args.codeChallenge,
      code_challenge_method: "S256",
    });

    return `${VK_ID_AUTHORIZE_URL}?${params.toString()}`;
  },
});

// Exchange authorization code for access token via VK ID OAuth 2.1
export const exchangeCodeForToken = action({
  args: {
    code: v.string(),
    redirectUri: v.string(),
    codeVerifier: v.string(),
    deviceId: v.string(),
    state: v.string(),
    userEmail: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    sessionToken: v.string(),
    user: v.object({
      id: v.string(),
      vkId: v.string(),
      name: v.string(),
      avatarUrl: v.optional(v.string()),
      email: v.string(),
    }),
  }),
  handler: async (ctx, args): Promise<{
    success: boolean;
    sessionToken: string;
    user: {
      id: string;
      vkId: string;
      name: string;
      avatarUrl?: string;
      email: string;
    };
  }> => {
    // Rate limiting by deviceId (5 attempts per minute)
    const rateLimitKey = `oauth_exchange:${args.deviceId}`;
    const rateCheck = await ctx.runQuery(internal.rateLimit.checkRateLimit, {
      key: rateLimitKey,
      type: "oauth_exchange",
    });

    if (!rateCheck.allowed) {
      throw new Error(
        `Too many login attempts. Try again in ${Math.ceil((rateCheck.retryAfterMs || 60000) / 1000)} seconds.`
      );
    }

    await ctx.runMutation(internal.rateLimit.recordAttempt, {
      key: rateLimitKey,
      type: "oauth_exchange",
    });

    const clientId = process.env.VK_CLIENT_ID;
    const clientSecret = process.env.VK_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("VK OAuth credentials are not configured");
    }

    // Exchange code for token via VK ID OAuth 2.1
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: clientId,
      device_id: args.deviceId,
      code_verifier: args.codeVerifier,
      state: args.state,
    });

    const response = await fetch(VK_ID_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenParams.toString(),
    });
    const data = await response.json();

    if (data.error) {
      throw new Error(data.error_description || data.error || "Failed to exchange code for token");
    }

    const accessToken = data.access_token;
    const userId = data.user_id;
    const email = data.email || args.userEmail || null;

    // Get user info from VK API
    const userInfoParams = new URLSearchParams({
      access_token: accessToken,
      v: VK_API_VERSION,
      fields: "photo_200",
    });

    const userInfoResponse = await fetch(
      `${VK_API_URL}/users.get?${userInfoParams.toString()}`
    );
    const userInfoData = await userInfoResponse.json();

    if (userInfoData.error) {
      throw new Error(userInfoData.error.error_msg || "Failed to get user info");
    }

    const vkUser = userInfoData.response[0];

    // Create or update user in our database
    const dbUserId: Id<"users"> = await ctx.runMutation(internal.users.upsertFromVk, {
      vkId: String(userId),
      email: email || `${userId}@vk.com`,
      name: `${vkUser.first_name} ${vkUser.last_name}`,
      avatarUrl: vkUser.photo_200,
      accessToken: accessToken,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 0,
      deviceId: args.deviceId,
    });

    // Auto-discover VK Ads cabinet ID (advertiser ID) via ads.getAccounts
    try {
      const adsResp = await fetch(`${VK_API_URL}/ads.getAccounts?v=${VK_API_VERSION}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `access_token=${accessToken}`,
      });
      const adsData = await adsResp.json();
      console.log(`[auth] ads.getAccounts response: ${JSON.stringify(adsData).substring(0, 300)}`);
      if (adsData.response && Array.isArray(adsData.response) && adsData.response.length > 0) {
        const cabinetId = String(adsData.response[0].account_id);
        // Save cabinet ID on user record (accounts may not exist yet)
        await ctx.runMutation(internal.auth.saveVkAdsCabinetId, {
          userId: dbUserId,
          vkAdsCabinetId: cabinetId,
        });
        // Also try to set on existing ad accounts
        await ctx.runMutation(internal.auth.setAdvertiserIdForUser, {
          userId: dbUserId,
          mtAdvertiserId: cabinetId,
        });
        console.log(`[auth] Auto-discovered cabinet ID: ${cabinetId}`);
      }
    } catch (e) {
      console.log(`[auth] ads.getAccounts failed (non-critical): ${e}`);
    }

    // Create session
    const sessionToken: string = await ctx.runMutation(internal.authInternal.createSession, {
      userId: dbUserId,
    });

    return {
      success: true,
      sessionToken,
      user: {
        id: dbUserId as string,
        vkId: String(userId),
        name: `${vkUser.first_name} ${vkUser.last_name}`,
        avatarUrl: vkUser.photo_200,
        email: email || `${userId}@vk.com`,
      },
    };
  },
});

// ─── VK ADS API (myTarget / ads.vk.com) via Client Credentials ──

const VK_ADS_API_BASE = "https://target.my.com";

// Connect VK Ads — get token via Client Credentials Grant (no redirect needed)
// Priority: args → user record → env vars
// IMPORTANT: Reuses existing valid token to avoid "Active access token limit reached" error
export const connectVkAds = action({
  args: {
    userId: v.id("users"),
    clientId: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Check if we already have a valid token (with 5-min buffer)
    if (!args.forceRefresh) {
      const existingTokens = await ctx.runQuery(internal.users.getVkAdsTokens, {
        userId: args.userId,
      });

      if (existingTokens?.accessToken) {
        const now = Date.now();
        const BUFFER_MS = 5 * 60 * 1000; // 5 minutes

        // If token exists and not expired (or no expiry set), reuse it
        if (!existingTokens.expiresAt || existingTokens.expiresAt > now + BUFFER_MS) {
          return { success: true, reused: true };
        }
      }
    }

    // 1) From arguments (wizard just submitted them)
    let clientId = args.clientId;
    let clientSecret = args.clientSecret;

    // 2) Fallback: user record
    if (!clientId || !clientSecret) {
      const creds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
        userId: args.userId,
      });
      if (creds?.clientId && creds?.clientSecret) {
        clientId = clientId || creds.clientId;
        clientSecret = clientSecret || creds.clientSecret;
      }
    }

    // 3) Fallback: env vars
    if (!clientId || !clientSecret) {
      clientId = clientId || process.env.VK_ADS_CLIENT_ID;
      clientSecret = clientSecret || process.env.VK_ADS_CLIENT_SECRET;
    }

    if (!clientId || !clientSecret) {
      throw new Error("Не указаны client_id / client_secret для VK Ads API. Введите их в визарде подключения.");
    }

    // Revoke the user's existing token (if any) before requesting a new one.
    const existingTokens = await ctx.runQuery(internal.users.getVkAdsTokens, {
      userId: args.userId,
    });
    if (existingTokens?.accessToken) {
      try {
        await fetch(`${VK_ADS_API_BASE}/api/v2/oauth2/token/delete.json`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            token: existingTokens.accessToken,
          }).toString(),
        });
      } catch {
        // Ignore — proceed to create new token
      }
    }

    // Helper: request a new token via client_credentials grant
    const requestNewToken = async () => {
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

    let data = await requestNewToken();

    // If we hit the token limit, purge ALL app tokens and retry once.
    // This handles orphaned tokens from testing/previous sessions not tracked in DB.
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
        data = await requestNewToken();
      }
    }

    if (data.error) {
      const errorMsg = data.error_description || data.error || "";
      if (errorMsg.toLowerCase().includes("invalid client")) {
        throw new Error("Неверный Client ID или Client Secret. Проверьте данные в настройках VK Ads (ads.vk.com → Настройки → Доступ к API).");
      }
      if (errorMsg.toLowerCase().includes("unauthorized")) {
        throw new Error("Доступ запрещён. Проверьте права приложения в VK Ads.");
      }
      throw new Error(errorMsg || "Не удалось получить токен VK Ads API");
    }

    // Save VK Ads token to user record
    await ctx.runMutation(internal.users.updateVkAdsTokens, {
      userId: args.userId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 86400,
    });

    return { success: true, reused: false };
  },
});



// ─── SESSION ──────────────────────────────────────────────────────

// Validate session and get user
export const validateSession = query({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (!session) {
      return null;
    }

    if (session.expiresAt < Date.now()) {
      return null;
    }

    const user = await ctx.db.get(session.userId);
    if (!user) {
      return null;
    }

    return {
      userId: user._id,
      vkId: user.vkId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      subscriptionTier: user.subscriptionTier,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
      onboardingCompleted: user.onboardingCompleted,
      isAdmin: user.isAdmin === true,
    };
  },
});

// Logout - delete session
export const logout = mutation({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (session) {
      await ctx.db.delete(session._id);
    }

    return { success: true };
  },
});

// ─── TOKEN REFRESH ────────────────────────────────────────────────

// Refresh VK access token using refresh_token (VK ID tokens)
export const refreshVkToken = internalAction({
  args: {
    userId: v.id("users"),
    refreshToken: v.string(),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> => {
    const clientId = process.env.VK_CLIENT_ID;

    if (!clientId) {
      throw new Error("VK_CLIENT_ID is not configured");
    }

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: clientId,
    });
    // VK ID OAuth 2.1 requires device_id for token refresh
    if (args.deviceId) {
      params.set("device_id", args.deviceId);
    }

    const response = await fetch(VK_ID_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const data = await response.json();

    if (data.error) {
      console.error(`[refreshVkToken] VK error: ${JSON.stringify(data)}`);
      throw new Error(data.error_description || data.error || "Failed to refresh VK token");
    }
    console.log(`[refreshVkToken] Success: new token expires in ${data.expires_in}s, new refresh_token=${data.refresh_token ? "YES" : "NO"}`);

    // Update tokens in the database
    await ctx.runMutation(internal.users.updateVkTokens, {
      userId: args.userId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 0,
    });

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 0,
    };
  },
});

// Get a valid VK token for a user, refreshing if needed (5-minute buffer)
export const getValidVkToken = internalAction({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args): Promise<string> => {
    const tokens = await ctx.runQuery(internal.users.getVkTokens, {
      userId: args.userId,
    });

    if (!tokens || !tokens.accessToken) {
      throw new Error("Токен VK не найден. Подключите VK Ads.");
    }

    // Tokens with no expiresAt don't expire (old VK OAuth)
    if (!tokens.expiresAt) {
      return tokens.accessToken;
    }

    const now = Date.now();
    const BUFFER_MS = 5 * 60 * 1000; // 5 minutes

    // If token is not expired (with 5-min buffer), return it
    if (tokens.expiresAt > now + BUFFER_MS) {
      return tokens.accessToken;
    }

    // Token expired or about to expire — try to refresh
    if (!tokens.refreshToken) {
      throw new Error("Токен VK истёк. Подключите VK Ads заново.");
    }

    try {
      const refreshed = await ctx.runAction(internal.auth.refreshVkToken, {
        userId: args.userId,
        refreshToken: tokens.refreshToken,
        deviceId: tokens.deviceId,
      });
      return refreshed.accessToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[getValidVkToken] Refresh failed for user ${args.userId}: ${msg}`);
      throw new Error(`Не удалось обновить токен VK: ${msg}`);
    }
  },
});

// ─── VK ADS TOKEN REFRESH ─────────────────────────────────────────

// Refresh VK Ads API token (per-user credentials → env vars fallback)
export const refreshVkAdsToken = internalAction({
  args: {
    userId: v.id("users"),
    refreshToken: v.string(),
  },
  handler: async (ctx, args): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> => {
    // Try per-user credentials first, then env vars
    const creds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
      userId: args.userId,
    });

    const clientId = creds?.clientId || process.env.VK_ADS_CLIENT_ID;
    const clientSecret = creds?.clientSecret || process.env.VK_ADS_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("VK_ADS_CLIENT_ID / VK_ADS_CLIENT_SECRET не настроены");
    }

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await fetch(`${VK_ADS_API_BASE}/api/v2/oauth2/token.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const data = await response.json();

    if (data.error) {
      const desc = data.error_description ? `${data.error}: ${data.error_description}` : data.error;
      throw new Error(desc || "Не удалось обновить токен VK Ads");
    }

    await ctx.runMutation(internal.users.updateVkAdsTokens, {
      userId: args.userId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 86400,
    });

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 86400,
    };
  },
});

// Get a valid VK Ads API token, refreshing if needed (5-minute buffer)
export const getValidVkAdsToken = internalAction({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args): Promise<string> => {
    const tokens = await ctx.runQuery(internal.users.getVkAdsTokens, {
      userId: args.userId,
    });

    if (!tokens || !tokens.accessToken) {
      throw new Error("Токен VK Ads не найден. Подключите VK Ads.");
    }

    // Tokens with no expiresAt don't expire
    if (!tokens.expiresAt) {
      return tokens.accessToken;
    }

    const now = Date.now();
    const BUFFER_MS = 5 * 60 * 1000; // 5 minutes

    // If token is not expired (with 5-min buffer), return it
    if (tokens.expiresAt > now + BUFFER_MS) {
      return tokens.accessToken;
    }

    // Token expired or about to expire — try to refresh
    if (!tokens.refreshToken) {
      throw new Error("Токен VK Ads истёк. Подключите VK Ads заново.");
    }

    try {
      const refreshed = await ctx.runAction(internal.auth.refreshVkAdsToken, {
        userId: args.userId,
        refreshToken: tokens.refreshToken,
      });
      return refreshed.accessToken;
    } catch (refreshErr) {
      const detail = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
      throw new Error(`Не удалось обновить токен VK Ads: ${detail}`);
    }
  },
});

// ─── PER-ACCOUNT TOKEN MANAGEMENT ────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const selfInternalAgency = internal as any;

// Helper: try refreshing token via Vitamin API using user's personal API key
async function tryVitaminRefresh(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  accountId: Id<"adAccounts">,
  account: { vitaminCabinetId?: string; agencyProviderId?: string; userId: string; name?: string },
): Promise<string | null> {
  if (!account.vitaminCabinetId) return null;
  try {
    // Look up user's personal Vitamin API key from agencyCredentials
    let userApiKey: string | undefined;
    if (account.agencyProviderId) {
      const creds = await ctx.runQuery(selfInternalAgency.agencyProviders.getCredentialsInternal, {
        userId: account.userId,
        providerId: account.agencyProviderId,
      });
      userApiKey = creds?.apiKey || undefined;
    }

    console.log(
      `[getValidTokenForAccount] «${account.name}» (${accountId}): trying Vitamin API refresh (personalKey=${!!userApiKey})`
    );
    const result = await ctx.runAction(internal.auth.refreshViaVitamin, {
      accountId,
      vitaminCabinetId: account.vitaminCabinetId,
      userApiKey,
    });
    return result.accessToken;
  } catch (vitErr) {
    const vitMsg = vitErr instanceof Error ? vitErr.message : String(vitErr);
    console.log(
      `[getValidTokenForAccount] «${account.name}» (${accountId}): Vitamin refresh failed: ${vitMsg}`
    );
    return null;
  }
}

/** Try refreshing VK Ads token via GetUNIQ API (for agency accounts linked to GetUNIQ provider) */
async function tryGetuniqRefresh(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  accountId: Id<"adAccounts">,
  account: { agencyProviderId?: string; agencyCabinetId?: string; userId: string; name?: string },
): Promise<string | null> {
  if (!account.agencyProviderId || !account.agencyCabinetId) return null;

  try {
    // Check if this provider is GetUNIQ
    const provider = await ctx.runQuery(selfInternalAgency.agencyProviders.getCredentialsInternal, {
      userId: account.userId,
      providerId: account.agencyProviderId,
    });
    if (!provider?.oauthAccessToken) return null;

    console.log(
      `[getValidTokenForAccount] «${account.name}» (${accountId}): trying GetUNIQ API fallback`
    );

    // Refresh GetUNIQ token if needed, then get VK token
    const GETUNIQ_TOKEN_URL = "https://getuniq.me/oauth/v2/token";
    const GETUNIQ_API_BASE = "https://getuniq.me/api/v1";

    let accessToken = provider.oauthAccessToken;

    // Refresh GetUNIQ token if expired
    if (provider.oauthTokenExpiresAt && provider.oauthTokenExpiresAt < Date.now() + 60000) {
      if (!provider.oauthClientId || !provider.oauthClientSecret || !provider.oauthRefreshToken) return null;
      const params = new URLSearchParams({
        client_id: provider.oauthClientId,
        client_secret: provider.oauthClientSecret,
        grant_type: "refresh_token",
        refresh_token: provider.oauthRefreshToken,
      });
      const refreshResp = await fetch(`${GETUNIQ_TOKEN_URL}?${params.toString()}`);
      if (!refreshResp.ok) return null;
      const refreshData = await refreshResp.json();
      accessToken = refreshData.access_token;

      // Save refreshed tokens
      await ctx.runMutation(selfInternalAgency.agencyProviders.updateCredentialsTokens, {
        userId: account.userId,
        providerId: account.agencyProviderId,
        oauthAccessToken: refreshData.access_token,
        oauthRefreshToken: refreshData.refresh_token,
        oauthTokenExpiresAt: Date.now() + (refreshData.expires_in || 3600) * 1000,
      });
    }

    // Fetch VK Ads token for the cabinet
    const tokenResp = await fetch(
      `${GETUNIQ_API_BASE}/accounts/vk-ads/${account.agencyCabinetId}/token`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!tokenResp.ok) return null;

    const tokenData = await tokenResp.json();
    const vkToken = tokenData.token || tokenData.access_token;
    if (!vkToken) return null;

    // Save new VK token to account
    await ctx.runMutation(internal.auth.updateAccountToken, {
      accountId,
      accessToken: vkToken,
    });

    return vkToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `[getValidTokenForAccount] «${account.name}» (${accountId}): GetUNIQ fallback failed: ${msg}`
    );
    return null;
  }
}

/** Try refreshing VK Ads token via Click.ru API (for agency accounts linked to Click.ru provider) */
async function tryClickruRefresh(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  accountId: Id<"adAccounts">,
  account: { agencyProviderId?: string; agencyCabinetId?: string; userId: string; name?: string },
): Promise<string | null> {
  if (!account.agencyProviderId || !account.agencyCabinetId) return null;

  try {
    const creds = await ctx.runQuery(selfInternalAgency.agencyProviders.getCredentialsInternal, {
      userId: account.userId,
      providerId: account.agencyProviderId,
    });
    if (!creds?.apiKey) return null;

    // Check if this is a Click.ru provider by trying the Click.ru API
    const CLICKRU_API_BASE = "https://api.click.ru/V0";

    console.log(
      `[getValidTokenForAccount] «${account.name}» (${accountId}): trying Click.ru API fallback`
    );

    const tokenResp = await fetch(
      `${CLICKRU_API_BASE}/accounts/${account.agencyCabinetId}/access_token/vk_ads/`,
      {
        headers: {
          "Accept": "application/json",
          "X-Auth-Token": creds.apiKey,
        },
      },
    );
    if (!tokenResp.ok) return null;

    const tokenData = await tokenResp.json();
    const vkToken = tokenData.token || tokenData.access_token || tokenData.data?.token || tokenData.data?.access_token;
    if (!vkToken) return null;

    await ctx.runMutation(internal.auth.updateAccountToken, {
      accountId,
      accessToken: vkToken,
    });

    return vkToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `[getValidTokenForAccount] «${account.name}» (${accountId}): Click.ru fallback failed: ${msg}`
    );
    return null;
  }
}

/** Try refreshing VK Ads token via ZaleyCash API (for agency accounts linked to ZaleyCash provider) */
async function tryZaleycashRefresh(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  accountId: Id<"adAccounts">,
  account: { agencyProviderId?: string; agencyCabinetId?: string; userId: string; name?: string },
): Promise<string | null> {
  if (!account.agencyProviderId || !account.agencyCabinetId) return null;

  try {
    const creds = await ctx.runQuery(selfInternalAgency.agencyProviders.getCredentialsInternal, {
      userId: account.userId,
      providerId: account.agencyProviderId,
    });
    if (!creds?.apiKey) return null;

    const ZALEYCASH_API_BASE = "https://zaleycash.com/api/v2";

    console.log(
      `[getValidTokenForAccount] «${account.name}» (${accountId}): trying ZaleyCash API fallback`
    );

    // Get session token from secret key
    const sessionResp = await fetch(`${ZALEYCASH_API_BASE}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    if (!sessionResp.ok) return null;
    const sessionData = await sessionResp.json();
    const sessionToken = sessionData.access_token || sessionData.accessToken || sessionData.token;
    if (!sessionToken) return null;

    // Get VK Ads token for the cabinet
    const tokenResp = await fetch(`${ZALEYCASH_API_BASE}/my_target/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ account_id: account.agencyCabinetId }),
    });
    if (!tokenResp.ok) return null;

    const tokenData = await tokenResp.json();
    const vkToken = tokenData.accessToken || tokenData.access_token || tokenData.token;
    if (!vkToken) return null;

    await ctx.runMutation(internal.auth.updateAccountToken, {
      accountId,
      accessToken: vkToken,
    });

    return vkToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `[getValidTokenForAccount] «${account.name}» (${accountId}): ZaleyCash fallback failed: ${msg}`
    );
    return null;
  }
}

// Get a valid token for a specific adAccount (per-account credentials)
// Falls back to user-level credentials if per-account ones are missing
export const getValidTokenForAccount = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<string> => {
    const account = await ctx.runQuery(internal.auth.getAccountWithCredentials, {
      accountId: args.accountId,
    });

    if (!account || !account.accessToken) {
      throw new Error("Токен VK Ads не найден. Подключите кабинет заново.");
    }

    const now = Date.now();
    const BUFFER_MS = 5 * 60 * 1000;

    // Resolve credentials: per-account first, then user-level fallback
    let clientId = account.clientId;
    let clientSecret = account.clientSecret;

    if (!clientId || !clientSecret) {
      // Try user-level credentials as fallback
      const userCreds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
        userId: account.userId as Id<"users">,
      });
      if (userCreds?.clientId && userCreds?.clientSecret) {
        clientId = userCreds.clientId;
        clientSecret = userCreds.clientSecret;
        console.log(
          `[getValidTokenForAccount] Account ${args.accountId}: using user-level credentials (per-account missing)`
        );
      }
    }

    // No credentials at all — agency/manual API keys
    if (!clientId && !clientSecret) {
      // If token has no expiry (undefined/null), check liveness before returning
      // tokenExpiresAt=0 means "invalidated", must NOT return here
      if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null) {
        const alive = await quickTokenCheck(account.accessToken);
        if (alive) {
          // Auto-set expiry so proactiveRefresh picks it up — no more blind returns
          await ctx.runMutation(internal.tokenRecovery.setTokenExpiry, {
            accountId: args.accountId,
            tokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
          });
          return account.accessToken;
        }
        // Token is dead — try recovery
        try {
          const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: args.accountId });
          if (recovered) {
            const fresh = await ctx.runQuery(api.adAccounts.get, { accountId: args.accountId });
            if (fresh?.accessToken) return fresh.accessToken;
          }
        } catch (recErr) {
          console.log(`[getValidTokenForAccount] «${account.name}» (${args.accountId}): recovery failed: ${recErr}`);
        }
        throw new Error("TOKEN_EXPIRED: токен недействителен и не удалось восстановить");
      }
      // If token is still valid, return it
      if (account.tokenExpiresAt > now + BUFFER_MS) {
        return account.accessToken;
      }
      // Token expired, no credentials — try agency_client_credentials as last resort
      // This needs user-level OAuth credentials + vkAccountId
      const userCreds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
        userId: account.userId as Id<"users">,
      });
      if (userCreds?.clientId && userCreds?.clientSecret && account.vkAccountId) {
        try {
          console.log(
            `[getValidTokenForAccount] «${account.name}» (${args.accountId}): no credentials, trying agency_client_credentials`
          );
          const generated = await ctx.runAction(internal.auth.generateAgencyToken, {
            accountId: args.accountId,
            clientId: userCreds.clientId,
            clientSecret: userCreds.clientSecret,
            agencyClientId: account.vkAccountId,
          });
          return generated.accessToken;
        } catch (agencyErr) {
          const agencyMsg = agencyErr instanceof Error ? agencyErr.message : String(agencyErr);
          console.log(
            `[getValidTokenForAccount] «${account.name}» (${args.accountId}): agency_client_credentials failed: ${agencyMsg}`
          );
        }
      }
      // Try GetUNIQ API
      const getuniqToken1 = await tryGetuniqRefresh(ctx, args.accountId, account);
      if (getuniqToken1) return getuniqToken1;
      const clickruToken1 = await tryClickruRefresh(ctx, args.accountId, account);
      if (clickruToken1) return clickruToken1;
      // Try ZaleyCash API
      const zaleycashToken1 = await tryZaleycashRefresh(ctx, args.accountId, account);
      if (zaleycashToken1) return zaleycashToken1;
      // Last resort: try Vitamin API
      const vitaminToken1 = await tryVitaminRefresh(ctx, args.accountId, account);
      if (vitaminToken1) return vitaminToken1;

      throw new Error(
        "TOKEN_EXPIRED: Токен VK Ads истёк, а clientId/clientSecret отсутствуют. Подключите кабинет заново."
      );
    }

    // Has credentials — check if token is still valid
    // Note: tokenExpiresAt=0 means "invalidated by TOKEN_EXPIRED", NOT "no expiry"
    if (account.tokenExpiresAt && account.tokenExpiresAt > now + BUFFER_MS) {
      return account.accessToken;
    }

    // Token without expiry (undefined/null) — check liveness before returning
    // But tokenExpiresAt=0 is "invalidated", must NOT return here
    if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null) {
      const alive = await quickTokenCheck(account.accessToken);
      if (alive) {
        // Auto-set expiry so proactiveRefresh picks it up — no more blind returns
        await ctx.runMutation(internal.tokenRecovery.setTokenExpiry, {
          accountId: args.accountId,
          tokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        });
        return account.accessToken;
      }
      // Token is dead — try recovery
      try {
        const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: args.accountId });
        if (recovered) {
          const fresh = await ctx.runQuery(api.adAccounts.get, { accountId: args.accountId });
          if (fresh?.accessToken) return fresh.accessToken;
        }
      } catch (recErr) {
        console.log(`[getValidTokenForAccount] «${account.name}» (${args.accountId}): recovery failed: ${recErr}`);
      }
      throw new Error("TOKEN_EXPIRED: токен недействителен и не удалось восстановить");
    }

    // Token expired or invalidated — log and proceed to refresh
    console.log(
      `[getValidTokenForAccount] «${account.name}» (${args.accountId}): token expired/invalidated (expiresAt=${account.tokenExpiresAt}), starting refresh`
    );

    // Token expired — try refresh
    // Use account-level refreshToken first, fallback to user-level
    let refreshToken = account.refreshToken;
    if (!refreshToken) {
      const userTokens = await ctx.runQuery(internal.users.getVkAdsTokens, {
        userId: account.userId as Id<"users">,
      });
      refreshToken = userTokens?.refreshToken ?? undefined;
    }
    // Helper: try agency_client_credentials as last-resort fallback
    const tryAgencyFallback = async (): Promise<string | null> => {
      if (!account.vkAccountId) return null;
      // Use user-level credentials (may differ from clientId/clientSecret resolved above)
      const userCreds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
        userId: account.userId as Id<"users">,
      });
      const agencyClientId = userCreds?.clientId;
      const agencyClientSecret = userCreds?.clientSecret;
      if (!agencyClientId || !agencyClientSecret) return null;
      try {
        console.log(
          `[getValidTokenForAccount] «${account.name}» (${args.accountId}): trying agency_client_credentials fallback`
        );
        const generated = await ctx.runAction(internal.auth.generateAgencyToken, {
          accountId: args.accountId,
          clientId: agencyClientId,
          clientSecret: agencyClientSecret,
          agencyClientId: account.vkAccountId,
        });
        return generated.accessToken;
      } catch (agencyErr) {
        const agencyMsg = agencyErr instanceof Error ? agencyErr.message : String(agencyErr);
        console.log(
          `[getValidTokenForAccount] «${account.name}» (${args.accountId}): agency_client_credentials fallback failed: ${agencyMsg}`
        );
        return null;
      }
    };

    if (!refreshToken) {
      // No refresh token — try agency_client_credentials before giving up
      const agencyToken = await tryAgencyFallback();
      if (agencyToken) return agencyToken;
      // Try GetUNIQ API
      const getuniqToken2 = await tryGetuniqRefresh(ctx, args.accountId, account);
      if (getuniqToken2) return getuniqToken2;
      const clickruToken2 = await tryClickruRefresh(ctx, args.accountId, account);
      if (clickruToken2) return clickruToken2;
      // Try ZaleyCash API
      const zaleycashToken2 = await tryZaleycashRefresh(ctx, args.accountId, account);
      if (zaleycashToken2) return zaleycashToken2;
      // Last resort: try Vitamin API
      const vitaminToken2 = await tryVitaminRefresh(ctx, args.accountId, account);
      if (vitaminToken2) return vitaminToken2;
      throw new Error("Токен VK Ads истёк, refreshToken отсутствует. Подключите кабинет заново.");
    }

    try {
      const refreshed = await ctx.runAction(internal.auth.refreshTokenForAccount, {
        accountId: args.accountId,
        refreshToken,
        clientId: clientId!,
        clientSecret: clientSecret!,
      });

      // If we used user-level credentials as fallback, save them to the account
      // so future refreshes don't need the fallback
      if (!account.clientId || !account.clientSecret) {
        await ctx.runMutation(internal.adAccounts.updateAccountCredentials, {
          accountId: args.accountId,
          clientId: clientId!,
          clientSecret: clientSecret!,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          tokenExpiresAt: now + (refreshed.expiresIn || 86400) * 1000,
        });
        console.log(
          `[getValidTokenForAccount] Account ${args.accountId}: saved user-level credentials to account after successful refresh`
        );
      }

      console.log(
        `[getValidTokenForAccount] «${account.name}» (${args.accountId}): ✅ token refreshed via refresh_token, new expiresIn=${refreshed.expiresIn}s`
      );
      return refreshed.accessToken;
    } catch (err) {
      const refreshMsg = err instanceof Error ? err.message : String(err);
      console.log(
        `[getValidTokenForAccount] «${account.name}» (${args.accountId}): refresh_token failed: ${refreshMsg}, trying fallbacks...`
      );
      // Refresh failed — try agency_client_credentials as last resort
      const agencyToken = await tryAgencyFallback();
      if (agencyToken) return agencyToken;
      // Try GetUNIQ API
      const getuniqToken3 = await tryGetuniqRefresh(ctx, args.accountId, account);
      if (getuniqToken3) return getuniqToken3;
      // Try Click.ru API
      const clickruToken3 = await tryClickruRefresh(ctx, args.accountId, account);
      if (clickruToken3) return clickruToken3;
      // Try ZaleyCash API
      const zaleycashToken3 = await tryZaleycashRefresh(ctx, args.accountId, account);
      if (zaleycashToken3) return zaleycashToken3;
      // Last resort: try Vitamin API
      const vitaminToken3 = await tryVitaminRefresh(ctx, args.accountId, account);
      if (vitaminToken3) return vitaminToken3;

      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Не удалось обновить токен VK Ads: ${msg}. Подключите кабинет заново.`);
    }
  },
});

// Internal query to get account with credentials
export const getAccountWithCredentials = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    return {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      tokenExpiresAt: account.tokenExpiresAt,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      userId: account.userId,
      vkAccountId: account.vkAccountId,
      name: account.name,
      vitaminCabinetId: (account as Record<string, unknown>).vitaminCabinetId as string | undefined,
      agencyProviderId: (account as Record<string, unknown>).agencyProviderId as string | undefined,
      agencyCabinetId: (account as Record<string, unknown>).agencyCabinetId as string | undefined,
    };
  },
});

// Refresh token via Vitamin.tools API using user's personal API key
export const refreshViaVitamin = internalAction({
  args: {
    accountId: v.id("adAccounts"),
    vitaminCabinetId: v.string(),
    userApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ accessToken: string }> => {
    const apiKey = args.userApiKey || process.env.VITAMIN_API_KEY;
    if (!apiKey) {
      throw new Error("Vitamin API-ключ не найден. Переподключите кабинет с персональным API-ключом.");
    }

    const resp = await fetch(
      "https://app.vitamin.tools/ext/api/v1/external_account/account/get-token-list-by-clients",
      {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: [parseInt(args.vitaminCabinetId)] }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Vitamin API error ${resp.status}: ${text}`);
    }

    const data = await resp.json();

    // Check for API-level errors (Vitamin returns 200 with is_ok:false)
    if (data.is_ok === false || data.error) {
      const errMsg = data.error?.message || JSON.stringify(data.error) || "Неизвестная ошибка";
      throw new Error(`Vitamin API: ${errMsg}`);
    }

    // Response format: extract token from response
    // Vitamin returns array of tokens or object with tokens
    let newToken: string | null = null;
    if (Array.isArray(data)) {
      // [{id, token, ...}]
      newToken = data[0]?.token || data[0]?.access_token || null;
    } else if (data.data && Array.isArray(data.data)) {
      newToken = data.data[0]?.token || data.data[0]?.access_token || null;
    } else if (data.token) {
      newToken = data.token;
    } else if (data.access_token) {
      newToken = data.access_token;
    }

    if (!newToken) {
      throw new Error(`Vitamin API: no token in response: ${JSON.stringify(data).slice(0, 200)}`);
    }

    // Save new token to account
    await ctx.runMutation(internal.auth.updateVitaminToken, {
      accountId: args.accountId,
      accessToken: newToken,
    });

    console.log(
      `[refreshViaVitamin] Account ${args.accountId}: got new token from Vitamin API`
    );

    return { accessToken: newToken };
  },
});

// Save token obtained from Vitamin API
export const updateVitaminToken = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    accessToken: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      accessToken: args.accessToken,
      status: "active" as const,
      lastError: undefined,
    });
  },
});

// Refresh token for a specific account
export const refreshTokenForAccount = internalAction({
  args: {
    accountId: v.id("adAccounts"),
    refreshToken: v.string(),
    clientId: v.string(),
    clientSecret: v.string(),
  },
  handler: async (ctx, args) => {
    const resp = await fetch(`${VK_ADS_API_BASE}/api/v2/oauth2/token.json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: args.refreshToken,
        client_id: args.clientId,
        client_secret: args.clientSecret,
      }).toString(),
    });
    const data = await resp.json();

    if (data.error) {
      throw new Error(data.error_description || data.error);
    }

    // Update this account AND any other accounts sharing the same clientId
    await ctx.runMutation(internal.auth.updateAccountTokens, {
      accountId: args.accountId,
      clientId: args.clientId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 86400,
    });

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 86400,
    };
  },
});

// Generate token for agency client via agency_client_credentials grant
// Fallback when refresh_token is unavailable or fails
export const generateAgencyToken = internalAction({
  args: {
    accountId: v.id("adAccounts"),
    clientId: v.string(),
    clientSecret: v.string(),
    agencyClientId: v.string(), // vkAccountId of the agency client
  },
  handler: async (ctx, args) => {
    console.log(
      `[generateAgencyToken] Account ${args.accountId}: trying agency_client_credentials for client ${args.agencyClientId}`
    );

    const resp = await fetch(`${VK_ADS_API_BASE}/api/v2/oauth2/token.json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "agency_client_credentials",
        client_id: args.clientId,
        client_secret: args.clientSecret,
        agency_client_id: args.agencyClientId,
      }).toString(),
    });
    const data = await resp.json();

    if (data.error) {
      throw new Error(
        `agency_client_credentials failed: ${data.error_description || data.error}`
      );
    }

    const now = Date.now();
    const expiresIn = data.expires_in || 86400;

    // Save new tokens to account
    await ctx.runMutation(internal.auth.updateAgencyAccountTokens, {
      accountId: args.accountId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiresAt: now + expiresIn * 1000,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
    });

    console.log(
      `[generateAgencyToken] Account ${args.accountId}: success, expires in ${expiresIn}s`
    );

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn,
    };
  },
});

// Save tokens from agency_client_credentials to account
export const updateAgencyAccountTokens = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.number(),
    clientId: v.string(),
    clientSecret: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: args.tokenExpiresAt,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      status: "active",
      lastError: undefined,
    });
  },
});

// Update only accessToken for a single account (used by GetUNIQ refresh)
export const updateAccountToken = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    accessToken: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      accessToken: args.accessToken,
      tokenExpiresAt: Date.now() + 86400 * 1000, // 24h default
      status: "active",
      lastError: undefined,
    });
  },
});

// Update token for an account (and any accounts sharing the same clientId)
export const updateAccountTokens = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    clientId: v.string(),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresIn: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const tokenExpiresAt = args.expiresIn > 0 ? now + args.expiresIn * 1000 : undefined;

    // Find all accounts with the same clientId (they share one myTarget token)
    const allAccounts = await ctx.db.query("adAccounts").collect();
    const sameClientAccounts = allAccounts.filter(
      (a) => a.clientId === args.clientId
    );

    for (const account of sameClientAccounts) {
      // Audit log token changes
      for (const field of ["accessToken", "refreshToken"] as const) {
        const oldVal = account[field] as string | undefined;
        const newVal = field === "accessToken" ? args.accessToken : (args.refreshToken ?? account.refreshToken);
        if (oldVal !== newVal && newVal) {
          const mask = (val: string | undefined) =>
            val && val.length > 8 ? val.slice(0, 4) + "..." + val.slice(-4) : val;
          await ctx.db.insert("credentialHistory", {
            accountId: account._id,
            field,
            oldValue: mask(oldVal),
            newValue: mask(newVal),
            changedAt: Date.now(),
            changedBy: "updateAccountTokens",
          });
        }
      }
      await ctx.db.patch(account._id, {
        accessToken: args.accessToken,
        refreshToken: args.refreshToken ?? account.refreshToken,
        tokenExpiresAt: tokenExpiresAt ?? account.tokenExpiresAt,
      });
    }

    // If no accounts matched by clientId, update just this one
    if (sameClientAccounts.length === 0) {
      const thisAccount = await ctx.db.get(args.accountId);
      if (thisAccount) {
        for (const field of ["accessToken", "refreshToken"] as const) {
          const oldVal = thisAccount[field] as string | undefined;
          const newVal = field === "accessToken" ? args.accessToken : args.refreshToken;
          if (oldVal !== newVal && newVal) {
            const mask = (val: string | undefined) =>
              val && val.length > 8 ? val.slice(0, 4) + "..." + val.slice(-4) : val;
            await ctx.db.insert("credentialHistory", {
              accountId: args.accountId,
              field,
              oldValue: mask(oldVal),
              newValue: mask(newVal),
              changedAt: Date.now(),
              changedBy: "updateAccountTokens",
            });
          }
        }
      }
      await ctx.db.patch(args.accountId, {
        accessToken: args.accessToken,
        refreshToken: args.refreshToken,
        tokenExpiresAt,
      });
    }
  },
});

// Delete all sessions for a user
export const deleteAllUserSessions = mutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }

    return { deleted: sessions.length };
  },
});

// Set mtAdvertiserId on all ad accounts for a user (called after VK login)
// Save VK Ads cabinet ID on user record (discovered at login)
export const saveVkAdsCabinetId = internalMutation({
  args: {
    userId: v.id("users"),
    vkAdsCabinetId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      vkAdsCabinetId: args.vkAdsCabinetId,
    });
  },
});

export const setAdvertiserIdForUser = internalMutation({
  args: {
    userId: v.id("users"),
    mtAdvertiserId: v.string(),
  },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    for (const account of accounts) {
      if (!account.mtAdvertiserId) {
        await ctx.db.patch(account._id, {
          mtAdvertiserId: args.mtAdvertiserId,
        });
      }
    }
  },
});

// ─── Proactive Token Refresh ───
// Cron: refreshes tokens expiring within 12h BEFORE they actually expire.
// Covers both user-level VK Ads tokens and per-account tokens.

const PROACTIVE_REFRESH_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

const ADMIN_CHAT_ID = "325307765";

// Unrecoverable VK API errors — no point retrying
const UNRECOVERABLE_ERRORS = ["invalid_token", "token has been deleted", "token_revoked"];

function isUnrecoverable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return UNRECOVERABLE_ERRORS.some((e) => msg.includes(e));
}

// Schedule a one-time retry for proactiveTokenRefresh (actions can't use ctx.scheduler)
export const scheduleProactiveRetry = internalMutation({
  args: { delayMs: v.number() },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(args.delayMs, internal.auth.proactiveTokenRefresh, { isRetry: true });
  },
});

export const proactiveTokenRefresh = internalAction({
  args: { isRetry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const isRetry = args.isRetry ?? false;

    // Record heartbeat — start
    await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
      name: "proactiveTokenRefresh",
      status: "running",
    });

    try {
    const now = Date.now();
    const threshold = now + PROACTIVE_REFRESH_WINDOW_MS;
    let refreshed = 0;
    let failed = 0;
    const failures: string[] = [];

    // 1. Per-account tokens
    const accounts = await ctx.runQuery(internal.auth.getExpiringAccounts, { threshold });
    for (const acc of accounts) {
      try {
        await ctx.runAction(internal.auth.getValidTokenForAccount, {
          accountId: acc._id,
        });
        // Verify: re-read and check expiresAt actually updated
        const updated = await ctx.runQuery(internal.auth.getAccountTokenExpiry, { accountId: acc._id });
        if (updated && updated > now) {
          refreshed++;
          console.log(`[proactiveRefresh] Account "${acc.name}": refreshed, expires ${new Date(updated).toISOString()}`);
        } else {
          failed++;
          const msg = `Account "${acc.name}": refresh returned OK but token not updated`;
          console.log(`[proactiveRefresh] ${msg}`);
          failures.push(msg);
        }
      } catch (err) {
        failed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`[proactiveRefresh] Account "${acc.name}": failed — ${errMsg}`);
        if (isUnrecoverable(err)) {
          // Clear refresh token so we don't retry forever
          await ctx.runMutation(internal.auth.clearAccountRefreshToken, { accountId: acc._id });
          // Try full recovery cascade before giving up
          try {
            const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: acc._id });
            if (recovered) {
              console.log(`[proactiveRefresh] Account "${acc.name}": восстановлен через каскад после ${errMsg}`);
              failed--;
              refreshed++;
            } else {
              failures.push(`Account "${acc.name}": НЕИСПРАВИМО — ${errMsg}. Автовосстановление запущено (7 дней).`);
            }
          } catch (recoveryErr) {
            failures.push(`Account "${acc.name}": НЕИСПРАВИМО — ${errMsg}. Recovery error: ${recoveryErr}`);
          }
        } else {
          failures.push(`Account "${acc.name}": ${errMsg}`);
        }
      }
    }

    // 2. User-level VK Ads tokens
    const users = await ctx.runQuery(internal.auth.getExpiringUserTokens, { threshold });
    for (const user of users) {
      const label = user.name || user.email;
      try {
        await ctx.runAction(internal.auth.getValidVkAdsToken, {
          userId: user._id,
        });
        // Verify
        const updated = await ctx.runQuery(internal.auth.getUserVkAdsTokenExpiry, { userId: user._id });
        if (updated && updated > now) {
          refreshed++;
          console.log(`[proactiveRefresh] User "${label}": VK Ads token refreshed, expires ${new Date(updated).toISOString()}`);
        } else {
          failed++;
          const msg = `User "${label}": VK Ads refresh OK but token not updated`;
          console.log(`[proactiveRefresh] ${msg}`);
          failures.push(msg);
        }
      } catch (err) {
        failed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`[proactiveRefresh] User "${label}": VK Ads refresh failed — ${errMsg}`);
        if (isUnrecoverable(err)) {
          await ctx.runMutation(internal.auth.clearUserVkAdsRefreshToken, { userId: user._id });
          failures.push(`User "${label}": VK Ads НЕИСПРАВИМО — ${errMsg}. Refresh token очищен.`);
        } else {
          failures.push(`User "${label}": VK Ads — ${errMsg}`);
        }
      }
    }

    // 3. User-level personal VK ID tokens
    const vkUsers = await ctx.runQuery(internal.auth.getExpiringUserVkTokens, { threshold });
    for (const user of vkUsers) {
      const label = user.name || user.email;
      try {
        await ctx.runAction(internal.auth.getValidVkToken, {
          userId: user._id,
        });
        refreshed++;
        console.log(`[proactiveRefresh] User "${label}": VK ID token refreshed`);
      } catch (err) {
        failed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`[proactiveRefresh] User "${label}": VK ID refresh failed — ${errMsg}`);
        if (isUnrecoverable(err)) {
          await ctx.runMutation(internal.auth.clearUserVkRefreshToken, { userId: user._id });
          failures.push(`User "${label}": VK ID НЕИСПРАВИМО — ${errMsg}. Refresh token очищен.`);
        } else {
          failures.push(`User "${label}": VK ID — ${errMsg}`);
        }
      }
    }

    if (refreshed > 0 || failed > 0) {
      console.log(`[proactiveRefresh] Done: ${refreshed} refreshed, ${failed} failed`);
    }

    // Notify admin on failures
    if (failures.length > 0) {
      const text = `🔑 <b>Proactive Token Refresh — ${failures.length} ошибок</b>\n\n${failures.map((f) => `• ${f}`).join("\n")}\n\n✅ Успешно: ${refreshed}`;
      try {
        await ctx.runAction(internal.telegram.sendMessage, {
          chatId: ADMIN_CHAT_ID,
          text,
        });
      } catch (tgErr) {
        console.error(`[proactiveRefresh] Failed to send Telegram alert: ${tgErr}`);
      }
    }

    // If some tokens failed to refresh and this is NOT already a retry — schedule one retry in 30 min.
    // Retry does NOT schedule another retry (isRetry=true), preventing infinite loops.
    if (failed > 0 && !isRetry) {
      console.log(`[proactiveRefresh] ${failed} failures — scheduling retry in 30 min`);
      await ctx.runMutation(internal.auth.scheduleProactiveRetry, {
        delayMs: 30 * 60_000,
      });
    }

    // Retry recovery for accounts stuck in error state
    try {
      await ctx.runAction(internal.tokenRecovery.retryRecovery, {});
    } catch (retryErr) {
      console.error(`[proactiveRefresh] retryRecovery failed: ${retryErr}`);
    }

    // Record heartbeat — completed (even with partial failures, the cron itself ran)
    await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
      name: "proactiveTokenRefresh",
      status: "completed",
    });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[proactiveTokenRefresh] Fatal error: ${errMsg}`);
      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "proactiveTokenRefresh",
        status: "failed",
        error: errMsg.slice(0, 200),
      });
      // Schedule retry on crash too (if not already a retry)
      if (!isRetry) {
        try {
          await ctx.runMutation(internal.auth.scheduleProactiveRetry, {
            delayMs: 30 * 60_000,
          });
        } catch { /* don't fail on scheduling failure */ }
      }
      throw err;
    }
  },
});

export const getExpiringAccounts = internalQuery({
  args: { threshold: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const MAX_EXPIRED_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const accounts = await ctx.db.query("adAccounts").collect();
    return accounts.filter(
      (a) =>
        (a.status === "active" || a.status === "error") &&
        a.tokenExpiresAt &&
        a.refreshToken &&
        (
          // About to expire (within proactive window)
          (a.tokenExpiresAt > now && a.tokenExpiresAt < args.threshold) ||
          // Already expired but within 30 days (refresh token still usable)
          (a.tokenExpiresAt <= now && a.tokenExpiresAt > now - MAX_EXPIRED_AGE_MS)
        )
    );
  },
});

export const getExpiringUserTokens = internalQuery({
  args: { threshold: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const MAX_EXPIRED_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const users = await ctx.db.query("users").collect();
    return users.filter(
      (u) =>
        u.vkAdsAccessToken &&
        u.vkAdsTokenExpiresAt &&
        u.vkAdsRefreshToken &&
        (
          // About to expire (within proactive window)
          (u.vkAdsTokenExpiresAt > now && u.vkAdsTokenExpiresAt < args.threshold) ||
          // Already expired but within 30 days (refresh token still usable)
          (u.vkAdsTokenExpiresAt <= now && u.vkAdsTokenExpiresAt > now - MAX_EXPIRED_AGE_MS)
        )
    );
  },
});

// TEMP: Force proactive refresh from API — remove after use
export const forceProactiveRefresh = action({
  args: { adminUserId: v.string() },
  handler: async (ctx, args): Promise<string> => {
    if (args.adminUserId !== "kx7djrrpr67bry6zxehzx0e65x8141ct") {
      throw new Error("Unauthorized");
    }
    await ctx.runAction(internal.auth.proactiveTokenRefresh, {});
    return "Done";
  },
});

// TEMP: Diagnose VK Ads token refresh for a user — shows raw VK API error
export const diagRefreshVkAds = action({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const tokens = await ctx.runQuery(internal.users.getVkAdsTokens, {
      userId: args.userId as Id<"users">,
    });
    if (!tokens?.refreshToken) return "No refresh token";

    const creds = await ctx.runQuery(internal.users.getVkAdsCredentials, {
      userId: args.userId as Id<"users">,
    });
    const clientId = creds?.clientId || process.env.VK_ADS_CLIENT_ID;
    const clientSecret = creds?.clientSecret || process.env.VK_ADS_CLIENT_SECRET;
    if (!clientId || !clientSecret) return "No client credentials";

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await fetch("https://target.my.com/api/v2/oauth2/token.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await response.json();

    if (data.error) {
      return `VK API error: ${data.error} — ${data.error_description || "no desc"} (status=${response.status})`;
    }
    // If we got here, save the new tokens
    await ctx.runMutation(internal.users.updateVkAdsTokens, {
      userId: args.userId as Id<"users">,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 86400,
    });
    return `OK: refreshed, new token starts with ${data.access_token?.substring(0, 15)}..., expires_in=${data.expires_in}`;
  },
});

export const getExpiringUserVkTokens = internalQuery({
  args: { threshold: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const MAX_EXPIRED_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — VK refresh tokens may be valid longer
    const users = await ctx.db.query("users").collect();
    return users.filter(
      (u) =>
        u.vkAccessToken &&
        u.vkTokenExpiresAt &&
        u.vkRefreshToken &&
        (
          // About to expire (within proactive window)
          (u.vkTokenExpiresAt > now && u.vkTokenExpiresAt < args.threshold) ||
          // Already expired but within 7 days (refresh token still usable)
          (u.vkTokenExpiresAt <= now && u.vkTokenExpiresAt > now - MAX_EXPIRED_AGE_MS)
        )
    );
  },
});

// ─── Verification & cleanup helpers for proactiveTokenRefresh ───

export const getAccountTokenExpiry = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const acc = await ctx.db.get(args.accountId);
    return acc?.tokenExpiresAt ?? null;
  },
});

export const getUserVkAdsTokenExpiry = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    return user?.vkAdsTokenExpiresAt ?? null;
  },
});

export const clearAccountRefreshToken = internalMutation({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, { refreshToken: undefined });
  },
});

export const clearUserVkAdsRefreshToken = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { vkAdsRefreshToken: undefined });
  },
});

export const clearUserVkRefreshToken = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { vkRefreshToken: undefined });
  },
});
