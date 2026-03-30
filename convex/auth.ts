import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
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
      throw new Error(data.error_description || data.error || "Не удалось обновить токен VK Ads");
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
    } catch {
      throw new Error("Не удалось обновить токен VK Ads. Подключите VK Ads заново.");
    }
  },
});

// ─── PER-ACCOUNT TOKEN MANAGEMENT ────────────────────────────────

// Get a valid token for a specific adAccount (per-account credentials)
export const getValidTokenForAccount = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<string> => {
    const account = await ctx.runQuery(internal.auth.getAccountWithCredentials, {
      accountId: args.accountId,
    });

    if (!account || !account.accessToken) {
      throw new Error("Токен VK Ads не найден. Подключите кабинет заново.");
    }

    // If account has its own clientId — use per-account flow
    if (account.clientId && account.clientSecret) {
      const now = Date.now();
      const BUFFER_MS = 5 * 60 * 1000;

      if (account.tokenExpiresAt && account.tokenExpiresAt > now + BUFFER_MS) {
        return account.accessToken;
      }

      // Token expired — try refresh
      if (!account.refreshToken) {
        throw new Error("Токен VK Ads истёк. Подключите кабинет заново.");
      }

      try {
        const refreshed = await ctx.runAction(internal.auth.refreshTokenForAccount, {
          accountId: args.accountId,
          refreshToken: account.refreshToken,
          clientId: account.clientId,
          clientSecret: account.clientSecret,
        });
        return refreshed.accessToken;
      } catch {
        throw new Error("Не удалось обновить токен VK Ads. Подключите кабинет заново.");
      }
    }

    // Fallback: old accounts without per-account credentials — use user-level token
    return ctx.runAction(internal.auth.getValidVkAdsToken, {
      userId: account.userId,
    });
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
    };
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
