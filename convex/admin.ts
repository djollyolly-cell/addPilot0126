import { v } from "convex/values";
import { action, internalAction, internalQuery, mutation, query } from "./_generated/server";
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

/** Admin: list all error + abandoned accounts with user name */
export const listProblemAccounts = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const allAccounts = await ctx.db.query("adAccounts").collect();
    const problems = allAccounts.filter(
      (a) => a.status === "error" || a.status === "abandoned"
    );
    const result = await Promise.all(
      problems.map(async (a) => {
        const user = await ctx.db.get(a.userId);
        return {
          _id: a._id,
          vkAccountId: a.vkAccountId,
          name: a.name,
          status: a.status,
          lastSyncAt: a.lastSyncAt,
          lastError: a.lastError,
          abandonedAt: a.abandonedAt,
          userName: user?.name || user?.email || "?",
          userId: a.userId,
        };
      })
    );
    return result;
  },
});

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
    }); } catch { /* non-critical */ }

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

    const tierPatch: Record<string, unknown> = {
      subscriptionTier: args.tier,
      updatedAt: Date.now(),
    };
    // Set proAccountLimit when admin assigns Pro (keep existing if already set)
    if (args.tier === "pro" && !user.proAccountLimit) {
      tierPatch.proAccountLimit = 9;
    }
    await ctx.db.patch(args.userId, tierPatch);

    // Audit log
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: admin._id,
      category: "admin",
      action: "tier_changed",
      status: "success",
      details: { targetUserId: args.userId, oldTier, newTier: args.tier },
    }); } catch { /* non-critical */ }

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
    }); } catch { /* non-critical */ }

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
    }); } catch { /* non-critical */ }

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

// TEMP: One-time migration — fix tokenExpiresAt for permanent-token providers (hasApi=false)
// Sets tokenExpiresAt=2099 and clears recovery artifacts for affected accounts.
// Remove after running.
export const migratePermanentTokenExpiry = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);

    const PERMANENT_EXPIRY = new Date("2099-01-01").getTime();
    const allProviders = await ctx.db.query("agencyProviders").collect();
    const permanentProviderIds = new Set(
      allProviders.filter((p) => !p.hasApi).map((p) => p._id)
    );

    const allAccounts = await ctx.db.query("adAccounts").collect();
    let migrated = 0;
    const details: { name: string; user: string; provider: string; oldExpiry: string }[] = [];

    for (const acc of allAccounts) {
      const provId = (acc as Record<string, unknown>).agencyProviderId as string | undefined;
      if (!provId || !permanentProviderIds.has(provId as any)) continue;
      // Already correct
      if (!acc.tokenExpiresAt || acc.tokenExpiresAt >= PERMANENT_EXPIRY - 1000) continue;

      const user = await ctx.db.get(acc.userId);
      const providerDoc = allProviders.find((p) => p._id === provId);

      await ctx.db.patch(acc._id, {
        tokenExpiresAt: PERMANENT_EXPIRY,
        tokenErrorSince: undefined,
        tokenRecoveryAttempts: undefined,
        lastError: undefined,
        ...(acc.status === "error" ? { status: "active" as const } : {}),
      });

      details.push({
        name: acc.name,
        user: user?.name || user?.email || "unknown",
        provider: providerDoc?.displayName || "unknown",
        oldExpiry: new Date(acc.tokenExpiresAt).toISOString(),
      });
      migrated++;
    }

    return { migrated, details };
  },
});

// ---- Module toggles ----

/** Toggle video rotation module for a user */
export const toggleVideoRotation = mutation({
  args: {
    sessionToken: v.string(),
    targetUserId: v.id("users"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);

    const user = await ctx.db.get(args.targetUserId);
    if (!user) throw new Error("Пользователь не найден");

    await ctx.db.patch(args.targetUserId, {
      videoRotationEnabled: args.enabled,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

/** Admin: manually move error account to abandoned (bypass 7-day wait) */
export const abandonAccount = mutation({
  args: {
    sessionToken: v.string(),
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Кабинет не найден");
    if (account.status !== "error") throw new Error("Только error-кабинеты можно заглушить");
    await ctx.db.patch(args.accountId, {
      status: "abandoned",
      abandonedAt: Date.now(),
      tokenErrorSince: undefined,
      tokenRecoveryAttempts: undefined,
      consecutiveSyncErrors: undefined,
    });
    return { success: true };
  },
});

/** Admin: move abandoned account back to error (retry recovery) */
export const reactivateAccount = mutation({
  args: {
    sessionToken: v.string(),
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Кабинет не найден");
    if (account.status !== "abandoned") throw new Error("Только abandoned-кабинеты можно реактивировать");
    await ctx.db.patch(args.accountId, {
      status: "error",
      abandonedAt: undefined,
    });
    return { success: true };
  },
});

/** List all users with their module flags (for admin Modules tab) */
export const listUsersModules = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.sessionToken))
      .first();
    if (!session) throw new Error("Не авторизован");
    const user = await ctx.db.get(session.userId);
    if (!user) throw new Error("Не авторизован");
    if (!user.isAdmin && !ADMIN_EMAILS.includes(user.email)) {
      throw new Error("Нет доступа");
    }

    const users = await ctx.db.query("users").collect();
    return users.map((u) => ({
      _id: u._id,
      name: u.name ?? u.email,
      email: u.email,
      videoRotationEnabled: u.videoRotationEnabled ?? false,
    }));
  },
});

// DIAGNOSTIC (temporary): list account ids+names — needed because runner
// action coordinates per-account counts (Convex disallows multiple paginated
// queries in one transaction, so a monolithic count UDF doesn't fit).
// Remove with the rest of the diagnostic block after Pre-Step B.
export const listAccountsForCount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    return accounts.map((a) => ({ _id: a._id, name: a.name }));
  },
});

// DIAGNOSTIC (temporary): one page of ads for an account. Convex rejects
// multiple paginate() calls per transaction (even sequentially with cursors)
// — one paginate per UDF, period. The runner action loops cursors externally,
// so each page is its own transaction. Remove with the rest of block.
export const adsPageForAccount = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { accountId, cursor }) => {
    const page = await ctx.db
      .query("ads")
      .withIndex("by_accountId_vkAdId", (q) => q.eq("accountId", accountId))
      .paginate({ cursor, numItems: 500 });
    return {
      pageSize: page.page.length,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// DIAGNOSTIC (temporary): runner that aggregates per-account counts and
// logs top-20. Each `runQuery` is its own transaction, so the per-account
// paginated query stays within Convex's single-paginate constraint. Self-
// hosted Dashboard может не давать UI для internalQuery; этот action
// видится в Functions list и легко триггерится через `npx convex run`.
// Explicit return type breaks circular inference through generated api.
// Remove with the rest of diagnostic block.
export const reportAdsCountByAccount = internalAction({
  args: {},
  handler: async (ctx): Promise<Array<[string, number, string]>> => {
    const accounts = await ctx.runQuery(internal.admin.listAccountsForCount, {});
    const results: Array<[string, number, string]> = [];
    for (const acc of accounts) {
      let count = 0;
      let cursor: string | null = null;
      while (true) {
        const page: { pageSize: number; isDone: boolean; continueCursor: string } =
          await ctx.runQuery(internal.admin.adsPageForAccount, {
            accountId: acc._id,
            cursor,
          });
        count += page.pageSize;
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      results.push([acc._id, count, acc.name]);
    }
    const top = results.sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.log("[diag] adsCountByAccount top-20:", JSON.stringify(top));
    return top;
  },
});
