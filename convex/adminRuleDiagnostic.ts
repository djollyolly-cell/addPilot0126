import { v } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  evaluateConditionTrace,
  matchesCampaignFilter,
  MetricsSnapshot,
} from "./ruleEngine";

// ═══════════════════════════════════════════════════════════
// Admin auth
// ═══════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

interface DiagRule {
  name: string;
  type: string;
  isActive: boolean;
  stopAd: boolean;
  triggerCount: number;
  targetAlive: boolean;
  problem: string | null;
}

interface DiagBanner {
  bannerId: string;
  campaignId: string;
  campaignName: string;
  spent: number;
  clicks: number;
  leads: number;
  cpl: number | null;
  isCovered: boolean;
  coveredByRules: string[];
  problem: string | null;
}

interface DiagTrace {
  bannerId: string;
  ruleName: string;
  stoppedAt: string;
  reason: string;
}

interface DiagProblem {
  category: string;
  message: string;
}

export interface UserDiagnostic {
  userId: string;
  name: string;
  email: string;
  tier: string;
  telegramConnected: boolean;
  error: string | null;
  rules: DiagRule[];
  banners: DiagBanner[];
  tracing: DiagTrace[];
  problems: DiagProblem[];
}

function emptyDiagnostic(
  user: { _id: any; name?: string; email: string; subscriptionTier?: string; telegramChatId?: string },
  error: string | null,
): UserDiagnostic {
  return {
    userId: user._id,
    name: user.name || user.email,
    email: user.email,
    tier: user.subscriptionTier || "freemium",
    telegramConnected: !!user.telegramChatId,
    error,
    rules: [],
    banners: [],
    tracing: [],
    problems: error ? [{ category: "ОШИБКА", message: error }] : [],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════
// Public query: user list for filter dropdown
// ═══════════════════════════════════════════════════════════

export const getUsersForFilter = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);

    const users = await ctx.db.query("users").collect();

    const result: {
      userId: string;
      name: string;
      email: string;
      tier: string;
      rulesCount: number;
      accountsCount: number;
    }[] = [];

    for (const user of users) {
      const accounts = await ctx.db
        .query("adAccounts")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .collect();
      if (accounts.length === 0) continue;

      const rules = await ctx.db
        .query("rules")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .collect();

      result.push({
        userId: user._id,
        name: user.name || user.email,
        email: user.email,
        tier: user.subscriptionTier || "freemium",
        rulesCount: rules.length,
        accountsCount: accounts.length,
      });
    }

    result.sort((a, b) => {
      if (a.rulesCount > 0 && b.rulesCount === 0) return -1;
      if (a.rulesCount === 0 && b.rulesCount > 0) return 1;
      return a.name.localeCompare(b.name);
    });

    return result;
  },
});

// ═══════════════════════════════════════════════════════════
// Internal queries for action
// ═══════════════════════════════════════════════════════════

export const verifyAdmin = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.sessionToken))
      .first();
    if (!session || session.expiresAt < Date.now()) return null;
    const user = await ctx.db.get(session.userId);
    if (!user) return null;
    if (user.isAdmin !== true && !ADMIN_EMAILS.includes(user.email)) return null;
    return { userId: user._id };
  },
});

export const getUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});

export const getUserRules = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

export const getUserAccounts = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

export const getActionLogs = internalQuery({
  args: {
    userId: v.id("users"),
    dateFromTs: v.number(),
    dateToTs: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    return logs.filter(
      (l) => l.createdAt >= args.dateFromTs && l.createdAt <= args.dateToTs
    );
  },
});

// ═══════════════════════════════════════════════════════════
// Main action: diagnose one user
// ═══════════════════════════════════════════════════════════

export const runDiagnosticForUser = action({
  args: {
    sessionToken: v.string(),
    userId: v.string(),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args): Promise<UserDiagnostic> => {
    // 1. Verify admin
    const adminCheck = await ctx.runQuery(
      internal.adminRuleDiagnostic.verifyAdmin,
      { sessionToken: args.sessionToken }
    );
    if (!adminCheck) throw new Error("Forbidden");

    // 2. Get target user
    const user = await ctx.runQuery(
      internal.adminRuleDiagnostic.getUser,
      { userId: args.userId as Id<"users"> }
    );
    if (!user) {
      return emptyDiagnostic(
        { _id: args.userId, email: "?" } as any,
        "Пользователь не найден"
      );
    }

    try {
      return await diagnoseUser(ctx, user, args.dateFrom, args.dateTo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("TOKEN_EXPIRED") || msg.includes("401")) {
        return emptyDiagnostic(user, "Токен VK истёк");
      }
      return emptyDiagnostic(user, `Ошибка: ${msg}`);
    }
  },
});

// ═══════════════════════════════════════════════════════════
// Core diagnostic logic
// ═══════════════════════════════════════════════════════════

async function diagnoseUser(
  ctx: any,
  user: any,
  dateFrom: string,
  dateTo: string,
): Promise<UserDiagnostic> {
  // 3. Get rules
  const allRules = await ctx.runQuery(
    internal.adminRuleDiagnostic.getUserRules,
    { userId: user._id }
  );

  // 4. Get accounts
  const accounts = await ctx.runQuery(
    internal.adminRuleDiagnostic.getUserAccounts,
    { userId: user._id }
  );

  if (accounts.length === 0) {
    return {
      ...emptyDiagnostic(user, null),
      rules: allRules.map((r: any) => ({
        name: r.name,
        type: r.type,
        isActive: r.isActive,
        stopAd: r.actions?.stopAd ?? false,
        triggerCount: r.triggerCount || 0,
        targetAlive: false,
        problem: "Нет рекламных кабинетов",
      })),
      problems: [{ category: "КАБИНЕТЫ", message: "Нет рекламных кабинетов" }],
    };
  }

  // 5. Get action logs for date range
  const dateFromTs = new Date(dateFrom + "T00:00:00Z").getTime();
  const dateToTs = new Date(dateTo + "T23:59:59Z").getTime();
  const actionLogs = await ctx.runQuery(
    internal.adminRuleDiagnostic.getActionLogs,
    { userId: user._id, dateFromTs, dateToTs }
  );

  const logsByRule = new Map<string, any[]>();
  for (const log of actionLogs) {
    const key = log.ruleId;
    if (!logsByRule.has(key)) logsByRule.set(key, []);
    logsByRule.get(key)!.push(log);
  }

  // 6. For each account: fetch VK API data
  const allBanners: DiagBanner[] = [];
  const allTracing: DiagTrace[] = [];
  const problems: DiagProblem[] = [];

  const liveCampaignIds = new Set<string>();
  const adCampaignMap = new Map<string, { adGroupId: string; adPlanId: string | null }>();

  for (const account of accounts) {
    if (!account.accessToken) {
      problems.push({ category: "ТОКЕН", message: `Кабинет ${account.name}: нет токена` });
      continue;
    }

    // Fetch campaigns
    let campaigns: any[] = [];
    try {
      campaigns = await ctx.runAction(api.vkApi.getMtCampaigns, {
        accessToken: account.accessToken,
      });
      await sleep(200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("TOKEN_EXPIRED") || msg.includes("401")) {
        throw err;
      }
      problems.push({ category: "VK_API", message: `Кабинет ${account.name}: ошибка получения кампаний` });
      continue;
    }

    for (const c of campaigns) {
      liveCampaignIds.add(String(c.id));
    }

    // Fetch banners
    let banners: any[] = [];
    try {
      banners = await ctx.runAction(api.vkApi.getMtBanners, {
        accessToken: account.accessToken,
      });
      await sleep(200);
    } catch {
      problems.push({ category: "VK_API", message: `Кабинет ${account.name}: ошибка получения баннеров` });
      continue;
    }

    // Build adId → campaign mapping
    for (const b of banners) {
      const campaign = campaigns.find((c: any) => c.id === b.campaign_id);
      adCampaignMap.set(String(b.id), {
        adGroupId: String(b.campaign_id),
        adPlanId: campaign?.package_id ? String(campaign.package_id) : null,
      });
    }

    // Fetch statistics
    let stats: any[] = [];
    if (banners.length > 0) {
      try {
        const bannerIds = banners.map((b: any) => String(b.id)).join(",");
        stats = await ctx.runAction(api.vkApi.getMtStatistics, {
          accessToken: account.accessToken,
          dateFrom,
          dateTo,
          bannerIds,
        });
        await sleep(200);
      } catch {
        problems.push({ category: "VK_API", message: `Кабинет ${account.name}: ошибка получения статистики` });
      }
    }

    // Aggregate stats per banner
    const bannerStats = new Map<string, { spent: number; clicks: number; leads: number; impressions: number }>();
    for (const item of stats) {
      const bid = String(item.id);
      if (!bannerStats.has(bid)) {
        bannerStats.set(bid, { spent: 0, clicks: 0, leads: 0, impressions: 0 });
      }
      const agg = bannerStats.get(bid)!;
      for (const row of item.rows || []) {
        agg.spent += parseFloat(row.base?.spent || "0");
        agg.clicks += parseInt(row.base?.clicks || "0", 10);
        agg.impressions += parseInt(row.base?.impressions || "0", 10);
        const baseGoals = parseInt(row.base?.goals || "0", 10);
        const vkResult = parseInt(row.base?.["vk.result"] || "0", 10);
        const vkGoals = parseInt(row.base?.["vk.goals"] || "0", 10);
        const eventsGoals = row.events
          ? Object.values(row.events as Record<string, string>).reduce(
              (s: number, val: string) => s + parseInt(val || "0", 10),
              0
            )
          : 0;
        agg.leads += Math.max(baseGoals, vkResult, vkGoals, eventsGoals);
      }
    }

    // Build coverage and tracing per banner with spend
    const rulesForAccount = allRules.filter((r: any) =>
      r.targetAccountIds?.includes(account._id as string)
    );

    for (const [bid, bStats] of bannerStats) {
      if (bStats.spent <= 0) continue;

      const banner = banners.find((b: any) => String(b.id) === bid);
      const campaignId = banner ? String(banner.campaign_id) : "";
      const campaignName =
        campaigns.find((c: any) => String(c.id) === campaignId)?.name || campaignId;

      const coveredBy: string[] = [];

      for (const rule of rulesForAccount) {
        if (!rule.isActive) continue;

        // Step 2: targetAdIds filter
        if (rule.targetAdIds && rule.targetAdIds.length > 0) {
          if (!rule.targetAdIds.includes(bid)) {
            allTracing.push({
              bannerId: bid,
              ruleName: rule.name,
              stoppedAt: "step2_not_in_target_ads",
              reason: "Баннер не в списке таргетных adIds",
            });
            continue;
          }
        }

        // Step 3: campaign filter
        if (rule.targetCampaignIds && rule.targetCampaignIds.length > 0) {
          const mapping = adCampaignMap.get(bid);
          const adGroupId = mapping?.adGroupId ?? null;
          const adPlanId = mapping?.adPlanId ?? null;
          if (!matchesCampaignFilter(rule.targetCampaignIds, adGroupId, adPlanId)) {
            allTracing.push({
              bannerId: bid,
              ruleName: rule.name,
              stoppedAt: "step3_campaign_mismatch",
              reason: `Кампания ${adGroupId} не в таргетах правила`,
            });
            continue;
          }
        }

        // Step 5: dedup check
        const ruleLogs = logsByRule.get(rule._id as string) || [];
        const hasActiveStop = ruleLogs.some(
          (l: any) =>
            l.adId === bid &&
            l.status === "success" &&
            (l.actionType === "stopped" || l.actionType === "stopped_and_notified")
        );
        if (hasActiveStop) {
          allTracing.push({
            bannerId: bid,
            ruleName: rule.name,
            stoppedAt: "step5_permanent_dedup",
            reason: "Баннер уже остановлен этим правилом (permanent dedup)",
          });
          coveredBy.push(rule.name);
          continue;
        }

        // Step 6: evaluate condition
        const metricsSnapshot: MetricsSnapshot = {
          spent: bStats.spent,
          leads: bStats.leads,
          impressions: bStats.impressions,
          clicks: bStats.clicks,
        };

        const trace = evaluateConditionTrace(
          rule.type,
          rule.conditions,
          metricsSnapshot
        );
        allTracing.push({
          bannerId: bid,
          ruleName: rule.name,
          stoppedAt: trace.stoppedAt,
          reason: trace.reason,
        });

        coveredBy.push(rule.name);
      }

      const cpl = bStats.leads > 0 ? bStats.spent / bStats.leads : null;
      allBanners.push({
        bannerId: bid,
        campaignId,
        campaignName,
        spent: Math.round(bStats.spent * 100) / 100,
        clicks: bStats.clicks,
        leads: bStats.leads,
        cpl: cpl !== null ? Math.round(cpl * 100) / 100 : null,
        isCovered: coveredBy.length > 0,
        coveredByRules: coveredBy,
        problem: coveredBy.length === 0 ? "Без покрытия правилами" : null,
      });
    }
  }

  // 7. Build rules diagnostics
  const diagRules: DiagRule[] = allRules.map((r: any) => {
    let targetAlive = true;
    if (r.targetCampaignIds && r.targetCampaignIds.length > 0) {
      targetAlive = r.targetCampaignIds.some((cid: string) =>
        liveCampaignIds.has(cid)
      );
    }

    const ruleLogs = logsByRule.get(r._id as string) || [];
    let problem: string | null = null;
    if (!r.isActive) problem = "Правило неактивно";
    else if (!targetAlive) problem = "Целевые кампании не найдены в VK";
    else if (!r.actions?.stopAd) problem = "Только уведомление, без остановки";

    return {
      name: r.name,
      type: r.type,
      isActive: r.isActive,
      stopAd: r.actions?.stopAd ?? false,
      triggerCount: ruleLogs.length,
      targetAlive,
      problem,
    };
  });

  // 8. Identify problems
  const uncoveredBanners = allBanners.filter((b) => !b.isCovered && b.spent > 0);
  if (uncoveredBanners.length > 0) {
    const total = uncoveredBanners.reduce((s, b) => s + b.spent, 0);
    problems.push({
      category: "ПОКРЫТИЕ",
      message: `${uncoveredBanners.length} баннер(ов) с расходом ${Math.round(total)}₽ без покрытия правилами`,
    });
  }

  const inertRules = diagRules.filter((r) => r.isActive && !r.targetAlive);
  if (inertRules.length > 0) {
    problems.push({
      category: "ИНЕРТНЫЕ",
      message: `${inertRules.length} правил(о) нацелены на несуществующие кампании: ${inertRules.map((r) => r.name).join(", ")}`,
    });
  }

  const permanentDedup = allTracing.filter(
    (t) => t.stoppedAt === "step5_permanent_dedup"
  );
  if (permanentDedup.length > 0) {
    const uniqueBanners = new Set(permanentDedup.map((t) => t.bannerId));
    problems.push({
      category: "DEDUP",
      message: `${uniqueBanners.size} баннер(ов) с permanent dedup (остановлены, но продолжают крутиться)`,
    });
  }

  if (!user.telegramChatId) {
    problems.push({
      category: "TELEGRAM",
      message: "Telegram не подключён — уведомления не работают",
    });
  }

  return {
    userId: user._id,
    name: user.name || user.email,
    email: user.email,
    tier: user.subscriptionTier || "freemium",
    telegramConnected: !!user.telegramChatId,
    error: null,
    rules: diagRules,
    banners: allBanners.sort((a, b) => b.spent - a.spent),
    tracing: allTracing,
    problems,
  };
}
