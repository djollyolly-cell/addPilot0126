import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { withTimeout } from "./vkApi";
import { CUSTOM_RULE_HANDLERS } from "./customRules";
import {
  groupRulesByAccount,
  filterCampaignsForRule,
  shouldTriggerBudgetIncrease,
  calculateNewBudget,
  type UzRule,
  type VkCampaign,
} from "./uzBudgetHelpers";

const ACCOUNT_TIMEOUT_MS = 90_000; // 90s per account

// Batch worker constants
const UZ_WORKER_COUNT = 6;
const UZ_WORKER_TIMEOUT_MS = 540_000; // 9 min
const UZ_BATCH_ACCOUNT_TIMEOUT_MS = 90_000; // 90s per account (same as current)

// ═══════════════════════════════════════════════════════════
// Pure functions — exported for direct unit testing
// ═══════════════════════════════════════════════════════════

export interface MetricsSnapshot {
  spent: number;
  leads: number;
  impressions: number;
  clicks: number;
  cpl?: number;
  ctr?: number;
  cpc?: number;        // computed: spent/clicks (L2 constructor metric)
  reach?: number;      // raw from metricsDaily (L2 constructor metric)
  campaignType?: string; // "lead" | "message" | "subscription" | "awareness"
}

export interface RuleCondition {
  metric: string;
  operator: string;
  value: number;
  minSamples?: number;
  timeWindow?: "daily" | "since_launch" | "24h" | "1h" | "6h";
  minSpent?: number;  // cpc_limit: minimum spent before evaluating CPC
}

export interface SpendSnapshot {
  spent: number;
  timestamp: number;
}

/**
 * Dual-matching campaign filter: checks if an ad's campaign matches
 * rule.targetCampaignIds by either ad_group_id or ad_plan_id.
 * Same pattern as uzBudgetHelpers.filterCampaignsForRule.
 */
export function matchesCampaignFilter(
  targetCampaignIds: string[],
  adGroupId: string | null,
  adPlanId: string | null
): boolean {
  if (!adGroupId && !adPlanId) return false;
  const matchesDirect = adGroupId !== null && targetCampaignIds.includes(adGroupId);
  const matchesPlan = adPlanId !== null && targetCampaignIds.includes(adPlanId);
  return matchesDirect || matchesPlan;
}

/**
 * Compute the delta of cumulative metrics between the oldest and newest
 * realtime snapshots. Used for 1h/6h time windows where metricsRealtime
 * stores cumulative values and we need the difference.
 */
export function computeRealtimeDelta(
  snapshots: { impressions: number; clicks: number; spent: number; leads: number; timestamp: number }[]
): { impressions: number; clicks: number; spent: number; leads: number } {
  if (snapshots.length <= 1) {
    return { impressions: 0, clicks: 0, spent: 0, leads: 0 };
  }
  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  return {
    impressions: newest.impressions - oldest.impressions,
    clicks: newest.clicks - oldest.clicks,
    spent: newest.spent - oldest.spent,
    leads: newest.leads - oldest.leads,
  };
}

/**
 * Context for evaluateCondition — optional, backward-compatible.
 * All existing L1 call sites continue to work without it.
 */
export interface EvalContext {
  spendHistory?: SpendSnapshot[];
  dailyBudget?: number;
  customRuleTypeCode?: string;  // L3: dispatch key to CUSTOM_RULE_HANDLERS
  meta?: Record<string, unknown>;  // L3: per-handler additional data
}

/**
 * Get metric value by string key.
 * Used by L2 constructor evaluator. Returns undefined for unknown keys
 * or when computation requires data that's missing.
 */
export function getMetricValue(metric: string, m: MetricsSnapshot): number | undefined {
  switch (metric) {
    case "spent": return m.spent;
    case "leads": return m.leads;
    case "clicks": return m.clicks;
    case "impressions": return m.impressions;
    case "cpl": return m.cpl !== undefined ? m.cpl : (m.leads > 0 ? m.spent / m.leads : undefined);
    case "ctr": return m.ctr !== undefined ? m.ctr : (m.impressions > 0 ? (m.clicks / m.impressions) * 100 : undefined);
    case "cpc": return m.cpc !== undefined ? m.cpc : (m.clicks > 0 ? m.spent / m.clicks : undefined);
    case "reach": return m.reach;
    default: return undefined;
  }
}

const CONDITION_OPERATORS: Record<string, (a: number, b: number) => boolean> = {
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b,
};

/**
 * Evaluate L2 array of conditions with AND logic.
 * Returns false if any metric is undefined or any condition fails.
 */
export function evaluateCustomConditions(
  conditions: RuleCondition[],
  metrics: MetricsSnapshot
): boolean {
  if (conditions.length === 0) return false;
  for (const cond of conditions) {
    const value = getMetricValue(cond.metric, metrics);
    if (value === undefined) return false;
    const op = CONDITION_OPERATORS[cond.operator];
    if (!op) return false;
    if (!op(value, cond.value)) return false;
  }
  return true;
}

/**
 * Evaluate whether a rule condition is met.
 * Returns true if the rule should trigger (ad should be stopped/notified).
 */
export function evaluateCondition(
  ruleType: string,
  condition: RuleCondition | RuleCondition[],
  metrics: MetricsSnapshot,
  context: EvalContext = {}
): boolean {
  // L2: type='custom' — array of conditions, AND
  if (ruleType === "custom") {
    if (!Array.isArray(condition)) return false;
    return evaluateCustomConditions(condition, metrics);
  }

  // L1: existing 9 types — expects single object
  if (Array.isArray(condition)) {
    // Should not happen for L1, but defensive
    return false;
  }

  switch (ruleType) {
    case "cpl_limit": {
      if (metrics.leads > 0) {
        const cpl = metrics.spent / metrics.leads;
        return cpl > condition.value;
      }
      // leads=0: если расход уже превышает CPL-порог,
      // даже 1 лид не снизит CPL ниже лимита
      return metrics.spent > condition.value;
    }

    case "min_ctr": {
      const ctr =
        metrics.impressions > 0
          ? (metrics.clicks / metrics.impressions) * 100
          : undefined;
      if (ctr === undefined) return false;
      return ctr < condition.value;
    }

    case "fast_spend": {
      if (!context?.spendHistory || context.spendHistory.length < 2)
        return false;
      const sorted = [...context.spendHistory].sort(
        (a, b) => a.timestamp - b.timestamp
      );
      const oldest = sorted[0];
      const newest = sorted[sorted.length - 1];
      const spentDiff = newest.spent - oldest.spent;
      const budget = context.dailyBudget;
      if (!budget || budget <= 0) return false;
      const percentSpent = (spentDiff / budget) * 100;
      return percentSpent > condition.value;
    }

    case "spend_no_leads": {
      return metrics.spent > condition.value && metrics.leads === 0;
    }

    case "budget_limit": {
      return metrics.spent > condition.value;
    }

    case "low_impressions": {
      // Все метрики нулевые = нет данных (новое объявление или нет снэпшотов)
      if (metrics.impressions === 0 && metrics.spent === 0 && metrics.clicks === 0)
        return false;
      return metrics.impressions < condition.value;
    }

    case "clicks_no_leads": {
      return metrics.clicks >= condition.value && metrics.leads === 0;
    }

    case "cpc_limit": {
      const minSpent = condition.minSpent ?? 0;
      if (metrics.spent < minSpent) return false;
      if (metrics.clicks === 0) return true;
      const cpc = metrics.spent / metrics.clicks;
      return cpc > condition.value;
    }

    case "new_lead": {
      // Skip subscription/awareness campaigns — vk.result for these is community joins, not leads
      if (metrics.campaignType === "subscription" || metrics.campaignType === "awareness")
        return false;
      // Triggers when leads > 0 (new lead detected).
      // The condition.value is ignored — any lead count > 0 triggers.
      // Dedup ensures this fires only once per ad per day.
      return metrics.leads > 0;
    }

    // uz_budget_manage: never triggers via standard evaluate — handled separately
    case "uz_budget_manage":
      return false;

    case "custom_l3": {
      // L3: dispatch to CUSTOM_RULE_HANDLERS via customRuleTypeCode
      if (Array.isArray(condition)) return false;
      const handlerCode = context?.customRuleTypeCode;
      if (!handlerCode) return false;
      const handler = CUSTOM_RULE_HANDLERS[handlerCode];
      if (!handler) return false;
      return handler.eval(condition, metrics, context);
    }

    default:
      return false;
  }
}

export interface TraceResult {
  triggered: boolean;
  stoppedAt: string;
  reason: string;
}

/**
 * Trace version of evaluateCondition — returns step code + human-readable reason.
 * Covers only step 6 (condition evaluation). Steps 1-5 (metrics presence,
 * campaign filter, dedup) are handled by the diagnostic action caller.
 */
export function evaluateConditionTrace(
  ruleType: string,
  condition: RuleCondition | RuleCondition[],
  metrics: MetricsSnapshot,
  context: EvalContext = {}
): TraceResult {
  // L2: type='custom' — array of conditions, AND with detailed trace
  if (ruleType === "custom") {
    if (!Array.isArray(condition)) {
      return { triggered: false, stoppedAt: "step6_custom_not_array", reason: "type=custom требует массив условий" };
    }
    if (condition.length === 0) {
      return { triggered: false, stoppedAt: "step6_no_conditions", reason: "Список условий пустой" };
    }
    const failedConditions: string[] = [];
    for (const c of condition) {
      const value = getMetricValue(c.metric, metrics);
      if (value === undefined) {
        return { triggered: false, stoppedAt: "step6_metric_undefined", reason: `Метрика "${c.metric}" недоступна` };
      }
      const op = CONDITION_OPERATORS[c.operator];
      if (!op) {
        return { triggered: false, stoppedAt: "step6_unknown_operator", reason: `Неизвестный оператор: ${c.operator}` };
      }
      if (!op(value, c.value)) {
        failedConditions.push(`${c.metric}=${value} ${c.operator} ${c.value} → false`);
      }
    }
    if (failedConditions.length > 0) {
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `Не выполнено: ${failedConditions.join("; ")}` };
    }
    return { triggered: true, stoppedAt: "triggered", reason: `Все ${condition.length} условий выполнены` };
  }

  // L1: single object expected
  if (Array.isArray(condition)) {
    return { triggered: false, stoppedAt: "step6_array_for_non_custom", reason: `Массив условий поддерживается только для type=custom (получен type=${ruleType})` };
  }

  switch (ruleType) {
    case "cpl_limit": {
      if (metrics.leads > 0) {
        const cpl = metrics.spent / metrics.leads;
        if (cpl > condition.value)
          return { triggered: true, stoppedAt: "triggered", reason: `CPL ${Math.round(cpl)}₽ > порог ${condition.value}₽` };
        return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `CPL ${Math.round(cpl)}₽ ≤ порог ${condition.value}₽` };
      }
      // leads=0: расход как нижняя граница CPL
      if (metrics.spent > condition.value)
        return { triggered: true, stoppedAt: "triggered", reason: `Расход ${Math.round(metrics.spent)}₽ > порог ${condition.value}₽, лидов: 0 (CPL превышен)` };
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `Расход ${Math.round(metrics.spent)}₽ ≤ порог ${condition.value}₽, лидов: 0 (ожидание)` };
    }

    case "min_ctr": {
      const ctr =
        metrics.impressions > 0
          ? (metrics.clicks / metrics.impressions) * 100
          : undefined;
      if (ctr === undefined)
        return { triggered: false, stoppedAt: "step6_ctr_undefined", reason: "CTR невычислим: impressions=0" };
      if (ctr < condition.value)
        return { triggered: true, stoppedAt: "triggered", reason: `CTR ${ctr.toFixed(2)}% < порог ${condition.value}%` };
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `CTR ${ctr.toFixed(2)}% ≥ порог ${condition.value}%` };
    }

    case "fast_spend": {
      if (!context?.spendHistory || context.spendHistory.length < 2)
        return { triggered: false, stoppedAt: "step6_condition_not_met", reason: "Недостаточно snapshot-ов расхода (нужно минимум 2 за 15 мин)" };
      const sorted = [...context.spendHistory].sort(
        (a, b) => a.timestamp - b.timestamp
      );
      const oldest = sorted[0];
      const newest = sorted[sorted.length - 1];
      const spentDiff = newest.spent - oldest.spent;
      const budget = context.dailyBudget;
      if (!budget || budget <= 0)
        return { triggered: false, stoppedAt: "step6_no_budget", reason: "Дневной бюджет не задан ни на группе, ни на кампании" };
      const percentSpent = (spentDiff / budget) * 100;
      if (percentSpent > condition.value)
        return { triggered: true, stoppedAt: "triggered", reason: `Потрачено ${Math.round(spentDiff)}₽ за 15 мин = ${percentSpent.toFixed(0)}% бюджета ${budget}₽ > порог ${condition.value}%` };
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `Потрачено ${Math.round(spentDiff)}₽ за 15 мин = ${percentSpent.toFixed(0)}% бюджета ${budget}₽ ≤ порог ${condition.value}%` };
    }

    case "spend_no_leads": {
      if (metrics.spent > condition.value && metrics.leads === 0)
        return { triggered: true, stoppedAt: "triggered", reason: `Расход ${Math.round(metrics.spent)}₽ > ${condition.value}₽, лидов: 0` };
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `Расход ${Math.round(metrics.spent)}₽, лидов: ${metrics.leads}` };
    }

    case "budget_limit": {
      if (metrics.spent > condition.value)
        return { triggered: true, stoppedAt: "triggered", reason: `Расход ${Math.round(metrics.spent)}₽ > лимит ${condition.value}₽` };
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `Расход ${Math.round(metrics.spent)}₽ ≤ лимит ${condition.value}₽` };
    }

    case "low_impressions": {
      if (metrics.impressions === 0 && metrics.spent === 0 && metrics.clicks === 0)
        return { triggered: false, stoppedAt: "step6_no_data", reason: "Все метрики нулевые — нет данных (объявление не крутится или только запущено)" };
      if (metrics.impressions < condition.value)
        return { triggered: true, stoppedAt: "triggered", reason: `Показов ${metrics.impressions} < порог ${condition.value}` };
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `Показов ${metrics.impressions} ≥ порог ${condition.value}` };
    }

    case "clicks_no_leads": {
      if (metrics.clicks >= condition.value && metrics.leads === 0)
        return { triggered: true, stoppedAt: "triggered", reason: `Кликов ${metrics.clicks} ≥ ${condition.value}, лидов: 0` };
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `Кликов ${metrics.clicks}, лидов: ${metrics.leads}` };
    }

    case "cpc_limit": {
      const minSpent = condition.minSpent ?? 0;
      if (metrics.spent < minSpent)
        return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `Расход ${Math.round(metrics.spent)}₽ < минимум ${minSpent}₽ (ожидание)` };
      if (metrics.clicks === 0)
        return { triggered: true, stoppedAt: "triggered", reason: `Расход ${Math.round(metrics.spent)}₽ ≥ ${minSpent}₽, кликов: 0 (CPC не определён → превышение)` };
      const cpc = metrics.spent / metrics.clicks;
      if (cpc > condition.value)
        return { triggered: true, stoppedAt: "triggered", reason: `CPC ${cpc.toFixed(2)}₽ > лимит ${condition.value}₽ (расход ${Math.round(metrics.spent)}₽, кликов ${metrics.clicks})` };
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: `CPC ${cpc.toFixed(2)}₽ ≤ лимит ${condition.value}₽` };
    }

    case "new_lead": {
      if (metrics.campaignType === "subscription" || metrics.campaignType === "awareness") {
        return { triggered: false, stoppedAt: "step6_campaign_type_excluded", reason: `Тип кампании "${metrics.campaignType}" — не лид` };
      }
      if (metrics.leads > 0)
        return { triggered: true, stoppedAt: "triggered", reason: `Новый лид: ${metrics.leads} лид(ов)` };
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: "Лидов: 0" };
    }

    case "uz_budget_manage":
      return { triggered: false, stoppedAt: "step6_condition_not_met", reason: "uz_budget_manage не участвует в стандартной оценке" };

    case "custom_l3": {
      if (Array.isArray(condition)) {
        return {
          triggered: false,
          stoppedAt: "step6_array_for_non_custom",
          reason: `Массив условий поддерживается только для type=custom`,
        };
      }
      const handlerCode = context?.customRuleTypeCode;
      if (!handlerCode) {
        return {
          triggered: false,
          stoppedAt: "step6_no_handler_code",
          reason: `customRuleTypeCode не задан для правила type=custom_l3`,
        };
      }
      const handler = CUSTOM_RULE_HANDLERS[handlerCode];
      if (!handler) {
        return {
          triggered: false,
          stoppedAt: "step6_unknown_rule_type",
          reason: `Неизвестный handler: ${handlerCode}`,
        };
      }
      const result = handler.trace(condition, metrics, context);
      return {
        triggered: result.triggered,
        stoppedAt: result.triggered ? "triggered" : "step6_l3_condition_not_met",
        reason: result.reason,
      };
    }

    default:
      return { triggered: false, stoppedAt: "step6_unknown_type", reason: `Неизвестный type: ${ruleType}` };
  }
}

/**
 * Calculate savings when ad is stopped.
 * Uses spentToday as a conservative real estimate —
 * we stopped the ad, so at minimum we prevented continued spending.
 * @param spentToday - amount already spent today (real data)
 */
export function calculateSavings(spentToday: number): number {
  return Math.max(0, spentToday);
}

/**
 * Get minutes remaining until 18:00 today.
 * @deprecated No longer used for savings calculation, kept for backward compatibility.
 */
export function minutesUntilEndOfDay(now: Date = new Date()): number {
  const endOfDay = new Date(now);
  endOfDay.setHours(18, 0, 0, 0);
  if (now >= endOfDay) return 0;
  return Math.floor((endOfDay.getTime() - now.getTime()) / (1000 * 60));
}

// ═══════════════════════════════════════════════════════════
// Convex queries & mutations for the rule engine
// ═══════════════════════════════════════════════════════════

/** Get all active rules for a user */
export const listActiveRules = internalQuery({
  args: {
    userId: v.id("users"),
    orgId: v.optional(v.id("organizations")),
  },
  handler: async (ctx, args) => {
    // Personal rules for this user
    const userRules = await ctx.db
      .query("rules")
      .withIndex("by_userId_active", (q) =>
        q.eq("userId", args.userId).eq("isActive", true)
      )
      .collect();

    // Org rules (if account belongs to an org)
    let orgRules: typeof userRules = [];
    if (args.orgId) {
      orgRules = await ctx.db
        .query("rules")
        .withIndex("by_orgId_active", (q) => q.eq("orgId", args.orgId!))
        .collect();
      orgRules = orgRules.filter((r) => r.isActive);
    }

    // Union (deduplicate — user's own org rules appear in both)
    const seen = new Set(userRules.map((r) => r._id.toString()));
    const combined = [...userRules];
    for (const r of orgRules) {
      if (!seen.has(r._id.toString())) {
        combined.push(r);
      }
    }

    // uz_budget_manage handled separately by checkUzBudgetRules
    return combined.filter((r) => r.type !== "uz_budget_manage");
  },
});

/** Get an ad account by ID (for token resolution in agency accounts) */
export const getAccountById = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.accountId);
  },
});

/** Get today's daily metrics for an account */
export const getAccountTodayMetrics = internalQuery({
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

/** Update leads count for a specific ad/date (used by safety check) */
export const updateAdLeads = internalMutation({
  args: {
    adId: v.string(),
    date: v.string(),
    leads: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("metricsDaily")
      .withIndex("by_adId_date", (q) =>
        q.eq("adId", args.adId).eq("date", args.date)
      )
      .first();
    if (existing) {
      const cpl = args.leads > 0 ? existing.spent / args.leads : undefined;
      await ctx.db.patch(existing._id, {
        leads: args.leads,
        ...(cpl !== undefined ? { cpl } : {}),
      });
    }
  },
});

/** Get aggregated metrics for an ad across all dates (since launch) or last 24h */
export const getAdAggregatedMetrics = internalQuery({
  args: {
    adId: v.string(),
    sinceDate: v.optional(v.string()), // "YYYY-MM-DD" — if set, only sum from this date
  },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("metricsDaily")
      .withIndex("by_adId_date", (q) => q.eq("adId", args.adId))
      .collect();

    const filtered = args.sinceDate
      ? records.filter((r) => r.date >= args.sinceDate!)
      : records;

    let clicks = 0;
    let leads = 0;
    let spent = 0;
    let impressions = 0;
    let reach = 0;
    for (const r of filtered) {
      clicks += r.clicks;
      leads += r.leads;
      spent += r.spent;
      impressions += r.impressions;
      reach += r.reach ?? 0;
    }

    return { clicks, leads, spent, impressions, reach: reach > 0 ? reach : undefined, daysCount: filtered.length };
  },
});

/** Get realtime history for an ad (for fast_spend detection) */
export const getRealtimeHistory = internalQuery({
  args: {
    adId: v.string(),
    sinceTimestamp: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("metricsRealtime")
      .withIndex("by_adId_timestamp", (q) =>
        q.eq("adId", args.adId).gte("timestamp", args.sinceTimestamp)
      )
      .collect();
  },
});

/** Get all unique ad IDs for an account (from all metricsDaily records) */
export const getAccountAllAdIds = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) => q.eq("accountId", args.accountId))
      .collect();
    const adIds = new Set<string>();
    for (const r of records) {
      adIds.add(r.adId);
    }
    return [...adIds];
  },
});

/** Get campaign daily limit for fast_spend calculation (cascade: group → ad_plan) */
export const getCampaignDailyLimit = internalQuery({
  args: { adId: v.string() },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ads")
      .withIndex("by_vkAdId", (q) => q.eq("vkAdId", args.adId))
      .first();
    if (!ad) return null;
    const campaign = await ctx.db.get(ad.campaignId);
    if (!campaign) return null;

    // Cascade: group budget first, then ad_plan budget
    if (campaign.dailyLimit && campaign.dailyLimit > 0) {
      return campaign.dailyLimit;
    }

    // Fallback: look up ad_plan budget via adPlanId (same account)
    if (campaign.adPlanId) {
      const adPlan = await ctx.db
        .query("campaigns")
        .withIndex("by_accountId_vkCampaignId", (q) =>
          q.eq("accountId", campaign.accountId).eq("vkCampaignId", campaign.adPlanId!)
        )
        .first();
      if (adPlan?.dailyLimit && adPlan.dailyLimit > 0) {
        return adPlan.dailyLimit;
      }
    }

    return null;
  },
});

/** Get vkCampaignId for a given adId (banner) */
export const getAdCampaignId = internalQuery({
  args: { adId: v.string() },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ads")
      .withIndex("by_vkAdId", (q) => q.eq("vkAdId", args.adId))
      .first();
    if (!ad) return null;
    const campaign = await ctx.db.get(ad.campaignId);
    return campaign?.vkCampaignId ?? null;
  },
});

/** Get adPlanId for a given adId (banner) — resolves through ads → campaigns table */
export const getAdPlanId = internalQuery({
  args: { adId: v.string() },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ads")
      .withIndex("by_vkAdId", (q) => q.eq("vkAdId", args.adId))
      .first();
    if (!ad) return null;
    const campaign = await ctx.db.get(ad.campaignId);
    return campaign?.adPlanId ?? null;
  },
});

/** Get account's own access token (for VK API calls) */
export const getAccountToken = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    return account?.accessToken ?? null;
  },
});

// 3 попытки × 5 мин цикл = 15 минут retry window
const MAX_FAILED_RETRIES = 3;

export interface ActionLogEntry {
  adId: string;
  status: "success" | "failed" | "reverted";
  actionType: string;
  createdAt: number;
}
// Бюджетные типы (budget_increased, budget_reset, zero_spend_alert) логируются
// через logBudgetAction, которая вызывается только из checkUzBudgetRules.
// Этот flow не проходит через isAlreadyTriggeredToday — бюджетные логи
// никогда не попадут в logs этой функции.

/**
 * Daily dedup + failed retry limit.
 * Pure function — testable without Convex context.
 *
 * Permanent dedup (successful stop any time) lives in the Convex query
 * (isAlreadyTriggeredToday fast path) — NOT duplicated here.
 *
 * Self-contained: defensively filters by adId, createdAt, reverted
 * even though query already applies these filters.
 */
export function shouldSkipDailyDedup(
  logs: ActionLogEntry[],
  adId: string,
  sinceTimestamp: number
): boolean {
  const adLogs = logs.filter(
    (log) =>
      log.adId === adId &&
      log.status !== "reverted" &&
      log.createdAt >= sinceTimestamp
  );

  // 1. Successful trigger today → skip
  if (adLogs.some((log) => log.status === "success")) return true;

  // 2. Failed retry limit: max 3 failed per day
  const failedCount = adLogs.filter((log) => log.status === "failed").length;
  return failedCount >= MAX_FAILED_RETRIES;
}

/** Check if rule already triggered for this ad today (dedup) */
export const isAlreadyTriggeredToday = internalQuery({
  args: {
    ruleId: v.id("rules"),
    adId: v.string(),
    sinceTimestamp: v.number(),
  },
  handler: async (ctx, args) => {
    // Fast path: permanent dedup — successful stop any time.
    // Uses by_ruleId_createdAt in desc order: newest logs first,
    // finds recent successful stops quickly. .first() stops at first match.
    const activeStop = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId_createdAt", (q) => q.eq("ruleId", args.ruleId))
      .order("desc")
      .filter((q) =>
        q.and(
          q.eq(q.field("adId"), args.adId),
          q.eq(q.field("status"), "success"),
          q.or(
            q.eq(q.field("actionType"), "stopped"),
            q.eq(q.field("actionType"), "stopped_and_notified")
          )
        )
      )
      .first();
    if (activeStop) return true;

    // Daily dedup + retry limit: delegate to pure function.
    // Uses compound index by_ruleId_createdAt with range filter —
    // Convex only scans logs from sinceTimestamp onward.
    const todayLogs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId_createdAt", (q) =>
        q.eq("ruleId", args.ruleId).gte("createdAt", args.sinceTimestamp)
      )
      .filter((q) => q.eq(q.field("adId"), args.adId))
      .collect();

    return shouldSkipDailyDedup(todayLogs, args.adId, args.sinceTimestamp);
  },
});

/** Create an action log entry (internal) */
export const createActionLog = internalMutation({
  args: {
    userId: v.id("users"),
    ruleId: v.id("rules"),
    accountId: v.id("adAccounts"),
    adId: v.string(),
    adName: v.string(),
    campaignName: v.optional(v.string()),
    actionType: v.union(
      v.literal("stopped"),
      v.literal("notified"),
      v.literal("stopped_and_notified")
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
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("actionLogs", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

/** Update actionLog status after-the-fact (e.g. when TG notification fails) */
export const updateActionLogStatus = internalMutation({
  args: {
    actionLogId: v.id("actionLogs"),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("reverted")
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.actionLogId, {
      status: args.status,
      ...(args.errorMessage !== undefined && { errorMessage: args.errorMessage }),
    });
  },
});

/** Create action log — public mutation for testing */
export const createActionLogPublic = mutation({
  args: {
    userId: v.id("users"),
    ruleId: v.id("rules"),
    accountId: v.id("adAccounts"),
    adId: v.string(),
    adName: v.string(),
    campaignName: v.optional(v.string()),
    actionType: v.union(
      v.literal("stopped"),
      v.literal("notified"),
      v.literal("stopped_and_notified")
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
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("actionLogs", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

/** Update rule trigger count */
export const incrementTriggerCount = internalMutation({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return;
    await ctx.db.patch(args.ruleId, {
      triggerCount: rule.triggerCount + 1,
      lastTriggeredAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** Query action logs for a user */
export const listActionLogs = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
  },
});

/** Get action logs by rule */
export const getActionLogsByRule = query({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId_createdAt", (q) => q.eq("ruleId", args.ruleId))
      .order("desc")
      .collect();
  },
});

/** Get last successful budget_increased log for a campaign under a rule */
export const getLastBudgetLogForCampaign = internalQuery({
  args: { ruleId: v.id("rules"), campaignId: v.string() },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId_createdAt", (q) => q.eq("ruleId", args.ruleId))
      .filter((q) =>
        q.and(
          q.eq(q.field("actionType"), "budget_increased"),
          q.eq(q.field("adId"), args.campaignId),
          q.eq(q.field("status"), "success")
        )
      )
      .order("desc")
      .first();
    if (!logs) return null;
    return { newBudget: logs.metricsSnapshot?.newBudget, createdAt: logs.createdAt };
  },
});

/** TEMP: List all UZ budget rules for a user (for diagnostic) */
export const listUzBudgetRulesForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("type"), "uz_budget_manage"))
      .collect();
  },
});

/** TEMP: Get recent budget actionLogs for a rule (for diagnostic) */
export const getRecentBudgetLogsForRule = internalQuery({
  args: { ruleId: v.id("rules"), limitCount: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId_createdAt", (q) => q.eq("ruleId", args.ruleId))
      .order("desc")
      .take(args.limitCount);
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 13 — Savings Widget Queries
// ═══════════════════════════════════════════════════════════

/** Get total saved amount for today (since midnight UTC) */
export const getSavedToday = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", args.userId).gte("createdAt", startOfDay)
      )
      .collect();

    return logs.reduce((sum, log) => sum + log.savedAmount, 0);
  },
});

/**
 * Get saved amounts per day for the last N days (default 7).
 * Returns array of { date: "YYYY-MM-DD", amount: number } sorted oldest-first.
 */
export const getSavedHistory = query({
  args: {
    userId: v.id("users"),
    days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numDays = args.days ?? 7;
    const now = new Date();
    const startDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - numDays + 1
    );
    const since = startDate.getTime();

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", args.userId).gte("createdAt", since)
      )
      .collect();

    // Group by date
    const byDate: Record<string, number> = {};
    for (let i = 0; i < numDays; i++) {
      const d = new Date(
        startDate.getFullYear(),
        startDate.getMonth(),
        startDate.getDate() + i
      );
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      byDate[key] = 0;
    }

    for (const log of logs) {
      const d = new Date(log.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (key in byDate) {
        byDate[key] += log.savedAmount;
      }
    }

    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, amount]) => ({ date, amount }));
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 14 — Activity Stats
// ═══════════════════════════════════════════════════════════

/** Get activity stats: count of triggers, stops, notifications for today */
export const getActivityStats = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", args.userId).gte("createdAt", startOfDay)
      )
      .collect();

    const triggers = logs.length;
    const stops = logs.filter(
      (l) => l.actionType === "stopped" || l.actionType === "stopped_and_notified"
    ).length;
    const notifications = logs.filter(
      (l) => l.actionType === "notified" || l.actionType === "stopped_and_notified"
    ).length;

    return { triggers, stops, notifications };
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 15 — Recent Events (Event Feed)
// ═══════════════════════════════════════════════════════════

/** Get recent action log events with optional filters */
export const getRecentEvents = query({
  args: {
    userId: v.id("users"),
    actionType: v.optional(
      v.union(
        v.literal("stopped"),
        v.literal("notified"),
        v.literal("stopped_and_notified"),
        v.literal("budget_increased"),
        v.literal("budget_reset"),
        v.literal("zero_spend_alert")
      )
    ),
    accountId: v.optional(v.id("adAccounts")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;

    let logs;
    if (args.accountId) {
      logs = await ctx.db
        .query("actionLogs")
        .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId!))
        .order("desc")
        .collect();
      // Filter by userId (accountId index doesn't include userId)
      logs = logs.filter((l) => l.userId === args.userId);
    } else {
      logs = await ctx.db
        .query("actionLogs")
        .withIndex("by_userId_date", (q) => q.eq("userId", args.userId))
        .order("desc")
        .collect();
    }

    // Apply actionType filter
    if (args.actionType) {
      logs = logs.filter((l) => l.actionType === args.actionType);
    }

    // Apply limit
    return logs.slice(0, limit);
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 17 — Analytics queries
// ═══════════════════════════════════════════════════════════

/** Get daily savings data for line chart (within a date range) */
export const getAnalyticsSavings = query({
  args: {
    userId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q
          .eq("userId", args.userId)
          .gte("createdAt", args.startDate)
          .lte("createdAt", args.endDate)
      )
      .collect();

    // Group by date
    const byDate: Record<string, number> = {};
    for (const log of logs) {
      const date = new Date(log.createdAt).toISOString().slice(0, 10);
      byDate[date] = (byDate[date] ?? 0) + log.savedAmount;
    }

    // Fill all dates in range
    const result: { date: string; amount: number }[] = [];
    const current = new Date(args.startDate);
    const end = new Date(args.endDate);
    while (current <= end) {
      const dateStr = current.toISOString().slice(0, 10);
      result.push({ date: dateStr, amount: byDate[dateStr] ?? 0 });
      current.setDate(current.getDate() + 1);
    }

    return result;
  },
});

/** Get action type breakdown for bar chart */
export const getAnalyticsByType = query({
  args: {
    userId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q
          .eq("userId", args.userId)
          .gte("createdAt", args.startDate)
          .lte("createdAt", args.endDate)
      )
      .collect();

    const counts: Record<string, number> = {
      stopped: 0,
      notified: 0,
      stopped_and_notified: 0,
      budget_increased: 0,
      budget_reset: 0,
    };

    for (const log of logs) {
      counts[log.actionType] = (counts[log.actionType] ?? 0) + 1;
    }

    return [
      { type: "stopped", label: "Остановки", count: counts.stopped },
      { type: "notified", label: "Уведомления", count: counts.notified },
      {
        type: "stopped_and_notified",
        label: "Стоп + увед.",
        count: counts.stopped_and_notified,
      },
      {
        type: "budget_increased",
        label: "Бюджет увеличен",
        count: counts.budget_increased,
      },
      {
        type: "budget_reset",
        label: "Бюджет сброшен",
        count: counts.budget_reset,
      },
    ];
  },
});

/** Get triggers per rule for pie chart */
export const getAnalyticsTriggersByRule = query({
  args: {
    userId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q
          .eq("userId", args.userId)
          .gte("createdAt", args.startDate)
          .lte("createdAt", args.endDate)
      )
      .collect();

    // Group by ruleId
    const byRule: Record<string, number> = {};
    for (const log of logs) {
      const key = log.ruleId as string;
      byRule[key] = (byRule[key] ?? 0) + 1;
    }

    // Fetch rule names
    const result: { ruleId: string; name: string; count: number }[] = [];
    for (const [ruleId, count] of Object.entries(byRule)) {
      const ruleDoc = await ctx.db.get(ruleId as Id<"rules">);
      const ruleName =
        ruleDoc && "name" in ruleDoc ? ruleDoc.name : "Удалённое правило";
      result.push({
        ruleId,
        name: ruleName as string,
        count,
      });
    }

    return result.sort((a, b) => b.count - a.count);
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 18 — Top-10 Ads & ROI
// ═══════════════════════════════════════════════════════════

/** Get top N ads by savedAmount within date range */
export const getTopAds = query({
  args: {
    userId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q
          .eq("userId", args.userId)
          .gte("createdAt", args.startDate)
          .lte("createdAt", args.endDate)
      )
      .collect();

    // Aggregate by adId, dedup by (adId, date) — take max per day
    const byAd: Record<
      string,
      {
        adName: string;
        triggers: number;
        // Per-date max values to avoid double-counting when multiple rules fire on same ad same day
        byDate: Record<string, { maxSaved: number; maxSpent: number }>;
      }
    > = {};

    for (const log of logs) {
      if (!byAd[log.adId]) {
        byAd[log.adId] = {
          adName: log.adName,
          triggers: 0,
          byDate: {},
        };
      }
      byAd[log.adId].triggers += 1;

      // Extract date string from createdAt timestamp for dedup
      const dateKey = new Date(log.createdAt).toISOString().slice(0, 10);
      const dayEntry = byAd[log.adId].byDate[dateKey];
      if (!dayEntry) {
        byAd[log.adId].byDate[dateKey] = {
          maxSaved: log.savedAmount,
          maxSpent: log.metricsSnapshot.spent,
        };
      } else {
        dayEntry.maxSaved = Math.max(dayEntry.maxSaved, log.savedAmount);
        dayEntry.maxSpent = Math.max(dayEntry.maxSpent, log.metricsSnapshot.spent);
      }
    }

    return Object.entries(byAd)
      .map(([adId, data]) => {
        let totalSaved = 0;
        let totalSpent = 0;
        for (const day of Object.values(data.byDate)) {
          totalSaved += day.maxSaved;
          totalSpent += day.maxSpent;
        }
        return { adId, adName: data.adName, totalSaved, totalSpent, triggers: data.triggers };
      })
      .sort((a, b) => b.totalSaved - a.totalSaved)
      .slice(0, limit);
  },
});

/** Get ROI metrics: total saved, total spent, ratio */
export const getROI = query({
  args: {
    userId: v.id("users"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q
          .eq("userId", args.userId)
          .gte("createdAt", args.startDate)
          .lte("createdAt", args.endDate)
      )
      .collect();

    // Dedup by (adId, date): take max spent and max savedAmount per day per ad
    // This prevents double-counting when multiple rules fire on the same ad the same day
    const byAdDate: Record<string, { maxSaved: number; maxSpent: number }> = {};

    for (const log of logs) {
      const dateKey = new Date(log.createdAt).toISOString().slice(0, 10);
      const key = `${log.adId}:${dateKey}`;
      const entry = byAdDate[key];
      if (!entry) {
        byAdDate[key] = {
          maxSaved: log.savedAmount,
          maxSpent: log.metricsSnapshot.spent,
        };
      } else {
        entry.maxSaved = Math.max(entry.maxSaved, log.savedAmount);
        entry.maxSpent = Math.max(entry.maxSpent, log.metricsSnapshot.spent);
      }
    }

    let totalSaved = 0;
    let totalSpent = 0;
    for (const entry of Object.values(byAdDate)) {
      totalSaved += entry.maxSaved;
      totalSpent += entry.maxSpent;
    }

    const roi = totalSpent > 0 ? (totalSaved / totalSpent) * 100 : 0;

    return {
      totalSaved,
      totalSpent,
      roi: Math.round(roi * 100) / 100,
      totalEvents: logs.length,
    };
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 19 — Logs page queries
// ═══════════════════════════════════════════════════════════

/** Full logs query with 4 filters + text search */
export const getLogs = query({
  args: {
    userId: v.id("users"),
    actionType: v.optional(
      v.union(
        v.literal("stopped"),
        v.literal("notified"),
        v.literal("stopped_and_notified"),
        v.literal("budget_increased"),
        v.literal("budget_reset"),
        v.literal("zero_spend_alert")
      )
    ),
    accountId: v.optional(v.id("adAccounts")),
    ruleId: v.optional(v.id("rules")),
    status: v.optional(
      v.union(
        v.literal("success"),
        v.literal("failed"),
        v.literal("reverted")
      )
    ),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    let logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();

    if (args.actionType) {
      logs = logs.filter((l) => l.actionType === args.actionType);
    }
    if (args.accountId) {
      logs = logs.filter((l) => l.accountId === args.accountId);
    }
    if (args.ruleId) {
      logs = logs.filter((l) => l.ruleId === args.ruleId);
    }
    if (args.status) {
      logs = logs.filter((l) => l.status === args.status);
    }
    if (args.search) {
      const q = args.search.toLowerCase();
      logs = logs.filter(
        (l) =>
          l.adName.toLowerCase().includes(q) ||
          l.reason.toLowerCase().includes(q) ||
          (l.campaignName && l.campaignName.toLowerCase().includes(q))
      );
    }

    return logs.slice(0, limit);
  },
});

/** Public mutation to revert a stopped ad action */
export const revertActionPublic = mutation({
  args: {
    actionLogId: v.id("actionLogs"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const log = await ctx.db.get(args.actionLogId);
    if (!log) {
      return { success: false, reason: "not_found" };
    }
    if (log.userId !== args.userId) {
      return { success: false, reason: "forbidden" };
    }
    if (log.status === "reverted") {
      return { success: false, reason: "already_reverted" };
    }
    const elapsed = Date.now() - log.createdAt;
    if (elapsed > 5 * 60 * 1000) {
      return { success: false, reason: "timeout" };
    }
    if (log.actionType !== "stopped" && log.actionType !== "stopped_and_notified") {
      return { success: false, reason: "not_stoppable" };
    }
    await ctx.db.patch(args.actionLogId, {
      status: "reverted",
      revertedAt: Date.now(),
      revertedBy: "user",
    });
    return { success: true, reason: "ok" };
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 11 — Revert action
// ═══════════════════════════════════════════════════════════

/** Revert timeout in milliseconds (5 minutes) */
export const REVERT_TIMEOUT_MS = 5 * 60 * 1000;

/** Get an action log by ID (internal, for callback processing) */
export const getActionLog = internalQuery({
  args: { actionLogId: v.id("actionLogs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.actionLogId);
  },
});

/**
 * Revert a stopped ad — mark actionLog as reverted.
 * Returns { success, reason } with reason for failure.
 */
export const revertAction = internalMutation({
  args: {
    actionLogId: v.id("actionLogs"),
    revertedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const log = await ctx.db.get(args.actionLogId);
    if (!log) {
      return { success: false, reason: "not_found" };
    }

    // Already reverted?
    if (log.status === "reverted") {
      return { success: false, reason: "already_reverted" };
    }

    // Timeout check (>5 minutes since creation)
    const elapsed = Date.now() - log.createdAt;
    if (elapsed > REVERT_TIMEOUT_MS) {
      return { success: false, reason: "timeout" };
    }

    // Only revert "stopped" or "stopped_and_notified" actions
    if (log.actionType !== "stopped" && log.actionType !== "stopped_and_notified") {
      return { success: false, reason: "not_stoppable" };
    }

    await ctx.db.patch(args.actionLogId, {
      status: "reverted",
      revertedAt: Date.now(),
      revertedBy: args.revertedBy,
    });

    return { success: true, reason: "ok" };
  },
});

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildReason(
  ruleType: string,
  condition: RuleCondition | RuleCondition[],
  metrics: MetricsSnapshot,
  timeWindow?: string
): string {
  // L2: build reason from array of conditions
  if (ruleType === "custom" && Array.isArray(condition)) {
    const parts = condition.map((c) => {
      const val = getMetricValue(c.metric, metrics);
      return `${c.metric}=${val !== undefined ? (typeof val === "number" && val % 1 !== 0 ? val.toFixed(2) : val) : "?"} ${c.operator} ${c.value}`;
    });
    return `Конструктор: ${parts.join(", ")}`;
  }

  if (Array.isArray(condition)) {
    return `Правило ${ruleType} сработало`;
  }

  switch (ruleType) {
    case "cpl_limit": {
      if (metrics.leads > 0) {
        const cpl = metrics.spent / metrics.leads;
        return `CPL ${cpl.toFixed(0)}₽ превысил лимит ${condition.value}₽`;
      }
      return `Расход ${Math.round(metrics.spent)}₽ без лидов превысил лимит CPL ${condition.value}₽`;
    }
    case "min_ctr": {
      const ctr =
        metrics.impressions > 0
          ? (metrics.clicks / metrics.impressions) * 100
          : 0;
      return `CTR ${ctr.toFixed(2)}% \u043D\u0438\u0436\u0435 \u043C\u0438\u043D\u0438\u043C\u0443\u043C\u0430 ${condition.value}%`;
    }
    case "fast_spend":
      return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u044B\u0441\u0442\u0440\u044B\u0439 \u0440\u0430\u0441\u0445\u043E\u0434 \u0431\u044E\u0434\u0436\u0435\u0442\u0430 (\u043F\u043E\u0440\u043E\u0433 ${condition.value}%)`;
    case "spend_no_leads":
      return `\u041F\u043E\u0442\u0440\u0430\u0447\u0435\u043D\u043E ${metrics.spent}\u20BD \u0431\u0435\u0437 \u043B\u0438\u0434\u043E\u0432 (\u043B\u0438\u043C\u0438\u0442 ${condition.value}\u20BD)`;
    case "budget_limit":
      return `\u0420\u0430\u0441\u0445\u043E\u0434 ${metrics.spent}\u20BD \u043F\u0440\u0435\u0432\u044B\u0441\u0438\u043B \u0431\u044E\u0434\u0436\u0435\u0442 ${condition.value}\u20BD`;
    case "low_impressions": {
      const impWindowLabel =
        timeWindow === "1h" ? " за 1ч" :
        timeWindow === "6h" ? " за 6ч" :
        timeWindow === "24h" ? " за 24ч" :
        timeWindow === "since_launch" ? " с запуска" : " за день";
      return `Показов ${metrics.impressions}${impWindowLabel} меньше минимума ${condition.value}`;
    }
    case "clicks_no_leads": {
      const windowLabel =
        timeWindow === "since_launch" ? " с запуска" :
        timeWindow === "24h" ? " за 24ч" : " за день";
      return `${metrics.clicks} кликов без лидов${windowLabel} (порог ${condition.value})`;
    }
    case "new_lead":
      return `Новый лид! Всего лидов: ${metrics.leads}, расход: ${metrics.spent}₽`;
    default:
      return `\u041F\u0440\u0430\u0432\u0438\u043B\u043E ${ruleType} \u0441\u0440\u0430\u0431\u043E\u0442\u0430\u043B\u043E`;
  }
}

// ═══════════════════════════════════════════════════════════
// Per-account rule checking — called from syncAll with live API data
// or from checkAllRules wrapper with DB fallback
// ═══════════════════════════════════════════════════════════

export const checkRulesForAccount = internalAction({
  args: {
    accountId: v.id("adAccounts"),
    adCampaignMap: v.optional(v.array(v.object({
      adId: v.string(),
      adGroupId: v.string(),
      adPlanId: v.union(v.string(), v.null()),
      dailyBudget: v.number(),
    }))),
  },
  handler: async (ctx, args) => {
    // 1. Get account → userId
    const account = await ctx.runQuery(
      internal.ruleEngine.getAccountById, { accountId: args.accountId }
    );
    if (!account) return;

    // 1.5. Skip rule execution for frozen/read-only orgs
    if (account.orgId) {
      const org = await ctx.runQuery(internal.loadUnits.getOrgById, { orgId: account.orgId });
      if (org?.expiredGracePhase === "read_only" || org?.expiredGracePhase === "deep_read_only" || org?.expiredGracePhase === "frozen") {
        return;
      }
    }

    // 2. Load active rules for this user (+ org rules if account has orgId)
    const allRules = await ctx.runQuery(
      internal.ruleEngine.listActiveRules, { userId: account.userId, orgId: account.orgId }
    );
    const rules = allRules.filter((r: { targetAccountIds: string[] }) =>
      r.targetAccountIds.includes(args.accountId as string)
    );
    if (rules.length === 0) return;

    // 3. Rebuild Map from serialized array (if provided)
    const campaignLookup = new Map<string, {
      adGroupId: string;
      adPlanId: string | null;
      dailyBudget: number;
    }>();
    if (args.adCampaignMap) {
      for (const entry of args.adCampaignMap) {
        campaignLookup.set(entry.adId, {
          adGroupId: entry.adGroupId,
          adPlanId: entry.adPlanId,
          dailyBudget: entry.dailyBudget,
        });
      }
    }
    const useMapLookup = campaignLookup.size > 0;

    const date = todayStr();
    const targetAccountId = args.accountId;
    let totalTriggered = 0;

    // Get campaigns in active rotations — skip them in rule evaluation
    let rotatingCampaignIds: Set<string>;
    try {
      const rotIds = await ctx.runQuery(internal.videoRotation.getRotatingCampaignIds, { accountId: args.accountId });
      rotatingCampaignIds = new Set(rotIds);
    } catch {
      rotatingCampaignIds = new Set();
    }

    // 4. Per-rule, per-ad evaluation
    for (const rule of rules) {
      // Skip video_rotation rules — handled by its own cron
      if (rule.type === "video_rotation") continue;

      // L2 (custom) and L3 (custom_l3) use array conditions — no timeWindow/needsAllAds
      const isL2 = rule.type === "custom" && Array.isArray(rule.conditions);
      const isL3 = rule.type === "custom_l3";
      const isCustom = isL2 || isL3;

      // For L1: single-object conditions with timeWindow/minSamples
      // For L2/L3: no timeWindow, no minSamples — use today's metrics
      const conditions = isCustom ? null : (rule.conditions as RuleCondition);
      const timeWindow = conditions?.timeWindow;
      const needsAllAds =
        !isCustom &&
        (rule.type === "clicks_no_leads" || rule.type === "low_impressions" || rule.type === "cpl_limit") &&
        timeWindow &&
        timeWindow !== "daily";

      let adIdsToCheck: string[];
      const todayMetricsByAd = new Map<
        string,
        { spent: number; leads: number; impressions: number; clicks: number; cpl?: number; ctr?: number; cpc?: number; reach?: number; campaignType?: string }
      >();

      const dailyMetrics = await ctx.runQuery(
        internal.ruleEngine.getAccountTodayMetrics,
        { accountId: targetAccountId, date }
      );
      for (const m of dailyMetrics) {
        todayMetricsByAd.set(m.adId, m);
      }

      if (needsAllAds) {
        const allAdIds = await ctx.runQuery(
          internal.ruleEngine.getAccountAllAdIds,
          { accountId: targetAccountId }
        );
        adIdsToCheck = allAdIds;
      } else {
        adIdsToCheck = dailyMetrics.map((m: { adId: string }) => m.adId);
      }

      // Campaign filter cache (for DB fallback path)
      const hasCampaignFilter = rule.targetCampaignIds && rule.targetCampaignIds.length > 0;
      const adCampaignCache = new Map<string, { adGroupId: string | null; adPlanId: string | null }>();

      for (const adId of adIdsToCheck) {
        // Skip banners whose campaign is in an active rotation
        if (rotatingCampaignIds.size > 0) {
          let bannerCampaignId: string | null = null;
          if (useMapLookup) {
            bannerCampaignId = campaignLookup.get(adId)?.adGroupId ?? null;
          } else if (adCampaignCache.has(adId)) {
            bannerCampaignId = adCampaignCache.get(adId)!.adGroupId;
          }
          if (bannerCampaignId && rotatingCampaignIds.has(bannerCampaignId)) {
            continue;
          }
        }

        // Filter by targeted ads if specified
        if (rule.targetAdIds && rule.targetAdIds.length > 0) {
          if (!rule.targetAdIds.includes(adId)) continue;
        }

        // Filter by targeted campaigns — DUAL PATH (map vs DB fallback)
        if (hasCampaignFilter) {
          let adGroupId: string | null;
          let adPlanId: string | null;

          if (useMapLookup) {
            // Fast path: O(1) map lookup from live VK API data
            const mapped = campaignLookup.get(adId);
            adGroupId = mapped?.adGroupId ?? null;
            adPlanId = mapped?.adPlanId ?? null;
          } else {
            // Fallback: DB lookup (existing functions)
            if (!adCampaignCache.has(adId)) {
              try {
                const [campId, planId] = await Promise.all([
                  ctx.runQuery(internal.ruleEngine.getAdCampaignId, { adId }),
                  ctx.runQuery(internal.ruleEngine.getAdPlanId, { adId }),
                ]);
                adCampaignCache.set(adId, { adGroupId: campId, adPlanId: planId });
              } catch (err) {
                console.error(`[ruleEngine] Campaign lookup failed for ad ${adId}:`, err);
                continue;
              }
            }
            const cached = adCampaignCache.get(adId)!;
            adGroupId = cached.adGroupId;
            adPlanId = cached.adPlanId;
          }

          if (!matchesCampaignFilter(rule.targetCampaignIds!, adGroupId, adPlanId)) continue;
        }

        const todayMetric = todayMetricsByAd.get(adId);

        // Check minSamples requirement (L1 only — L2/L3 don't have minSamples)
        if (conditions?.minSamples) {
          const history = await ctx.runQuery(
            internal.ruleEngine.getRealtimeHistory,
            { adId, sinceTimestamp: Date.now() - 24 * 60 * 60 * 1000 }
          );
          if (history.length < conditions.minSamples) continue;
        }

        // Build context for fast_spend — DUAL PATH (map vs DB fallback)
        let context:
          | { spendHistory?: SpendSnapshot[]; dailyBudget?: number }
          | undefined;

        if (rule.type === "fast_spend") {
          const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
          const history = await ctx.runQuery(
            internal.ruleEngine.getRealtimeHistory,
            { adId, sinceTimestamp: fifteenMinAgo }
          );

          let dailyBudget: number | undefined;
          if (useMapLookup) {
            // Fast path: from live API map
            const mapped = campaignLookup.get(adId);
            dailyBudget = mapped && mapped.dailyBudget > 0 ? mapped.dailyBudget : undefined;
          } else {
            // Fallback: DB lookup
            const dbBudget = await ctx.runQuery(
              internal.ruleEngine.getCampaignDailyLimit, { adId }
            );
            dailyBudget = dbBudget ?? undefined;
          }

          context = {
            spendHistory: history.map((h: { spent: number; timestamp: number }) => ({
              spent: h.spent,
              timestamp: h.timestamp,
            })),
            dailyBudget,
          };
        }

        // Build metrics snapshot (may be aggregated for time-windowed rules)
        let metricsSnapshot: MetricsSnapshot;

        if (needsAllAds && (timeWindow === "1h" || timeWindow === "6h")) {
          const windowMs = timeWindow === "1h" ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
          const sinceTs = Date.now() - windowMs;
          const history = await ctx.runQuery(
            internal.ruleEngine.getRealtimeHistory,
            { adId, sinceTimestamp: sinceTs }
          );
          const delta = computeRealtimeDelta(history);
          metricsSnapshot = {
            spent: delta.spent,
            leads: delta.leads,
            impressions: delta.impressions,
            clicks: delta.clicks,
            cpc: delta.clicks > 0 ? delta.spent / delta.clicks : undefined,
            campaignType: todayMetric?.campaignType,
            // reach not available in realtime snapshots
          };
        } else if (needsAllAds) {
          let sinceDate: string | undefined;
          if (timeWindow === "24h") {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            sinceDate = yesterday.toISOString().slice(0, 10);
          }
          const aggregated = await ctx.runQuery(
            internal.ruleEngine.getAdAggregatedMetrics,
            { adId, sinceDate }
          );
          metricsSnapshot = {
            spent: aggregated.spent,
            leads: aggregated.leads,
            impressions: aggregated.impressions,
            clicks: aggregated.clicks,
            cpc: aggregated.clicks > 0 ? aggregated.spent / aggregated.clicks : undefined,
            reach: aggregated.reach,
            campaignType: todayMetric?.campaignType,
          };
        } else if (todayMetric) {
          metricsSnapshot = {
            spent: todayMetric.spent,
            leads: todayMetric.leads,
            impressions: todayMetric.impressions,
            clicks: todayMetric.clicks,
            cpl: todayMetric.cpl ?? undefined,
            ctr: todayMetric.ctr ?? undefined,
            cpc: todayMetric.clicks > 0 ? todayMetric.spent / todayMetric.clicks : undefined,
            reach: todayMetric.reach ?? undefined,
            campaignType: todayMetric.campaignType,
          };
        } else {
          continue;
        }

        // Dedup: skip if this rule already triggered for this ad today
        const todayStart = new Date(date + "T00:00:00Z").getTime();
        const alreadyTriggered = await ctx.runQuery(
          internal.ruleEngine.isAlreadyTriggeredToday,
          { ruleId: rule._id, adId, sinceTimestamp: todayStart }
        );
        if (alreadyTriggered) continue;

        // Evaluate condition
        const triggered = evaluateCondition(
          rule.type,
          rule.conditions,
          metricsSnapshot,
          context
        );

        if (rule.type === "clicks_no_leads" || rule.type === "cpl_limit") {
          console.log(
            `[ruleEngine] ${rule.type} check for ad ${adId}: spent=${metricsSnapshot.spent}, clicks=${metricsSnapshot.clicks}, leads=${metricsSnapshot.leads}, threshold=${conditions?.value}, triggered=${triggered}`
          );
        }

        if (!triggered) continue;

        // Safety check for clicks_no_leads: re-verify leads via statistics API
        if ((rule.type === "clicks_no_leads" || rule.type === "cpl_limit") && rule.actions.stopAd && metricsSnapshot.leads === 0) {
          try {
            const accessToken = await ctx.runAction(
              internal.auth.getValidTokenForAccount,
              { accountId: targetAccountId }
            );

            let freshLeads = 0;
            try {
              const freshStats = await ctx.runAction(api.vkApi.getMtStatistics, {
                accessToken,
                dateFrom: "2020-01-01",
                dateTo: date,
                bannerIds: adId,
              });
              if (freshStats && freshStats.length > 0 && freshStats[0].total) {
                const vk = (freshStats[0].total as any).base?.vk;
                if (vk) {
                  freshLeads = Math.max(Number(vk.result) || 0, Number(vk.goals) || 0);
                }
              }
            } catch (statsErr) {
              console.error(
                `[ruleEngine] Safety check stats API failed for ad ${adId}:`,
                statsErr instanceof Error ? statsErr.message : statsErr
              );
            }

            if (freshLeads === 0) {
              try {
                const freshLeadCounts = await ctx.runAction(api.vkApi.getMtLeadCounts, {
                  accessToken,
                  dateFrom: date,
                  dateTo: date,
                });
                freshLeads = freshLeadCounts[adId] || 0;
              } catch {
                // Lead Ads API may not be available (404) — non-fatal
              }
            }

            if (freshLeads > 0) {
              console.log(
                `[ruleEngine] SAFETY CHECK: ad ${adId} has ${freshLeads} leads (vk.result/Lead Ads). Skipping stop.`
              );
              const todayM = todayMetricsByAd.get(adId);
              if (todayM) {
                await ctx.runMutation(internal.ruleEngine.updateAdLeads, {
                  adId,
                  date,
                  leads: freshLeads,
                });
              }
              continue;
            }
          } catch (verifyErr) {
            console.error(
              `[ruleEngine] Lead verification failed for ad ${adId}, proceeding with caution:`,
              verifyErr instanceof Error ? verifyErr.message : verifyErr
            );
          }
        }

        // Calculate savings
        const spentToday = todayMetric?.spent ?? 0;
        const savedAmount = calculateSavings(spentToday);

        // Determine action type
        const actionType:
          | "stopped"
          | "notified"
          | "stopped_and_notified" =
          rule.actions.stopAd && rule.actions.notify
            ? "stopped_and_notified"
            : rule.actions.stopAd
              ? "stopped"
              : "notified";

        const reason = buildReason(
          rule.type,
          rule.conditions,
          metricsSnapshot,
          timeWindow
        );

        // Try to stop the ad via VK API
        let status: "success" | "failed" = "success";
        let errorMessage: string | undefined;

        if (rule.actions.stopAd) {
          try {
            const accessToken = await ctx.runAction(
              internal.auth.getValidTokenForAccount,
              { accountId: targetAccountId }
            );
            await ctx.runAction(api.vkApi.stopAd, {
              accessToken,
              adId,
              accountId: targetAccountId,
            });
          } catch (err) {
            status = "failed";
            errorMessage =
              err instanceof Error ? err.message : "Unknown error";
            try { await ctx.runMutation(internal.systemLogger.log, {
              userId: account.userId,
              accountId: targetAccountId,
              level: "error",
              source: "ruleEngine",
              message: `stopAd failed for ad ${adId}: ${(errorMessage ?? "").slice(0, 150)}`,
              details: { ruleId: rule._id, adId },
            }); } catch { /* non-critical */ }
          }
        }

        // Create action log
        const actionLogId = await ctx.runMutation(
          internal.ruleEngine.createActionLog,
          {
            userId: account.userId,
            ruleId: rule._id,
            accountId: targetAccountId,
            adId,
            adName: `Ad ${adId}`,
            actionType,
            reason,
            metricsSnapshot: {
              spent: metricsSnapshot.spent,
              leads: metricsSnapshot.leads,
              impressions: metricsSnapshot.impressions,
              clicks: metricsSnapshot.clicks,
              cpl: metricsSnapshot.cpl ?? undefined,
              ctr: metricsSnapshot.ctr ?? undefined,
            },
            savedAmount,
            status,
            errorMessage,
          }
        );

        // Alert admin on failed rule actions
        if (status === "failed") {
          try { await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
            category: "ruleErrors",
            dedupKey: `ruleEngine:${rule._id}:${adId}`,
            text: `⚠️ <b>Ошибка правила</b>\n\nОбъявление: Ad ${adId}\nОшибка: ${errorMessage ?? "неизвестно"}`,
          }); } catch { /* non-critical */ }
        }

        let notifyFailed = false;

        // Send Telegram notification if notify is enabled
        if (rule.actions.notify) {
          try {
            console.log(
              `[ruleEngine] Sending notification for ad ${adId}, rule ${rule._id}, actionLogId=${String(actionLogId)}`
            );
            const notifResult = await ctx.runAction(
              internal.telegram.sendRuleNotification,
              {
                userId: account.userId,
                accountId: targetAccountId,
                event: {
                  ruleName: rule.name,
                  adName: `Ad ${adId}`,
                  reason,
                  actionType,
                  savedAmount,
                  metrics: {
                    spent: metricsSnapshot.spent,
                    leads: metricsSnapshot.leads,
                    cpl: metricsSnapshot.cpl ?? undefined,
                    ctr: metricsSnapshot.ctr ?? undefined,
                  },
                },
                priority: rule.actions.stopAd ? "critical" : "standard",
                actionLogId: actionLogId as string,
              }
            );
            console.log(
              `[ruleEngine] Notification result for ad ${adId}:`,
              JSON.stringify(notifResult)
            );
          } catch (notifErr) {
            const notifMsg = notifErr instanceof Error ? notifErr.message : String(notifErr);
            console.error(
              `[ruleEngine] Failed to send TG notification for rule ${rule._id}, ad ${adId}:`,
              notifMsg
            );
            try { await ctx.runMutation(internal.systemLogger.log, {
              userId: account.userId,
              level: "error",
              source: "ruleEngine",
              message: `TG notification failed for ad ${adId}: ${notifMsg.slice(0, 150)}`,
              details: { ruleId: rule._id, adId },
            }); } catch { /* non-critical */ }

            // Mark notify failure — used by incrementTriggerCount guard below
            notifyFailed = true;

            // Update actionLog status when notification fails for notify-only rules
            if (!rule.actions.stopAd && actionLogId) {
              try {
                await ctx.runMutation(internal.ruleEngine.updateActionLogStatus, {
                  actionLogId,
                  status: "failed",
                  errorMessage: `Telegram notification failed: ${notifMsg.slice(0, 200)}`,
                });
              } catch { /* non-critical */ }
            }
          }
        } else {
          console.warn(
            `[ruleEngine] Rule ${rule._id} has notify=false, skipping notification for ad ${adId}`
          );
        }

        // Update rule trigger count — only on actual success
        // For stopAd rules: success = stopAd succeeded (TG failure is non-critical)
        // For notify-only rules: success = TG notification delivered
        const finalStatus = (!rule.actions.stopAd && notifyFailed) ? "failed" : status;
        if (finalStatus === "success") {
          await ctx.runMutation(
            internal.ruleEngine.incrementTriggerCount,
            { ruleId: rule._id }
          );
        }

        totalTriggered++;
      }
    }

    if (totalTriggered > 0) {
      console.log(`[ruleEngine] checkRulesForAccount ${args.accountId}: ${totalTriggered} rules triggered`);
    }
  },
});

// ═══════════════════════════════════════════════════════════
// Main orchestrator — called after metrics sync
// ═══════════════════════════════════════════════════════════

export const checkAllRules = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(
      internal.syncMetrics.listActiveAccounts
    );
    if (accounts.length === 0) return;

    // No processedUsers dedup needed — checkRulesForAccount loads rules
    // for the account's owner and filters by targetAccountIds.includes(accountId).
    // Each account processes only its own ads.
    for (const account of accounts) {
      try {
        await ctx.runAction(internal.ruleEngine.checkRulesForAccount, {
          accountId: account._id,
          // No adCampaignMap — uses DB fallback
        });
      } catch (err) {
        console.error(`[checkAllRules] Failed for account ${account._id}:`, err);
      }
    }
  },
});

// ═══════════════════════════════════════════════════════════
// uz_budget_manage — Budget management for УЗ groups
// ═══════════════════════════════════════════════════════════

/** Get all active uz_budget_manage rules */
export const getActiveUzRules = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allRules = await ctx.db.query("rules").collect();
    return allRules.filter(
      (r) => r.type === "uz_budget_manage" && r.isActive
    );
  },
});

/** TEMP: Diagnose wrong notifications — find all UZ rules + check chatId collisions */
export const diagnoseBudgetNotifications = query({
  args: {},
  handler: async (ctx) => {
    // 1. All active UZ budget rules with user info
    const allRules = await ctx.db.query("rules").collect();
    const uzRules = allRules.filter(
      (r) => r.type === "uz_budget_manage" && r.isActive
    );

    const rulesWithUsers = [];
    for (const rule of uzRules) {
      const user = await ctx.db.get(rule.userId);
      const accounts = [];
      for (const accId of rule.targetAccountIds) {
        const acc = await ctx.db.get(accId);
        accounts.push({
          id: accId,
          name: acc?.name,
          vkAccountId: acc?.vkAccountId,
          userId: acc?.userId,
        });
      }
      rulesWithUsers.push({
        ruleId: rule._id,
        ruleName: rule.name,
        userId: rule.userId,
        userName: user?.name || user?.email,
        telegramChatId: user?.telegramChatId,
        targetAccountIds: rule.targetAccountIds,
        targetCampaignIds: rule.targetCampaignIds,
        accounts,
        notifyOnEveryIncrease: rule.actions.notifyOnEveryIncrease,
        notifyOnKeyEvents: rule.actions.notifyOnKeyEvents,
      });
    }

    // 2. Check for chatId collisions — multiple users with same chatId
    const allUsers = await ctx.db.query("users").collect();
    const chatIdMap: Record<string, { userId: string; name: string | undefined; email: string | undefined }[]> = {};
    for (const u of allUsers) {
      if (u.telegramChatId) {
        const key = u.telegramChatId;
        if (!chatIdMap[key]) chatIdMap[key] = [];
        chatIdMap[key].push({ userId: u._id, name: u.name, email: u.email });
      }
    }
    const duplicateChatIds = Object.fromEntries(
      Object.entries(chatIdMap).filter(([, users]) => users.length > 1)
    );

    // 3. Recent budget_increased logs (last 50)
    const recentLogs = await ctx.db
      .query("actionLogs")
      .order("desc")
      .filter((q) =>
        q.eq(q.field("actionType"), "budget_increased")
      )
      .take(50);

    const logsWithRuleOwner = [];
    for (const log of recentLogs) {
      const rule = log.ruleId ? await ctx.db.get(log.ruleId) : null;
      logsWithRuleOwner.push({
        campaignName: log.adName,
        ruleId: log.ruleId,
        ruleName: rule?.name,
        ruleUserId: rule?.userId,
        logUserId: log.userId,
        accountId: log.accountId,
        createdAt: new Date(log.createdAt).toISOString(),
        reason: log.reason,
      });
    }

    // 4. Check if any rule targets accounts owned by different users
    const crossUserAccounts = rulesWithUsers.filter((r) =>
      r.accounts.some((a) => a.userId && a.userId !== r.userId)
    );

    return {
      totalUzRules: uzRules.length,
      rules: rulesWithUsers,
      duplicateChatIds,
      crossUserAccounts,
      recentBudgetLogs: logsWithRuleOwner,
    };
  },
});

// getCampaignSpentToday moved to vkApi.ts — now queries VK API directly (real-time)

/** Check if budget was recently increased and spent hasn't grown since.
 *  Returns true = skip (dedup), false = allow increase.
 *  Core rule: only allow next increase when spent has actually grown
 *  since the last increase. No time-based escape hatches.
 */
export const hasRecentBudgetIncrease = internalQuery({
  args: {
    ruleId: v.id("rules"),
    campaignId: v.string(),
    withinMs: v.number(),
    currentSpent: v.optional(v.number()),
    currentBudget: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Find the most recent successful budget increase for this campaign today
    // Use rule owner's timezone (consistent with resetBudgets)
    const rule = await ctx.db.get(args.ruleId);
    let tz = "Europe/Moscow";
    if (rule) {
      const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", rule.userId))
        .first();
      if (settings?.timezone) tz = settings.timezone;
    }
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric", minute: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    const minutesSinceMidnight = hour * 60 + minute;
    const dayStartUtc = now.getTime() - (minutesSinceMidnight * 60 + now.getSeconds()) * 1000;

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId_createdAt", (q) =>
        q.eq("ruleId", args.ruleId).gte("createdAt", dayStartUtc)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("actionType"), "budget_increased"),
          q.eq(q.field("adId"), args.campaignId),
          q.eq(q.field("status"), "success")
        )
      )
      .collect();

    if (logs.length === 0) return false;

    // Get the most recent log
    const lastLog = logs.sort((a, b) => b.createdAt - a.createdAt)[0];

    if (args.currentSpent !== undefined && lastLog.metricsSnapshot) {
      const spentAtLastIncrease = lastLog.metricsSnapshot.spent ?? 0;

      // Only allow next increase if spent has actually grown since last increase
      if (args.currentSpent > spentAtLastIncrease) {
        return false; // spent grew — allow new increase
      }

      // Spent hasn't grown — but check if previous write reached VK.
      // If VK budget still differs from what we set → write didn't reach ad_group → allow retry.
      if (args.currentBudget !== undefined && lastLog.metricsSnapshot.newBudget !== undefined) {
        if (args.currentBudget !== lastLog.metricsSnapshot.newBudget) {
          return false; // budget mismatch — write didn't reach VK, retry
        }
      }

      // Spent hasn't grown AND budget matches (write reached) — block
      return true;
    }

    // Fallback for logs without spent data: use time-based dedup
    const since = Date.now() - args.withinMs;
    return lastLog.createdAt >= since;
  },
});

/** Check if this is the first budget increase today for a campaign.
 *  Uses rule owner's timezone (consistent with resetBudgets). */
export const isFirstBudgetIncreaseToday = internalQuery({
  args: {
    ruleId: v.id("rules"),
    campaignId: v.string(),
  },
  handler: async (ctx, args) => {
    // Use rule owner's timezone
    const rule = await ctx.db.get(args.ruleId);
    let tz = "Europe/Moscow";
    if (rule) {
      const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", rule.userId))
        .first();
      if (settings?.timezone) tz = settings.timezone;
    }
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric", minute: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    const minutesSinceMidnight = hour * 60 + minute;
    const dayStartUtc = now.getTime() - (minutesSinceMidnight * 60 + now.getSeconds()) * 1000;
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId_createdAt", (q) => q.eq("ruleId", args.ruleId))
      .filter((q) =>
        q.and(
          q.eq(q.field("actionType"), "budget_increased"),
          q.eq(q.field("adId"), args.campaignId),
          q.gte(q.field("createdAt"), dayStartUtc),
          q.eq(q.field("status"), "success")
        )
      )
      .first();
    return logs === null;
  },
});

/** Check if uncovered-paused notification was already sent today for this campaign */
export const hasUncoveredNotificationToday = internalQuery({
  args: {
    ruleId: v.id("rules"),
    campaignId: v.string(),
  },
  handler: async (ctx, args) => {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const mskMidnight = new Date(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
    const dayStartUtc = mskMidnight.getTime() - 3 * 60 * 60 * 1000;
    const log = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId_createdAt", (q) => q.eq("ruleId", args.ruleId))
      .filter((q) =>
        q.and(
          q.eq(q.field("adId"), args.campaignId),
          q.gte(q.field("createdAt"), dayStartUtc),
          q.eq(q.field("errorMessage"), "uncovered_paused_notification")
        )
      )
      .first();
    return log !== null;
  },
});

/** Log a budget action (increase or reset) */
export const logBudgetAction = internalMutation({
  args: {
    userId: v.id("users"),
    ruleId: v.id("rules"),
    accountId: v.id("adAccounts"),
    campaignId: v.string(),
    campaignName: v.string(),
    actionType: v.union(v.literal("budget_increased"), v.literal("budget_reset"), v.literal("zero_spend_alert")),
    oldBudget: v.number(),
    newBudget: v.number(),
    step: v.number(),
    spentToday: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("actionLogs", {
      userId: args.userId,
      ruleId: args.ruleId,
      accountId: args.accountId,
      adId: args.campaignId,
      adName: args.campaignName,
      campaignName: args.campaignName,
      actionType: args.actionType,
      reason: args.actionType === "budget_increased"
        ? `Бюджет увеличен: ${args.oldBudget}₽ → ${args.newBudget}₽ (+${args.step}₽)`
        : args.actionType === "budget_reset"
          ? `Бюджет сброшен до ${args.newBudget}₽`
          : args.error || `Кампания без расхода`,
      metricsSnapshot: {
        spent: args.spentToday ?? 0,
        leads: 0,
        newBudget: args.newBudget,
      },
      savedAmount: 0,
      status: args.error ? ("failed" as const) : ("success" as const),
      errorMessage: args.error,
      createdAt: Date.now(),
    });

    // Update triggerCount and lastTriggeredAt on the rule
    if (!args.error) {
      const rule = await ctx.db.get(args.ruleId);
      if (rule) {
        await ctx.db.patch(args.ruleId, {
          triggerCount: (rule.triggerCount ?? 0) + 1,
          lastTriggeredAt: Date.now(),
        });
      }
    }
  },
});

/** Get banner IDs that were stopped by rules TODAY and not reverted (for this account).
 *  Used by cascade unblock to avoid reactivating intentionally-stopped banners.
 *  Only considers today's stops — older stops may have been manually restarted by user.
 */
export const getStoppedBannerIdsForAccount = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    // Only look at today's logs (UTC midnight)
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .filter((q) =>
        q.and(
          q.gte(q.field("createdAt"), todayStart),
          q.or(
            q.eq(q.field("actionType"), "stopped"),
            q.eq(q.field("actionType"), "stopped_and_notified")
          )
        )
      )
      .collect();
    // Collect stopped banner IDs, excluding reverted ones
    const stoppedIds = new Set<string>();
    for (const log of logs) {
      if (log.status === "success") {
        stoppedIds.add(log.adId);
      } else if (log.status === "reverted") {
        stoppedIds.delete(log.adId);
      }
    }
    return Array.from(stoppedIds);
  },
});

/**
 * Check all active uz_budget_manage rules.
 * Runs as independent cron (not inside syncAll) to avoid timeout dependency.
 */
export const checkUzBudgetRules = internalAction({
  args: {},
  handler: async (ctx) => {
    // Level 3: Heartbeat guard
    const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
    const prevHeartbeat = await ctx.runQuery(internal.syncMetrics.getCronHeartbeat, { name: "checkUzBudgetRules" });
    if (prevHeartbeat && prevHeartbeat.status === "running") {
      const stuckMinutes = Math.round((Date.now() - prevHeartbeat.startedAt) / 60_000);
      if (Date.now() - prevHeartbeat.startedAt > STUCK_THRESHOLD_MS) {
        console.warn(`[uz_budget] WARNING: previous run started ${stuckMinutes}m ago and hasn't finished. Proceeding anyway.`);
      }
    }
    await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, { name: "checkUzBudgetRules", status: "running" });

    let cronError: string | undefined;
    try {

    const uzRules = await ctx.runQuery(internal.ruleEngine.getActiveUzRules);
    if (uzRules.length === 0) return;

    let totalActions = 0;
    const skipped = { blocked: 0, noBudget: 0, delivering: 0, dedup: 0, maxReached: 0, tokenErr: 0 };

    // ─── KEY CHANGE: group rules by account, fetch once per account ───
    const rulesByAccount = groupRulesByAccount(uzRules as UzRule[]);

    console.log(
      `[uz_budget] Processing ${uzRules.length} rules across ${rulesByAccount.size} unique accounts`
    );

    for (const [accountId, accountRules] of rulesByAccount) {
      try {
        await withTimeout((async () => {
          // 1. Get token ONCE per account
          let accessToken: string;
          try {
            accessToken = await ctx.runAction(
              internal.auth.getValidTokenForAccount,
              { accountId: accountId as Id<"adAccounts"> }
            );
          } catch (tokenErr) {
            const tokenMsg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
            console.error(`[uz_budget] Cannot get token for account ${accountId}: ${tokenMsg}`);
            // Invalidate tokenExpiresAt so next cycle triggers refresh
            if (tokenMsg.includes("TOKEN_EXPIRED")) {
              try {
                await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
                  accountId: accountId as Id<"adAccounts">,
                });
              } catch (handleErr) {
                console.log(`[uz_budget] handleTokenExpired for ${accountId} failed: ${handleErr}`);
              }
            }
            skipped.tokenErr++;
            return;
          }

          // 2. Get campaigns ONCE per account
          let campaigns: VkCampaign[] = [];
          try {
            campaigns = await ctx.runAction(
              internal.vkApi.getCampaignsForAccount,
              { accessToken }
            ) as VkCampaign[];
          } catch (apiErr) {
            console.error(`[uz_budget] Failed to fetch campaigns for account ${accountId}:`, apiErr);
            return;
          }

          // 3. Collect all real campaign IDs that match any rule's targets
          // targetCampaignIds may contain ad_plan IDs, so resolve via filterCampaignsForRule
          const allMatchedCampaignIds = new Set<string>();
          for (const rule of accountRules) {
            const matched = filterCampaignsForRule(campaigns, rule);
            for (const c of matched) allMatchedCampaignIds.add(String(c.id));
          }

          // 4. Fetch spent for ALL matched campaigns in one batch API call
          // Proactive: check spent for every campaign (not just paused/blocked)
          // so we can increase budget BEFORE VK stops the group
          const eligibleIds: string[] = [];
          for (const cid of allMatchedCampaignIds) {
            const camp = campaigns.find((c) => String(c.id) === cid);
            if (!camp) continue;
            if (Number(camp.budget_limit_day || "0") <= 0) continue;
            if (camp.status === "deleted") continue;
            eligibleIds.push(cid);
          }

          const spentCache = new Map<string, number>();
          if (eligibleIds.length > 0) {
            try {
              const batchResult = await ctx.runAction(
                internal.vkApi.getCampaignsSpentTodayBatch,
                { accessToken, campaignIds: eligibleIds }
              ) as Record<string, number>;
              for (const [cid, spent] of Object.entries(batchResult)) {
                spentCache.set(cid, spent);
              }
            } catch (err) {
              console.error(`[uz_budget] Batch spent fetch failed for account ${accountId}:`, err);
            }
          }

          // 5. Evaluate each rule using cached data
          for (const rule of accountRules) {
            try {
              const { initialBudget, budgetStep, maxDailyBudget } = rule.conditions;
              if (!initialBudget || !budgetStep) continue;

              const ruleCampaigns = filterCampaignsForRule(campaigns, rule);

              for (const campaign of ruleCampaigns) {
                const dailyLimitRubles = Number(campaign.budget_limit_day || "0");
                if (dailyLimitRubles <= 0) { skipped.noBudget++; continue; }
                if (campaign.status === "deleted") { skipped.blocked++; continue; }

                const campaignIdStr = String(campaign.id);
                const spentToday = spentCache.get(campaignIdStr);

                // Cascade unblock: if campaign is blocked — it may be blocked by VK
                // either directly (spent >= limit) or cascaded from parent ad_plan.
                // In both cases: set budget above spent, resume (ad_plan + banners).
                // Only for campaigns covered by this UZ rule.
                // Dedup: skip if already unblocked in the last 5 minutes.
                if (campaign.status === "blocked") {
                  // Guard: only cascade-unblock if VK blocked for budget exhaustion.
                  // Two checks distinguish budget block from manual stop:
                  //
                  // 1. If spent data exists: spent >= budget means VK exhausted the limit.
                  //    spent < budget means someone stopped it manually (budget still available).
                  //
                  // 2. If spent data is missing (VK omits stats for some blocked campaigns):
                  //    Compare current VK budget with our last logged newBudget.
                  //    Match → we set this budget, VK likely blocked by exhaustion → unblock.
                  //    Mismatch → someone changed budget externally → don't touch.
                  if (spentToday !== undefined) {
                    // Case 1: spent data available — direct check
                    if (spentToday < dailyLimitRubles) {
                      // Budget still has room → manual stop, skip
                      skipped.blocked++;
                      continue;
                    }
                  } else {
                    // Case 2: no spent data — compare budget with our last log
                    const lastLog = await ctx.runQuery(
                      internal.ruleEngine.getLastBudgetLogForCampaign,
                      { ruleId: rule._id, campaignId: campaignIdStr }
                    );
                    if (!lastLog || lastLog.newBudget === undefined) {
                      // No log at all — we never touched this campaign, skip
                      skipped.blocked++;
                      continue;
                    }
                    if (dailyLimitRubles !== lastLog.newBudget) {
                      // Budget changed externally since our last write → manual action, skip
                      skipped.blocked++;
                      continue;
                    }
                    // Budget matches our last write → VK exhausted it → proceed to unblock
                  }
                  const spent = spentToday ?? dailyLimitRubles;

                  // Dedup: check if we already did cascade unblock for this campaign recently
                  const recentUnblock = await ctx.runQuery(
                    internal.ruleEngine.hasRecentBudgetIncrease,
                    { ruleId: rule._id, campaignId: campaignIdStr, withinMs: 5 * 60 * 1000, currentSpent: spentToday ?? 0, currentBudget: dailyLimitRubles }
                  );
                  if (recentUnblock) {
                    skipped.dedup++;
                    continue;
                  }

                  try {
                    // spent already computed above (guard check)
                    // Use same formula as normal path: currentLimit + step (with catch-up if spent > limit)
                    const cappedBudget = calculateNewBudget(dailyLimitRubles, spent, budgetStep, maxDailyBudget);
                    await ctx.runAction(internal.vkApi.setCampaignBudget, {
                      accessToken, campaignId: campaign.id, newLimitRubles: cappedBudget,
                    });

                    // Get banner IDs stopped by rules — don't reactivate them
                    const stoppedBannerIds = await ctx.runQuery(
                      internal.ruleEngine.getStoppedBannerIdsForAccount,
                      { accountId: accountId as Id<"adAccounts"> }
                    );

                    await ctx.runAction(internal.vkApi.resumeCampaign, {
                      accessToken, campaignId: campaign.id,
                      excludeBannerIds: stoppedBannerIds,
                    });
                    // Always log cascade unblock — even if budget didn't change.
                    // Without this log, dedup (hasRecentBudgetIncrease) won't find it
                    // and cascade unblock will repeat every 5 minutes infinitely.
                    await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                      userId: rule.userId, ruleId: rule._id,
                      accountId: accountId as Id<"adAccounts">,
                      campaignId: campaignIdStr, campaignName: campaign.name,
                      actionType: "budget_increased" as const,
                      oldBudget: dailyLimitRubles, newBudget: cappedBudget,
                      step: cappedBudget - dailyLimitRubles, spentToday: spent,
                    });
                    console.log(`[uz_budget] Cascade unblock: ${campaign.name} (${campaignIdStr}) budget=${cappedBudget}₽ spent=${spent}₽ excludedBanners=${stoppedBannerIds.length}`);
                    totalActions++;
                  } catch (err) {
                    console.error(`[uz_budget] Cascade unblock failed for ${campaignIdStr}:`, err);
                  }
                  continue;
                }

                // No cached spent = campaign was delivering, skip
                if (spentToday === undefined) { skipped.delivering++; continue; }

                if (!shouldTriggerBudgetIncrease(campaign.delivery, campaign.status, spentToday, dailyLimitRubles, budgetStep)) {
                  skipped.delivering++;
                  continue;
                }

                // Dedup: skip if budget was already increased and spent hasn't grown
                const recentIncrease = await ctx.runQuery(
                  internal.ruleEngine.hasRecentBudgetIncrease,
                  { ruleId: rule._id, campaignId: campaignIdStr, withinMs: 5 * 60 * 1000, currentSpent: spentToday, currentBudget: dailyLimitRubles }
                );
                if (recentIncrease) { skipped.dedup++; continue; }

                // Check max budget
                if (maxDailyBudget && dailyLimitRubles >= maxDailyBudget) {
                  skipped.maxReached++;
                  if (rule.actions.notifyOnKeyEvents) {
                    try {
                      await ctx.runAction(internal.telegram.sendBudgetNotification, {
                        userId: rule.userId,
                        type: "max_reached" as const,
                        campaignName: campaign.name,
                        currentBudget: dailyLimitRubles,
                        maxBudget: maxDailyBudget,
                      });
                    } catch (notifErr) {
                      console.error(`[uz_budget] Failed to send max_reached notification:`, notifErr);
                    }
                  }
                  continue;
                }

                const newLimit = calculateNewBudget(dailyLimitRubles, spentToday, budgetStep, maxDailyBudget);

                try {
                  await ctx.runAction(internal.vkApi.setCampaignBudget, {
                    accessToken,
                    campaignId: campaign.id,
                    newLimitRubles: newLimit,
                  });

                  const isFirstToday = await ctx.runQuery(
                    internal.ruleEngine.isFirstBudgetIncreaseToday,
                    { ruleId: rule._id, campaignId: campaignIdStr }
                  );

                  if (campaign.status !== "active" || campaign.delivery === "not_delivering") {
                    try {
                      // Get banner IDs stopped by rules — don't reactivate them
                      const stoppedBannerIds = await ctx.runQuery(
                        internal.ruleEngine.getStoppedBannerIdsForAccount,
                        { accountId: accountId as Id<"adAccounts"> }
                      );
                      await ctx.runAction(internal.vkApi.resumeCampaign, {
                        accessToken,
                        campaignId: campaign.id,
                        excludeBannerIds: stoppedBannerIds,
                      });
                    } catch (resumeErr) {
                      console.error(`[uz_budget] Budget set OK but resume failed for campaign ${campaign.id}:`, resumeErr);
                    }
                  }

                  // Verify: read back actual budget from VK API
                  // If VK didn't apply the change, log as failed so dedup allows retry
                  let verifyFailed = false;
                  try {
                    const actual = await ctx.runAction(internal.vkApi.verifyCampaignState, {
                      accessToken,
                      campaignId: campaign.id,
                    });
                    if (actual && actual.budget < newLimit) {
                      console.warn(`[uz_budget] VERIFY FAILED: campaign ${campaign.id} budget=${actual.budget} (expected ${newLimit}), status=${actual.status}`);
                      verifyFailed = true;
                    }
                  } catch {
                    // Verification failed — don't block, log as success
                  }

                  await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                    userId: rule.userId,
                    ruleId: rule._id,
                    accountId: accountId as Id<"adAccounts">,
                    campaignId: campaignIdStr,
                    campaignName: campaign.name,
                    actionType: "budget_increased" as const,
                    oldBudget: dailyLimitRubles,
                    newBudget: newLimit,
                    step: newLimit - dailyLimitRubles,
                    spentToday,
                    ...(verifyFailed ? { error: `VK не применил изменение бюджета` } : {}),
                  });

                  if (rule.actions.notifyOnEveryIncrease ||
                      (rule.actions.notifyOnKeyEvents && isFirstToday)) {
                    try {
                      await ctx.runAction(internal.telegram.sendBudgetNotification, {
                        userId: rule.userId,
                        type: isFirstToday ? ("first_increase" as const) : ("increase" as const),
                        campaignName: campaign.name,
                        oldBudget: dailyLimitRubles,
                        newBudget: newLimit,
                        step: newLimit - dailyLimitRubles,
                      });
                    } catch (notifErr) {
                      console.error(`[uz_budget] Failed to send budget notification:`, notifErr);
                    }
                  }

                  totalActions++;
                } catch (err) {
                  console.error(`[uz_budget] Failed to increase budget for campaign ${campaign.id}:`, err);
                  await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                    userId: rule.userId,
                    ruleId: rule._id,
                    accountId: accountId as Id<"adAccounts">,
                    campaignId: campaignIdStr,
                    campaignName: campaign.name,
                    actionType: "budget_increased" as const,
                    oldBudget: dailyLimitRubles,
                    newBudget: newLimit,
                    step: budgetStep,
                    spentToday,
                    error: err instanceof Error ? err.message : "Unknown error",
                  });
                }
              }
            } catch (err) {
              console.error(`[uz_budget] Error processing rule ${rule._id}:`, err);
            }
          }
        })(), ACCOUNT_TIMEOUT_MS, `uz_budget account ${accountId}`);
      } catch (accountErr) {
        console.error(`[uz_budget] Account ${accountId} timed out or failed:`, accountErr);
        skipped.tokenErr++;
      }
    }

    // Summary log — always emit for observability
    const skipTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
    console.log(
      `[uz_budget] ${totalActions} increased (${rulesByAccount.size} accounts)` +
      (skipTotal > 0
        ? ` | skipped: ${skipped.delivering} delivering, ${skipped.dedup} dedup, ${skipped.blocked} blocked, ${skipped.maxReached} max, ${skipped.noBudget} no-budget, ${skipped.tokenErr} token-err`
        : "")
    );

    } catch (err) {
      cronError = err instanceof Error ? err.message : "Unknown error";
      console.error("[uz_budget] Fatal error:", cronError);
    } finally {
      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "checkUzBudgetRules",
        status: cronError ? "failed" : "completed",
        error: cronError,
      });
    }
  },
});

// ─── Fan-Out: UZ Budget Dispatch + Worker ────────────────────────

/** Split UZ accounts into chunks and schedule batch workers. */
export const dispatchUzBatches = internalMutation({
  args: { accountIds: v.array(v.id("adAccounts")) },
  handler: async (ctx, args) => {
    const chunkSize = Math.ceil(args.accountIds.length / UZ_WORKER_COUNT);
    for (let i = 0; i < UZ_WORKER_COUNT; i++) {
      const chunk = args.accountIds.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunk.length === 0) break;
      await ctx.scheduler.runAfter(0, internal.ruleEngine.uzBudgetBatchWorker, {
        accountIds: chunk,
        workerIndex: i,
      });
    }
  },
});

/**
 * Per-account UZ budget logic extracted from the former uzBudgetOneAccount.
 * Called sequentially by uzBudgetBatchWorker for each account in its chunk.
 */
async function processUzBudgetForAccount(
  ctx: { runQuery: any; runMutation: any; runAction: any },
  accountId: Id<"adAccounts">
): Promise<void> {
    // Pre-check: skip accounts with known bad tokens — sync cron handles recovery
    const account = await ctx.runQuery(internal.adAccounts.getInternal, { accountId });
    if (!account) return;
    if (account.status === "error" && account.lastError?.includes("TOKEN_EXPIRED")) {
      return; // Token recovery is handled by syncBatchWorker, not UZ budget
    }
    if (account.status !== "active") return; // Only process active accounts

    // Re-fetch UZ rules for this account (lightweight query)
    const allUzRules = await ctx.runQuery(internal.ruleEngine.getActiveUzRules);
    const rulesByAccount = groupRulesByAccount(allUzRules as UzRule[]);
    const accountRules = rulesByAccount.get(accountId as string);
    if (!accountRules || accountRules.length === 0) return;

    let totalActions = 0;
    const skipped = { blocked: 0, noBudget: 0, delivering: 0, dedup: 0, maxReached: 0, tokenErr: 0 };

    try {
      await withTimeout((async () => {
        // 1. Get token ONCE per account
        let accessToken: string;
        try {
          accessToken = await ctx.runAction(
            internal.auth.getValidTokenForAccount,
            { accountId }
          );
        } catch (tokenErr) {
          const tokenMsg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
          console.error(`[uz_budget] Cannot get token for account ${accountId}: ${tokenMsg}`);
          if (tokenMsg.includes("TOKEN_EXPIRED")) {
            try {
              await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
                accountId,
              });
            } catch (handleErr) {
              console.log(`[uz_budget] handleTokenExpired for ${accountId} failed: ${handleErr}`);
            }
          }
          skipped.tokenErr++;
          return;
        }

        // 2. Get campaigns ONCE per account
        let campaigns: VkCampaign[] = [];
        try {
          campaigns = await ctx.runAction(
            internal.vkApi.getCampaignsForAccount, { accessToken }
          ) as VkCampaign[];
        } catch (apiErr) {
          console.error(`[uz_budget] Failed to fetch campaigns for account ${accountId}:`, apiErr);
          return;
        }

        // 3. Collect all real campaign IDs that match any rule's targets
        const allMatchedCampaignIds = new Set<string>();
        for (const rule of accountRules) {
          const matched = filterCampaignsForRule(campaigns, rule);
          for (const c of matched) allMatchedCampaignIds.add(String(c.id));
        }

        // 4. Fetch spent for ALL matched campaigns in one batch API call
        const eligibleIds: string[] = [];
        for (const cid of allMatchedCampaignIds) {
          const camp = campaigns.find((c) => String(c.id) === cid);
          if (!camp) continue;
          if (Number(camp.budget_limit_day || "0") <= 0) continue;
          if (camp.status === "deleted") continue;
          eligibleIds.push(cid);
        }

        const spentCache = new Map<string, number>();
        if (eligibleIds.length > 0) {
          try {
            const batchResult = await ctx.runAction(
              internal.vkApi.getCampaignsSpentTodayBatch,
              { accessToken, campaignIds: eligibleIds }
            ) as Record<string, number>;
            for (const [cid, spent] of Object.entries(batchResult)) {
              spentCache.set(cid, spent);
            }
          } catch (err) {
            console.error(`[uz_budget] Batch spent fetch failed for account ${accountId}:`, err);
          }
        }

        // 5. Evaluate each rule using cached data
        for (const rule of accountRules) {
          try {
            const { initialBudget, budgetStep, maxDailyBudget } = rule.conditions;
            if (!initialBudget || !budgetStep) continue;

            const ruleCampaigns = filterCampaignsForRule(campaigns, rule);

            for (const campaign of ruleCampaigns) {
              const dailyLimitRubles = Number(campaign.budget_limit_day || "0");
              if (dailyLimitRubles <= 0) { skipped.noBudget++; continue; }
              if (campaign.status === "deleted") { skipped.blocked++; continue; }

              const campaignIdStr = String(campaign.id);
              const spentToday = spentCache.get(campaignIdStr);

              // Cascade unblock for blocked campaigns
              if (campaign.status === "blocked") {
                if (spentToday !== undefined) {
                  if (spentToday < dailyLimitRubles) {
                    skipped.blocked++;
                    continue;
                  }
                } else {
                  const lastLog = await ctx.runQuery(
                    internal.ruleEngine.getLastBudgetLogForCampaign,
                    { ruleId: rule._id, campaignId: campaignIdStr }
                  );
                  if (!lastLog || lastLog.newBudget === undefined) {
                    skipped.blocked++;
                    continue;
                  }
                  if (dailyLimitRubles !== lastLog.newBudget) {
                    skipped.blocked++;
                    continue;
                  }
                }
                const spent = spentToday ?? dailyLimitRubles;

                const recentUnblock = await ctx.runQuery(
                  internal.ruleEngine.hasRecentBudgetIncrease,
                  { ruleId: rule._id, campaignId: campaignIdStr, withinMs: 5 * 60 * 1000, currentSpent: spentToday ?? 0, currentBudget: dailyLimitRubles }
                );
                if (recentUnblock) { skipped.dedup++; continue; }

                try {
                  const cappedBudget = calculateNewBudget(dailyLimitRubles, spent, budgetStep, maxDailyBudget);
                  await ctx.runAction(internal.vkApi.setCampaignBudget, {
                    accessToken, campaignId: campaign.id, newLimitRubles: cappedBudget,
                  });
                  const stoppedBannerIds = await ctx.runQuery(
                    internal.ruleEngine.getStoppedBannerIdsForAccount,
                    { accountId }
                  );
                  await ctx.runAction(internal.vkApi.resumeCampaign, {
                    accessToken, campaignId: campaign.id,
                    excludeBannerIds: stoppedBannerIds,
                  });
                  await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                    userId: rule.userId, ruleId: rule._id,
                    accountId,
                    campaignId: campaignIdStr, campaignName: campaign.name,
                    actionType: "budget_increased" as const,
                    oldBudget: dailyLimitRubles, newBudget: cappedBudget,
                    step: cappedBudget - dailyLimitRubles, spentToday: spent,
                  });
                  console.log(`[uz_budget] Cascade unblock: ${campaign.name} (${campaignIdStr}) budget=${cappedBudget} spent=${spent} excludedBanners=${stoppedBannerIds.length}`);
                  totalActions++;
                } catch (err) {
                  console.error(`[uz_budget] Cascade unblock failed for ${campaignIdStr}:`, err);
                }
                continue;
              }

              // Normal path: not blocked
              if (spentToday === undefined) { skipped.delivering++; continue; }

              if (!shouldTriggerBudgetIncrease(campaign.delivery, campaign.status, spentToday, dailyLimitRubles, budgetStep)) {
                skipped.delivering++;
                continue;
              }

              const recentIncrease = await ctx.runQuery(
                internal.ruleEngine.hasRecentBudgetIncrease,
                { ruleId: rule._id, campaignId: campaignIdStr, withinMs: 5 * 60 * 1000, currentSpent: spentToday, currentBudget: dailyLimitRubles }
              );
              if (recentIncrease) { skipped.dedup++; continue; }

              if (maxDailyBudget && dailyLimitRubles >= maxDailyBudget) {
                skipped.maxReached++;
                if (rule.actions.notifyOnKeyEvents) {
                  try {
                    await ctx.runAction(internal.telegram.sendBudgetNotification, {
                      userId: rule.userId, type: "max_reached" as const,
                      campaignName: campaign.name, currentBudget: dailyLimitRubles,
                      maxBudget: maxDailyBudget,
                    });
                  } catch (notifErr) {
                    console.error(`[uz_budget] Failed to send max_reached notification:`, notifErr);
                  }
                }
                continue;
              }

              const newLimit = calculateNewBudget(dailyLimitRubles, spentToday, budgetStep, maxDailyBudget);

              try {
                await ctx.runAction(internal.vkApi.setCampaignBudget, {
                  accessToken, campaignId: campaign.id, newLimitRubles: newLimit,
                });
                const isFirstToday = await ctx.runQuery(
                  internal.ruleEngine.isFirstBudgetIncreaseToday,
                  { ruleId: rule._id, campaignId: campaignIdStr }
                );
                if (campaign.status !== "active" || campaign.delivery === "not_delivering") {
                  try {
                    const stoppedBannerIds = await ctx.runQuery(
                      internal.ruleEngine.getStoppedBannerIdsForAccount,
                      { accountId }
                    );
                    await ctx.runAction(internal.vkApi.resumeCampaign, {
                      accessToken, campaignId: campaign.id,
                      excludeBannerIds: stoppedBannerIds,
                    });
                  } catch (resumeErr) {
                    console.error(`[uz_budget] Budget set OK but resume failed for campaign ${campaign.id}:`, resumeErr);
                  }
                }

                let verifyFailed = false;
                try {
                  const actual = await ctx.runAction(internal.vkApi.verifyCampaignState, {
                    accessToken, campaignId: campaign.id,
                  });
                  if (actual && actual.budget < newLimit) {
                    console.warn(`[uz_budget] VERIFY FAILED: campaign ${campaign.id} budget=${actual.budget} (expected ${newLimit}), status=${actual.status}`);
                    verifyFailed = true;
                  }
                } catch { /* Verification failed -- don't block */ }

                await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                  userId: rule.userId, ruleId: rule._id,
                  accountId,
                  campaignId: campaignIdStr, campaignName: campaign.name,
                  actionType: "budget_increased" as const,
                  oldBudget: dailyLimitRubles, newBudget: newLimit,
                  step: newLimit - dailyLimitRubles, spentToday,
                  ...(verifyFailed ? { error: `VK не применил изменение бюджета` } : {}),
                });

                if (rule.actions.notifyOnEveryIncrease ||
                    (rule.actions.notifyOnKeyEvents && isFirstToday)) {
                  try {
                    await ctx.runAction(internal.telegram.sendBudgetNotification, {
                      userId: rule.userId,
                      type: isFirstToday ? ("first_increase" as const) : ("increase" as const),
                      campaignName: campaign.name,
                      oldBudget: dailyLimitRubles, newBudget: newLimit,
                      step: newLimit - dailyLimitRubles,
                    });
                  } catch (notifErr) {
                    console.error(`[uz_budget] Failed to send budget notification:`, notifErr);
                  }
                }
                totalActions++;
              } catch (err) {
                console.error(`[uz_budget] Failed to increase budget for campaign ${campaign.id}:`, err);
                await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                  userId: rule.userId, ruleId: rule._id,
                  accountId,
                  campaignId: campaignIdStr, campaignName: campaign.name,
                  actionType: "budget_increased" as const,
                  oldBudget: dailyLimitRubles, newBudget: newLimit,
                  step: budgetStep, spentToday,
                  error: err instanceof Error ? err.message : "Unknown error",
                });
              }
            }
          } catch (err) {
            console.error(`[uz_budget] Error processing rule ${rule._id}:`, err);
          }
        }
      })(), UZ_BATCH_ACCOUNT_TIMEOUT_MS, `uz_budget account ${accountId}`);
    } catch (accountErr) {
      console.error(`[uz_budget] Account ${accountId} timed out or failed:`, accountErr);
    }

    // Summary log
    const skipTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
    if (totalActions > 0 || skipTotal > 0) {
      console.log(
        `[uz_budget] Account ${accountId}: ${totalActions} increased` +
        (skipTotal > 0
          ? ` | skipped: ${skipped.delivering} delivering, ${skipped.dedup} dedup, ${skipped.blocked} blocked, ${skipped.maxReached} max, ${skipped.noBudget} no-budget, ${skipped.tokenErr} token-err`
          : "")
      );
    }
}

/**
 * Batch worker for UZ budget rules. Processes accounts sequentially.
 */
export const uzBudgetBatchWorker = internalAction({
  args: {
    accountIds: v.array(v.id("adAccounts")),
    workerIndex: v.number(),
  },
  handler: async (_ctx, _args) => {
    // EMERGENCY DRAIN MODE: no-op. Restore body after pending queue drains.
    return;
  },
});

/**
 * Batch dispatcher for UZ budget rules. Dispatches UZ_WORKER_COUNT batch workers.
 */
export const uzBudgetDispatch = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
      name: "uzBudgetDispatch", status: "running",
    });

    let cronError: string | undefined;
    try {
      const uzRules = await ctx.runQuery(internal.ruleEngine.getActiveUzRules);
      if (uzRules.length === 0) {
        console.log("[uzBudgetDispatch] No active UZ rules");
        return;
      }

      // Collect unique accountIds
      const rulesByAccount = groupRulesByAccount(uzRules as UzRule[]);
      const accountIds = [...rulesByAccount.keys()] as Id<"adAccounts">[];

      // Dispatch workers
      await ctx.runMutation(internal.ruleEngine.dispatchUzBatches, { accountIds });
      console.log(`[uzBudgetDispatch] Dispatched ${Math.min(UZ_WORKER_COUNT, accountIds.length)} batch workers for ${accountIds.length} accounts (${uzRules.length} rules)`);

    } catch (err) {
      cronError = err instanceof Error ? err.message : "Unknown error";
      console.error("[uzBudgetDispatch] Fatal error:", cronError);
    } finally {
      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "uzBudgetDispatch",
        status: cronError ? "failed" : "completed",
        error: cronError,
      });
    }
  },
});
