import { v } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  computeRealtimeDelta,
  evaluateConditionTrace,
  matchesCampaignFilter,
  MetricsSnapshot,
} from "./ruleEngine";
import type { MtCampaign, MtBanner, MtStatItem } from "./vkApi";

// ═══════════════════════════════════════════════════════════
// Admin auth
// ═══════════════════════════════════════════════════════════

const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];

async function assertAdmin(ctx: QueryCtx, sessionToken: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", sessionToken))
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
  user: { _id: Id<"users"> | string; name?: string; email: string; subscriptionTier?: string; telegramChatId?: string },
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
        { _id: args.userId, email: "?" },
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
  ctx: ActionCtx,
  user: Doc<"users">,
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
      rules: allRules.map((r: Doc<"rules">) => ({
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

  const logsByRule = new Map<string, Doc<"actionLogs">[]>();
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
    let campaigns: MtCampaign[] = [];
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
      if (c.package_id) {
        liveCampaignIds.add(String(c.package_id));
      }
    }

    // Fetch ad_plans (new VK Ads format: campaigns are ad_plans, not campaigns.json)
    // Rules may target ad_plan IDs which are not returned by campaigns.json
    try {
      const adPlans = await ctx.runAction(api.vkApi.getMtAdPlans, {
        accessToken: account.accessToken,
      });
      await sleep(200);
      for (const plan of adPlans) {
        liveCampaignIds.add(String(plan.id));
      }
    } catch {
      // Non-fatal: ad_plans may not be available for legacy accounts
    }

    // Fetch banners
    let banners: MtBanner[] = [];
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
      const campaign = campaigns.find((c) => c.id === b.campaign_id);
      adCampaignMap.set(String(b.id), {
        adGroupId: String(b.campaign_id),
        adPlanId: campaign?.package_id ? String(campaign.package_id) : null,
      });
    }

    // VK stats — used ONLY for banner list display, NOT for rule evaluation.
    // Rule evaluation uses DB metricsDaily (same source as ruleEngine).
    let stats: MtStatItem[] = [];
    if (banners.length > 0) {
      try {
        const bannerIds = banners.map((b) => String(b.id)).join(",");
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
        // VK API stat rows have a looser shape than typed interface at runtime
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const base = row.base as Record<string, any> | undefined;
        agg.spent += parseFloat(base?.spent || "0");
        agg.clicks += parseInt(base?.clicks || "0", 10);
        agg.impressions += parseInt(base?.impressions || "0", 10);
        const baseGoals = parseInt(base?.goals || "0", 10);
        const vkResult = parseInt(base?.["vk.result"] || "0", 10);
        const vkGoals = parseInt(base?.["vk.goals"] || "0", 10);
        const eventsGoals = row.events
          ? Object.values(row.events as Record<string, unknown>).reduce(
              (s: number, val) => s + parseInt(String(val || "0"), 10),
              0
            )
          : 0;
        agg.leads += Math.max(baseGoals, vkResult, vkGoals, eventsGoals);
      }
    }

    // DB metrics (same source as ruleEngine)
    const todayStr = dateTo;
    const dailyMetrics = await ctx.runQuery(
      internal.ruleEngine.getAccountTodayMetrics,
      { accountId: account._id, date: todayStr }
    );
    const todayMetricsByAd = new Map<string, { spent: number; leads: number; impressions: number; clicks: number }>();
    for (const m of dailyMetrics) {
      todayMetricsByAd.set(m.adId, m);
    }

    // Build coverage and tracing per banner
    const rulesForAccount = allRules.filter((r: Doc<"rules">) =>
      r.targetAccountIds?.includes(account._id)
    );

    for (const banner of banners) {
      const bid = String(banner.id);
      const dbMetric = todayMetricsByAd.get(bid);
      const vkStats = bannerStats.get(bid);
      const displayStats = vkStats || { spent: 0, clicks: 0, leads: 0, impressions: 0 };

      // Skip banners with no data at all
      if (!dbMetric && !vkStats?.spent) continue;

      const campaignId = String(banner.campaign_id);
      const campaignName =
        campaigns.find((c) => String(c.id) === campaignId)?.name || campaignId;

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

        // Step 5: dedup check (exact same logic as ruleEngine)
        const todayStart = new Date(todayStr + "T00:00:00Z").getTime();
        const alreadyTriggered = await ctx.runQuery(
          internal.ruleEngine.isAlreadyTriggeredToday,
          { ruleId: rule._id, adId: bid, sinceTimestamp: todayStart }
        );
        if (alreadyTriggered) {
          allTracing.push({
            bannerId: bid,
            ruleName: rule.name,
            stoppedAt: "step5_dedup",
            reason: "Дедупликация: правило уже сработало для этого баннера (permanent/daily/retry limit)",
          });
          coveredBy.push(rule.name);
          continue;
        }

        // Step 5b: minSamples check (same as ruleEngine:1531-1538)
        if (rule.conditions.minSamples) {
          const history = await ctx.runQuery(
            internal.ruleEngine.getRealtimeHistory,
            { adId: bid, sinceTimestamp: Date.now() - 24 * 60 * 60 * 1000 }
          );
          if (history.length < rule.conditions.minSamples) {
            allTracing.push({
              bannerId: bid,
              ruleName: rule.name,
              stoppedAt: "step5b_min_samples",
              reason: `Недостаточно данных: ${history.length} снимков за 24ч < minSamples ${rule.conditions.minSamples}`,
            });
            continue;
          }
        }

        // Step 6: build metricsSnapshot (timeWindow-aware, same as ruleEngine:1574-1619)
        const timeWindow = rule.conditions.timeWindow;
        const needsAllAds =
          (rule.type === "clicks_no_leads" || rule.type === "low_impressions") &&
          timeWindow && timeWindow !== "daily";

        let metricsSnapshot: MetricsSnapshot;

        if (needsAllAds && (timeWindow === "1h" || timeWindow === "6h")) {
          const windowMs = timeWindow === "1h" ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
          const sinceTs = Date.now() - windowMs;
          const history = await ctx.runQuery(
            internal.ruleEngine.getRealtimeHistory,
            { adId: bid, sinceTimestamp: sinceTs }
          );
          const delta = computeRealtimeDelta(history);
          metricsSnapshot = {
            spent: delta.spent,
            leads: delta.leads,
            impressions: delta.impressions,
            clicks: delta.clicks,
          };
        } else if (needsAllAds && (timeWindow === "24h" || timeWindow === "since_launch")) {
          let sinceDate: string | undefined;
          if (timeWindow === "24h") {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            sinceDate = yesterday.toISOString().slice(0, 10);
          }
          const aggregated = await ctx.runQuery(
            internal.ruleEngine.getAdAggregatedMetrics,
            { adId: bid, sinceDate }
          );
          metricsSnapshot = {
            spent: aggregated.spent,
            leads: aggregated.leads,
            impressions: aggregated.impressions,
            clicks: aggregated.clicks,
          };
        } else if (dbMetric) {
          metricsSnapshot = {
            spent: dbMetric.spent,
            leads: dbMetric.leads,
            impressions: dbMetric.impressions,
            clicks: dbMetric.clicks,
          };
        } else {
          // No DB metrics and not a time-windowed rule — skip (engine skips too)
          continue;
        }

        // Build context for fast_spend (same as ruleEngine:1545-1572)
        let context:
          | { spendHistory?: { spent: number; timestamp: number }[]; dailyBudget?: number }
          | undefined;

        if (rule.type === "fast_spend") {
          const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
          const history = await ctx.runQuery(
            internal.ruleEngine.getRealtimeHistory,
            { adId: bid, sinceTimestamp: fifteenMinAgo }
          );
          const dbBudget = await ctx.runQuery(
            internal.ruleEngine.getCampaignDailyLimit,
            { adId: bid }
          );
          context = {
            spendHistory: history.map((h: { spent: number; timestamp: number }) => ({
              spent: h.spent,
              timestamp: h.timestamp,
            })),
            dailyBudget: dbBudget ?? undefined,
          };
        }

        // Step 7: evaluate condition
        const trace = evaluateConditionTrace(
          rule.type,
          rule.conditions,
          metricsSnapshot,
          context
        );

        // Safety check indicator (ruleEngine:1645-1707)
        let safetyNote = "";
        if (
          trace.triggered &&
          rule.actions?.stopAd &&
          (rule.type === "clicks_no_leads" || rule.type === "cpl_limit") &&
          metricsSnapshot.leads === 0
        ) {
          safetyNote = " [⚠ safety check: движок перепроверит лиды через VK API перед остановкой]";
        }

        allTracing.push({
          bannerId: bid,
          ruleName: rule.name,
          stoppedAt: trace.stoppedAt,
          reason: trace.reason + safetyNote,
        });

        coveredBy.push(rule.name);
      }

      const cpl = displayStats.leads > 0 ? displayStats.spent / displayStats.leads : null;
      allBanners.push({
        bannerId: bid,
        campaignId,
        campaignName,
        spent: Math.round(displayStats.spent * 100) / 100,
        clicks: displayStats.clicks,
        leads: displayStats.leads,
        cpl: cpl !== null ? Math.round(cpl * 100) / 100 : null,
        isCovered: coveredBy.length > 0,
        coveredByRules: coveredBy,
        problem: coveredBy.length === 0 ? "Без покрытия правилами" : null,
      });
    }
  }

  // 7. Build rules diagnostics
  const diagRules: DiagRule[] = allRules.map((r: Doc<"rules">) => {
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

  const dedupTraces = allTracing.filter(
    (t) => t.stoppedAt === "step5_dedup" || t.stoppedAt === "step5_permanent_dedup"
  );
  if (dedupTraces.length > 0) {
    const uniqueBanners = new Set(dedupTraces.map((t) => t.bannerId));
    problems.push({
      category: "DEDUP",
      message: `${uniqueBanners.size} баннер(ов) с дедупликацией (остановлены/повторно сработали)`,
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
