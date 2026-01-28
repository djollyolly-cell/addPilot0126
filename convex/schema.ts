import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    email: v.string(),
    vkId: v.string(),
    name: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    telegramChatId: v.optional(v.string()),
    subscriptionTier: v.union(
      v.literal("freemium"),
      v.literal("start"),
      v.literal("pro")
    ),
    subscriptionExpiresAt: v.optional(v.number()),
    onboardingCompleted: v.boolean(),
    createdAt: v.number(),
    vkAccessToken: v.optional(v.string()),
    vkRefreshToken: v.optional(v.string()),
    vkTokenExpiresAt: v.optional(v.number()),
    // VK Ads API (myTarget) tokens — separate from VK ID login tokens
    vkAdsAccessToken: v.optional(v.string()),
    vkAdsRefreshToken: v.optional(v.string()),
    vkAdsTokenExpiresAt: v.optional(v.number()),
    // Per-user VK Ads API credentials (client_id / client_secret)
    vkAdsClientId: v.optional(v.string()),
    vkAdsClientSecret: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_vkId", ["vkId"])
    .index("by_email", ["email"]),

  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_userId", ["userId"]),

  adAccounts: defineTable({
    userId: v.id("users"),
    vkAccountId: v.string(),
    name: v.string(),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("error")
    ),
    lastSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_vkAccountId", ["vkAccountId"]),

  campaigns: defineTable({
    accountId: v.id("adAccounts"),
    vkCampaignId: v.string(),
    name: v.string(),
    status: v.string(),
    dailyLimit: v.optional(v.number()),
    allLimit: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_accountId", ["accountId"])
    .index("by_vkCampaignId", ["vkCampaignId"]),

  ads: defineTable({
    accountId: v.id("adAccounts"),
    campaignId: v.id("campaigns"),
    vkAdId: v.string(),
    name: v.string(),
    status: v.string(),
    approved: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_campaignId", ["campaignId"])
    .index("by_vkAdId", ["vkAdId"]),

  rules: defineTable({
    userId: v.id("users"),
    name: v.string(),
    type: v.union(
      v.literal("cpl_limit"),
      v.literal("min_ctr"),
      v.literal("fast_spend"),
      v.literal("spend_no_leads"),
      v.literal("budget_limit"),
      v.literal("low_impressions"),
      v.literal("clicks_no_leads")
    ),
    conditions: v.object({
      metric: v.string(),
      operator: v.string(),
      value: v.number(),
      minSamples: v.optional(v.number()),
    }),
    actions: v.object({
      stopAd: v.boolean(),
      notify: v.boolean(),
      notifyChannel: v.optional(v.string()),
      customMessage: v.optional(v.string()),
    }),
    targetAccountIds: v.array(v.id("adAccounts")),
    targetCampaignIds: v.optional(v.array(v.string())),
    targetAdIds: v.optional(v.array(v.string())),
    isActive: v.boolean(),
    triggerCount: v.number(),
    lastTriggeredAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_active", ["userId", "isActive"]),

  actionLogs: defineTable({
    userId: v.id("users"),
    ruleId: v.id("rules"),
    accountId: v.id("adAccounts"),
    adId: v.string(),
    adName: v.string(),
    campaignName: v.optional(v.string()),
    actionType: v.union(
      v.literal("stopped"),
      v.literal("notified"),
      v.literal("stopped_and_notified")
    ),
    reason: v.string(),
    metricsSnapshot: v.object({
      cpl: v.optional(v.number()),
      ctr: v.optional(v.number()),
      spent: v.number(),
      leads: v.number(),
      impressions: v.optional(v.number()),
      clicks: v.optional(v.number()),
    }),
    savedAmount: v.number(),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("reverted")
    ),
    errorMessage: v.optional(v.string()),
    revertedAt: v.optional(v.number()),
    revertedBy: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_date", ["userId", "createdAt"])
    .index("by_ruleId", ["ruleId"])
    .index("by_accountId", ["accountId"]),

  metricsDaily: defineTable({
    accountId: v.id("adAccounts"),
    adId: v.string(),
    date: v.string(),
    impressions: v.number(),
    clicks: v.number(),
    spent: v.number(),
    leads: v.number(),
    reach: v.optional(v.number()),
    cpl: v.optional(v.number()),
    ctr: v.optional(v.number()),
    cpc: v.optional(v.number()),
  })
    .index("by_accountId_date", ["accountId", "date"])
    .index("by_adId_date", ["adId", "date"]),

  metricsRealtime: defineTable({
    accountId: v.id("adAccounts"),
    adId: v.string(),
    timestamp: v.number(),
    spent: v.number(),
    leads: v.number(),
    impressions: v.number(),
    clicks: v.number(),
  })
    .index("by_adId", ["adId"])
    .index("by_accountId_timestamp", ["accountId", "timestamp"]),

  notifications: defineTable({
    userId: v.id("users"),
    type: v.union(
      v.literal("critical"),
      v.literal("standard"),
      v.literal("digest")
    ),
    channel: v.union(
      v.literal("telegram"),
      v.literal("email"),
      v.literal("push")
    ),
    title: v.string(),
    message: v.string(),
    data: v.optional(v.any()),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("failed")
    ),
    sentAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_status", ["status"]),

  loginAttempts: defineTable({
    email: v.string(),
    attempts: v.number(),
    lastAttemptAt: v.number(),
    blockedUntil: v.optional(v.number()),
  })
    .index("by_email", ["email"]),

  telegramLinks: defineTable({
    userId: v.id("users"),
    token: v.string(),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_userId", ["userId"]),

  userSettings: defineTable({
    userId: v.id("users"),
    quietHoursEnabled: v.boolean(),
    quietHoursStart: v.optional(v.string()),
    quietHoursEnd: v.optional(v.string()),
    timezone: v.string(),
    digestEnabled: v.boolean(),
    digestTime: v.string(),
    language: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"]),
});
