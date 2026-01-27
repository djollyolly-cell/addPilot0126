import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// VK ID OAuth 2.1 configuration
const VK_API_VERSION = "5.131";
const VK_ID_AUTHORIZE_URL = "https://id.vk.com/authorize";
const VK_ID_TOKEN_URL = "https://id.vk.com/oauth2/auth";
const VK_API_URL = "https://api.vk.com/method";

// Generate VK ID OAuth 2.1 authorization URL with PKCE
export const getVkAuthUrl = action({
  args: {
    redirectUri: v.string(),
    codeChallenge: v.string(),
    state: v.string(),
  },
  handler: async (_, args) => {
    const clientId = process.env.VK_CLIENT_ID;
    if (!clientId) {
      throw new Error("VK_CLIENT_ID is not configured");
    }

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: args.redirectUri,
      scope: "email",
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
    const email = data.email;

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
      expiresIn: data.expires_in || 0,
    });

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

