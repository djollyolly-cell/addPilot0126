import { v } from "convex/values";
import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];

async function assertAdmin(ctx: any, sessionToken: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", sessionToken))
    .first();
  if (!session || session.expiresAt < Date.now()) {
    throw new Error("Unauthorized: invalid session");
  }
  const user = await ctx.db.get(session.userId);
  if (!user) throw new Error("Forbidden: admin access required");
  if (user.isAdmin !== true && !ADMIN_EMAILS.includes(user.email)) {
    throw new Error("Forbidden: admin access required");
  }
  return user;
}

// ─── Helpers ─────────────────────────────────────────

function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "REF-";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ─── Queries ─────────────────────────────────────────

/** Validate a referral code entered by invited user at payment */
export const validateReferralCode = query({
  args: { code: v.string(), userId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const code = args.code.trim().toUpperCase();
    if (code.length < 4) return { valid: false as const, error: "Код слишком короткий" };

    const referrer = await ctx.db
      .query("users")
      .withIndex("by_referralCode", (q) => q.eq("referralCode", code))
      .first();

    if (!referrer) return { valid: false as const, error: "Код не найден" };
    if (args.userId && referrer._id === args.userId) {
      return { valid: false as const, error: "Нельзя использовать свой код" };
    }

    if (args.userId) {
      const existingReferral = await ctx.db
        .query("referrals")
        .withIndex("by_referredId", (q) => q.eq("referredId", args.userId!))
        .first();
      if (existingReferral) {
        return { valid: false as const, error: "Реферальный код можно использовать только при первой оплате" };
      }

      const payment = await ctx.db
        .query("payments")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId!))
        .filter((q) => q.eq(q.field("status"), "completed"))
        .first();
      if (payment) {
        return { valid: false as const, error: "Реферальный код можно использовать только при первой оплате" };
      }
    }

    const isDiscount = referrer.referralType === "discount";
    const discount = isDiscount ? (referrer.referralDiscount ?? 10) : 0;

    return {
      valid: true as const,
      referrerId: referrer._id,
      referrerName: referrer.name || referrer.email || "Пользователь",
      discount,
      isDiscount,
    };
  },
});

/** Get referral stats for the current user (Settings tab) */
export const getMyReferralStats = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;

    const referrals = await ctx.db
      .query("referrals")
      .withIndex("by_referrerId", (q) => q.eq("referrerId", args.userId))
      .collect();

    const registered = referrals.length;
    const paid = referrals.filter((r) => r.status === "paid").length;
    const bonusDays = user.referralBonusDaysEarned ?? 0;

    return {
      referralCode: user.referralCode ?? null,
      referralType: user.referralType ?? "basic",
      referralDiscount: user.referralDiscount ?? 10,
      registered,
      paid,
      bonusDays,
      milestone3Claimed: user.referralMilestone3Claimed ?? false,
      milestone10Reached: user.referralMilestone10Reached ?? false,
      referrals: referrals.map((r) => ({
        referredId: r.referredId,
        status: r.status,
        createdAt: r.createdAt,
        paidAt: r.paidAt,
        bonusDaysGranted: r.bonusDaysGranted,
      })),
    };
  },
});

// ─── Mutations ───────────────────────────────────────

/** Generate a unique referral code for a user */
export const generateCodeForUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.referralCode) return;

    let code = "";
    let attempts = 0;
    do {
      code = generateReferralCode();
      const existing = await ctx.db
        .query("users")
        .withIndex("by_referralCode", (q) => q.eq("referralCode", code))
        .first();
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    await ctx.db.patch(args.userId, {
      referralCode: code,
      referralType: "basic",
      referralDiscount: 10,
      referralCount: 0,
      referralBonusDaysEarned: 0,
      referralMilestone3Claimed: false,
      referralMilestone10Reached: false,
    });
  },
});

/** Apply referral bonus when invited user pays */
export const applyReferralBonus = internalMutation({
  args: {
    referralCode: v.string(),
    referredUserId: v.id("users"),
    paymentId: v.id("payments"),
    paymentTier: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const referrer = await ctx.db
      .query("users")
      .withIndex("by_referralCode", (q) => q.eq("referralCode", args.referralCode))
      .first();
    if (!referrer) return null;

    // Dedup — already paid referral from this user
    const existing = await ctx.db
      .query("referrals")
      .withIndex("by_referredId", (q) => q.eq("referredId", args.referredUserId))
      .filter((q) => q.eq(q.field("status"), "paid"))
      .first();
    if (existing) return null;

    // Create or update referral record
    const existingReg = await ctx.db
      .query("referrals")
      .withIndex("by_referredId", (q) => q.eq("referredId", args.referredUserId))
      .first();

    // Tier-specific bonus days
    const TIER_BONUS_DAYS: Record<string, number> = {
      start: 7, pro: 14,
      agency_s: 14, agency_m: 14, agency_l: 21, agency_xl: 30,
    };
    const bonusDays = TIER_BONUS_DAYS[args.paymentTier ?? "start"] ?? 7;
    const now = Date.now();

    if (existingReg) {
      await ctx.db.patch(existingReg._id, {
        status: "paid",
        paymentId: args.paymentId,
        bonusDaysGranted: bonusDays,
        paidAt: now,
      });
    } else {
      await ctx.db.insert("referrals", {
        referrerId: referrer._id,
        referredId: args.referredUserId,
        referralCode: args.referralCode,
        status: "paid",
        paymentId: args.paymentId,
        bonusDaysGranted: bonusDays,
        createdAt: now,
        paidAt: now,
      });
    }

    // Grant +7 days to referrer
    const currentExpires = referrer.subscriptionExpiresAt ?? now;
    const base = Math.max(currentExpires, now);
    let newExpires = base + bonusDays * 24 * 60 * 60 * 1000;
    const newCount = (referrer.referralCount ?? 0) + 1;
    let totalBonusDays = (referrer.referralBonusDaysEarned ?? 0) + bonusDays;

    const patch: Record<string, unknown> = {
      subscriptionExpiresAt: newExpires,
      referralCount: newCount,
      referralBonusDaysEarned: totalBonusDays,
    };

    // Milestone: 3 referrals → +9 bonus days (итого 7×3 + 9 = 30 дней — бесплатный месяц)
    let milestone3 = false;
    if (newCount >= 3 && !referrer.referralMilestone3Claimed) {
      newExpires += 9 * 24 * 60 * 60 * 1000;
      totalBonusDays += 9;
      patch.subscriptionExpiresAt = newExpires;
      patch.referralBonusDaysEarned = totalBonusDays;
      patch.referralMilestone3Claimed = true;
      milestone3 = true;
    }

    // Milestone: 10 referrals → 15% discount flag
    let milestone10 = false;
    if (newCount >= 10 && !referrer.referralMilestone10Reached) {
      patch.referralMilestone10Reached = true;
      milestone10 = true;
    }

    await ctx.db.patch(referrer._id, patch);

    // Set referredBy on the invited user (write-once)
    const referred = await ctx.db.get(args.referredUserId);
    if (referred && !referred.referredBy) {
      await ctx.db.patch(args.referredUserId, { referredBy: referrer._id });
    }

    return { referrerId: referrer._id, bonusDays, newCount, milestone3, milestone10 };
  },
});

// ─── Admin ───────────────────────────────────────────

/** Admin: update referral type and discount for a user */
export const adminUpdateReferral = mutation({
  args: {
    sessionToken: v.string(),
    userId: v.id("users"),
    referralType: v.union(v.literal("basic"), v.literal("discount")),
    referralDiscount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const patch: Record<string, unknown> = { referralType: args.referralType };
    if (args.referralDiscount !== undefined) {
      patch.referralDiscount = args.referralDiscount;
    }
    await ctx.db.patch(args.userId, patch);
  },
});

/** Admin: filtered list of users with referral data (action — not reactive) */
export const adminFilterReferrals = action({
  args: {
    minReferrals: v.optional(v.number()),
    maxReferrals: v.optional(v.number()),
    referralType: v.optional(v.string()),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    type ReferralUser = {
      _id: Id<"users">;
      name?: string;
      email?: string;
      referralCode?: string;
      referralType: string;
      referralDiscount: number;
      referralCount: number;
      referralBonusDaysEarned: number;
      milestone3Claimed: boolean;
      milestone10Reached: boolean;
    };
    const allUsers: ReferralUser[] = await ctx.runQuery(internal.referrals.getAllUsersWithReferrals);
    let filtered = allUsers;

    if (args.minReferrals !== undefined) {
      filtered = filtered.filter((u: ReferralUser) => u.referralCount >= args.minReferrals!);
    }
    if (args.maxReferrals !== undefined) {
      filtered = filtered.filter((u: ReferralUser) => u.referralCount <= args.maxReferrals!);
    }
    if (args.referralType && args.referralType !== "all") {
      filtered = filtered.filter((u: ReferralUser) => u.referralType === args.referralType);
    }
    if (args.search) {
      const s = args.search.toLowerCase();
      filtered = filtered.filter((u: ReferralUser) =>
        (u.name ?? "").toLowerCase().includes(s) ||
        (u.email ?? "").toLowerCase().includes(s)
      );
    }
    return filtered;
  },
});

/** Internal: get all users with referral codes */
export const getAllUsersWithReferrals = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => u.referralCode)
      .map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        referralCode: u.referralCode,
        referralType: (u.referralType ?? "basic") as string,
        referralDiscount: u.referralDiscount ?? 10,
        referralCount: u.referralCount ?? 0,
        referralBonusDaysEarned: u.referralBonusDaysEarned ?? 0,
        milestone3Claimed: u.referralMilestone3Claimed ?? false,
        milestone10Reached: u.referralMilestone10Reached ?? false,
      }));
  },
});

/** Admin: get referral details for a specific user */
export const adminGetUserReferrals = query({
  args: { sessionToken: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const referrals = await ctx.db
      .query("referrals")
      .withIndex("by_referrerId", (q) => q.eq("referrerId", args.userId))
      .collect();

    const details = [];
    for (const r of referrals) {
      const referred = await ctx.db.get(r.referredId);
      details.push({
        _id: r._id,
        referredName: referred?.name ?? referred?.email ?? "—",
        referredEmail: referred?.email ?? "—",
        status: r.status,
        createdAt: r.createdAt,
        paidAt: r.paidAt,
        bonusDaysGranted: r.bonusDaysGranted,
      });
    }
    return details;
  },
});

/** Internal: find referrer by code (for billing) */
export const findReferrerByCode = internalQuery({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_referralCode", (q) => q.eq("referralCode", args.code))
      .first();
    if (!user) return null;
    return {
      _id: user._id,
      referralType: (user.referralType ?? "basic") as string,
      referralDiscount: user.referralDiscount ?? 10,
    };
  },
});

// ─── Migration ───────────────────────────────────────

/** One-time migration: generate referral codes for all existing users */
export const migrateExistingUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let migrated = 0;
    for (const user of users) {
      if (user.referralCode) continue;

      let code = "";
      let attempts = 0;
      do {
        code = generateReferralCode();
        const existing = await ctx.db
          .query("users")
          .withIndex("by_referralCode", (q) => q.eq("referralCode", code))
          .first();
        if (!existing) break;
        attempts++;
      } while (attempts < 10);

      await ctx.db.patch(user._id, {
        referralCode: code,
        referralType: "basic",
        referralDiscount: 10,
        referralCount: 0,
        referralBonusDaysEarned: 0,
        referralMilestone3Claimed: false,
        referralMilestone10Reached: false,
      });
      migrated++;
    }
    console.log(`[referral-migration] Migrated ${migrated} users`);
    return { migrated };
  },
});
