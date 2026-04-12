import { v } from "convex/values";
import { action, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

// Bootstrap admins: used as fallback so existing admins can still access
// even before their DB isAdmin flag is set
const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];

// Helper: validate session and check admin access
// Checks user.isAdmin first, falls back to ADMIN_EMAILS for bootstrap
async function assertAdmin(ctx: any, sessionToken: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", sessionToken))
    .first();

  if (!session || session.expiresAt < Date.now()) {
    throw new Error("Unauthorized: invalid session");
  }

  const user = await ctx.db.get(session.userId);
  if (!user) {
    throw new Error("Forbidden: admin access required");
  }

  // Check DB flag first, then fallback to hardcoded list for bootstrap
  if (user.isAdmin !== true && !ADMIN_EMAILS.includes(user.email)) {
    throw new Error("Forbidden: admin access required");
  }

  return user;
}

// List all users with joined data
export const listUsers = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);

    const users = await ctx.db.query("users").collect();

    const result = await Promise.all(
      users.map(async (user) => {
        const accounts = await ctx.db
          .query("adAccounts")
          .withIndex("by_userId", (q) => q.eq("userId", user._id))
          .collect();

        const rules = await ctx.db
          .query("rules")
          .withIndex("by_userId", (q) => q.eq("userId", user._id))
          .collect();

        // Payments: read all per user (usually < 20 per user, safe)
        const payments = await ctx.db
          .query("payments")
          .withIndex("by_userId", (q) => q.eq("userId", user._id))
          .collect();
        const completedPayments = payments.filter((p) => p.status === "completed");
        const lastPayment = completedPayments
          .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt))[0];

        return {
          _id: user._id,
          email: user.email,
          name: user.name,
          isAdmin: user.isAdmin === true,
          subscriptionTier: user.subscriptionTier,
          subscriptionExpiresAt: user.subscriptionExpiresAt,
          telegramChatId: user.telegramChatId,
          createdAt: user.createdAt,
          accountsCount: accounts.length,
          rulesCount: rules.length,
          lastPromoCode: lastPayment?.promoCode || null,
          lastBonusDays: lastPayment?.bonusDays || null,
          totalPaid: completedPayments.reduce((sum, p) => sum + (p.amount || 0), 0),
          lastPaymentDate: lastPayment ? (lastPayment.completedAt || lastPayment.createdAt) : null,
          referralCode: user.referralCode ?? null,
          referralType: (user.referralType ?? "basic") as string,
          referralDiscount: user.referralDiscount ?? 10,
          referralCount: user.referralCount ?? 0,
        };
      })
    );

    return result;
  },
});

// Toggle admin role for a user
export const toggleAdmin = mutation({
  args: {
    sessionToken: v.string(),
    userId: v.id("users"),
    isAdmin: v.boolean(),
  },
  handler: async (ctx, args) => {
    const admin = await assertAdmin(ctx, args.sessionToken);

    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    await ctx.db.patch(args.userId, {
      isAdmin: args.isAdmin,
      updatedAt: Date.now(),
    });

    // Audit log
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: admin._id,
      category: "admin",
      action: "admin_toggled",
      status: "success",
      details: { targetUserId: args.userId, isAdmin: args.isAdmin },
    }); } catch {}

    return { success: true, isAdmin: args.isAdmin };
  },
});

// Get summary statistics
export const getStats = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);

    const users = await ctx.db.query("users").collect();
    const payments = await ctx.db.query("payments").collect();

    const totalUsers = users.length;
    const freemiumCount = users.filter((u) => u.subscriptionTier === "freemium").length;
    const startCount = users.filter((u) => u.subscriptionTier === "start").length;
    const proCount = users.filter((u) => u.subscriptionTier === "pro").length;
    const withTelegram = users.filter((u) => u.telegramChatId).length;

    // Count users with at least one ad account — iterate without collecting all
    const accountUserIds = new Set<string>();
    for (const user of users) {
      const firstAccount = await ctx.db
        .query("adAccounts")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .first();
      if (firstAccount) accountUserIds.add(user._id as string);
    }
    const withAccounts = accountUserIds.size;

    // Revenue
    const completedPayments = payments.filter((p) => p.status === "completed");
    const totalRevenue = completedPayments.reduce((sum, p) => sum + p.amount, 0);

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentRevenue = completedPayments
      .filter((p) => (p.completedAt || p.createdAt) > thirtyDaysAgo)
      .reduce((sum, p) => sum + p.amount, 0);

    return {
      totalUsers,
      freemiumCount,
      startCount,
      proCount,
      withTelegram,
      withAccounts,
      totalRevenue,
      recentRevenue,
    };
  },
});

// Update user tier (admin action)
export const updateUserTier = mutation({
  args: {
    sessionToken: v.string(),
    userId: v.id("users"),
    tier: v.union(v.literal("freemium"), v.literal("start"), v.literal("pro")),
  },
  handler: async (ctx, args) => {
    const admin = await assertAdmin(ctx, args.sessionToken);

    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    const oldTier = user.subscriptionTier;

    // Handle downgrade: deactivate excess rules
    if (
      (oldTier === "pro" && (args.tier === "start" || args.tier === "freemium")) ||
      (oldTier === "start" && args.tier === "freemium")
    ) {
      const TIER_LIMITS: Record<string, { rules: number; autoStop: boolean }> = {
        freemium: { rules: 2, autoStop: false },
        start: { rules: 10, autoStop: true },
        pro: { rules: Infinity, autoStop: true },
      };
      const limits = TIER_LIMITS[args.tier];

      const rules = await ctx.db
        .query("rules")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .collect();

      const activeRules = rules.filter((r) => r.isActive);
      if (activeRules.length > limits.rules) {
        const excess = activeRules.slice(limits.rules);
        for (const rule of excess) {
          await ctx.db.patch(rule._id, { isActive: false, updatedAt: Date.now() });
        }
      }

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

    await ctx.db.patch(args.userId, {
      subscriptionTier: args.tier,
      updatedAt: Date.now(),
    });

    // Audit log
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: admin._id,
      category: "admin",
      action: "tier_changed",
      status: "success",
      details: { targetUserId: args.userId, oldTier, newTier: args.tier },
    }); } catch {}

    return { success: true, previousTier: oldTier, newTier: args.tier };
  },
});

// Update user subscription expiry date (admin)
export const updateUserExpiry = mutation({
  args: {
    sessionToken: v.string(),
    userId: v.id("users"),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const admin = await assertAdmin(ctx, args.sessionToken);
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    await ctx.db.patch(args.userId, {
      subscriptionExpiresAt: args.expiresAt,
      updatedAt: Date.now(),
    });

    // Audit log
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: admin._id,
      category: "admin",
      action: "expiry_changed",
      status: "success",
      details: { targetUserId: args.userId, newExpiry: args.expiresAt },
    }); } catch {}

    return { success: true };
  },
});

// Get list of Telegram-connected users for broadcast
export const getTelegramUsers = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => u.telegramChatId)
      .map((u) => ({
        _id: u._id,
        name: u.name || u.email,
        telegramChatId: u.telegramChatId!,
        telegramFirstName: u.telegramFirstName,
        telegramUsername: u.telegramUsername,
      }));
  },
});

// Send broadcast message to Telegram users
export const broadcastTelegram = action({
  args: {
    sessionToken: v.string(),
    message: v.string(),
    chatIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    // Verify admin
    const adminUserId = await ctx.runQuery(internal.admin.verifyAdminWithId, {
      sessionToken: args.sessionToken,
    });
    if (!adminUserId) throw new Error("Forbidden: admin access required");

    let sent = 0;
    let failed = 0;
    for (const chatId of args.chatIds) {
      try {
        await ctx.runAction(internal.telegram.sendMessage, {
          chatId,
          text: args.message,
        });
        sent++;
      } catch (err) {
        console.error(`[broadcast] Failed to send to ${chatId}:`, err);
        failed++;
      }
    }

    // Audit log
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: adminUserId,
      category: "admin",
      action: "broadcast_sent",
      status: "success",
      details: { recipientCount: args.chatIds.length },
    }); } catch {}

    return { sent, failed, total: args.chatIds.length };
  },
});

// Send in-app notification to a specific user
export const sendUserNotification = mutation({
  args: {
    sessionToken: v.string(),
    userId: v.id("users"),
    title: v.string(),
    message: v.string(),
    type: v.union(v.literal("info"), v.literal("warning"), v.literal("payment")),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);

    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    await ctx.db.insert("userNotifications", {
      userId: args.userId,
      title: args.title,
      message: args.message,
      type: args.type,
      direction: "admin_to_user",
      isRead: false,
      createdAt: Date.now(),
    });

    return { success: true };
  },
});

// Internal query for admin verification (used by actions)
export const verifyAdmin = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    try {
      await assertAdmin(ctx, args.sessionToken);
      return true;
    } catch {
      return false;
    }
  },
});

// Internal query: verify admin and return userId (used by actions that need audit logging)
export const verifyAdminWithId = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    try {
      const user = await assertAdmin(ctx, args.sessionToken);
      return user._id;
    } catch {
      return null;
    }
  },
});
