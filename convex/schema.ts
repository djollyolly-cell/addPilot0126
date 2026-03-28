import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    email: v.string(),
    vkId: v.optional(v.string()),
    name: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    telegramChatId: v.optional(v.string()),
    subscriptionTier: v.optional(v.union(
      v.literal("freemium"),
      v.literal("start"),
      v.literal("pro")
    )),
    subscriptionExpiresAt: v.optional(v.number()),
    onboardingCompleted: v.optional(v.boolean()),
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
    updatedAt: v.optional(v.number()),
  })
    .index("by_vkId", ["vkId"])
    .index("by_email", ["email"]),

  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    expiresAt: v.number(),
    createdAt: v.optional(v.number()),
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
    clientId: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
    // Business profile
    companyName: v.optional(v.string()),
    industry: v.optional(v.string()),
    tone: v.optional(v.string()),
    website: v.optional(v.string()),
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

  businessDirections: defineTable({
    accountId: v.id("adAccounts"),
    name: v.string(),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
    isActive: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_accountId", ["accountId"]),

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
    .index("by_vkCampaignId", ["vkCampaignId"])
    .index("by_accountId_vkCampaignId", ["accountId", "vkCampaignId"]),

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
    .index("by_vkAdId", ["vkAdId"])
    .index("by_accountId_vkAdId", ["accountId", "vkAdId"]),

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
      v.literal("clicks_no_leads"),
      v.literal("new_lead")
    ),
    conditions: v.object({
      metric: v.string(),
      operator: v.string(),
      value: v.number(),
      minSamples: v.optional(v.number()),
      timeWindow: v.optional(
        v.union(
          v.literal("daily"),
          v.literal("since_launch"),
          v.literal("24h")
        )
      ),
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
    campaignId: v.optional(v.string()),
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

  // Universal rate limiting for OAuth, API calls, etc.
  rateLimits: defineTable({
    key: v.string(), // "oauth:deviceId:xxx" or "api:userId:xxx"
    attempts: v.number(),
    lastAttemptAt: v.number(),
    blockedUntil: v.optional(v.number()),
  })
    .index("by_key", ["key"]),

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
    activeAccountId: v.optional(v.id("adAccounts")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"]),

  // Payments table for bePaid integration
  payments: defineTable({
    userId: v.id("users"),
    tier: v.union(v.literal("start"), v.literal("pro")),
    orderId: v.string(),
    token: v.string(),
    amount: v.number(),
    currency: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("refunded")
    ),
    bepaidUid: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_orderId", ["orderId"])
    .index("by_token", ["token"]),
  // AI-generated banner creatives
  creatives: defineTable({
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
    offer: v.string(),           // Main offer (60 chars)
    bullets: v.string(),         // Bullet points (120 chars)
    benefit: v.string(),         // Benefit (50 chars)
    cta: v.string(),             // CTA (40 chars)
    adTitle: v.optional(v.string()),     // Ad title for VK (90 chars)
    adText: v.optional(v.string()),      // Ad body text for VK (220 chars)
    storageId: v.optional(v.id("_storage")),
    imageUrl: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed")
    ),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),       // createdAt + 2 days, for cron cleanup
  })
    .index("by_userId", ["userId"])
    .index("by_accountId", ["accountId"])
    .index("by_expiresAt", ["expiresAt"]),

  // Video creatives uploaded to VK
  videos: defineTable({
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
    filename: v.string(),
    fileSize: v.optional(v.number()),
    duration: v.optional(v.number()),
    vkMediaId: v.optional(v.string()),
    vkMediaUrl: v.optional(v.string()),
    vkAdId: v.optional(v.string()),         // Links video to VK ad (banner) for stats
    lastAnalyzedAt: v.optional(v.number()), // When AI last analyzed this video's watch rates
    direction: v.optional(v.string()),  // Business direction tag
    isActive: v.boolean(),
    uploadStatus: v.union(
      v.literal("queued"),
      v.literal("uploading"),
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed")
    ),
    uploadProgress: v.optional(v.number()),
    transcription: v.optional(v.string()),
    aiScore: v.optional(v.number()),
    aiScoreLabel: v.optional(v.string()),
    aiAnalysis: v.optional(v.object({
      watchRates: v.optional(v.object({
        p25: v.optional(v.number()),
        p50: v.optional(v.number()),
        p75: v.optional(v.number()),
        p95: v.optional(v.number()),
      })),
      avgWatchTime: v.optional(v.number()),
      totalViews: v.optional(v.number()),
      recommendations: v.optional(v.array(v.object({
        field: v.string(),
        original: v.string(),
        suggested: v.string(),
        reason: v.optional(v.string()),
      }))),
      transcriptMatch: v.optional(v.string()),
    })),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_accountId", ["accountId"])
    .index("by_uploadStatus", ["uploadStatus"]),

  // AI generation usage tracking for rate limiting
  aiGenerations: defineTable({
    userId: v.id("users"),
    type: v.union(
      v.literal("text"),
      v.literal("image"),
      v.literal("analysis")
    ),
    createdAt: v.number(),
  })
    .index("by_userId_type", ["userId", "type"])
    .index("by_createdAt", ["createdAt"]),

  // Creative performance statistics (accumulated from VK API)
  creativeStats: defineTable({
    accountId: v.id("adAccounts"),
    videoId: v.optional(v.id("videos")),
    adId: v.string(),           // VK banner ID
    date: v.string(),           // "YYYY-MM-DD"
    impressions: v.number(),
    clicks: v.number(),
    spent: v.number(),
    // Video watch funnel (from myTarget API: statistics/banners/day.json?metrics=base,video)
    videoStarted: v.optional(v.number()),
    videoViewed3s: v.optional(v.number()),
    videoViewed10s: v.optional(v.number()),
    videoViewed25: v.optional(v.number()),
    videoViewed50: v.optional(v.number()),
    videoViewed75: v.optional(v.number()),
    videoViewed100: v.optional(v.number()),
    depthOfView: v.optional(v.number()),   // avg % of video watched
    // Pre-calculated rates from API (0-100%)
    viewed3sRate: v.optional(v.number()),
    viewed25Rate: v.optional(v.number()),
    viewed50Rate: v.optional(v.number()),
    viewed75Rate: v.optional(v.number()),
    viewed100Rate: v.optional(v.number()),
    // AI analysis results
    aiAnalyzedAt: v.optional(v.number()),
    aiWatchScore: v.optional(v.number()),        // 0-100
    aiWatchScoreLabel: v.optional(v.string()),   // "Плохо" | "Средне" | "Хорошо" | "Отлично"
    aiRecommendations: v.optional(v.array(v.object({
      issue: v.string(),
      suggestion: v.string(),
      priority: v.string(),   // "high" | "medium" | "low"
    }))),
    createdAt: v.number(),
  })
    .index("by_adId_date", ["adId", "date"])
    .index("by_videoId", ["videoId"])
    .index("by_accountId_date", ["accountId", "date"]),

  // Audit log for credential changes (clientId, clientSecret, tokens)
  credentialHistory: defineTable({
    accountId: v.id("adAccounts"),
    field: v.string(), // "clientId" | "clientSecret" | "accessToken" | "refreshToken"
    oldValue: v.optional(v.string()),
    newValue: v.optional(v.string()),
    changedAt: v.number(),
    changedBy: v.optional(v.string()), // mutation name or userId
  })
    .index("by_accountId", ["accountId"])
    .index("by_field_changedAt", ["field", "changedAt"]),
}, { schemaValidation: false });
