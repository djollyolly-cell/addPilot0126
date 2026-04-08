// convex/healthCheck.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { v } from "convex/values";
import {
  query,
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  CheckResult,
  CheckStatus,
  SystemReport,
  FunctionReport,
  UserCheckResult,
  worstStatus,
  formatSystemReport,
  formatFunctionReport,
} from "./healthReport";

// ─── Constants ───

const ADMIN_CHAT_ID = "325307765";
const TIER_LIMITS: Record<string, { accounts: number; rules: number }> = {
  freemium: { accounts: 1, rules: 2 },
  start: { accounts: 3, rules: 10 },
  pro: { accounts: 999, rules: 999 },
};

// ─── Helpers ───

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function hoursAgo(ts: number): number {
  return Math.round((Date.now() - ts) / 3_600_000);
}

function minutesAgo(ts: number): number {
  return Math.round((Date.now() - ts) / 60_000);
}

// ─── Block 1.1: Cron Health (heartbeat + results) ───

// Split into small queries to avoid 1s timeout, assembled in orchestrator

export const checkCronHeartbeats = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const heartbeats = await ctx.db.query("cronHeartbeats").collect();
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    const CRON_CONFIGS: Array<{
      name: string;
      label: string;
      maxStaleMin?: number;
    }> = [
      { name: "syncAll", label: "sync-metrics", maxStaleMin: 10 },
      { name: "checkUzBudgetRules", label: "uz-budget-increase", maxStaleMin: 15 },
      { name: "resetBudgets", label: "uz-budget-reset" },
      { name: "sendDailyDigest", label: "daily-digest" },
      { name: "sendWeeklyDigest", label: "weekly-digest" },
      { name: "sendMonthlyDigest", label: "monthly-digest" },
      { name: "checkAgencyTokenHealth", label: "agency-token-health" },
    ];

    for (const cfg of CRON_CONFIGS) {
      const hb = heartbeats.find((h) => h.name === cfg.name);
      if (!hb) continue;

      if (hb.status === "running" && minutesAgo(hb.startedAt) > 10) {
        issues.push(`${cfg.label}: STUCK (${minutesAgo(hb.startedAt)} мин)`);
        status = "error";
        continue;
      }
      if (hb.error) {
        issues.push(`${cfg.label}: ошибка — ${hb.error.slice(0, 80)}`);
        status = "error";
        continue;
      }
      if (cfg.maxStaleMin && hb.finishedAt && minutesAgo(hb.finishedAt) > cfg.maxStaleMin) {
        issues.push(`${cfg.label}: отстаёт (${minutesAgo(hb.finishedAt)} мин)`);
        if (status === "ok") status = "warning";
      }
    }

    return { name: "Кроны (heartbeat)", status, message: issues.length ? `${issues.length} проблем` : "ок", details: issues };
  },
});

export const checkCronSyncResults = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    const allAccounts = await ctx.db.query("adAccounts").collect();
    const activeAccounts = allAccounts.filter((a) => a.status === "active" || a.status === "error");
    const now = Date.now();
    const syncedCount = activeAccounts.filter((a) => a.lastSyncAt && now - a.lastSyncAt < 10 * 60_000).length;

    if (activeAccounts.length > 0 && syncedCount < activeAccounts.length) {
      issues.push(`sync: ${syncedCount}/${activeAccounts.length} синхронизированы`);
      if (status === "ok") status = "warning";
    }

    return { name: "Кроны (sync)", status, message: issues.length ? issues[0] : "ок", details: issues };
  },
});

export const checkCronResetResults = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    // Reset happens at 23:00 user timezone. Only check if it's past midnight (i.e. reset window has passed).
    const now = new Date();
    const utcHour = now.getUTCHours();

    // Reset window is 23:00 local. Most users are UTC+3 (MSK), so 23:00 MSK = 20:00 UTC.
    // Only flag missing resets after 21:00 UTC (midnight MSK) when the window has definitely passed.
    if (utcHour < 21) {
      return { name: "Кроны (ресет)", status: "ok", message: "окно ресета ещё не наступило", details: [] };
    }

    const uzRules = await ctx.db.query("rules").collect();
    const resetRules = uzRules.filter(
      (r) =>
        r.type === "uz_budget_manage" &&
        r.isActive &&
        (r.conditions as any).resetDaily === true
    );

    if (resetRules.length > 0) {
      // Only fetch recent reset logs (last 24h) per rule to avoid scanning all actionLogs
      const yesterday = Date.now() - 24 * 3600_000;
      for (const rule of resetRules) {
        const ruleLogs = await ctx.db
          .query("actionLogs")
          .withIndex("by_ruleId", (q) => q.eq("ruleId", rule._id))
          .order("desc")
          .take(50);
        const recentResets = ruleLogs.filter(
          (l) => l.actionType === "budget_reset" && l.createdAt >= yesterday
        );
        const targetCount = rule.targetCampaignIds?.length ?? 0;
        if (targetCount > 0 && recentResets.length === 0) {
          issues.push(`Ресет "${rule.name}": не выполнен (0/${targetCount})`);
          status = "error";
        } else if (targetCount > 0 && recentResets.length < targetCount) {
          issues.push(`Ресет "${rule.name}": частичный (${recentResets.length}/${targetCount})`);
          if (status === "ok") status = "warning";
        }
      }
    }

    return { name: "Кроны (ресет)", status, message: issues.length ? `${issues.length} проблем` : "ок", details: issues };
  },
});

export const checkCronDigestResults = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    const today = todayStr();
    const todayStart = new Date(today).getTime();
    const heartbeats = await ctx.db.query("cronHeartbeats").collect();
    const digestHb = heartbeats.find((h) => h.name === "sendDailyDigest");

    if (digestHb?.finishedAt && digestHb.finishedAt >= todayStart) {
      const settings = await ctx.db.query("userSettings").collect();
      const digestUsers = settings.filter((s) => s.digestEnabled);
      const sentNotifs = await ctx.db.query("notifications").withIndex("by_status").collect();
      const todayDigests = sentNotifs.filter(
        (n) => n.type === "digest" && n.createdAt >= todayStart && n.status === "sent"
      );

      if (digestUsers.length > 0 && todayDigests.length === 0) {
        issues.push(`Дайджест: ${digestUsers.length} пользователей ожидали, 0 отправлено`);
        if (status === "ok") status = "warning";
      }
    }

    return { name: "Кроны (дайджест)", status, message: issues.length ? issues[0] : "ок", details: issues };
  },
});

// ─── Block 1.2: User Token Health ───

export const checkTokenHealth = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const users = await ctx.db.query("users").collect();
    const accounts = await ctx.db.query("adAccounts").collect();
    const usersWithAccounts = users.filter((u) =>
      accounts.some((a) => a.userId === u._id)
    );

    const now = Date.now();
    const DAY = 24 * 3600_000;
    const expired: string[] = [];
    const expiring: string[] = [];
    const noRefresh: string[] = [];

    for (const u of usersWithAccounts) {
      const label = u.name || u.email;
      if (u.vkAdsTokenExpiresAt && u.vkAdsTokenExpiresAt < now) {
        expired.push(`${label}: VK Ads токен истёк ${hoursAgo(u.vkAdsTokenExpiresAt)}ч назад`);
      } else if (u.vkAdsTokenExpiresAt && u.vkAdsTokenExpiresAt < now + DAY) {
        expiring.push(`${label}: VK Ads истекает через ${Math.round((u.vkAdsTokenExpiresAt - now) / 3_600_000)}ч`);
      }
      if (!u.vkAdsRefreshToken && u.vkAdsTokenExpiresAt) {
        noRefresh.push(`${label}: нет refresh token`);
      }
    }

    const issues = [...expired, ...expiring, ...noRefresh];
    let status: CheckStatus = "ok";
    if (expired.length > 0) status = "error";
    else if (expiring.length > 0 || noRefresh.length > 0) status = "warning";

    const total = usersWithAccounts.length;
    const message = status === "ok"
      ? `${total}/${total} валидны`
      : expired.length > 0
        ? `${expired.length} истекли, ${total - expired.length}/${total} ок`
        : `${expiring.length} истекают в 24ч`;

    return { name: "Токены", status, message, details: issues };
  },
});

// ─── Block 1.3: Account Sync ───

export const checkAccountSync = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const accounts = await ctx.db.query("adAccounts").collect();
    const users = await ctx.db.query("users").collect();
    const active = accounts.filter((a) => a.status !== "paused");
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    for (const acc of active) {
      const user = users.find((u) => u._id === acc.userId);
      const label = `"${acc.name}" (${user?.name || user?.email || "?"})`;

      if (acc.status === "error") {
        // Agency-specific diagnostics
        if (
          (acc as any).vitaminCabinetId &&
          acc.lastError?.includes("TOKEN_EXPIRED")
        ) {
          const errHours = acc.lastError
            ? hoursAgo((acc as any).lastErrorAt || acc._creationTime)
            : 0;
          issues.push(
            `${label}: Витамин TOKEN_EXPIRED (${errHours}ч). Проверить VITAMIN_API_KEY и cabinetId`
          );
          status = "error";
          continue;
        }
        issues.push(`${label}: status=error — ${acc.lastError?.slice(0, 60) || "?"}`);
        status = "error";
        continue;
      }

      if (!acc.lastSyncAt) {
        issues.push(`${label}: ни разу не синхронизировался`);
        status = "error";
        continue;
      }

      // With batching (40 accounts per 5min cycle), full coverage takes ~20min.
      // Use 30min threshold to avoid false positives.
      if (minutesAgo(acc.lastSyncAt) > 30) {
        issues.push(`${label}: lastSync ${minutesAgo(acc.lastSyncAt)} мин назад`);
        if (status === "ok") status = "warning";
      }

      if (!acc.accessToken) {
        issues.push(`${label}: accessToken отсутствует`);
        status = "error";
      }

      if (acc.lastError) {
        issues.push(`${label}: lastError — ${acc.lastError.slice(0, 60)}`);
        if (status === "ok") status = "warning";
      }
    }

    const message = status === "ok"
      ? `${active.length}/${active.length} синхронизируются`
      : `${issues.length} ${issues.length === 1 ? "проблема" : "проблем"} из ${active.length}`;

    return { name: "Кабинеты", status, message, details: issues };
  },
});

// ─── Block 1.4: Notifications ───

export const checkNotifications = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const now = Date.now();
    const DAY = 24 * 3600_000;
    const notifs = await ctx.db.query("notifications").collect();
    const recent = notifs.filter((n) => n.createdAt > now - DAY);
    const failed = recent.filter((n) => n.status === "failed");
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    if (failed.length > 0) {
      issues.push(`${failed.length} уведомлений не доставлено за 24ч`);
      status = "error";
    }

    // Users with active rules but no telegramChatId
    const rules = await ctx.db.query("rules").collect();
    const activeRuleUserIds = [
      ...new Set(rules.filter((r) => r.isActive).map((r) => r.userId)),
    ];
    const users = await ctx.db.query("users").collect();
    const noTelegram = activeRuleUserIds.filter((uid) => {
      const u = users.find((usr) => usr._id === uid);
      return u && !u.telegramChatId;
    });
    if (noTelegram.length > 0) {
      issues.push(`${noTelegram.length} пользователей с правилами без Telegram`);
      if (status === "ok") status = "warning";
    }

    const sent = recent.filter((n) => n.status === "sent").length;
    const message = status === "ok"
      ? `${sent}/${recent.length} доставлены`
      : failed.length > 0
        ? `${failed.length} не доставлено`
        : `${noTelegram.length} без Telegram`;

    return { name: "Уведомления", status, message, details: issues };
  },
});

// ─── Block 1.5: Payments ───

export const checkPayments = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const payments = await ctx.db.query("payments").collect();
    const users = await ctx.db.query("users").collect();
    const now = Date.now();
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    const stuckPayments = payments.filter(
      (p) => p.status === "pending" && now - (p as any).createdAt > 2 * 3600_000
    );
    if (stuckPayments.length > 0) {
      issues.push(`${stuckPayments.length} зависших платежей (pending >2ч)`);
      if (status === "ok") status = "warning";
    }

    const expiredNotDowngraded = users.filter(
      (u) =>
        u.subscriptionTier &&
        u.subscriptionTier !== "freemium" &&
        u.subscriptionExpiresAt &&
        u.subscriptionExpiresAt < now
    );
    if (expiredNotDowngraded.length > 0) {
      for (const u of expiredNotDowngraded) {
        issues.push(`${u.name || u.email}: ${u.subscriptionTier} истёк, не даунгрейднут`);
      }
      status = "error";
    }

    const message = status === "ok" ? "ок" : `${issues.length} проблем`;
    return { name: "Платежи", status, message, details: issues };
  },
});

// ─── Block 1.6: Subscriptions ───

export const checkSubscriptions = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const users = await ctx.db.query("users").collect();
    const accounts = await ctx.db.query("adAccounts").collect();
    const rules = await ctx.db.query("rules").collect();
    const now = Date.now();
    const TWO_DAYS = 48 * 3600_000;
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    for (const u of users) {
      const tier = u.subscriptionTier || "freemium";
      if (tier === "freemium") continue;

      // Expiring soon
      if (u.subscriptionExpiresAt && u.subscriptionExpiresAt < now + TWO_DAYS && u.subscriptionExpiresAt > now) {
        const hoursLeft = Math.round((u.subscriptionExpiresAt - now) / 3_600_000);
        issues.push(`${u.name || u.email}: ${tier} истекает через ${hoursLeft}ч`);
        if (status === "ok") status = "warning";
      }

      // Limit checks
      const limits = TIER_LIMITS[tier] || TIER_LIMITS.freemium;
      const userAccounts = accounts.filter(
        (a) => a.userId === u._id && a.status !== "paused"
      ).length;
      const userRules = rules.filter(
        (r) => r.userId === u._id && r.isActive
      ).length;

      if (userAccounts > limits.accounts) {
        issues.push(`${u.name || u.email}: ${userAccounts} каб. (лимит ${limits.accounts})`);
        status = "error";
      }
      if (userRules > limits.rules) {
        issues.push(`${u.name || u.email}: ${userRules} правил (лимит ${limits.rules})`);
        status = "error";
      }
    }

    const message = status === "ok" ? "ок" : `${issues.length} проблем`;
    return { name: "Подписки", status, message, details: issues };
  },
});

// ─── Cycle 1 Orchestrator ───

export const runSystemCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const startTime = Date.now();

    const blocks: CheckResult[] = [];

    // Cron health split into 4 small queries to avoid 1s timeout
    const cronChecks = [
      { name: "checkCronHeartbeats", fn: internal.healthCheck.checkCronHeartbeats },
      { name: "checkCronSyncResults", fn: internal.healthCheck.checkCronSyncResults },
      { name: "checkCronResetResults", fn: internal.healthCheck.checkCronResetResults },
      { name: "checkCronDigestResults", fn: internal.healthCheck.checkCronDigestResults },
    ];

    // Merge cron sub-checks into one "Кроны" block
    const cronIssues: string[] = [];
    let cronStatus: CheckStatus = "ok";
    for (const check of cronChecks) {
      try {
        const result = await ctx.runQuery(check.fn, {});
        if (result.details) cronIssues.push(...result.details);
        cronStatus = worstStatus([cronStatus, result.status]);
      } catch (err) {
        cronIssues.push(`${check.name}: CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`);
        cronStatus = worstStatus([cronStatus, "warning"]);
      }
    }
    blocks.push({
      name: "Кроны",
      status: cronStatus,
      message: cronStatus === "ok" ? "все кроны в норме" : `${cronIssues.length} ${cronIssues.length === 1 ? "проблема" : "проблем"}`,
      details: cronIssues,
    });

    // Other checks
    const blockChecks = [
      { name: "checkTokenHealth", fn: internal.healthCheck.checkTokenHealth },
      { name: "checkAccountSync", fn: internal.healthCheck.checkAccountSync },
      { name: "checkNotifications", fn: internal.healthCheck.checkNotifications },
      { name: "checkPayments", fn: internal.healthCheck.checkPayments },
      { name: "checkSubscriptions", fn: internal.healthCheck.checkSubscriptions },
    ];

    for (const check of blockChecks) {
      try {
        const result = await ctx.runQuery(check.fn, {});
        blocks.push(result);
      } catch (err) {
        blocks.push({
          name: check.name,
          status: "warning",
          message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const statuses = blocks.map((b) => b.status);
    const report: SystemReport = {
      type: "system",
      status: worstStatus(statuses),
      blocks,
      warnings: statuses.filter((s) => s === "warning").length,
      errors: statuses.filter((s) => s === "error").length,
      duration: Date.now() - startTime,
    };

    // Save result
    await ctx.runMutation(internal.healthCheck.saveResult, {
      type: "system",
      status: report.status,
      summary: formatSystemReport(report),
      details: report as any,
      checkedUsers: 0,
      checkedAccounts: 0,
      checkedRules: 0,
      warnings: report.warnings,
      errors: report.errors,
      duration: report.duration,
    });

    // Send Telegram only if problems found
    const text = formatSystemReport(report);
    if (text) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: ADMIN_CHAT_ID,
        text,
      });
    }
  },
});

// ─── Save result mutation ───

export const saveResult = internalMutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("healthCheckResults", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

// ─── Manual triggers (public actions for admin UI) ───

export const runManualSystemCheck = action({
  args: {},
  handler: async (ctx) => {
    await ctx.runAction(internal.healthCheck.runSystemCheck, {});
  },
});

// ─── Query results for admin UI ───

export const getLatestResults = query({
  args: {},
  handler: async (ctx) => {
    const results = await ctx.db
      .query("healthCheckResults")
      .withIndex("by_createdAt")
      .order("desc")
      .take(20);
    return results;
  },
});

export const getResultHistory = query({
  args: {
    type: v.union(v.literal("system"), v.literal("function"), v.literal("user")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("healthCheckResults")
      .withIndex("by_type", (q) => q.eq("type", args.type))
      .order("desc")
      .take(args.limit ?? 10);
    return results;
  },
});

// ═══════════════════════════════════════════════════════
// ─── Cycle 2: Function Verification ───
// ═══════════════════════════════════════════════════════

// Per-user check — runs all blocks 2.1-2.10 for a single user
export const checkUserFunctions = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<UserCheckResult> => {
    const user = await ctx.runQuery(internal.healthCheck.getUserData, {
      userId: args.userId,
    });
    if (!user) {
      return {
        userId: args.userId,
        userName: "?",
        email: "?",
        tier: "?",
        accounts: 0,
        rules: 0,
        status: "error",
        checks: [{ name: "user", status: "error", message: "Пользователь не найден" }],
      };
    }

    const checks: CheckResult[] = [];

    // Block 2.1: Profile
    try {
      const profileCheck = await ctx.runQuery(
        internal.healthCheck.checkUserProfile,
        { userId: args.userId }
      );
      checks.push(profileCheck);
    } catch (err) {
      checks.push({
        name: "Профиль",
        status: "warning",
        message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Block 2.2: Token test call (VK API)
    const tokenResults: Map<string, boolean> = new Map();
    for (const acc of user.accounts) {
      try {
        const result = await ctx.runAction(
          internal.healthCheck.testAccountToken,
          { accountId: acc._id }
        );
        checks.push(result);
        tokenResults.set(acc._id, result.status === "ok");
      } catch (err) {
        checks.push({
          name: `Токен "${acc.name}"`,
          status: "error",
          message: `"${acc.name}": ${err instanceof Error ? err.message : "ошибка"}`,
        });
        tokenResults.set(acc._id, false);
      }
    }

    // Block 2.3: Rule coverage
    for (const rule of user.rules) {
      if (!rule.isActive) continue;
      try {
        const coverageCheck = await ctx.runQuery(
          internal.healthCheck.checkRuleCoverage,
          { ruleId: rule._id }
        );
        checks.push(coverageCheck);
      } catch (err) {
        checks.push({
          name: `Правило "${rule.name}"`,
          status: "warning",
          message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Block 2.6: Log dynamics (UZ rules)
    for (const rule of user.rules) {
      if (rule.type !== "uz_budget_manage" || !rule.isActive) continue;
      try {
        const dynamicsCheck = await ctx.runQuery(
          internal.healthCheck.checkLogDynamics,
          { ruleId: rule._id }
        );
        checks.push(dynamicsCheck);
      } catch (err) {
        checks.push({
          name: `Динамика "${rule.name}"`,
          status: "warning",
          message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Block 2.8: Deduplication
    try {
      const dedupCheck = await ctx.runQuery(
        internal.healthCheck.checkDeduplication,
        { userId: args.userId }
      );
      checks.push(dedupCheck);
    } catch (err) {
      checks.push({
        name: "Дедупликация",
        status: "warning",
        message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Block 2.9: Account functionality (VK API)
    for (const acc of user.accounts) {
      if (!tokenResults.get(acc._id)) continue;
      try {
        const funcCheck = await ctx.runAction(
          internal.healthCheck.checkAccountFunctionality,
          { accountId: acc._id }
        );
        checks.push(funcCheck);
      } catch (err) {
        checks.push({
          name: `Функции "${acc.name}"`,
          status: "warning",
          message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Block 2.10: Budget overspend (VK API, UZ rules only)
    const uzRules = user.rules.filter(
      (r) => r.type === "uz_budget_manage" && r.isActive
    );
    if (uzRules.length > 0) {
      for (const acc of user.accounts) {
        if (!tokenResults.get(acc._id)) continue;
        try {
          const overspendCheck = await ctx.runAction(
            internal.healthCheck.checkBudgetOverspend,
            { accountId: acc._id }
          );
          if (overspendCheck.status !== "ok") {
            checks.push(overspendCheck);
          }
        } catch (err) {
          checks.push({
            name: `Перерасход "${acc.name}"`,
            status: "warning",
            message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    const statuses = checks.map((c) => c.status);
    return {
      userId: args.userId,
      userName: user.user.name || user.user.email,
      email: user.user.email,
      tier: user.user.subscriptionTier || "freemium",
      accounts: user.accounts.length,
      rules: user.rules.length,
      status: worstStatus(statuses),
      checks,
    };
  },
});

// ─── Cycle 2 helper: get user data bundle ───

export const getUserData = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    return {
      user,
      accounts: accounts.filter((a) => a.status !== "paused"),
      rules,
    };
  },
});

// ─── Block 2.1: User Profile ───

export const checkUserProfile = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { name: "Профиль", status: "error", message: "Не найден" };

    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const activeAccounts = accounts.filter((a) => a.status !== "paused");
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const activeRules = rules.filter((r) => r.isActive);

    const tier = user.subscriptionTier || "freemium";
    const limits = TIER_LIMITS[tier] || TIER_LIMITS.freemium;
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    if (activeAccounts.length > limits.accounts) {
      issues.push(`${activeAccounts.length} каб. (лимит ${limits.accounts})`);
      status = "error";
    }
    if (activeRules.length > limits.rules) {
      issues.push(`${activeRules.length} правил (лимит ${limits.rules})`);
      status = "error";
    }

    // stopAd on freemium
    if (tier === "freemium") {
      const stopRules = activeRules.filter((r) => r.actions.stopAd);
      if (stopRules.length > 0) {
        issues.push(`${stopRules.length} правил с авто-стоп на freemium`);
        status = "error";
      }
    }

    // No Telegram
    if (activeRules.length > 0 && !user.telegramChatId) {
      issues.push("Нет Telegram (правила не уведомят)");
      if (status === "ok") status = "warning";
    }

    const message =
      status === "ok"
        ? `${tier}, ${activeAccounts.length} каб., ${activeRules.length} правил`
        : issues.join("; ");

    return { name: "Профиль", status, message, details: issues };
  },
});

// ─── Block 2.2: Token test call ───

export const testAccountToken = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const account = await ctx.runQuery(internal.healthCheck.getAccount, {
      accountId: args.accountId,
    });
    const name = account?.name || "?";

    try {
      const token = await ctx.runAction(
        internal.auth.getValidTokenForAccount,
        { accountId: args.accountId }
      );
      // Light test: fetch campaigns list (read-only)
      await ctx.runAction(internal.vkApi.getCampaignsForAccount, {
        accessToken: token,
      });
      return {
        name: `Токен "${name}"`,
        status: "ok",
        message: `"${name}": токен рабочий`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errStatus: CheckStatus = msg.includes("timeout") ? "warning" : "error";
      return {
        name: `Токен "${name}"`,
        status: errStatus,
        message: `"${name}": ${msg.slice(0, 80)}`,
      };
    }
  },
});

export const getAccount = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.accountId);
  },
});

// ─── Block 2.3: Rule Coverage ───

export const checkRuleCoverage = internalQuery({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return { name: "Правило", status: "error", message: "Не найдено" };

    const todayStart = new Date(todayStr()).getTime();

    // Skip rules created today
    if (rule.createdAt && rule.createdAt >= todayStart) {
      return {
        name: `"${rule.name}"`,
        status: "ok",
        message: `"${rule.name}": создано сегодня, пропуск`,
      };
    }

    const targetCount = rule.targetCampaignIds?.length ?? 0;
    if (targetCount === 0) {
      return {
        name: `"${rule.name}"`,
        status: "ok",
        message: `"${rule.name}": нет целевых кампаний`,
      };
    }

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .collect();
    const todayLogs = logs.filter((l) => l.createdAt >= todayStart);
    const processedCampaigns = new Set(
      todayLogs.map((l) => (l as any).campaignId || l.adId)
    );
    const processed = processedCampaigns.size;

    let status: CheckStatus = "ok";
    const issues: string[] = [];

    if (processed === 0 && targetCount > 0) {
      status = "error";
      issues.push("Ни одна кампания не обработана сегодня");
    } else if (processed < targetCount) {
      status = "warning";
      issues.push(`${targetCount - processed} кампаний не обработаны`);
    }

    return {
      name: `"${rule.name}"`,
      status,
      message: `"${rule.name}": ${processed}/${targetCount} обработано`,
      details: issues,
    };
  },
});

// ─── Block 2.6: Log Dynamics ───

export const checkLogDynamics = internalQuery({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return { name: "Динамика", status: "error", message: "Правило не найдено" };

    const todayStart = new Date(todayStr()).getTime();
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .collect();
    const todayLogs = logs
      .filter((l) => l.createdAt >= todayStart && l.actionType === "budget_increased")
      .sort((a, b) => a.createdAt - b.createdAt);

    if (todayLogs.length < 2) {
      return {
        name: `Динамика "${rule.name}"`,
        status: "ok",
        message: `"${rule.name}": ${todayLogs.length} увеличений сегодня`,
      };
    }

    const issues: string[] = [];
    let status: CheckStatus = "ok";
    let spentStuckCount = 0;
    let slowGapCount = 0;

    for (let i = 1; i < todayLogs.length; i++) {
      const prev = todayLogs[i - 1];
      const curr = todayLogs[i];
      const gapMin = Math.round((curr.createdAt - prev.createdAt) / 60_000);
      const prevSpent = prev.metricsSnapshot.spent;
      const currSpent = curr.metricsSnapshot.spent;

      if (currSpent <= prevSpent && gapMin > 5) {
        spentStuckCount++;
      }
      if (gapMin > 10) {
        slowGapCount++;
      }
    }

    if (spentStuckCount > 2) {
      issues.push(`spent не растёт в ${spentStuckCount} переходах — resume не работает?`);
      status = "error";
    }
    if (slowGapCount > 2) {
      issues.push(`${slowGapCount} gap'ов >10 мин между увеличениями`);
      if (status === "ok") status = "warning";
    }

    // Daily reset check
    if ((rule.conditions as any).resetDaily) {
      const resetLogs = logs.filter(
        (l) => l.createdAt >= todayStart && l.actionType === "budget_reset"
      );
      const targetCount = rule.targetCampaignIds?.length ?? 0;

      if (targetCount > 0 && resetLogs.length === 0) {
        issues.push(`Ресет не выполнен (0/${targetCount})`);
        status = "error";
      } else if (targetCount > 0 && resetLogs.length < targetCount) {
        issues.push(`Ресет частичный (${resetLogs.length}/${targetCount})`);
        status = "error";
      }
    }

    const message = status === "ok"
      ? `"${rule.name}": ${todayLogs.length} увеличений, динамика ок`
      : `"${rule.name}": ${issues.join("; ")}`;

    return {
      name: `Динамика "${rule.name}"`,
      status,
      message,
      details: issues,
    };
  },
});

// ─── Block 2.8: Deduplication ───

export const checkDeduplication = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const todayStart = new Date(todayStr()).getTime();
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const todayLogs = logs.filter((l) => l.createdAt >= todayStart);
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    // Double stops
    const stopLogs = todayLogs.filter(
      (l) =>
        (l.actionType === "stopped" || l.actionType === "stopped_and_notified") &&
        l.status === "success"
    );
    const adStopCounts = new Map<string, number>();
    for (const l of stopLogs) {
      adStopCounts.set(l.adId, (adStopCounts.get(l.adId) || 0) + 1);
    }
    for (const [adId, count] of adStopCounts) {
      if (count > 1) {
        const log = stopLogs.find((l) => l.adId === adId);
        issues.push(`Объявление ${log?.adName || adId}: остановлено ${count} раз`);
        status = "error";
      }
    }

    // UZ campaign overlap
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const uzRulesLocal = rules.filter(
      (r) => r.type === "uz_budget_manage" && r.isActive
    );

    if (uzRulesLocal.length >= 2) {
      for (let i = 0; i < uzRulesLocal.length; i++) {
        for (let j = i + 1; j < uzRulesLocal.length; j++) {
          const idsA = new Set(uzRulesLocal[i].targetCampaignIds || []);
          const overlap = (uzRulesLocal[j].targetCampaignIds || []).filter((id) =>
            idsA.has(id)
          );
          if (overlap.length > 0) {
            issues.push(
              `${overlap.length} кампаний в правилах "${uzRulesLocal[i].name}" и "${uzRulesLocal[j].name}"`
            );
            status = "error";
          }
        }
      }
    }

    const message = status === "ok" ? "ок" : issues.join("; ");
    return { name: "Дедупликация", status, message, details: issues };
  },
});

// ─── Block 2.9: Account Functionality ───

export const checkAccountFunctionality = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const account = await ctx.runQuery(internal.healthCheck.getAccount, {
      accountId: args.accountId,
    });
    const name = account?.name || "?";

    try {
      const result = await ctx.runAction(api.vkApi.fetchUzCampaigns, {
        accountId: args.accountId,
      });
      const totalCampaigns =
        result.adPlans.reduce((sum: number, p: any) => sum + p.campaigns.length, 0) +
        result.ungrouped.length;

      if (totalCampaigns === 0) {
        return {
          name: `Функции "${name}"`,
          status: "warning",
          message: `"${name}": нет кампаний/групп`,
          details: ["Кабинет пустой — правила создать нельзя"],
        };
      }
      if (result.adPlans.length === 0 && result.ungrouped.length > 0) {
        return {
          name: `Функции "${name}"`,
          status: "warning",
          message: `"${name}": ${totalCampaigns} кампаний, но нет UZ-групп`,
          details: ["Нет ad_plans — UZ-правило создать нельзя"],
        };
      }

      return {
        name: `Функции "${name}"`,
        status: "ok",
        message: `"${name}": ${result.adPlans.length} групп, ${totalCampaigns} кампаний`,
      };
    } catch (err) {
      return {
        name: `Функции "${name}"`,
        status: "error",
        message: `"${name}": ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`,
      };
    }
  },
});

// ─── Block 2.10: Budget Overspend ───

export const checkBudgetOverspend = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const account = await ctx.runQuery(internal.healthCheck.getAccount, {
      accountId: args.accountId,
    });
    const name = account?.name || "?";

    try {
      const result = await ctx.runAction(api.vkApi.fetchUzCampaigns, {
        accountId: args.accountId,
      });

      const issues: string[] = [];
      let overspendCount = 0;

      const allCampaigns = [
        ...result.adPlans.flatMap((p: any) => p.campaigns),
        ...result.ungrouped,
      ];

      // Check via metricsDaily
      const todayDate = todayStr();
      const metrics = await ctx.runQuery(
        internal.healthCheck.getAccountMetricsToday,
        { accountId: args.accountId, date: todayDate }
      );

      for (const m of metrics) {
        const campaign = allCampaigns.find(
          (c: any) => String(c.id) === m.adId || String(c.id) === (m as any).campaignId
        );
        if (!campaign?.budgetLimitDay || campaign.budgetLimitDay <= 0) continue;

        const budget = campaign.budgetLimitDay;
        const spent = m.spent;
        if (spent > budget * 1.05) {
          const pct = Math.round(((spent - budget) / budget) * 100);
          issues.push(
            `"${campaign.name}": бюджет ${budget}, потрачено ${spent} (+${pct}%)`
          );
          overspendCount++;
        }
      }

      if (overspendCount === 0) {
        return { name: `Перерасход "${name}"`, status: "ok", message: `"${name}": ок` };
      }

      const overspendStatus: CheckStatus = overspendCount > 3 ? "error" : "warning";
      return {
        name: `Перерасход "${name}"`,
        status: overspendStatus,
        message: `"${name}": ${overspendCount} групп с перерасходом`,
        details: issues,
      };
    } catch (err) {
      return {
        name: `Перерасход "${name}"`,
        status: "warning",
        message: `"${name}": не удалось проверить — ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`,
      };
    }
  },
});

export const getAccountMetricsToday = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    date: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId).eq("date", args.date)
      )
      .collect();
  },
});

// ─── Cycle 2 Orchestrator ───

export const runFunctionCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const startTime = Date.now();
    const TIMEOUT = 5 * 60_000; // 5 min

    // Get all users with at least 1 account
    const usersWithAccounts = await ctx.runQuery(
      internal.healthCheck.getUsersWithAccounts,
      {}
    );

    const userResults: UserCheckResult[] = [];
    let totalAccounts = 0;
    let totalRules = 0;

    for (const userId of usersWithAccounts) {
      if (Date.now() - startTime > TIMEOUT) {
        userResults.push({
          userId,
          userName: "?",
          email: "?",
          tier: "?",
          accounts: 0,
          rules: 0,
          status: "warning",
          checks: [{ name: "timeout", status: "warning", message: "Таймаут общей проверки" }],
        });
        break;
      }

      try {
        const result = await ctx.runAction(
          internal.healthCheck.checkUserFunctions,
          { userId: userId as Id<"users"> }
        );
        userResults.push(result);
        totalAccounts += result.accounts;
        totalRules += result.rules;
      } catch (err) {
        userResults.push({
          userId,
          userName: "?",
          email: "?",
          tier: "?",
          accounts: 0,
          rules: 0,
          status: "warning",
          checks: [{
            name: "error",
            status: "warning",
            message: `USER_CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
          }],
        });
      }
    }

    const statuses = userResults.map((u) => u.status);
    const report: FunctionReport = {
      type: "function",
      status: worstStatus(statuses),
      users: userResults,
      checkedUsers: userResults.length,
      checkedAccounts: totalAccounts,
      checkedRules: totalRules,
      warnings: userResults.filter((u) => u.status === "warning").length,
      errors: userResults.filter((u) => u.status === "error").length,
      duration: Date.now() - startTime,
    };

    // Save result
    await ctx.runMutation(internal.healthCheck.saveResult, {
      type: "function",
      status: report.status,
      summary: formatFunctionReport(report),
      details: report as any,
      checkedUsers: report.checkedUsers,
      checkedAccounts: report.checkedAccounts,
      checkedRules: report.checkedRules,
      warnings: report.warnings,
      errors: report.errors,
      duration: report.duration,
    });

    // Always send Telegram summary for Cycle 2
    const text = formatFunctionReport(report);
    if (text) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: ADMIN_CHAT_ID,
        text,
      });
    }
  },
});

// ─── Helper: get user IDs with accounts ───

export const getUsersWithAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    const activeAccounts = accounts.filter((a) => a.status !== "paused");
    const userIds = [...new Set(activeAccounts.map((a) => a.userId))];
    return userIds;
  },
});

// ─── Manual triggers ───

export const runManualFunctionCheck = action({
  args: {},
  handler: async (ctx) => {
    await ctx.runAction(internal.healthCheck.runFunctionCheck, {});
  },
});

export const runManualUserCheck = action({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const startTime = Date.now();
    const result = await ctx.runAction(
      internal.healthCheck.checkUserFunctions,
      { userId: args.userId }
    );

    const report: FunctionReport = {
      type: "user",
      status: result.status,
      users: [result],
      checkedUsers: 1,
      checkedAccounts: result.accounts,
      checkedRules: result.rules,
      warnings: result.checks.filter((c) => c.status === "warning").length,
      errors: result.checks.filter((c) => c.status === "error").length,
      duration: Date.now() - startTime,
    };

    await ctx.runMutation(internal.healthCheck.saveResult, {
      type: "user",
      targetUserId: args.userId,
      status: report.status,
      summary: formatFunctionReport(report),
      details: report as any,
      checkedUsers: 1,
      checkedAccounts: report.checkedAccounts,
      checkedRules: report.checkedRules,
      warnings: report.warnings,
      errors: report.errors,
      duration: report.duration,
    });

    const text = formatFunctionReport(report);
    if (text) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: ADMIN_CHAT_ID,
        text,
      });
    }
  },
});
