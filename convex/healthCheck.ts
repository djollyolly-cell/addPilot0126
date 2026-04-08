// convex/healthCheck.ts
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

export const checkCronHealth = internalQuery({
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

      // Stuck check
      if (hb.status === "running" && minutesAgo(hb.startedAt) > 10) {
        issues.push(`${cfg.label}: STUCK (${minutesAgo(hb.startedAt)} мин)`);
        status = "error";
        continue;
      }

      // Error check
      if (hb.error) {
        issues.push(`${cfg.label}: ошибка — ${hb.error.slice(0, 80)}`);
        status = "error";
        continue;
      }

      // Staleness check
      if (cfg.maxStaleMin && hb.finishedAt && minutesAgo(hb.finishedAt) > cfg.maxStaleMin) {
        issues.push(`${cfg.label}: отстаёт (${minutesAgo(hb.finishedAt)} мин)`);
        if (status === "ok") status = "warning";
      }
    }

    // ── Result verification ──

    // sync-metrics: count synced accounts
    const allAccounts = await ctx.db.query("adAccounts").collect();
    const activeAccounts = allAccounts.filter(
      (a) => a.status === "active" || a.status === "error"
    );
    const now = Date.now();
    const syncedCount = activeAccounts.filter(
      (a) => a.lastSyncAt && now - a.lastSyncAt < 10 * 60_000
    ).length;

    if (activeAccounts.length > 0 && syncedCount < activeAccounts.length) {
      issues.push(
        `sync: ${syncedCount}/${activeAccounts.length} синхронизированы`
      );
      if (status === "ok") status = "warning";
    }

    // uz-budget-reset: check for today's resets
    const today = todayStr();
    const todayStart = new Date(today).getTime();
    const uzRules = await ctx.db.query("rules").collect();
    const resetRules = uzRules.filter(
      (r) =>
        r.type === "uz_budget_manage" &&
        r.isActive &&
        (r.conditions as any).resetDaily === true
    );

    if (resetRules.length > 0) {
      const todayLogs = await ctx.db.query("actionLogs").collect();
      const resetLogs = todayLogs.filter(
        (l) => l.actionType === "budget_reset" && l.createdAt >= todayStart
      );

      for (const rule of resetRules) {
        const ruleResetCount = resetLogs.filter(
          (l) => l.ruleId === rule._id
        ).length;
        const targetCount = rule.targetCampaignIds?.length ?? 0;
        if (targetCount > 0 && ruleResetCount === 0) {
          issues.push(`Ресет "${rule.name}": не выполнен (0/${targetCount})`);
          status = "error";
        } else if (targetCount > 0 && ruleResetCount < targetCount) {
          issues.push(
            `Ресет "${rule.name}": частичный (${ruleResetCount}/${targetCount})`
          );
          status = "error";
        }
      }
    }

    // daily-digest: check sent
    const digestHb = heartbeats.find((h) => h.name === "sendDailyDigest");
    if (digestHb?.finishedAt && digestHb.finishedAt >= todayStart) {
      const settings = await ctx.db.query("userSettings").collect();
      const digestUsers = settings.filter((s) => s.digestEnabled);
      const sentNotifs = await ctx.db
        .query("notifications")
        .withIndex("by_status")
        .collect();
      const todayDigests = sentNotifs.filter(
        (n) =>
          n.type === "digest" &&
          n.createdAt >= todayStart &&
          n.status === "sent"
      );

      if (digestUsers.length > 0 && todayDigests.length === 0) {
        issues.push(
          `Дайджест: ${digestUsers.length} пользователей ожидали, 0 отправлено`
        );
        if (status === "ok") status = "warning";
      }
    }

    const message =
      status === "ok"
        ? `все кроны в норме`
        : `${issues.length} ${issues.length === 1 ? "проблема" : "проблем"}`;

    return {
      name: "Кроны",
      status,
      message,
      details: issues,
    };
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

      if (minutesAgo(acc.lastSyncAt) > 15) {
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
    const blockChecks = [
      { name: "checkCronHealth", fn: internal.healthCheck.checkCronHealth },
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
