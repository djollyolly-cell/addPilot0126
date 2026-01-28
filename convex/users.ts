import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";

// Subscription tier limits
export const TIER_LIMITS = {
  freemium: {
    accounts: 1,
    rules: 2,
    autoStop: false,
  },
  start: {
    accounts: 3,
    rules: 10,
    autoStop: true,
  },
  pro: {
    accounts: Infinity,
    rules: Infinity,
    autoStop: true,
  },
} as const;

// Create a new user
export const create = mutation({
  args: {
    email: v.string(),
    vkId: v.string(),
    name: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check if user already exists
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_vkId", (q) => q.eq("vkId", args.vkId))
      .first();

    if (existingUser) {
      throw new Error("User with this VK ID already exists");
    }

    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      email: args.email,
      vkId: args.vkId,
      name: args.name,
      avatarUrl: args.avatarUrl,
      subscriptionTier: "freemium",
      onboardingCompleted: false,
      createdAt: now,
      updatedAt: now,
    });

    // Create default user settings
    await ctx.db.insert("userSettings", {
      userId,
      quietHoursEnabled: false,
      timezone: "Europe/Moscow",
      digestEnabled: true,
      digestTime: "09:00",
      language: "ru",
      createdAt: now,
      updatedAt: now,
    });

    return userId;
  },
});

// Get user by VK ID
export const getByVkId = query({
  args: {
    vkId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_vkId", (q) => q.eq("vkId", args.vkId))
      .first();
  },
});

// Get user by ID
export const get = query({
  args: {
    id: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Get user by email
export const getByEmail = query({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
  },
});

// Update user subscription tier
export const updateTier = mutation({
  args: {
    userId: v.id("users"),
    tier: v.union(v.literal("freemium"), v.literal("start"), v.literal("pro")),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    const oldTier = user.subscriptionTier;
    const newTier = args.tier;

    // Handle downgrade: deactivate excess rules and accounts
    if (
      (oldTier === "pro" && (newTier === "start" || newTier === "freemium")) ||
      (oldTier === "start" && newTier === "freemium")
    ) {
      await handleDowngrade(ctx, args.userId, newTier);
    }

    const patchData: Record<string, unknown> = {
      subscriptionTier: args.tier,
      updatedAt: Date.now(),
    };

    if (args.expiresAt !== undefined) {
      patchData.subscriptionExpiresAt = args.expiresAt;
    }

    await ctx.db.patch(args.userId, patchData);

    return { success: true, previousTier: oldTier, newTier };
  },
});

// Helper function to handle downgrade
async function handleDowngrade(
  ctx: any,
  userId: any,
  newTier: "freemium" | "start" | "pro"
) {
  const limits = TIER_LIMITS[newTier];

  // Get user's rules and deactivate excess ones
  const rules = await ctx.db
    .query("rules")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .collect();

  const activeRules = rules.filter((r: any) => r.isActive);
  if (activeRules.length > limits.rules) {
    const rulesToDeactivate = activeRules.slice(limits.rules);
    for (const rule of rulesToDeactivate) {
      await ctx.db.patch(rule._id, { isActive: false, updatedAt: Date.now() });
    }
  }

  // Disable autoStop for all rules if tier doesn't support it
  if (!limits.autoStop) {
    for (const rule of rules) {
      if (rule.actions.stopAd) {
        await ctx.db.patch(rule._id, {
          actions: { ...rule.actions, stopAd: false },
          updatedAt: Date.now(),
        });
      }
    }
  }
}

// Update user profile
export const updateProfile = mutation({
  args: {
    userId: v.id("users"),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    const updates: any = { updatedAt: Date.now() };
    if (args.name !== undefined) updates.name = args.name;
    if (args.email !== undefined) updates.email = args.email;

    await ctx.db.patch(args.userId, updates);
    return { success: true };
  },
});

// Set onboarding completed
export const completeOnboarding = mutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      onboardingCompleted: true,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

// Connect Telegram
export const connectTelegram = mutation({
  args: {
    userId: v.id("users"),
    chatId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      telegramChatId: args.chatId,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

// Disconnect Telegram
export const disconnectTelegram = mutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    // Create new object without telegramChatId
    const { telegramChatId: _, _id, _creationTime, ...rest } = user;
    await ctx.db.replace(args.userId, {
      ...rest,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

// Get user's subscription limits
export const getLimits = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    const limits = TIER_LIMITS[user.subscriptionTier];

    // Count current usage
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const activeRules = rules.filter((r) => r.isActive);

    return {
      tier: user.subscriptionTier,
      limits: {
        accounts: limits.accounts,
        rules: limits.rules,
        autoStop: limits.autoStop,
      },
      usage: {
        accounts: accounts.length,
        rules: activeRules.length,
      },
      canAddAccount: accounts.length < limits.accounts,
      canAddRule: activeRules.length < limits.rules,
    };
  },
});

// Internal mutation for upserting user from VK OAuth
export const upsertFromVk = internalMutation({
  args: {
    vkId: v.string(),
    email: v.string(),
    name: v.string(),
    avatarUrl: v.optional(v.string()),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresIn: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const tokenExpiresAt = args.expiresIn > 0 ? now + args.expiresIn * 1000 : undefined;

    // Check if user exists
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_vkId", (q) => q.eq("vkId", args.vkId))
      .first();

    if (existingUser) {
      // Update existing user
      await ctx.db.patch(existingUser._id, {
        name: args.name,
        email: args.email,
        vkAccessToken: args.accessToken,
        updatedAt: now,
      });
      if (args.avatarUrl !== undefined) {
        await ctx.db.patch(existingUser._id, { avatarUrl: args.avatarUrl });
      }
      if (args.refreshToken !== undefined) {
        await ctx.db.patch(existingUser._id, { vkRefreshToken: args.refreshToken });
      }
      if (tokenExpiresAt !== undefined) {
        await ctx.db.patch(existingUser._id, { vkTokenExpiresAt: tokenExpiresAt });
      }
      return existingUser._id;
    }

    // Create new user
    const userId = await ctx.db.insert("users", {
      email: args.email,
      vkId: args.vkId,
      name: args.name,
      avatarUrl: args.avatarUrl,
      vkAccessToken: args.accessToken,
      vkRefreshToken: args.refreshToken,
      vkTokenExpiresAt: tokenExpiresAt,
      subscriptionTier: "freemium",
      onboardingCompleted: false,
      createdAt: now,
      updatedAt: now,
    });

    // Create default user settings
    await ctx.db.insert("userSettings", {
      userId,
      quietHoursEnabled: false,
      timezone: "Europe/Moscow",
      digestEnabled: true,
      digestTime: "09:00",
      language: "ru",
      createdAt: now,
      updatedAt: now,
    });

    return userId;
  },
});

// Internal mutation to update VK tokens after refresh
export const updateVkTokens = internalMutation({
  args: {
    userId: v.id("users"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresIn: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const tokenExpiresAt = args.expiresIn > 0 ? now + args.expiresIn * 1000 : undefined;

    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    await ctx.db.patch(args.userId, {
      vkAccessToken: args.accessToken,
      vkRefreshToken: args.refreshToken ?? user.vkRefreshToken,
      vkTokenExpiresAt: tokenExpiresAt ?? user.vkTokenExpiresAt,
      updatedAt: now,
    });
  },
});

// Internal query to get VK tokens for a user
export const getVkTokens = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return null;
    }
    return {
      accessToken: user.vkAccessToken,
      refreshToken: user.vkRefreshToken,
      expiresAt: user.vkTokenExpiresAt,
    };
  },
});

// Internal mutation to update VK Ads API tokens (myTarget/ads.vk.com)
export const updateVkAdsTokens = internalMutation({
  args: {
    userId: v.id("users"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresIn: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const tokenExpiresAt = args.expiresIn > 0 ? now + args.expiresIn * 1000 : undefined;

    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    await ctx.db.patch(args.userId, {
      vkAdsAccessToken: args.accessToken,
      vkAdsRefreshToken: args.refreshToken ?? user.vkAdsRefreshToken,
      vkAdsTokenExpiresAt: tokenExpiresAt ?? user.vkAdsTokenExpiresAt,
      updatedAt: now,
    });
  },
});

// Internal query to get VK Ads API tokens
export const getVkAdsTokens = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return null;
    }
    return {
      accessToken: user.vkAdsAccessToken,
      refreshToken: user.vkAdsRefreshToken,
      expiresAt: user.vkAdsTokenExpiresAt,
    };
  },
});

// Save per-user VK Ads API credentials
export const saveVkAdsCredentials = mutation({
  args: {
    userId: v.id("users"),
    clientId: v.string(),
    clientSecret: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("Пользователь не найден");
    }

    await ctx.db.patch(args.userId, {
      vkAdsClientId: args.clientId,
      vkAdsClientSecret: args.clientSecret,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

// Get per-user VK Ads credentials (internal — for backend API calls)
export const getVkAdsCredentials = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return null;
    }
    return {
      clientId: user.vkAdsClientId,
      clientSecret: user.vkAdsClientSecret,
    };
  },
});

// Check if user has VK Ads credentials saved (for frontend)
export const hasVkAdsCredentials = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return false;
    }
    return !!(user.vkAdsClientId && user.vkAdsClientSecret);
  },
});

// Get VK Ads credentials for frontend (pre-fill wizard)
export const getVkAdsCredentialsForFrontend = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !user.vkAdsClientId || !user.vkAdsClientSecret) {
      return null;
    }
    return {
      clientId: user.vkAdsClientId,
      clientSecret: user.vkAdsClientSecret,
    };
  },
});

// Delete user and all related data
export const deleteUser = mutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    // Delete user settings
    const settings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    if (settings) {
      await ctx.db.delete(settings._id);
    }

    // Delete sessions
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }

    // Delete rules
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const rule of rules) {
      await ctx.db.delete(rule._id);
    }

    // Delete ad accounts
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const account of accounts) {
      await ctx.db.delete(account._id);
    }

    // Delete action logs
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const log of logs) {
      await ctx.db.delete(log._id);
    }

    // Delete notifications
    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const notification of notifications) {
      await ctx.db.delete(notification._id);
    }

    // Finally delete the user
    await ctx.db.delete(args.userId);

    return { success: true };
  },
});
