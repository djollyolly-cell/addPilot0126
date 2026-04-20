import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    email: v.string(),
    vkId: v.optional(v.string()),
    name: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    telegramChatId: v.optional(v.string()),
    telegramUserId: v.optional(v.number()),
    telegramFirstName: v.optional(v.string()),
    telegramLastName: v.optional(v.string()),
    telegramUsername: v.optional(v.string()),
    telegramPhone: v.optional(v.string()),
    subscriptionTier: v.optional(v.union(
      v.literal("freemium"),
      v.literal("start"),
      v.literal("pro")
    )),
    subscriptionExpiresAt: v.optional(v.number()),
    // Pro account limit: 27 for grandfathered users, 20 for new Pro subscribers
    proAccountLimit: v.optional(v.number()),
    onboardingCompleted: v.optional(v.boolean()),
    createdAt: v.number(),
    vkAccessToken: v.optional(v.string()),
    vkRefreshToken: v.optional(v.string()),
    vkDeviceId: v.optional(v.string()),
    vkTokenExpiresAt: v.optional(v.number()),
    // VK Ads API (myTarget) tokens — separate from VK ID login tokens
    vkAdsAccessToken: v.optional(v.string()),
    vkAdsRefreshToken: v.optional(v.string()),
    vkAdsTokenExpiresAt: v.optional(v.number()),
    // Per-user VK Ads API credentials (client_id / client_secret)
    vkAdsClientId: v.optional(v.string()),
    vkAdsClientSecret: v.optional(v.string()),
    // VK Ads cabinet ID discovered via ads.getAccounts at login
    vkAdsCabinetId: v.optional(v.string()),
    isAdmin: v.optional(v.boolean()),
    updatedAt: v.optional(v.number()),
    // Grandfathered pricing: old prices locked until this timestamp
    lockedPrices: v.optional(v.object({
      start: v.number(),
      pro: v.number(),
      until: v.number(),
    })),
    // Referral system
    referralCode: v.optional(v.string()),
    referralType: v.optional(v.union(v.literal("basic"), v.literal("discount"))),
    referralDiscount: v.optional(v.number()),
    referralCount: v.optional(v.number()),
    referralBonusDaysEarned: v.optional(v.number()),
    referredBy: v.optional(v.id("users")),
    referralMilestone3Claimed: v.optional(v.boolean()),
    referralMilestone10Reached: v.optional(v.boolean()),
  })
    .index("by_vkId", ["vkId"])
    .index("by_email", ["email"])
    .index("by_referralCode", ["referralCode"])
    .index("by_telegramUserId", ["telegramUserId"])
    .index("by_telegramChatId", ["telegramChatId"]),

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
    // myTarget advertiser ID (e.g. 292358) — different from user ID in vkAccountId
    // Required for content upload API (?account= param)
    mtAdvertiserId: v.optional(v.string()),
    // Vitamin.tools cabinet ID — for auto-refreshing agency_client tokens
    vitaminCabinetId: v.optional(v.string()),
    // Universal agency provider link
    agencyProviderId: v.optional(v.id("agencyProviders")),
    agencyCabinetId: v.optional(v.string()),
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
    // Token recovery tracking
    tokenErrorSince: v.optional(v.number()),
    tokenRecoveryAttempts: v.optional(v.number()),
    // Transient sync error tracking (non-TOKEN_EXPIRED)
    consecutiveSyncErrors: v.optional(v.number()),
    lastSyncError: v.optional(v.string()),
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
    adPlanId: v.optional(v.string()),
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
      v.literal("new_lead"),
      v.literal("uz_budget_manage")
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
          v.literal("24h"),
          v.literal("1h"),
          v.literal("6h")
        )
      ),
      // uz_budget_manage fields
      initialBudget: v.optional(v.number()),
      budgetStep: v.optional(v.number()),
      maxDailyBudget: v.optional(v.number()),
      resetDaily: v.optional(v.boolean()),
    }),
    actions: v.object({
      stopAd: v.boolean(),
      notify: v.boolean(),
      notifyChannel: v.optional(v.string()),
      customMessage: v.optional(v.string()),
      // uz_budget_manage notification options
      notifyOnEveryIncrease: v.optional(v.boolean()),
      notifyOnKeyEvents: v.optional(v.boolean()),
    }),
    targetAccountIds: v.array(v.id("adAccounts")),
    targetCampaignIds: v.optional(v.array(v.string())),
    targetAdPlanIds: v.optional(v.array(v.string())),
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
      v.literal("stopped_and_notified"),
      v.literal("budget_increased"),
      v.literal("budget_reset"),
      v.literal("zero_spend_alert")
    ),
    reason: v.string(),
    metricsSnapshot: v.object({
      cpl: v.optional(v.number()),
      ctr: v.optional(v.number()),
      spent: v.number(),
      leads: v.number(),
      impressions: v.optional(v.number()),
      clicks: v.optional(v.number()),
      newBudget: v.optional(v.number()),
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
    .index("by_ruleId_createdAt", ["ruleId", "createdAt"])
    .index("by_accountId", ["accountId"]),

  systemLogs: defineTable({
    userId: v.optional(v.id("users")),
    accountId: v.optional(v.id("adAccounts")),
    level: v.union(v.literal("error"), v.literal("warn"), v.literal("info")),
    source: v.string(),
    message: v.string(),
    details: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_userId_createdAt", ["userId", "createdAt"])
    .index("by_level_createdAt", ["level", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  metricsDaily: defineTable({
    accountId: v.id("adAccounts"),
    adId: v.string(),
    campaignId: v.optional(v.string()),
    date: v.string(),
    impressions: v.number(),
    clicks: v.number(),
    spent: v.number(),
    leads: v.number(),
    vkResult: v.optional(v.number()),
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
    .index("by_adId_timestamp", ["adId", "timestamp"])
    .index("by_timestamp", ["timestamp"]),

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
    tier: v.union(
      v.literal("start"),
      v.literal("pro"),
      v.literal("agency_s"),
      v.literal("agency_m"),
      v.literal("agency_l"),
      v.literal("agency_xl")
    ),
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
    promoCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
    referralDiscount: v.optional(v.number()),
    bonusDays: v.optional(v.number()),
    bepaidUid: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    isUpgrade: v.optional(v.boolean()),
    creditAmount: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_orderId", ["orderId"])
    .index("by_token", ["token"]),
  // Promo codes
  promoCodes: defineTable({
    code: v.string(),             // Unique code (uppercase)
    description: v.string(),      // Admin note
    bonusDays: v.number(),        // Extra days added to subscription
    maxUses: v.optional(v.number()), // Max total uses (null = unlimited)
    usedCount: v.number(),        // How many times used
    isActive: v.boolean(),
    expiresAt: v.optional(v.number()), // Expiry timestamp (null = never)
    createdAt: v.number(),
  })
    .index("by_code", ["code"]),

  // Referral tracking
  referrals: defineTable({
    referrerId: v.id("users"),
    referredId: v.id("users"),
    referralCode: v.string(),
    status: v.union(v.literal("registered"), v.literal("paid")),
    paymentId: v.optional(v.id("payments")),
    bonusDaysGranted: v.optional(v.number()),
    createdAt: v.number(),
    paidAt: v.optional(v.number()),
  })
    .index("by_referrerId", ["referrerId"])
    .index("by_referredId", ["referredId"])
    .index("by_referralCode", ["referralCode"]),

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
    storageId: v.optional(v.id("_storage")),  // Convex file storage
    frameStorageIds: v.optional(v.array(v.id("_storage"))),  // Pre-extracted video frames
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

  // AI Cabinet: campaigns created via AI
  aiCampaigns: defineTable({
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
    name: v.string(),
    businessDirection: v.string(),
    objective: v.string(), // traffic | social | messages | video_views | engagement
    targetUrl: v.string(),
    packageId: v.optional(v.number()),
    regions: v.array(v.number()),
    ageFrom: v.number(),
    ageTo: v.number(),
    sex: v.string(), // "MF" | "M" | "F"
    dailyBudget: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("creating"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("error")
    ),
    vkCampaignId: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_accountId", ["accountId"])
    .index("by_status", ["status"]),

  // AI Cabinet: banners (ads) within AI campaigns
  aiBanners: defineTable({
    campaignId: v.id("aiCampaigns"),
    title: v.string(),       // ≤25 chars (adTitle for VK Ads)
    text: v.string(),        // ≤90 chars (adText for VK Ads)
    headline: v.optional(v.string()),    // ≤35 chars (text ON banner image)
    subtitle: v.optional(v.string()),    // ≤60 chars (subtitle ON banner image)
    bullets: v.optional(v.array(v.string())), // up to 4 bullets ON banner image
    imageStorageId: v.optional(v.id("_storage")),     // 1080×1080 (FLUX Ultra)
    wideImageStorageId: v.optional(v.id("_storage")), // 1080×607
    iconStorageId: v.optional(v.id("_storage")),      // 256×256
    vkContentIds: v.optional(v.object({
      image600: v.optional(v.number()),
      image1080: v.optional(v.number()),
      icon: v.optional(v.number()),
    })),
    isSelected: v.boolean(),
    vkBannerId: v.optional(v.string()),
    moderationStatus: v.optional(v.string()), // new | changed | delayed | allowed | banned
    moderationReason: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("paused")
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_campaignId", ["campaignId"]),

  // AI Cabinet: recommendations
  aiRecommendations: defineTable({
    campaignId: v.id("aiCampaigns"),
    type: v.string(), // increase_budget | decrease_budget | pause_banner | expand_geo | regenerate
    message: v.string(),
    actionData: v.optional(v.any()),
    status: v.union(
      v.literal("pending"),
      v.literal("applied"),
      v.literal("rejected")
    ),
    createdAt: v.number(),
  })
    .index("by_campaignId", ["campaignId"])
    .index("by_status", ["status"]),

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
  // In-app notifications & feedback threads
  userNotifications: defineTable({
    userId: v.id("users"),
    title: v.string(),
    message: v.string(),
    type: v.union(
      v.literal("info"),
      v.literal("warning"),
      v.literal("payment"),
      v.literal("feedback")
    ),
    direction: v.optional(v.union(
      v.literal("admin_to_user"),
      v.literal("user_to_admin")
    )),
    // Thread support: first message has no threadId, replies point to root message
    threadId: v.optional(v.id("userNotifications")),
    isRead: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_unread", ["userId", "isRead"])
    .index("by_direction", ["direction", "isRead"])
    .index("by_threadId", ["threadId"]),

  // Agency service providers (Витамин, GetUNIQ, TargetHunter, Церебро)
  agencyProviders: defineTable({
    name: v.string(),              // "vitamin" | "getuniq" | "targethunter" | "cerebro"
    displayName: v.string(),       // "Витамин" | "GetUNIQ" | "TargetHunter" | "Церебро"
    hasApi: v.boolean(),           // true = auto-refresh, false = manual token
    authMethod: v.optional(v.string()),   // "api_key" | "oauth2"
    // Fields the user needs to provide when connecting through this provider
    requiredFields: v.optional(v.array(v.object({
      key: v.string(),            // field identifier: "apiKey", "cabinetId", "clientId", "clientSecret", "accessToken"
      label: v.string(),          // Russian label for UI
      placeholder: v.optional(v.string()),
      type: v.optional(v.string()),  // "text" | "password" | "textarea"
    }))),
    notes: v.optional(v.string()),
    docsUrl: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_name", ["name"]),

  // Per-user credentials for each agency provider
  agencyCredentials: defineTable({
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    // API key auth (Витамин)
    apiKey: v.optional(v.string()),
    previousApiKey: v.optional(v.string()), // Audit: old apiKey before last overwrite
    // OAuth2 auth (GetUNIQ)
    oauthClientId: v.optional(v.string()),
    oauthClientSecret: v.optional(v.string()),
    oauthAccessToken: v.optional(v.string()),
    oauthRefreshToken: v.optional(v.string()),
    oauthTokenExpiresAt: v.optional(v.number()),
    isActive: v.boolean(),
    lastUsedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_provider", ["userId", "providerId"]),

  // Cron heartbeats — detect stuck/zombie cron runs
  cronHeartbeats: defineTable({
    name: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
  }).index("by_name", ["name"]),

  // Health check results — diagnostic history
  healthCheckResults: defineTable({
    type: v.union(v.literal("system"), v.literal("function"), v.literal("user")),
    targetUserId: v.optional(v.id("users")),
    status: v.union(v.literal("ok"), v.literal("warning"), v.literal("error")),
    summary: v.string(),
    details: v.any(),
    checkedUsers: v.number(),
    checkedAccounts: v.number(),
    checkedRules: v.number(),
    warnings: v.number(),
    errors: v.number(),
    duration: v.number(),
    createdAt: v.number(),
  })
    .index("by_type", ["type", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // Support chat: forwarded messages mapping (user ↔ admin topic)
  supportMessages: defineTable({
    forwardedMessageId: v.number(),    // ID сообщения в группе (после forward)
    originalChatId: v.string(),        // chatId пользователя (для ответа)
    originalMessageId: v.optional(v.number()), // ID исходного сообщения
    userName: v.optional(v.string()),  // имя пользователя для контекста
    createdAt: v.number(),
  })
    .index("by_forwardedMessageId", ["forwardedMessageId"]),

  // Audit log — все действия пользователей (успех + провал)
  auditLog: defineTable({
    userId: v.id("users"),
    category: v.union(
      v.literal("account"),
      v.literal("rule"),
      v.literal("payment"),
      v.literal("telegram"),
      v.literal("settings"),
      v.literal("auth"),
      v.literal("admin"),
    ),
    action: v.string(),
    status: v.union(v.literal("success"), v.literal("failed")),
    details: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_userId_createdAt", ["userId", "createdAt"])
    .index("by_category_createdAt", ["category", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // Настройки Telegram-уведомлений для админов
  adminAlertSettings: defineTable({
    userId: v.id("users"),
    payments: v.boolean(),
    criticalErrors: v.boolean(),
    accountConnections: v.boolean(),
    newUsers: v.boolean(),
    ruleErrors: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"]),

  // Дедупликация алертов (не спамить одну ошибку)
  adminAlertDedup: defineTable({
    key: v.string(),
    lastSentAt: v.number(),
  })
    .index("by_key", ["key"]),

  // VK API rate-limit headers from response (X-RateLimit-RPS-Limit, etc.)
  vkApiLimits: defineTable({
    accountId: v.optional(v.id("adAccounts")),
    endpoint: v.string(),
    rpsLimit: v.optional(v.number()),
    rpsRemaining: v.optional(v.number()),
    hourlyLimit: v.optional(v.number()),
    hourlyRemaining: v.optional(v.number()),
    dailyLimit: v.optional(v.number()),
    dailyRemaining: v.optional(v.number()),
    statusCode: v.number(),
    capturedAt: v.number(),
  })
    .index("by_accountId_capturedAt", ["accountId", "capturedAt"])
    .index("by_endpoint_capturedAt", ["endpoint", "capturedAt"])
    .index("by_capturedAt", ["capturedAt"]),
  // Agency organization — owns adAccounts/rules/etc, has subscription,
  // has manager team with granular permissions
  organizations: defineTable({
    name: v.string(),                                // "Digital Agency"
    ownerId: v.id("users"),                          // owner — full access
    subscriptionTier: v.union(
      v.literal("agency_s"),
      v.literal("agency_m"),
      v.literal("agency_l"),
      v.literal("agency_xl")
    ),
    subscriptionExpiresAt: v.optional(v.number()),
    // Load units (computed daily)
    maxLoadUnits: v.number(),                        // package limit
    currentLoadUnits: v.number(),                    // last computed
    // Niche distribution at signup (n cabinets per niche)
    // niche is v.string() — validated at runtime via AVAILABLE_NICHES constant.
    // This avoids schema redeploy when adding new niches.
    nichesConfig: v.optional(v.array(v.object({
      niche: v.string(),
      cabinetsCount: v.number(),
    }))),
    // Overage flags (Решение 4: tier 1 — overage)
    overageNotifiedAt: v.optional(v.number()),       // first 7+day notification
    overageGraceStartedAt: v.optional(v.number()),   // 14d grace begin
    featuresDisabledAt: v.optional(v.number()),      // grace expired → premium off
    // Expired flags (Решение 4: tier 2 — subscription expired)
    expiredGracePhase: v.optional(v.union(
      v.literal("warnings"),                         // day 0-14
      v.literal("read_only"),                        // day 14-45
      v.literal("deep_read_only"),                   // day 45-60
      v.literal("frozen")                            // day 60+
    )),
    expiredGraceStartedAt: v.optional(v.number()),
    // Pending credit from manager subscriptions (3.7 way 2)
    pendingCredit: v.optional(v.number()),
    pendingCreditCurrency: v.optional(v.string()),
    // Timezone for monthly org-report (D2.4)
    timezone: v.optional(v.string()),                // "Europe/Moscow", default
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_subscriptionTier", ["subscriptionTier"])
    .index("by_expiredGracePhase", ["expiredGracePhase"]),

}, { schemaValidation: false });
