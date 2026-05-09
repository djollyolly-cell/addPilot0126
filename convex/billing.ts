import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Tier limits and pricing
export const TIERS = {
  freemium: {
    name: "Freemium",
    price: 0,
    accountsLimit: 1,
    rulesLimit: 3,
    includedLoadUnits: 0,
    overagePrice: 0,
    maxManagers: 0,
    maxNiches: 0,
    features: ["1 рекламный кабинет", "3 правила автоматизации", "Telegram-уведомления"],
  },
  start: {
    name: "Start",
    price: 1290,
    accountsLimit: 3,
    rulesLimit: 10,
    includedLoadUnits: 0,
    overagePrice: 0,
    maxManagers: 0,
    maxNiches: 0,
    features: ["3 рекламных кабинета", "10 правил автоматизации", "Telegram-уведомления", "Базовая аналитика"],
  },
  pro: {
    name: "Pro",
    price: 2990,
    accountsLimit: 9, // grandfathered users get 27 via proAccountLimit field
    rulesLimit: -1, // unlimited
    includedLoadUnits: 0,
    overagePrice: 0,
    maxManagers: 0,
    maxNiches: 0,
    features: ["До 9 кабинетов", "Неограниченные правила", "Приоритетная поддержка", "Расширенная аналитика"],
  },
  // Agency tiers — load-units based
  // Agency tiers (spec §3.2-3.4)
  agency_s: {
    name: "Agency S",
    price: 14900,
    accountsLimit: -1,
    rulesLimit: -1,
    includedLoadUnits: 30,
    overagePrice: 600,
    maxManagers: 3,
    maxNiches: 3,
    features: ["От 10 кабинетов", "Конструктор правил (L2)", "До 3 менеджеров", "До 3 ниш", "Приоритетная поддержка", "Мониторинг здоровья аккаунтов", "Месячный отчёт по нагрузке"],
  },
  agency_m: {
    name: "Agency M",
    price: 24900,
    accountsLimit: -1,
    rulesLimit: -1,
    includedLoadUnits: 60,
    overagePrice: 500,
    maxManagers: 10,
    maxNiches: 6,
    features: ["От 20 кабинетов", "Конструктор правил (L2)", "До 10 менеджеров", "До 6 ниш", "Приоритетная поддержка", "Мониторинг здоровья аккаунтов", "Месячный отчёт по нагрузке"],
  },
  agency_l: {
    name: "Agency L",
    price: 39900,
    accountsLimit: -1,
    rulesLimit: -1,
    includedLoadUnits: 120,
    overagePrice: 400,
    maxManagers: 30,
    maxNiches: -1,
    features: ["От 40 кабинетов", "Конструктор правил (L2)", "До 30 менеджеров", "Все ниши", "Приоритетная поддержка", "Мониторинг здоровья аккаунтов", "Месячный отчёт по нагрузке", "Выделенный IP", "Кастомные типы правил (L3)", "SLA на синхронизацию"],
  },
  // Agency XL — individual pricing, no fixed price. Used only for schema/type completeness.
  agency_xl: {
    name: "Agency XL",
    price: 0,
    accountsLimit: -1,
    rulesLimit: -1,
    includedLoadUnits: 200,
    overagePrice: 0,
    maxManagers: -1,
    maxNiches: -1,
    features: ["От 50 кабинетов", "Всё из Agency L", "Персональный менеджер", "Индивидуальная цена"],
  },
} as const;

export type SubscriptionTier = keyof typeof TIERS;
export type AgencyTier = "agency_s" | "agency_m" | "agency_l" | "agency_xl";
export type IndividualTier = "freemium" | "start" | "pro";

export const isAgencyTier = (tier: string): tier is AgencyTier =>
  tier === "agency_s" || tier === "agency_m" || tier === "agency_l" || tier === "agency_xl";

// Old prices before 2026-04-04 increase
const OLD_PRICES = { start: 990, pro: 2490 } as const;

/** Round timestamp to end of day (23:59:59.999) in a given IANA timezone */
function endOfDayInTz(ts: number, timezone: string): number {
  // Get the date string in the user's timezone
  const dateStr = new Date(ts).toLocaleDateString("en-CA", { timeZone: timezone }); // "YYYY-MM-DD"
  // Build 23:59:59.999 in that timezone by finding the UTC offset
  // Create a date at start of that day in UTC, then adjust
  const [y, m, d] = dateStr.split("-").map(Number);
  // Use a known time in the target timezone to find the offset
  const probe = new Date(ts);
  const utcStr = probe.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = probe.toLocaleString("en-US", { timeZone: timezone });
  const offsetMs = new Date(utcStr).getTime() - new Date(tzStr).getTime();
  // End of day in timezone = YYYY-MM-DD 23:59:59.999 local → UTC
  const endOfDayLocal = new Date(y, m - 1, d, 23, 59, 59, 999);
  return endOfDayLocal.getTime() + offsetMs;
}

// Get user's effective prices (respects grandfathered/locked pricing)
export const getUserPrices = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);

    const basePrices = {
      start: TIERS.start.price,
      pro: TIERS.pro.price,
      agency_s: TIERS.agency_s.price,
      agency_m: TIERS.agency_m.price,
      agency_l: TIERS.agency_l.price,
      agency_xl: TIERS.agency_xl.price,
    };

    if (!user) return basePrices;

    // lockedPrices applies only to individual tiers (start/pro)
    // Grace: valid until end of day in user's timezone
    const settings = await ctx.db.query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    const tz = settings?.timezone || "Europe/Moscow";
    const locked = user.lockedPrices;
    if (locked && endOfDayInTz(locked.until, tz) >= Date.now()) {
      return {
        ...basePrices,
        start: locked.start,
        pro: locked.pro,
      };
    }
    return basePrices;
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

const TIER_ORDER: Record<string, number> = {
  freemium: 0, start: 1, pro: 2,
  agency_s: 3, agency_m: 4, agency_l: 5, agency_xl: 6,
};

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

/**
 * Решение 2: hybrid prorated formula.
 * Primary: existing calculateUpgradePrice (uses lastPayment).
 * Fallback: catalog price / 30 × remainingDays (when no payment history).
 *
 * Use case for fallback:
 * - Grandfathered Pro users (no payment record)
 * - Admin-granted tiers via admin.updateUserTier
 * - Test orgs without prior subscription
 */
export function calculateUpgradePriceWithFallback(input: UpgradePriceInput): UpgradePriceResult {
  const primary = calculateUpgradePrice(input);
  if (primary.isUpgrade) return primary;

  const { currentTier, newTier, subscriptionExpiresAt, now } = input;

  if (currentTier === "freemium" || !subscriptionExpiresAt || subscriptionExpiresAt <= now) {
    return { credit: 0, remainingDays: 0, isUpgrade: false };
  }
  if ((TIER_ORDER[newTier] ?? 0) <= (TIER_ORDER[currentTier] ?? 0)) {
    return { credit: 0, remainingDays: 0, isUpgrade: false };
  }

  const catalogPrice = (TIERS as Record<string, { price: number }>)[currentTier]?.price;
  if (!catalogPrice || catalogPrice <= 0) {
    return { credit: 0, remainingDays: 0, isUpgrade: false };
  }

  const remainingDays = Math.ceil((subscriptionExpiresAt - now) / (24 * 60 * 60 * 1000));
  const credit = Math.round((remainingDays / 30) * catalogPrice * 100) / 100;

  return { credit, remainingDays, isUpgrade: true, currency: "RUB" };
}

// ═══════════════════════════════════════════════════════════
// Renewal — продление того же тарифа в последние 7 дней
// ═══════════════════════════════════════════════════════════

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RenewalExpiresAtInput {
  /** Текущий subscriptionExpiresAt (может быть в прошлом, если cron не сбросил) */
  currentExpiresAt: number | undefined;
  /** Сколько дней оплачивается (30 + bonusDays) */
  totalDays: number;
  /** Now timestamp (для тестируемости) */
  now: number;
}

/**
 * Pure: расчёт нового expiresAt при продлении.
 *
 * - Активная подписка (currentExpiresAt > now): продлевает с конца срока.
 * - Просроченная-не-сброшенная (currentExpiresAt <= now) или undefined: с now.
 *
 * Гарантирует, что юзер не теряет оплаченный остаток, но не возвращает «просроченные» дни.
 */
export function calculateRenewalExpiresAt(input: RenewalExpiresAtInput): number {
  const { currentExpiresAt, totalDays, now } = input;
  const baseTs = currentExpiresAt && currentExpiresAt > now ? currentExpiresAt : now;
  return baseTs + totalDays * DAY_MS;
}

export interface RenewalEligibleInput {
  currentTier: string;
  paymentTier: string;
  currentExpiresAt: number | undefined;
  now: number;
}

/**
 * Pure: разрешено ли продление?
 *
 * Условия:
 * - currentTier — платный (не freemium).
 * - paymentTier === currentTier (продление того же тарифа).
 * - currentExpiresAt задан.
 * - currentExpiresAt - now <= 7 дней (включая отрицательные значения — истёкшая,
 *   но не сброшенная подписка).
 */
export function isRenewalEligible(input: RenewalEligibleInput): boolean {
  const { currentTier, paymentTier, currentExpiresAt, now } = input;
  if (currentTier === "freemium") return false;
  if (currentTier !== paymentTier) return false;
  if (typeof currentExpiresAt !== "number") return false;
  return currentExpiresAt - now <= SEVEN_DAYS_MS;
}

/** Query: get upgrade credit for prorated pricing (with fallback) */
export const getUpgradePrice = query({
  args: {
    userId: v.id("users"),
    newTier: v.union(
      v.literal("start"),
      v.literal("pro"),
      v.literal("agency_s"),
      v.literal("agency_m"),
      v.literal("agency_l"),
      v.literal("agency_xl")
    ),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { credit: 0, remainingDays: 0, isUpgrade: false };

    const currentTier = (user.subscriptionTier as string) ?? "freemium";

    const payments = await ctx.db
      .query("payments")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();

    // Filter lastPayment by tier category to prevent cross-contamination
    // when owner has both individual and agency payment history
    const targetIsAgency = isAgencyTier(args.newTier);
    const lastPayment = payments.find((p) =>
      p.status === "completed" && isAgencyTier(p.tier) === targetIsAgency
    );

    return calculateUpgradePriceWithFallback({
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

/**
 * Query: можно ли продлить тариф `tier` для юзера userId, и если да — детали.
 *
 * Возвращает:
 *  - eligible: можно ли продлить
 *  - daysLeft: сколько дней до конца текущей подписки (может быть отрицательным
 *    для истёкшей-но-не-сброшенной)
 *  - currentExpiresAt: текущий expiresAt (для отрисовки «с DD.MM до DD.MM»)
 *  - newExpiresAt: каким станет expiresAt после оплаты 30 дней (без бонусов)
 */
export const getRenewalEligibility = query({
  args: {
    userId: v.id("users"),
    tier: v.union(v.literal("start"), v.literal("pro")),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return { eligible: false, daysLeft: 0, currentExpiresAt: null, newExpiresAt: null };
    }

    const currentTier = user.subscriptionTier ?? "freemium";
    const currentExpiresAt = user.subscriptionExpiresAt;
    const now = Date.now();

    const eligible = isRenewalEligible({
      currentTier,
      paymentTier: args.tier,
      currentExpiresAt,
      now,
    });

    const daysLeft = currentExpiresAt
      ? Math.ceil((currentExpiresAt - now) / (24 * 60 * 60 * 1000))
      : 0;

    const newExpiresAt = eligible
      ? calculateRenewalExpiresAt({ currentExpiresAt, totalDays: 30, now })
      : null;

    return {
      eligible,
      daysLeft,
      currentExpiresAt: currentExpiresAt ?? null,
      newExpiresAt,
    };
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
    tier: v.union(
      v.literal("start"), v.literal("pro"),
      v.literal("agency_s"), v.literal("agency_m"),
      v.literal("agency_l"), v.literal("agency_xl")
    ),
    promoCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
    returnUrl: v.string(),
    amountBYN: v.number(),
    isUpgrade: v.optional(v.boolean()),
    creditAmount: v.optional(v.number()),
    /** For agency tiers: which org will be upgraded */
    orgId: v.optional(v.id("organizations")),
    /** For agency new-org: name + niches (creates pending org) */
    pendingOrgName: v.optional(v.string()),
    pendingOrgNiches: v.optional(v.array(v.object({
      niche: v.string(),
      cabinetsCount: v.number(),
    }))),
  },
  handler: async (ctx, args): Promise<BepaidCheckoutResult> => {
    // Mutual exclusion: promo code and referral code cannot be used together
    if (args.promoCode && args.referralCode) {
      throw new Error("Нельзя использовать промокод и реферальный код одновременно");
    }

    // Validate agency args
    const isAgency = isAgencyTier(args.tier);
    if (isAgency && !args.orgId && !args.pendingOrgName) {
      throw new Error("agency-тариф требует orgId или pendingOrgName");
    }
    if (isAgency && args.orgId && args.pendingOrgName) {
      throw new Error("orgId и pendingOrgName взаимоисключаются");
    }

    const shopId = process.env.BEPAID_SHOP_ID;
    const secretKey = process.env.BEPAID_SECRET_KEY;
    const isTestMode = process.env.BEPAID_TEST_MODE === "true";
    const siteUrl = process.env.CONVEX_SITE_URL;

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

    // ─────────────────────────────────────────────────────────────
    // Renewal guard: same-tier purchase only allowed in 7-day window
    // ─────────────────────────────────────────────────────────────
    if (!isAgency && user.subscriptionTier === args.tier) {
      const eligible = isRenewalEligible({
        currentTier: user.subscriptionTier,
        paymentTier: args.tier,
        currentExpiresAt: user.subscriptionExpiresAt,
        now: Date.now(),
      });
      if (!eligible) {
        throw new Error(
          "Продление того же тарифа доступно только в последние 7 дней подписки"
        );
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Server-side price sanity bound (guards against client manipulation)
    //
    // Bound applies to ALL non-agency purchases — including upgrades.
    // For upgrades we shrink the minimum by the SERVER-COMPUTED upgrade
    // credit (normalized to BYN), because legitimate upgrade payment can be
    // small. Without this, an active Start user upgrading to Pro could
    // bypass the bound entirely with amountBYN: 1.
    //
    // Source of truth for both isUpgrade and credit: getUpgradePrice query
    // (calls calculateUpgradePriceWithFallback). Avoids duplicating the
    // currentTier/newTier/expiresAt rules inline.
    //
    // Limitation: lower-bound is a heuristic. Exact server-side validation
    // would require cached NBRB rate + server recompute. Future work.
    //
    // Formula: minBYN = tierRUB * 0.0175 (≈ 50% of typical 3.5/100 rate),
    // shrunk by serverComputedCreditBYN for upgrades, floored at 1 BYN.
    // For Pro 2990 RUB → minBYN ≈ 52 BYN (typical actual ~105 BYN @ rate 3.5).
    // For Start 1290 RUB → minBYN ≈ 23 BYN (typical actual ~46 BYN @ rate 3.5).
    //
    // ⚠ DO NOT trust args.isUpgrade or args.creditAmount — both come from
    // client. Use getUpgradePrice result instead. Credit may be returned in
    // RUB (fallback path) — normalize to BYN before subtracting.
    // ─────────────────────────────────────────────────────────────
    if (!isAgency) {
      const serverUpgradeInfo = await ctx.runQuery(api.billing.getUpgradePrice, {
        userId: args.userId,
        newTier: args.tier,
      });
      const serverIsUpgrade = serverUpgradeInfo.isUpgrade;

      // Normalize credit to BYN — calculateUpgradePriceWithFallback can return RUB
      // (fallback path: no payment history → uses catalog RUB price for proration).
      // Conservative conversion at 0.0175 (same heuristic as minTierBYN), so credit
      // is rounded DOWN — minAcceptable stays defensively higher.
      const serverComputedCreditBYN =
        !serverIsUpgrade
          ? 0
          : serverUpgradeInfo.currency === "BYN"
            ? serverUpgradeInfo.credit
            : serverUpgradeInfo.currency === "RUB"
              ? serverUpgradeInfo.credit * 0.0175
              : 0;

      const tierRUB = (TIERS as Record<string, { price: number }>)[args.tier]?.price ?? 0;
      if (tierRUB > 0) {
        const minTierBYN = tierRUB * 0.0175;
        const minAcceptableBYN = serverIsUpgrade
          ? Math.max(1, minTierBYN - serverComputedCreditBYN)
          : minTierBYN;

        if (args.amountBYN < minAcceptableBYN) {
          await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
            category: "payments",
            dedupKey: `checkout-amount-suspicious:${args.userId}:${args.tier}`,
            text: `🚨 <b>Подозрительная сумма checkout</b>\n\nUser: ${args.userId}\nTier: ${args.tier}\nПрислано: ${args.amountBYN} BYN\nМинимум: ${minAcceptableBYN.toFixed(2)} BYN${serverIsUpgrade ? `\nUpgrade credit: ${serverComputedCreditBYN.toFixed(2)} BYN (${serverUpgradeInfo.currency})` : ""}`,
          });
          throw new Error(
            `Сумма платежа ниже допустимого минимума для тарифа ${args.tier}`
          );
        }
      }
    }

    // For new agency: create pending org (idempotent)
    let resolvedOrgId = args.orgId;
    if (isAgency && !resolvedOrgId && args.pendingOrgName) {
      resolvedOrgId = await ctx.runMutation(internal.organizations.createPending, {
        name: args.pendingOrgName,
        ownerId: args.userId,
        subscriptionTier: args.tier as AgencyTier,
        maxLoadUnits: TIERS[args.tier].includedLoadUnits,
        nichesConfig: args.pendingOrgNiches,
      });
    }

    // Calculate referral discount (fallback to pendingReferralCode from user record)
    const effectiveReferralCode = args.referralCode || (user as Record<string, unknown>).pendingReferralCode as string | undefined;
    let referralDiscount = 0;
    if (effectiveReferralCode) {
      const referrer = await ctx.runQuery(internal.referrals.findReferrerByCode, {
        code: effectiveReferralCode.toUpperCase(),
      });
      if (referrer && referrer.referralType === "discount") {
        referralDiscount = referrer.referralDiscount ?? 10;
      }
    } else if (!args.promoCode && (user as Record<string, unknown>).referralMilestone10Reached) {
      referralDiscount = 15;
    }

    const tierInfo = TIERS[args.tier];
    const discountedBYN = referralDiscount > 0
      ? Math.round(args.amountBYN * (100 - referralDiscount) / 100 * 100) / 100
      : args.amountBYN;
    const amountInCents = Math.round(discountedBYN * 100);

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
        referralCode: effectiveReferralCode?.toUpperCase(),
        referralDiscount: referralDiscount > 0 ? referralDiscount : undefined,
        isUpgrade: args.isUpgrade,
        creditAmount: args.creditAmount,
        orgId: resolvedOrgId,
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
    tier: v.union(
      v.literal("start"), v.literal("pro"),
      v.literal("agency_s"), v.literal("agency_m"),
      v.literal("agency_l"), v.literal("agency_xl")
    ),
    orderId: v.string(),
    token: v.string(),
    amount: v.number(),
    currency: v.string(),
    promoCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
    referralDiscount: v.optional(v.number()),
    isUpgrade: v.optional(v.boolean()),
    creditAmount: v.optional(v.number()),
    orgId: v.optional(v.id("organizations")),
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
      orgId: args.orgId,
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
      await ctx.scheduler.runAfter(0, internal.systemLogger.log, {
        level: "warn",
        source: "billing",
        message: `Webhook: payment not found for trackingId=${args.trackingId}`,
      });
      return { success: false, error: "Payment not found" };
    }

    if (args.status === "successful") {
      // Idempotency: bePaid retries on transient failures. Don't re-activate
      // a subscription, re-apply promo, re-trigger referral bonus on duplicate.
      if (payment.status === "completed") {
        console.log(`bePaid webhook: ${args.trackingId} already completed, ignoring duplicate`);
        return { success: true, alreadyProcessed: true };
      }

      // Amount sanity check: args.amount is already in BYN (converted in http.ts:98).
      // Defense-in-depth alongside bePaid HMAC: rejects mismatches that bypass signing.
      // Note: this catches webhook tampering, not client-side price manipulation at
      // checkout creation — that's enforced separately in createBepaidCheckout.
      if (Math.abs(args.amount - payment.amount) > 0.01) {
        console.error(
          `bePaid webhook: amount mismatch for ${args.trackingId} — ` +
          `expected ${payment.amount} BYN, got ${args.amount} BYN`
        );
        await ctx.scheduler.runAfter(0, internal.systemLogger.log, {
          userId: payment.userId,
          level: "error",
          source: "billing",
          message: `Webhook amount mismatch: ${args.trackingId} expected=${payment.amount} got=${args.amount}`,
        });
        await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
          category: "payments",
          dedupKey: `payment-amount-mismatch:${args.trackingId}`,
          text: `🚨 <b>Webhook amount mismatch</b>\n\nTrackingId: ${args.trackingId}\nExpected: ${payment.amount} BYN\nGot: ${args.amount} BYN`,
        });
        await ctx.db.patch(payment._id, {
          status: "failed",
          errorMessage: `amount_mismatch: expected ${payment.amount}, got ${args.amount}`,
          completedAt: Date.now(),
        });
        return { success: false, error: "amount_mismatch" };
      }

      const isAgencyPayment = isAgencyTier(payment.tier);

      // Check promo code bonus days (individual tiers only)
      let bonusDays = 0;
      if (payment.promoCode && !isAgencyPayment) {
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
      // For agency: promo discount already applied during checkout, no bonus days

      // Referral bonus — works for both individual and agency
      if (payment.referralCode) {
        const bonusResult = await ctx.runMutation(internal.referrals.applyReferralBonus, {
          referralCode: payment.referralCode,
          referredUserId: payment.userId,
          paymentId: payment._id,
          paymentTier: payment.tier,
        });

        if (bonusResult) {
          await ctx.scheduler.runAfter(0, internal.telegram.sendReferralNotification, {
            referrerId: bonusResult.referrerId,
            bonusDays: bonusResult.bonusDays,
            totalReferrals: bonusResult.newCount,
            milestone3: bonusResult.milestone3,
            milestone10: bonusResult.milestone10,
          });
        }
      }

      // Activate subscription (30 days + bonus). For same-tier renewal of an
      // active individual subscription within the 7d window, extend from
      // current expiresAt. Otherwise fresh: extend from now.
      //
      // ⚠ DO NOT shortcut to subscriber.subscriptionTier === payment.tier —
      // a legacy/internal pending payment outside the 7d window must NOT
      // get period-extension treatment. Use the same isRenewalEligible
      // gate as createBepaidCheckout for defense-in-depth.
      const totalDays = 30 + bonusDays;
      const renewalNow = Date.now();

      let isRenewal = false;
      let renewalCurrentExpiresAt: number | undefined;
      if (!payment.orgId) {
        const subscriber = await ctx.db.get(payment.userId);
        if (subscriber) {
          const eligible = isRenewalEligible({
            currentTier: subscriber.subscriptionTier ?? "freemium",
            paymentTier: payment.tier,
            currentExpiresAt: subscriber.subscriptionExpiresAt,
            now: renewalNow,
          });
          if (eligible) {
            isRenewal = true;
            renewalCurrentExpiresAt = subscriber.subscriptionExpiresAt;
          }
        }
      }

      const expiresAt = isRenewal
        ? calculateRenewalExpiresAt({
            currentExpiresAt: renewalCurrentExpiresAt,
            totalDays,
            now: renewalNow,
          })
        : renewalNow + totalDays * 24 * 60 * 60 * 1000;

      // Update payment status (after isRenewal is known so we can record it)
      await ctx.db.patch(payment._id, {
        status: "completed",
        bepaidUid: args.uid,
        bonusDays: bonusDays > 0 ? bonusDays : undefined,
        completedAt: Date.now(),
        isRenewal: isRenewal || undefined,
      });

      if (payment.orgId) {
        // Agency: update organizations record, not users
        await ctx.runMutation(internal.organizations.updateSubscriptionFromPayment, {
          orgId: payment.orgId,
          tier: payment.tier as AgencyTier,
          expiresAt,
        });
      } else {
        // Individual: existing logic — patch users
        const paidUser = await ctx.db.get(payment.userId);
        const lockedUpdate: Record<string, unknown> = {};
        if (paidUser?.lockedPrices) {
          // Grace period: locked prices valid until end of day in user's timezone
          const userSettings = await ctx.db.query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", payment.userId))
            .first();
          const userTz = userSettings?.timezone || "Europe/Moscow";
          const lockedUntilEOD = endOfDayInTz(paidUser.lockedPrices.until, userTz);
          const isStillActive = lockedUntilEOD >= Date.now();
          if (isStillActive) {
            lockedUpdate.lockedPrices = {
              ...paidUser.lockedPrices,
              until: endOfDayInTz(expiresAt, userTz),
            };
          }
        }

        const proLimitPatch: Record<string, unknown> = {};
        if (payment.tier === "pro" && !paidUser?.proAccountLimit) {
          proLimitPatch.proAccountLimit = 9;
        }

        await ctx.db.patch(payment.userId, {
          subscriptionTier: payment.tier as "start" | "pro",
          subscriptionExpiresAt: expiresAt,
          updatedAt: Date.now(),
          ...lockedUpdate,
          ...proLimitPatch,
        });

        // Auto-reactivation: вернуть paused-кабинеты и billing-disabled rules.
        // Идемпотентно — webhook retry безопасен. Вызываем helper напрямую
        // (Convex запрещает mutation→mutation через runMutation).
        await applyUpgradeReactivation(
          ctx,
          payment.userId,
          payment.tier as UpgradeTier
        );
      }

      console.log(`bePaid: Subscription ${payment.tier} activated for user ${payment.userId} (${totalDays} days, promo: ${payment.promoCode || "none"}, orgId: ${payment.orgId || "none"})`);

      // Audit log: payment completed
      try { await ctx.runMutation(internal.auditLog.log, {
        userId: payment.userId,
        category: "payment",
        action: "payment_completed",
        status: "success",
        details: {
          tier: payment.tier,
          amount: args.amount,
          promoCode: payment.promoCode,
          orgId: payment.orgId,
          isRenewal: isRenewal || undefined,
        },
      }); } catch { /* non-critical */ }
      // Admin alert: payment
      const alertUser = await ctx.db.get(payment.userId);
      const alertUserName = alertUser?.name || alertUser?.email || "—";
      try { await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
        category: "payments",
        text: `💰 <b>Оплата</b>\n\nПользователь: ${alertUserName}\nТариф: ${payment.tier}\nСумма: ${args.amount} ${args.currency}${payment.orgId ? "\nОрганизация: " + payment.orgId : ""}`,
      }); } catch { /* non-critical */ }

      return { success: true };
    }

    if (args.status === "failed" || args.status === "declined") {
      await ctx.db.patch(payment._id, {
        status: "failed",
        errorMessage: args.message,
        completedAt: Date.now(),
      });

      console.log(`bePaid: Payment failed for ${args.trackingId}: ${args.message}`);
      try { await ctx.scheduler.runAfter(0, internal.systemLogger.log, {
        userId: payment.userId,
        level: "warn",
        source: "billing",
        message: `Payment ${args.status}: ${args.trackingId} — ${(args.message ?? "no message").slice(0, 150)}`,
      }); } catch { /* non-critical */ }

      // Audit log: payment failed
      try { await ctx.runMutation(internal.auditLog.log, {
        userId: payment.userId,
        category: "payment",
        action: "payment_failed",
        status: "failed",
        details: { status: args.status, message: args.message },
      }); } catch { /* non-critical */ }

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

    // Same-tier guard: only allow buying current tier within 7-day renewal window.
    // Mirrors the guard in createBepaidCheckout for consistency in mock flow.
    if (user.subscriptionTier === args.tier) {
      const eligible = isRenewalEligible({
        currentTier: user.subscriptionTier,
        paymentTier: args.tier,
        currentExpiresAt: user.subscriptionExpiresAt,
        now: Date.now(),
      });
      if (!eligible) {
        return {
          success: false,
          error: "Продление того же тарифа доступно только в последние 7 дней подписки",
        };
      }
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

    // Calculate expiration (30 days + bonus). For same-tier renewal,
    // extend from currentExpiresAt; otherwise from now.
    //
    // Use isRenewalEligible (not raw tier comparison) for defense-in-depth:
    // if the same-tier guard above is ever refactored away, this still won't
    // grant period-extension to ineligible payments.
    const totalDays = 30 + bonusDays;
    const renewalNow = Date.now();
    const isRenewal = isRenewalEligible({
      currentTier: user.subscriptionTier ?? "freemium",
      paymentTier: args.tier,
      currentExpiresAt: user.subscriptionExpiresAt,
      now: renewalNow,
    });
    const expiresAt = isRenewal
      ? calculateRenewalExpiresAt({
          currentExpiresAt: user.subscriptionExpiresAt,
          totalDays,
          now: renewalNow,
        })
      : renewalNow + totalDays * 24 * 60 * 60 * 1000;

    // Extend lockedPrices if subscription is continuous
    const lockedUpdate: Record<string, unknown> = {};
    if (user.lockedPrices) {
      // Grace period: locked prices valid until end of day in user's timezone
      const mockSettings = await ctx.db.query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();
      const mockTz = mockSettings?.timezone || "Europe/Moscow";
      const lockedUntilEOD = endOfDayInTz(user.lockedPrices.until, mockTz);
      const isStillActive = lockedUntilEOD >= Date.now();
      if (isStillActive) {
        lockedUpdate.lockedPrices = {
          ...user.lockedPrices,
          until: endOfDayInTz(expiresAt, mockTz),
        };
      }
    }

    // Set proAccountLimit for new Pro subscribers (keep existing if re-subscribing)
    const proLimitPatch: Record<string, unknown> = {};
    if (args.tier === "pro" && !user.proAccountLimit) {
      proLimitPatch.proAccountLimit = 9;
    }

    // Update user subscription
    await ctx.db.patch(args.userId, {
      subscriptionTier: args.tier,
      subscriptionExpiresAt: expiresAt,
      updatedAt: Date.now(),
      ...lockedUpdate,
      ...proLimitPatch,
    });

    // Auto-reactivation: симметрично bePaid webhook flow. Без этого вызова mock payment
    // в dev/test проходит без восстановления paused-кабинетов и billing-disabled rules.
    await applyUpgradeReactivation(ctx, args.userId, args.tier);

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
    // Skip downgrade for org-members — they have separate grace policies (Решение 4)
    const user = await ctx.db.get(args.userId);
    if (!user) return { accountsDeactivated: 0, rulesDeactivated: 0 };
    if (user.organizationId) {
      return {
        accountsDeactivated: 0,
        rulesDeactivated: 0,
        skipped: "user is in organization, downgrade not applied",
      };
    }

    // For Pro tier, use user's personal limit; for others, use TIERS constant
    let newLimit: number;
    if (args.newTier === "pro") {
      newLimit = user.proAccountLimit ?? TIERS.pro.accountsLimit;
    } else {
      newLimit = TIERS[args.newTier].accountsLimit;
    }

    // Get user's active accounts sorted by createdAt (oldest first to keep)
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const activeAccounts = accounts
      .filter((a) => a.status === "active" || a.status === "abandoned")
      .sort((a, b) => a.createdAt - b.createdAt);

    // Deactivate excess accounts (keep oldest ones active)
    const accountsToDeactivate = newLimit < 0 ? [] : activeAccounts.slice(newLimit);
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
      const isRotation = rule.type === "video_rotation";
      // video_rotation НЕ маркируется (риск автозапуска ротации с устаревшими креативами при upgrade —
      // см. спек §2). Reactive-правила получают marker для последующей auto-reactivation.
      await ctx.db.patch(rule._id, {
        isActive: false,
        updatedAt: Date.now(),
        ...(isRotation ? {} : { disabledByBillingAt: Date.now() }),
      });
      // Останавливаем фоновый процесс ротации для video_rotation. Без этого rotationState
      // продолжает крутиться до health-check'а — pre-existing bug, попутно чиним.
      if (isRotation) {
        await ctx.scheduler.runAfter(0, internal.videoRotation.deactivate, { ruleId: rule._id });
      }
      deactivatedRuleIds.push(rule._id);
    }

    return {
      accountsDeactivated: deactivatedIds.length,
      rulesDeactivated: deactivatedRuleIds.length,
    };
  },
});

// Helper: реализация upgrade-восстановления. Вызывается:
//  - напрямую из processPayment / handleBepaidWebhook (mutations, нельзя runMutation→mutation)
//  - через тонкую обёртку updateLimitsOnUpgrade (для тестов и внешних callers через runMutation из action)
// Convex запрещает mutation→mutation через ctx.runMutation, поэтому общий код вынесен сюда.

type UpgradeTier = "freemium" | "start" | "pro";

async function applyUpgradeReactivation(
  ctx: MutationCtx,
  userId: Id<"users">,
  newTier: UpgradeTier
): Promise<{ accountsActivated: number; rulesReactivated: number; skipped?: string }> {
  // Skip org-members симметрично downgrade — у них своя grace policy
  const user = await ctx.db.get(userId);
  if (!user) return { accountsActivated: 0, rulesReactivated: 0 };
  if (user.organizationId) {
    return {
      accountsActivated: 0,
      rulesReactivated: 0,
      skipped: "user is in organization, upgrade flow N/A",
    };
  }

  // Compute new account limit
  const newAccountLimit =
    newTier === "pro"
      ? user.proAccountLimit ?? TIERS.pro.accountsLimit
      : TIERS[newTier].accountsLimit;

  // Reactivate paused accounts up to limit (oldest first by createdAt)
  const accounts = await ctx.db
    .query("adAccounts")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  const activeCount = accounts.filter(
    (a) => a.status === "active" || a.status === "abandoned"
  ).length;
  const pausedAccounts = accounts
    .filter((a) => a.status === "paused")
    .sort((a, b) => a.createdAt - b.createdAt);

  const slotsAvailable =
    newAccountLimit < 0
      ? pausedAccounts.length
      : Math.max(0, newAccountLimit - activeCount);
  const accountsToActivate = pausedAccounts.slice(0, slotsAvailable);

  let reactivatedAt: number | null = null;
  for (const account of accountsToActivate) {
    await ctx.db.patch(account._id, { status: "active" });
    reactivatedAt = Date.now();
    // Audit log: вызываем helper напрямую (не через runMutation), потому что
    // mutation→mutation запрещено в Convex. Используем ctx.db.insert.
    try {
      await ctx.db.insert("auditLog", {
        userId,
        category: "account",
        action: "account_activated",
        status: "success",
        details: {
          accountName: account.name,
          vkAccountId: account.vkAccountId,
          source: "auto_reactivation",
        },
        createdAt: Date.now(),
      });
    } catch {
      /* non-critical */
    }
  }

  // Reactivate ONLY billing-disabled reactive rules — never user-disabled,
  // never video_rotation (defensive filter — marker shouldn't exist on rotation,
  // но защищаемся от будущих миграций / ручных patches).
  const newRulesLimit =
    TIERS[newTier].rulesLimit === -1
      ? Infinity
      : TIERS[newTier].rulesLimit;

  const rules = await ctx.db
    .query("rules")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  const activeRulesCount = rules.filter((r) => r.isActive).length;
  const billingDisabledRules = rules
    .filter(
      (r) =>
        !r.isActive &&
        r.disabledByBillingAt !== undefined &&
        r.type !== "video_rotation"
    )
    .sort(
      (a, b) =>
        (a.disabledByBillingAt ?? 0) - (b.disabledByBillingAt ?? 0)
    );

  const ruleSlotsAvailable = Math.max(0, newRulesLimit - activeRulesCount);
  const rulesToReactivate = billingDisabledRules.slice(0, ruleSlotsAvailable);

  for (const rule of rulesToReactivate) {
    // Physically remove disabledByBillingAt via replace() — patch({ field: undefined })
    // is no-op in Convex. Без удаления повторный вызов нашёл бы те же правила и
    // продублировал audit log (нарушение идемпотентности).
    // CRITICAL: replace ожидает body БЕЗ системных полей. Destructure обязателен.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, _creationTime, disabledByBillingAt: _drop, ...rest } = rule;
    await ctx.db.replace(rule._id, {
      ...rest,
      isActive: true,
      updatedAt: Date.now(),
    });
    reactivatedAt = Date.now();
    try {
      await ctx.db.insert("auditLog", {
        userId,
        category: "rule",
        action: "rule_reactivated",
        status: "success",
        details: { ruleName: rule.name, source: "auto_reactivation" },
        createdAt: Date.now(),
      });
    } catch {
      /* non-critical */
    }
  }

  // Stamp lastReactivationAt только если что-то реально реактивировано —
  // иначе пустой вызов (webhook retry, no-op upgrade) сбросит окно CTA.
  if (reactivatedAt) {
    await ctx.db.patch(userId, { lastReactivationAt: reactivatedAt });
  }

  return {
    accountsActivated: accountsToActivate.length,
    rulesReactivated: rulesToReactivate.length,
  };
}

// Public-facing wrapper: для вызова из тестов и из actions через runMutation.
// Внутри mutations использовать applyUpgradeReactivation напрямую.
export const updateLimitsOnUpgrade = internalMutation({
  args: {
    userId: v.id("users"),
    newTier: v.union(
      v.literal("freemium"),
      v.literal("start"),
      v.literal("pro")
    ),
  },
  handler: async (ctx, args) => {
    return await applyUpgradeReactivation(ctx, args.userId, args.newTier);
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
      // Skip org-members — Plan 4 (Load Monitoring) handles org expiry separately
      if (user.organizationId) continue;

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

// ─── One-time incident compensation: 2026-05-05 Convex degradation ─────
//
// Goal: add 10 paid days to every subscription that was active on
// 2026-05-05 Europe/Minsk. This is intentionally implemented as
// preview-first + explicit apply with a permanent marker table.

const INCIDENT_COMPENSATION_KEY = "subscription_compensation_2026_05_05_convex_incident";
const INCIDENT_COMPENSATION_CONFIRM = "APPLY_2026_05_05_COMPENSATION";
const INCIDENT_SNAPSHOT_START_MS = Date.parse("2026-05-04T21:00:00.000Z"); // 2026-05-05 00:00 Europe/Minsk
const INCIDENT_SNAPSHOT_END_MS = Date.parse("2026-05-05T20:59:59.999Z"); // 2026-05-05 23:59:59.999 Europe/Minsk
const COMPENSATION_DAY_MS = 24 * 60 * 60 * 1000;

type CompensationTargetType = "user" | "organization";
type CompensationEvidence = "payment_backed" | "state_backed_no_pre_snapshot_payment";
type CompensationCandidate = {
  targetType: CompensationTargetType;
  targetId: string;
  userId?: Id<"users">;
  orgId?: Id<"organizations">;
  ownerId?: Id<"users">;
  label: string;
  email?: string;
  tierAtSnapshot: string;
  tierBefore: string;
  tierAfter: string;
  expiresAtBefore: number;
  expiresAtAfter: number;
  evidence: CompensationEvidence;
  willReactivate: boolean;
};

function isPaidIndividualTier(tier: unknown): tier is "start" | "pro" {
  return tier === "start" || tier === "pro";
}

function isPaidAgencyTier(tier: unknown): tier is AgencyTier {
  return typeof tier === "string" && isAgencyTier(tier);
}

function paymentCompletedAt(payment: { completedAt?: number; createdAt: number }) {
  return payment.completedAt ?? payment.createdAt;
}

function buildMarkerKey(targetType: CompensationTargetType, targetId: string) {
  return `${targetType}:${targetId}`;
}

function summarizeCompensationCandidates(candidates: CompensationCandidate[]) {
  const byTargetType: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const byEvidence: Record<string, number> = {};
  let reactivations = 0;

  for (const c of candidates) {
    byTargetType[c.targetType] = (byTargetType[c.targetType] ?? 0) + 1;
    byTier[c.tierAtSnapshot] = (byTier[c.tierAtSnapshot] ?? 0) + 1;
    byEvidence[c.evidence] = (byEvidence[c.evidence] ?? 0) + 1;
    if (c.willReactivate) reactivations++;
  }

  return { byTargetType, byTier, byEvidence, reactivations };
}

async function buildIncidentCompensationPlan(
  ctx: any,
  input: {
    incidentKey: string;
    daysToAdd: number;
    includeStateBacked: boolean;
  }
) {
  const now = Date.now();
  const extensionMs = input.daysToAdd * COMPENSATION_DAY_MS;
  const [rawUsers, rawOrgs, rawMarkers] = await Promise.all([
    ctx.db.query("users").collect(),
    ctx.db.query("organizations").collect(),
    ctx.db
      .query("subscriptionCompensations")
      .withIndex("by_incident", (q: any) => q.eq("incidentKey", input.incidentKey))
      .collect(),
  ]);
  const users = rawUsers as any[];
  const orgs = rawOrgs as any[];
  const markers = rawMarkers as any[];

  const markerKeys = new Set(
    markers.map((m: any) => buildMarkerKey(m.targetType, m.targetId))
  );

  const candidates: CompensationCandidate[] = [];
  const alreadyApplied: CompensationCandidate[] = [];

  function addCandidate(candidate: CompensationCandidate) {
    if (markerKeys.has(buildMarkerKey(candidate.targetType, candidate.targetId))) {
      alreadyApplied.push(candidate);
    } else {
      candidates.push(candidate);
    }
  }

  for (const user of users) {
    const expiresAtBefore = user.subscriptionExpiresAt;
    if (!expiresAtBefore || expiresAtBefore < INCIDENT_SNAPSHOT_START_MS) continue;

    const userPayments = ((await ctx.db
      .query("payments")
      .withIndex("by_userId", (q: any) => q.eq("userId", user._id))
      .collect()) as any[])
      .filter((p) => p.status === "completed" && !p.orgId)
      .filter((p) => isPaidIndividualTier(p.tier))
      .sort((a, b) => paymentCompletedAt(a) - paymentCompletedAt(b));
    const preSnapshotPayments = userPayments.filter(
      (p) => paymentCompletedAt(p) <= INCIDENT_SNAPSHOT_END_MS
    );
    const postSnapshotPayments = userPayments.filter(
      (p) => paymentCompletedAt(p) > INCIDENT_SNAPSHOT_END_MS
    );
    const latestPreSnapshotPayment = preSnapshotPayments[preSnapshotPayments.length - 1];

    let evidence: CompensationEvidence | undefined;
    let tierAtSnapshot: "start" | "pro" | undefined;
    if (latestPreSnapshotPayment) {
      evidence = "payment_backed";
      tierAtSnapshot = latestPreSnapshotPayment.tier;
    } else if (
      input.includeStateBacked &&
      postSnapshotPayments.length === 0 &&
      user.createdAt <= INCIDENT_SNAPSHOT_END_MS &&
      isPaidIndividualTier(user.subscriptionTier)
    ) {
      evidence = "state_backed_no_pre_snapshot_payment";
      tierAtSnapshot = user.subscriptionTier;
    }

    if (!evidence || !tierAtSnapshot) continue;

    const tierBefore = user.subscriptionTier ?? "freemium";
    const expiresAtAfter = expiresAtBefore + extensionMs;
    const shouldReactivate = tierBefore === "freemium" && expiresAtAfter > now;
    const tierAfter = shouldReactivate ? tierAtSnapshot : tierBefore;

    addCandidate({
      targetType: "user",
      targetId: String(user._id),
      userId: user._id,
      label: user.name ?? user.email,
      email: user.email,
      tierAtSnapshot,
      tierBefore,
      tierAfter,
      expiresAtBefore,
      expiresAtAfter,
      evidence,
      willReactivate: shouldReactivate,
    });
  }

  const usersById = new Map(users.map((u) => [String(u._id), u]));
  for (const org of orgs) {
    const expiresAtBefore = org.subscriptionExpiresAt;
    if (!expiresAtBefore || expiresAtBefore < INCIDENT_SNAPSHOT_START_MS) continue;

    const orgPayments = ((await ctx.db
      .query("payments")
      .withIndex("by_orgId", (q: any) => q.eq("orgId", org._id))
      .collect()) as any[])
      .filter((p) => p.status === "completed")
      .filter((p) => isPaidAgencyTier(p.tier))
      .sort((a, b) => paymentCompletedAt(a) - paymentCompletedAt(b));
    const preSnapshotPayments = orgPayments.filter(
      (p) => paymentCompletedAt(p) <= INCIDENT_SNAPSHOT_END_MS
    );
    const postSnapshotPayments = orgPayments.filter(
      (p) => paymentCompletedAt(p) > INCIDENT_SNAPSHOT_END_MS
    );
    const latestPreSnapshotPayment = preSnapshotPayments[preSnapshotPayments.length - 1];

    let evidence: CompensationEvidence | undefined;
    let tierAtSnapshot: AgencyTier | undefined;
    if (latestPreSnapshotPayment) {
      evidence = "payment_backed";
      tierAtSnapshot = latestPreSnapshotPayment.tier;
    } else if (
      input.includeStateBacked &&
      postSnapshotPayments.length === 0 &&
      org.createdAt <= INCIDENT_SNAPSHOT_END_MS &&
      isPaidAgencyTier(org.subscriptionTier)
    ) {
      evidence = "state_backed_no_pre_snapshot_payment";
      tierAtSnapshot = org.subscriptionTier;
    }

    if (!evidence || !tierAtSnapshot) continue;

    const owner = usersById.get(String(org.ownerId));
    const expiresAtAfter = expiresAtBefore + extensionMs;

    addCandidate({
      targetType: "organization",
      targetId: String(org._id),
      orgId: org._id,
      ownerId: org.ownerId,
      label: org.name,
      email: owner?.email,
      tierAtSnapshot,
      tierBefore: org.subscriptionTier,
      tierAfter: org.subscriptionTier,
      expiresAtBefore,
      expiresAtAfter,
      evidence,
      willReactivate: expiresAtBefore <= now && expiresAtAfter > now,
    });
  }

  return {
    incidentKey: input.incidentKey,
    daysToAdd: input.daysToAdd,
    snapshot: {
      localDate: "2026-05-05 Europe/Minsk",
      startMs: INCIDENT_SNAPSHOT_START_MS,
      endMs: INCIDENT_SNAPSHOT_END_MS,
      startIso: new Date(INCIDENT_SNAPSHOT_START_MS).toISOString(),
      endIso: new Date(INCIDENT_SNAPSHOT_END_MS).toISOString(),
    },
    includeStateBacked: input.includeStateBacked,
    toApply: candidates,
    alreadyApplied,
    summary: {
      toApplyCount: candidates.length,
      alreadyAppliedCount: alreadyApplied.length,
      ...summarizeCompensationCandidates(candidates),
    },
  };
}

export const previewIncidentSubscriptionCompensation = internalQuery({
  args: {
    incidentKey: v.optional(v.string()),
    daysToAdd: v.optional(v.number()),
    includeStateBacked: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const plan = await buildIncidentCompensationPlan(ctx, {
      incidentKey: args.incidentKey ?? INCIDENT_COMPENSATION_KEY,
      daysToAdd: args.daysToAdd ?? 10,
      includeStateBacked: args.includeStateBacked ?? false,
    });
    const limit = args.limit ?? 200;
    const stateBackedOnly = plan.toApply.filter(
      (candidate) => candidate.evidence === "state_backed_no_pre_snapshot_payment"
    );
    return {
      ...plan,
      toApply: plan.toApply.slice(0, limit),
      alreadyApplied: plan.alreadyApplied.slice(0, limit),
      stateBackedOnly: stateBackedOnly.slice(0, limit),
      truncated:
        plan.toApply.length > limit ||
        plan.alreadyApplied.length > limit ||
        stateBackedOnly.length > limit,
    };
  },
});

export const applyIncidentSubscriptionCompensation = internalMutation({
  args: {
    confirm: v.literal(INCIDENT_COMPENSATION_CONFIRM),
    expectedToApplyCount: v.number(),
    maxApplyCount: v.optional(v.number()),
    incidentKey: v.optional(v.string()),
    daysToAdd: v.optional(v.number()),
    includeStateBacked: v.optional(v.boolean()),
    appliedBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const incidentKey = args.incidentKey ?? INCIDENT_COMPENSATION_KEY;
    const daysToAdd = args.daysToAdd ?? 10;
    const plan = await buildIncidentCompensationPlan(ctx, {
      incidentKey,
      daysToAdd,
      includeStateBacked: args.includeStateBacked ?? false,
    });
    const maxApplyCount = args.maxApplyCount ?? 200;

    if (plan.toApply.length !== args.expectedToApplyCount) {
      throw new Error(
        `Compensation target count changed: expected ${args.expectedToApplyCount}, got ${plan.toApply.length}. Re-run preview before apply.`
      );
    }
    if (plan.toApply.length > maxApplyCount) {
      throw new Error(
        `Compensation target count ${plan.toApply.length} exceeds maxApplyCount ${maxApplyCount}. Use a batched plan instead of one mutation.`
      );
    }

    const applied: CompensationCandidate[] = [];
    for (const target of plan.toApply) {
      if (target.targetType === "user" && target.userId) {
        const user = await ctx.db.get(target.userId);
        if (!user) continue;

        const patch: Record<string, unknown> = {
          subscriptionExpiresAt: target.expiresAtAfter,
          updatedAt: now,
        };
        if (target.tierAfter !== target.tierBefore && isPaidIndividualTier(target.tierAfter)) {
          patch.subscriptionTier = target.tierAfter;
        }
        if (
          user.lockedPrices &&
          user.lockedPrices.until >= target.expiresAtBefore - COMPENSATION_DAY_MS
        ) {
          patch.lockedPrices = {
            ...user.lockedPrices,
            until: Math.max(user.lockedPrices.until, target.expiresAtAfter),
          };
        }

        await ctx.db.patch(target.userId, patch);
        if (target.willReactivate && isPaidIndividualTier(target.tierAfter)) {
          await applyUpgradeReactivation(ctx, target.userId, target.tierAfter);
        }
      } else if (target.targetType === "organization" && target.orgId) {
        if (target.willReactivate) {
          const org = await ctx.db.get(target.orgId);
          if (org) {
            const stripFields = new Set([
              "_id",
              "_creationTime",
              "expiredGracePhase",
              "expiredGraceStartedAt",
            ]);
            const clean = Object.fromEntries(
              Object.entries(org).filter(([key]) => !stripFields.has(key))
            );
            await ctx.db.replace(target.orgId, {
              ...clean,
              subscriptionExpiresAt: target.expiresAtAfter,
              updatedAt: now,
            } as never);
          }
        } else {
          await ctx.db.patch(target.orgId, {
            subscriptionExpiresAt: target.expiresAtAfter,
            updatedAt: now,
          });
        }
      }

      const compensationRecord: Record<string, unknown> = {
        incidentKey,
        targetType: target.targetType,
        targetId: target.targetId,
        snapshotStartMs: INCIDENT_SNAPSHOT_START_MS,
        snapshotEndMs: INCIDENT_SNAPSHOT_END_MS,
        daysAdded: daysToAdd,
        tierAtSnapshot: target.tierAtSnapshot,
        tierBefore: target.tierBefore,
        tierAfter: target.tierAfter,
        expiresAtBefore: target.expiresAtBefore,
        expiresAtAfter: target.expiresAtAfter,
        evidence: target.evidence,
        appliedAt: now,
      };
      if (target.userId) compensationRecord.userId = target.userId;
      if (target.orgId) compensationRecord.orgId = target.orgId;
      if (args.appliedBy) compensationRecord.appliedBy = args.appliedBy;
      await ctx.db.insert("subscriptionCompensations", compensationRecord as never);

      const auditUserId = target.userId ?? target.ownerId;
      if (!auditUserId) {
        throw new Error(
          `Compensation target ${target.targetId} has neither userId nor ownerId`
        );
      }

      const auditRecord: Record<string, unknown> = {
        userId: auditUserId,
        category: "payment",
        action: "subscription_incident_compensation",
        status: "success",
        details: {
          incidentKey,
          targetType: target.targetType,
          targetId: target.targetId,
          daysAdded: daysToAdd,
          tierAtSnapshot: target.tierAtSnapshot,
          tierBefore: target.tierBefore,
          tierAfter: target.tierAfter,
          expiresAtBefore: target.expiresAtBefore,
          expiresAtAfter: target.expiresAtAfter,
          evidence: target.evidence,
          willReactivate: target.willReactivate,
        },
        createdAt: now,
      };
      if (target.orgId) auditRecord.orgId = target.orgId;
      await ctx.db.insert("auditLog", auditRecord as never);

      applied.push(target);
    }

    return {
      incidentKey,
      appliedCount: applied.length,
      alreadyAppliedCount: plan.alreadyApplied.length,
      summary: summarizeCompensationCandidates(applied),
      applied,
    };
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
// Checks bePaid API for actual status of pending payments >4h old.
// If bePaid says "successful" → process webhook manually.
// If bePaid says "failed"/"expired"/unknown → mark as failed.

const STUCK_PAYMENT_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
const BEPAID_CHECKOUT_STATUS_URL = "https://checkout.bepaid.by/ctp/api/checkouts";

export const getStuckPendingPayments = internalQuery({
  args: {},
  handler: async (ctx) => {
    const payments = await ctx.db.query("payments").collect();
    const now = Date.now();
    return payments.filter(
      (p) =>
        p.status === "pending" &&
        p.createdAt &&
        now - p.createdAt > STUCK_PAYMENT_THRESHOLD_MS
    );
  },
});

export const markPaymentFailed = internalMutation({
  args: {
    paymentId: v.id("payments"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.paymentId, {
      status: "failed",
      errorMessage: args.errorMessage,
      completedAt: Date.now(),
    });
  },
});

export const cleanupStuckPayments = internalAction({
  args: {},
  handler: async (ctx) => {
    const stuckPayments = await ctx.runQuery(internal.billing.getStuckPendingPayments, {});
    if (stuckPayments.length === 0) return;

    const shopId = process.env.BEPAID_SHOP_ID;
    const secretKey = process.env.BEPAID_SECRET_KEY;
    const hasCredentials = !!(shopId && secretKey);

    let recovered = 0;
    let markedFailed = 0;

    for (const payment of stuckPayments) {
      // Try to check actual status in bePaid
      if (hasCredentials && payment.token) {
        try {
          const resp = await fetch(`${BEPAID_CHECKOUT_STATUS_URL}/${payment.token}`, {
            headers: {
              "Authorization": `Basic ${btoa(`${shopId}:${secretKey}`)}`,
              "Content-Type": "application/json",
            },
          });

          if (resp.ok) {
            const data = await resp.json();
            const txStatus = data?.checkout?.order?.status;
            const txUid = data?.checkout?.order?.uid;

            if (txStatus === "successful" && txUid) {
              // Payment actually succeeded! Process it via webhook handler.
              await ctx.runMutation(internal.billing.handleBepaidWebhook, {
                transactionType: "payment",
                status: "successful",
                trackingId: payment.orderId,
                uid: txUid,
                amount: payment.amount * 100, // webhook expects kopecks
                currency: payment.currency || "BYN",
              });
              recovered++;
              console.log(`[cleanupStuckPayments] RECOVERED payment ${payment.orderId} — was successful in bePaid`);
              continue;
            }
          }
        } catch (err) {
          console.log(`[cleanupStuckPayments] bePaid check failed for ${payment.orderId}: ${err}`);
        }
      }

      // bePaid says not successful or check failed → mark as failed
      await ctx.runMutation(internal.billing.markPaymentFailed, {
        paymentId: payment._id,
        errorMessage: hasCredentials
          ? "Платёж не завершён в bePaid (проверено через API)"
          : "Webhook от bePaid не получен (таймаут 4ч)",
      });
      markedFailed++;
    }

    if (recovered > 0 || markedFailed > 0) {
      console.log(`[cleanupStuckPayments] ${recovered} recovered, ${markedFailed} marked failed`);
    }
  },
});
