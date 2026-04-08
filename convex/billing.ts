import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

// Tier limits and pricing
export const TIERS = {
  freemium: {
    name: "Freemium",
    price: 0,
    accountsLimit: 1,
    rulesLimit: 3,
    features: ["1 рекламный кабинет", "3 правила автоматизации", "Telegram-уведомления"],
  },
  start: {
    name: "Start",
    price: 1290,
    accountsLimit: 3,
    rulesLimit: 10,
    features: ["3 рекламных кабинета", "10 правил автоматизации", "Telegram-уведомления", "Базовая аналитика"],
  },
  pro: {
    name: "Pro",
    price: 2990,
    accountsLimit: -1, // unlimited
    rulesLimit: -1, // unlimited
    features: ["Безлимит кабинетов", "Неограниченные правила", "Приоритетная поддержка", "Расширенная аналитика"],
  },
} as const;

export type SubscriptionTier = keyof typeof TIERS;

// Old prices before 2026-04-04 increase
const OLD_PRICES = { start: 990, pro: 2490 } as const;

// Get user's effective prices (respects grandfathered/locked pricing)
export const getUserPrices = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { start: TIERS.start.price, pro: TIERS.pro.price };

    const locked = user.lockedPrices;
    if (locked && locked.until > Date.now()) {
      return { start: locked.start, pro: locked.pro };
    }
    return { start: TIERS.start.price, pro: TIERS.pro.price };
  },
});

// bePaid API configuration
const BEPAID_CHECKOUT_URL = "https://checkout.bepaid.by/ctp/api/checkouts";

// Get current subscription info
export const getSubscription = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;

    const tier = user.subscriptionTier as SubscriptionTier;
    const tierInfo = TIERS[tier];
    const isExpired = user.subscriptionExpiresAt ? user.subscriptionExpiresAt < Date.now() : false;

    return {
      tier,
      tierInfo,
      expiresAt: user.subscriptionExpiresAt,
      isExpired,
      isActive: !isExpired && tier !== "freemium",
    };
  },
});

// ─── Prorated Upgrade ────────────────────────────────

const TIER_ORDER: Record<string, number> = { freemium: 0, start: 1, pro: 2 };

export interface UpgradePriceInput {
  currentTier: string;
  newTier: string;
  subscriptionExpiresAt: number | undefined;
  lastPaymentAmount: number | undefined;
  lastPaymentBonusDays: number | undefined;
  lastPaymentCurrency: string | undefined;
  now: number;
}

export interface UpgradePriceResult {
  credit: number;
  remainingDays: number;
  isUpgrade: boolean;
  currency?: string;
}

/** Pure calculation — exported for unit testing */
export function calculateUpgradePrice(input: UpgradePriceInput): UpgradePriceResult {
  const { currentTier, newTier, subscriptionExpiresAt, lastPaymentAmount, lastPaymentBonusDays, lastPaymentCurrency, now } = input;
  const noUpgrade: UpgradePriceResult = { credit: 0, remainingDays: 0, isUpgrade: false };

  if (currentTier === "freemium" || !subscriptionExpiresAt || subscriptionExpiresAt <= now) {
    return noUpgrade;
  }
  if ((TIER_ORDER[newTier] ?? 0) <= (TIER_ORDER[currentTier] ?? 0)) {
    return noUpgrade;
  }
  if (!lastPaymentAmount || !lastPaymentCurrency) {
    return noUpgrade;
  }

  const remainingDays = Math.ceil((subscriptionExpiresAt - now) / (24 * 60 * 60 * 1000));
  const totalDays = 30 + (lastPaymentBonusDays || 0);
  const dailyRate = lastPaymentAmount / totalDays;
  const credit = Math.round(dailyRate * remainingDays * 100) / 100;

  return { credit, remainingDays, isUpgrade: true, currency: lastPaymentCurrency };
}

/** Query: get upgrade credit for prorated pricing */
export const getUpgradePrice = query({
  args: {
    userId: v.id("users"),
    newTier: v.union(v.literal("start"), v.literal("pro")),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { credit: 0, remainingDays: 0, isUpgrade: false };

    const currentTier = (user.subscriptionTier as string) ?? "freemium";

    // Find last completed payment
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
    const lastPayment = payments.find((p) => p.status === "completed");

    return calculateUpgradePrice({
      currentTier,
      newTier: args.newTier,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
      lastPaymentAmount: lastPayment?.amount,
      lastPaymentBonusDays: lastPayment?.bonusDays,
      lastPaymentCurrency: lastPayment?.currency,
      now: Date.now(),
    });
  },
});

// bePaid checkout result type
type BepaidCheckoutResult = {
  success: boolean;
  mockMode?: boolean;
  error?: string;
  token?: string;
  redirectUrl?: string;
};

// Create bePaid checkout token
export const createBepaidCheckout = action({
  args: {
    userId: v.id("users"),
    tier: v.union(v.literal("start"), v.literal("pro")),
    promoCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
    returnUrl: v.string(),
    amountBYN: v.number(), // Price in BYN (calculated on frontend with NBRB rate)
    isUpgrade: v.optional(v.boolean()),
    creditAmount: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BepaidCheckoutResult> => {
    // Mutual exclusion: promo code and referral code cannot be used together
    if (args.promoCode && args.referralCode) {
      throw new Error("Нельзя использовать промокод и реферальный код одновременно");
    }

    const shopId = process.env.BEPAID_SHOP_ID;
    const secretKey = process.env.BEPAID_SECRET_KEY;
    const isTestMode = process.env.BEPAID_TEST_MODE === "true";
    const siteUrl = process.env.CONVEX_SITE_URL; // e.g., https://resilient-terrier-567.convex.site

    // If bePaid not configured, return mock mode indicator
    if (!shopId || !secretKey) {
      return {
        success: false,
        mockMode: true,
        error: "bePaid не настроен. Используйте тестовый режим с картой 4242 4242 4242 4242",
      };
    }

    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    if (!user) {
      throw new Error("Пользователь не найден");
    }

    // Calculate referral discount
    let referralDiscount = 0;
    if (args.referralCode) {
      const referrer = await ctx.runQuery(internal.referrals.findReferrerByCode, {
        code: args.referralCode.toUpperCase(),
      });
      if (referrer && referrer.referralType === "discount") {
        referralDiscount = referrer.referralDiscount ?? 10;
      }
    } else if (!args.promoCode && (user as Record<string, unknown>).referralMilestone10Reached) {
      // Auto-apply 15% discount for users with 10+ referrals
      referralDiscount = 15;
    }

    const tierInfo = TIERS[args.tier];
    const discountedBYN = referralDiscount > 0
      ? Math.round(args.amountBYN * (100 - referralDiscount) / 100 * 100) / 100
      : args.amountBYN;
    const amountInCents = Math.round(discountedBYN * 100); // bePaid expects amount in minimal units (kopecks)

    const orderId = `order_${args.userId}_${args.tier}_${Date.now()}`;

    const checkoutRequest = {
      checkout: {
        test: isTestMode,
        transaction_type: "payment",
        attempts: 3,
        settings: {
          success_url: `${args.returnUrl}?status=success&tier=${args.tier}`,
          fail_url: `${args.returnUrl}?status=failed`,
          notification_url: siteUrl ? `${siteUrl}/api/bepaid-webhook` : undefined,
          language: "ru",
        },
        order: {
          amount: amountInCents,
          currency: "BYN",
          description: `AddPilot ${tierInfo.name}`,
          tracking_id: orderId,
        },
        customer: {
          email: user.email,
        },
      },
    };

    try {
      const response: Response = await fetch(BEPAID_CHECKOUT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-API-Version": "2",
          "Authorization": `Basic ${btoa(`${shopId}:${secretKey}`)}`,
        },
        body: JSON.stringify(checkoutRequest),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();

      if (!response.ok || data.errors) {
        console.error("bePaid checkout error:", data);
        return {
          success: false,
          error: data.message || data.errors?.[0]?.message || "Ошибка создания платежа",
        };
      }

      // Save pending payment to track it
      await ctx.runMutation(internal.billing.savePendingPayment, {
        userId: args.userId,
        tier: args.tier,
        orderId,
        token: data.checkout.token as string,
        amount: discountedBYN,
        currency: "BYN",
        promoCode: args.promoCode,
        referralCode: args.referralCode?.toUpperCase(),
        referralDiscount: referralDiscount > 0 ? referralDiscount : undefined,
        isUpgrade: args.isUpgrade,
        creditAmount: args.creditAmount,
      });

      return {
        success: true,
        token: data.checkout.token as string,
        redirectUrl: data.checkout.redirect_url as string,
      };
    } catch (error) {
      console.error("bePaid request failed:", error);
      return {
        success: false,
        error: "Ошибка подключения к платёжной системе",
      };
    }
  },
});

// Save pending payment record (internal)
export const savePendingPayment = internalMutation({
  args: {
    userId: v.id("users"),
    tier: v.union(v.literal("start"), v.literal("pro")),
    orderId: v.string(),
    token: v.string(),
    amount: v.number(),
    currency: v.string(),
    promoCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
    referralDiscount: v.optional(v.number()),
    isUpgrade: v.optional(v.boolean()),
    creditAmount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("payments", {
      userId: args.userId,
      tier: args.tier,
      orderId: args.orderId,
      token: args.token,
      amount: args.amount,
      currency: args.currency,
      promoCode: args.promoCode?.trim().toUpperCase(),
      referralCode: args.referralCode,
      referralDiscount: args.referralDiscount,
      isUpgrade: args.isUpgrade,
      creditAmount: args.creditAmount,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

// Handle bePaid webhook notification (internal - called from http.ts)
export const handleBepaidWebhook = internalMutation({
  args: {
    transactionType: v.string(),
    status: v.string(),
    trackingId: v.string(),
    uid: v.string(),
    amount: v.number(),
    currency: v.string(),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Find payment by tracking_id (orderId)
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_orderId", (q) => q.eq("orderId", args.trackingId))
      .first();

    if (!payment) {
      console.error("bePaid webhook: payment not found for", args.trackingId);
      return { success: false, error: "Payment not found" };
    }

    if (args.status === "successful") {
      // Check promo code bonus days
      let bonusDays = 0;
      if (payment.promoCode) {
        const promo = await ctx.db
          .query("promoCodes")
          .withIndex("by_code", (q) => q.eq("code", payment.promoCode!))
          .first();
        if (promo && promo.isActive
            && (!promo.expiresAt || promo.expiresAt > Date.now())
            && (!promo.maxUses || promo.usedCount < promo.maxUses)) {
          bonusDays = promo.bonusDays;
          await ctx.db.patch(promo._id, { usedCount: promo.usedCount + 1 });
        }
      }

      // Referral bonus
      if (payment.referralCode) {
        const bonusResult = await ctx.runMutation(internal.referrals.applyReferralBonus, {
          referralCode: payment.referralCode,
          referredUserId: payment.userId,
          paymentId: payment._id,
        });

        if (bonusResult) {
          // Send Telegram notification to referrer
          await ctx.scheduler.runAfter(0, internal.telegram.sendReferralNotification, {
            referrerId: bonusResult.referrerId,
            bonusDays: bonusResult.bonusDays,
            totalReferrals: bonusResult.newCount,
            milestone3: bonusResult.milestone3,
            milestone10: bonusResult.milestone10,
          });
        }
      }

      // Update payment status
      await ctx.db.patch(payment._id, {
        status: "completed",
        bepaidUid: args.uid,
        bonusDays: bonusDays > 0 ? bonusDays : undefined,
        completedAt: Date.now(),
      });

      // Activate subscription (30 days + bonus)
      const totalDays = 30 + bonusDays;
      const expiresAt = Date.now() + totalDays * 24 * 60 * 60 * 1000;

      // Extend lockedPrices if user has them and subscription is continuous
      const paidUser = await ctx.db.get(payment.userId);
      const lockedUpdate: Record<string, unknown> = {};
      if (paidUser?.lockedPrices) {
        // Subscription is continuous if not yet expired at time of renewal
        const isStillActive = paidUser.subscriptionExpiresAt && paidUser.subscriptionExpiresAt >= Date.now();
        if (isStillActive) {
          lockedUpdate.lockedPrices = {
            ...paidUser.lockedPrices,
            until: expiresAt,
          };
        }
      }

      await ctx.db.patch(payment.userId, {
        subscriptionTier: payment.tier,
        subscriptionExpiresAt: expiresAt,
        updatedAt: Date.now(),
        ...lockedUpdate,
      });

      console.log(`bePaid: Subscription ${payment.tier} activated for user ${payment.userId} (${totalDays} days, promo: ${payment.promoCode || "none"})`);
      return { success: true };
    }

    if (args.status === "failed" || args.status === "declined") {
      await ctx.db.patch(payment._id, {
        status: "failed",
        errorMessage: args.message,
        completedAt: Date.now(),
      });

      console.log(`bePaid: Payment failed for ${args.trackingId}: ${args.message}`);
      return { success: false, error: args.message };
    }

    // Pending or other status - just log
    console.log(`bePaid webhook: ${args.trackingId} status=${args.status}`);
    return { success: true };
  },
});

// Process payment (mock for testing when bePaid not configured)
export const processPayment = mutation({
  args: {
    userId: v.id("users"),
    tier: v.union(v.literal("start"), v.literal("pro")),
    cardNumber: v.string(),
    promoCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    // Mock card validation
    const cardLast4 = args.cardNumber.slice(-4);

    // Test card for declined payment
    if (args.cardNumber.startsWith("4000000000000002")) {
      return {
        success: false,
        error: "Карта отклонена. Попробуйте другую карту.",
      };
    }

    // Test card for success (4242424242424242)
    if (!args.cardNumber.startsWith("4242424242424242") && !args.cardNumber.startsWith("4000")) {
      return {
        success: false,
        error: "Неверный номер карты",
      };
    }

    // Check promo code bonus days
    let bonusDays = 0;
    if (args.promoCode) {
      const code = args.promoCode.trim().toUpperCase();
      const promo = await ctx.db
        .query("promoCodes")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      if (promo && promo.isActive
          && (!promo.expiresAt || promo.expiresAt > Date.now())
          && (!promo.maxUses || promo.usedCount < promo.maxUses)) {
        bonusDays = promo.bonusDays;
        await ctx.db.patch(promo._id, { usedCount: promo.usedCount + 1 });
      }
    }

    // Calculate expiration (30 days + bonus)
    const totalDays = 30 + bonusDays;
    const expiresAt = Date.now() + totalDays * 24 * 60 * 60 * 1000;

    // Extend lockedPrices if subscription is continuous
    const lockedUpdate: Record<string, unknown> = {};
    if (user.lockedPrices) {
      const isStillActive = user.subscriptionExpiresAt && user.subscriptionExpiresAt >= Date.now();
      if (isStillActive) {
        lockedUpdate.lockedPrices = {
          ...user.lockedPrices,
          until: expiresAt,
        };
      }
    }

    // Update user subscription
    await ctx.db.patch(args.userId, {
      subscriptionTier: args.tier,
      subscriptionExpiresAt: expiresAt,
      updatedAt: Date.now(),
      ...lockedUpdate,
    });

    return {
      success: true,
      tier: args.tier,
      expiresAt,
      cardLast4,
      bonusDays,
    };
  },
});

// Cancel subscription (downgrade to freemium)
export const cancelSubscription = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    await ctx.db.patch(args.userId, {
      subscriptionTier: "freemium",
      subscriptionExpiresAt: undefined,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

// Get all tiers info
export const getTiers = query({
  args: {},
  handler: async () => {
    return TIERS;
  },
});

// Get payment history for user
export const getPaymentHistory = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(20);

    return payments.map((p) => ({
      id: p._id,
      tier: p.tier,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
    }));
  },
});

// Check if bePaid is configured
export const isBepaidConfigured = action({
  args: {},
  handler: async () => {
    const shopId = process.env.BEPAID_SHOP_ID;
    const secretKey = process.env.BEPAID_SECRET_KEY;
    return {
      configured: !!(shopId && secretKey),
      testMode: process.env.BEPAID_TEST_MODE === "true",
    };
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 25 — Expiry Notifications & Limit Updates
// ═══════════════════════════════════════════════════════════

// Get users with subscriptions expiring within a given window
export const getUsersWithExpiringSubscriptions = internalQuery({
  args: {
    daysAhead: v.number(), // 7 or 1
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const targetDate = now + args.daysAhead * dayMs;
    const windowStart = targetDate - dayMs / 2; // 12 hours before target
    const windowEnd = targetDate + dayMs / 2; // 12 hours after target

    const users = await ctx.db.query("users").collect();

    return users.filter((user) => {
      if (!user.subscriptionExpiresAt) return false;
      if (user.subscriptionTier === "freemium") return false;
      return (
        user.subscriptionExpiresAt >= windowStart &&
        user.subscriptionExpiresAt <= windowEnd
      );
    });
  },
});

// Format expiry notification message
export function formatExpiryNotification(
  daysLeft: number,
  tierName: string,
  expiresAt: number
): string {
  const expiryDate = new Date(expiresAt);
  const dateStr = `${String(expiryDate.getDate()).padStart(2, "0")}.${String(expiryDate.getMonth() + 1).padStart(2, "0")}.${expiryDate.getFullYear()}`;

  if (daysLeft === 7) {
    return [
      `⚠️ <b>Подписка заканчивается через 7 дней</b>`,
      ``,
      `Ваш тариф <b>${tierName}</b> истекает ${dateStr}.`,
      ``,
      `Чтобы не потерять доступ к функциям, продлите подписку заранее.`,
      ``,
      `👉 <a href="${process.env.SITE_URL || "https://adpilot.ru"}/pricing">Продлить подписку</a>`,
    ].join("\n");
  }

  if (daysLeft === 1) {
    return [
      `🔴 <b>Подписка истекает завтра!</b>`,
      ``,
      `Ваш тариф <b>${tierName}</b> истекает ${dateStr}.`,
      ``,
      `После истечения:`,
      `• Лишние рекламные кабинеты будут деактивированы`,
      `• Правила сверх лимита будут отключены`,
      ``,
      `👉 <a href="${process.env.SITE_URL || "https://adpilot.ru"}/pricing">Продлить сейчас</a>`,
    ].join("\n");
  }

  return "";
}

// Send expiry notification to a single user (internal)
export const sendExpiryNotificationToUser = internalAction({
  args: {
    userId: v.id("users"),
    daysLeft: v.number(),
  },
  handler: async (ctx, args): Promise<{ sent: boolean; reason?: string; telegram?: boolean }> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user: any = await ctx.runQuery(internal.users.getById, {
      userId: args.userId,
    });

    if (!user) return { sent: false, reason: "user_not_found" };
    if (!user.subscriptionExpiresAt) return { sent: false, reason: "no_expiry" };
    if (user.subscriptionTier === "freemium")
      return { sent: false, reason: "freemium" };

    const tierInfo = TIERS[user.subscriptionTier as SubscriptionTier];
    const message = formatExpiryNotification(
      args.daysLeft,
      tierInfo.name,
      user.subscriptionExpiresAt
    );

    if (!message) return { sent: false, reason: "no_message" };

    let telegramSent = false;

    // Send via Telegram if connected
    if (user.telegramChatId) {
      try {
        await ctx.runAction(internal.telegram.sendMessageWithRetry, {
          chatId: user.telegramChatId,
          text: message,
        });
        telegramSent = true;
      } catch (err) {
        console.error(
          `[billing] Failed to send TG expiry notification to ${user._id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Store notification record
    await ctx.runMutation(internal.billing.storeExpiryNotification, {
      userId: args.userId,
      daysLeft: args.daysLeft,
      message,
    });

    return { sent: telegramSent, telegram: telegramSent };
  },
});

// Store expiry notification record
export const storeExpiryNotification = internalMutation({
  args: {
    userId: v.id("users"),
    daysLeft: v.number(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("notifications", {
      userId: args.userId,
      type: args.daysLeft === 1 ? "critical" : "standard",
      channel: "telegram",
      title: `Подписка истекает через ${args.daysLeft} дн.`,
      message: args.message,
      status: "sent",
      sentAt: Date.now(),
      createdAt: Date.now(),
    });
  },
});

// Cron handler: check and send expiry notifications
export const checkExpiringSubscriptions = internalAction({
  args: {},
  handler: async (ctx) => {
    let sent7d = 0;
    let sent1d = 0;

    // Check 7-day expiry
    const users7d = await ctx.runQuery(
      internal.billing.getUsersWithExpiringSubscriptions,
      { daysAhead: 7 }
    );

    for (const user of users7d) {
      const result = await ctx.runAction(
        internal.billing.sendExpiryNotificationToUser,
        { userId: user._id, daysLeft: 7 }
      );
      if (result.sent) sent7d++;
    }

    // Check 1-day expiry
    const users1d = await ctx.runQuery(
      internal.billing.getUsersWithExpiringSubscriptions,
      { daysAhead: 1 }
    );

    for (const user of users1d) {
      const result = await ctx.runAction(
        internal.billing.sendExpiryNotificationToUser,
        { userId: user._id, daysLeft: 1 }
      );
      if (result.sent) sent1d++;
    }

    console.log(
      `[billing] Expiry notifications sent: 7d=${sent7d}, 1d=${sent1d}`
    );

    return { sent7d, sent1d };
  },
});

// Update limits on downgrade — deactivate excess accounts
export const updateLimitsOnDowngrade = internalMutation({
  args: {
    userId: v.id("users"),
    newTier: v.union(
      v.literal("freemium"),
      v.literal("start"),
      v.literal("pro")
    ),
  },
  handler: async (ctx, args) => {
    const newLimit = TIERS[args.newTier].accountsLimit;

    // Get user's active accounts sorted by createdAt (oldest first to keep)
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const activeAccounts = accounts
      .filter((a) => a.status === "active")
      .sort((a, b) => a.createdAt - b.createdAt);

    // Deactivate excess accounts (keep oldest ones active)
    // -1 means unlimited — no accounts to deactivate
    const accountsToDeactivate = newLimit === -1 ? [] : activeAccounts.slice(newLimit);
    const deactivatedIds: string[] = [];

    for (const account of accountsToDeactivate) {
      await ctx.db.patch(account._id, { status: "paused" });
      deactivatedIds.push(account._id);
    }

    // Also deactivate excess rules
    const rulesLimit =
      TIERS[args.newTier].rulesLimit === -1
        ? Infinity
        : TIERS[args.newTier].rulesLimit;

    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const activeRules = rules
      .filter((r) => r.isActive)
      .sort((a, b) => a.createdAt - b.createdAt);

    const rulesToDeactivate = activeRules.slice(rulesLimit);
    const deactivatedRuleIds: string[] = [];

    for (const rule of rulesToDeactivate) {
      await ctx.db.patch(rule._id, { isActive: false, updatedAt: Date.now() });
      deactivatedRuleIds.push(rule._id);
    }

    return {
      accountsDeactivated: deactivatedIds.length,
      rulesDeactivated: deactivatedRuleIds.length,
    };
  },
});

// Handle subscription expiry (called by cron)
export const handleExpiredSubscriptions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const users = await ctx.db.query("users").collect();

    let processed = 0;

    for (const user of users) {
      if (
        user.subscriptionTier !== "freemium" &&
        user.subscriptionExpiresAt &&
        user.subscriptionExpiresAt < now
      ) {
        // Downgrade to freemium
        await ctx.db.patch(user._id, {
          subscriptionTier: "freemium",
          updatedAt: now,
        });

        processed++;
      }
    }

    return { processed };
  },
});

// Wrap handleExpiredSubscriptions for cron (action that calls mutation)
export const processExpiredSubscriptions = internalAction({
  args: {},
  handler: async (ctx): Promise<{ processed: number }> => {
    // First handle expired subscriptions
    const expiredResult: { processed: number } = await ctx.runMutation(
      internal.billing.handleExpiredSubscriptions,
      {}
    );

    // Then update limits for all freemium users who may have been downgraded
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const users: any[] = await ctx.runQuery(internal.billing.getFreemiumUsers, {});

    for (const user of users) {
      await ctx.runMutation(internal.billing.updateLimitsOnDowngrade, {
        userId: user._id,
        newTier: "freemium",
      });
    }

    return expiredResult;
  },
});

// Get all freemium users (for limit updates after downgrade)
export const getFreemiumUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users.filter((u) => u.subscriptionTier === "freemium");
  },
});

// ─── Promo Codes ─────────────────────────────────────

/** Validate promo code (public — called from frontend) */
export const validatePromoCode = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const code = args.code.trim().toUpperCase();
    if (!code) return { valid: false, error: "Введите промокод" };

    const promo = await ctx.db
      .query("promoCodes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();

    if (!promo) return { valid: false, error: "Промокод не найден" };
    if (!promo.isActive) return { valid: false, error: "Промокод неактивен" };
    if (promo.expiresAt && promo.expiresAt < Date.now()) return { valid: false, error: "Промокод истёк" };
    if (promo.maxUses && promo.usedCount >= promo.maxUses) return { valid: false, error: "Промокод исчерпан" };

    return {
      valid: true,
      bonusDays: promo.bonusDays,
      description: promo.description,
    };
  },
});

/** Apply promo code — increment usedCount (called after successful payment) */
export const applyPromoCode = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const promo = await ctx.db
      .query("promoCodes")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .first();
    if (!promo) return;
    await ctx.db.patch(promo._id, { usedCount: promo.usedCount + 1 });
  },
});

/** Create promo code (admin) */
export const createPromoCode = mutation({
  args: {
    code: v.string(),
    description: v.string(),
    bonusDays: v.number(),
    maxUses: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const code = args.code.trim().toUpperCase();
    const existing = await ctx.db
      .query("promoCodes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();
    if (existing) throw new Error("Промокод уже существует");

    return await ctx.db.insert("promoCodes", {
      code,
      description: args.description,
      bonusDays: args.bonusDays,
      maxUses: args.maxUses,
      usedCount: 0,
      isActive: true,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });
  },
});

/** List all promo codes (admin) */
export const listPromoCodes = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("promoCodes").collect();
  },
});

/** Toggle promo code active/inactive (admin) */
export const togglePromoCode = mutation({
  args: { promoId: v.id("promoCodes") },
  handler: async (ctx, args) => {
    const promo = await ctx.db.get(args.promoId);
    if (!promo) throw new Error("Промокод не найден");
    await ctx.db.patch(args.promoId, { isActive: !promo.isActive });
  },
});

// ─── Price Migration (one-time) ─────────────────────────────────────
// Lock old prices for existing users:
// - Paid users: lock until subscriptionExpiresAt (continuous subscription)
// - Registered but unpaid: lock until 00:00 05.04.2026 (MSK = UTC+3)
export const migrateLockOldPrices = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    // 00:00 05.04.2026 MSK = 04.04.2026 21:00 UTC
    const deadline = new Date("2026-04-04T21:00:00Z").getTime();
    let locked = 0;

    for (const user of users) {
      // Skip if already has locked prices
      if (user.lockedPrices) continue;

      const tier = user.subscriptionTier ?? "freemium";
      const hasPaidSubscription = tier !== "freemium" && user.subscriptionExpiresAt && user.subscriptionExpiresAt > Date.now();

      if (hasPaidSubscription) {
        // Paid users: lock prices until their subscription expires
        await ctx.db.patch(user._id, {
          lockedPrices: {
            start: OLD_PRICES.start,
            pro: OLD_PRICES.pro,
            until: user.subscriptionExpiresAt!,
          },
        });
        locked++;
      } else {
        // Registered but unpaid: lock until 00:00 05.04.2026 MSK
        await ctx.db.patch(user._id, {
          lockedPrices: {
            start: OLD_PRICES.start,
            pro: OLD_PRICES.pro,
            until: deadline,
          },
        });
        locked++;
      }
    }

    return { locked, total: users.length };
  },
});

// One-time: notify freemium & start users about price change
export const notifyPriceChange = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const targets = users.filter(
      (u) => !u.subscriptionTier || u.subscriptionTier === "freemium" || u.subscriptionTier === "start"
    );

    const message = `Спасибо, что вы с нами!

Вы — одни из первых пользователей AddPilot, и мы это ценим.

За последние недели количество пользователей сервиса выросло в несколько раз. Чтобы обеспечить стабильную работу — быструю синхронизацию, моментальные уведомления и надёжную автоостановку — мы масштабируем серверные мощности. Это требует затрат, поэтому с завтрашнего дня стоимость тарифов изменится:

— Start: 990 → 1 290 ₽/мес
— Pro: 2 490 → 2 990 ₽/мес

Но для вас — особые условия. Если вы оформите подписку сегодня до 23:59, старая цена сохранится на весь период непрерывной подписки. Не на месяц — навсегда, пока подписка активна.

👉 Start за 990 ₽/мес: https://aipilot.by/pricing?plan=start
👉 Pro за 2 490 ₽/мес: https://aipilot.by/pricing?plan=pro

Вопросы? Пишите @Addpilot_bot — ответим лично.`;

    let sent = 0;
    for (const user of targets) {
      await ctx.db.insert("userNotifications", {
        userId: user._id,
        title: "Цены меняются с 5 апреля",
        message,
        type: "info" as const,
        direction: "admin_to_user" as const,
        isRead: false,
        createdAt: Date.now(),
      });
      sent++;
    }

    // Collect Telegram chatIds for broadcast
    const telegramChatIds = targets
      .filter((u) => u.telegramChatId)
      .map((u) => u.telegramChatId!);

    return { sent, telegramChatIds };
  },
});

// ─── TEMP: One-time checkout link generator ─────────────────────────
// Run from Convex dashboard to create a payment link for any user
export const createOneTimeCheckout = internalAction({
  args: {
    email: v.string(),
    tier: v.union(v.literal("start"), v.literal("pro")),
    amountRUB: v.number(), // Price in RUB (e.g. 2490)
    returnUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ redirectUrl?: string; error?: string; amountBYN?: number }> => {
    // 1. Find user by email
    const user = await ctx.runQuery(internal.billing.getUserByEmailInternal, { email: args.email });
    if (!user) return { error: `Пользователь ${args.email} не найден` };

    // 2. Get NBRB rate RUB → BYN
    const nbrbResp = await fetch("https://api.nbrb.by/exrates/rates/456");
    if (!nbrbResp.ok) return { error: "Не удалось получить курс НБРБ" };
    const nbrbData = await nbrbResp.json();
    const rate = nbrbData.Cur_OfficialRate; // per 100 RUB
    const scale = nbrbData.Cur_Scale || 100;
    const amountBYN = Math.round((args.amountRUB / scale) * rate * 100) / 100;

    // 3. Create bePaid checkout
    const shopId = process.env.BEPAID_SHOP_ID;
    const secretKey = process.env.BEPAID_SECRET_KEY;
    const isTestMode = process.env.BEPAID_TEST_MODE === "true";
    const siteUrl = process.env.CONVEX_SITE_URL;

    if (!shopId || !secretKey) return { error: "bePaid не настроен" };

    const returnUrl = args.returnUrl || "https://aipilot.by/pricing";
    const tierInfo = TIERS[args.tier];
    const orderId = `order_${user._id}_${args.tier}_${Date.now()}`;

    const checkoutRequest = {
      checkout: {
        test: isTestMode,
        transaction_type: "payment",
        attempts: 3,
        settings: {
          success_url: `${returnUrl}?status=success&tier=${args.tier}`,
          fail_url: `${returnUrl}?status=failed`,
          notification_url: siteUrl ? `${siteUrl}/api/bepaid-webhook` : undefined,
          language: "ru",
        },
        order: {
          amount: Math.round(amountBYN * 100),
          currency: "BYN",
          description: `AddPilot ${tierInfo.name} (${args.amountRUB} ₽)`,
          tracking_id: orderId,
        },
        customer: {
          email: user.email,
        },
      },
    };

    const response = await fetch(BEPAID_CHECKOUT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-Version": "2",
        "Authorization": `Basic ${btoa(`${shopId}:${secretKey}`)}`,
      },
      body: JSON.stringify(checkoutRequest),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (!response.ok || data.errors) {
      console.error("bePaid checkout error:", data);
      return { error: data.message || data.errors?.[0]?.message || "Ошибка bePaid" };
    }

    // Save pending payment
    await ctx.runMutation(internal.billing.savePendingPayment, {
      userId: user._id,
      tier: args.tier,
      orderId,
      token: data.checkout.token,
      amount: amountBYN,
      currency: "BYN",
    });

    const redirectUrl = data.checkout.redirect_url as string;
    console.log(`[billing] One-time checkout created: ${args.email}, ${args.tier}, ${args.amountRUB} RUB = ${amountBYN} BYN, URL: ${redirectUrl}`);

    return { redirectUrl, amountBYN };
  },
});

// Internal helper: get user by email (for createOneTimeCheckout)
export const getUserByEmailInternal = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
  },
});

// ─── Cleanup stuck pending payments ───
// Marks payments stuck in "pending" for >4 hours as "failed".
// bePaid webhook should arrive within minutes; 4h means it never will.

const STUCK_PAYMENT_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

export const cleanupStuckPayments = internalMutation({
  args: {},
  handler: async (ctx) => {
    const payments = await ctx.db.query("payments").collect();
    const now = Date.now();
    let cleaned = 0;

    for (const p of payments) {
      if (
        p.status === "pending" &&
        p.createdAt &&
        now - p.createdAt > STUCK_PAYMENT_THRESHOLD_MS
      ) {
        await ctx.db.patch(p._id, {
          status: "failed",
          errorMessage: "Webhook от bePaid не получен (таймаут 4ч)",
          completedAt: now,
        });
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[cleanupStuckPayments] Marked ${cleaned} stuck payments as failed`);
    }
  },
});
