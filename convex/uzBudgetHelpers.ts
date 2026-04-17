/**
 * Pure helper functions for UZ budget management.
 * Extracted for testability — no Convex dependencies.
 */
import { Id } from "./_generated/dataModel";

// ─── Types ──────────────────────────────────────────────

export interface UzRule {
  _id: Id<"rules">;
  userId: Id<"users">;
  name: string;
  targetAccountIds: Id<"adAccounts">[];
  targetCampaignIds?: string[];
  conditions: {
    initialBudget?: number;
    budgetStep?: number;
    maxDailyBudget?: number;
    resetDaily?: boolean;
    metric: string;
    operator: string;
    value: number;
  };
  actions: {
    notify: boolean;
    stopAd: boolean;
    notifyOnEveryIncrease?: boolean;
    notifyOnKeyEvents?: boolean;
  };
}

export interface VkCampaign {
  id: number;
  name: string;
  status: string;
  budget_limit_day: string;
  package_id?: number;
  delivery?: string;
  ad_plan_id?: number;
}

// ─── Pure functions ─────────────────────────────────────

/**
 * Group rules by accountId.
 * A rule targeting [acc1, acc2] appears in both groups.
 * Skips rules with missing initialBudget or budgetStep.
 */
export function groupRulesByAccount(
  rules: UzRule[]
): Map<string, UzRule[]> {
  const map = new Map<string, UzRule[]>();
  for (const rule of rules) {
    if (!rule.conditions.initialBudget || !rule.conditions.budgetStep) continue;
    for (const accId of rule.targetAccountIds) {
      const key = accId as string;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(rule);
    }
  }
  return map;
}

/**
 * Collect all unique campaign IDs targeted by a group of rules.
 * Used to fetch spent only once per campaign.
 */
export function collectTargetCampaignIds(rules: UzRule[]): Set<string> {
  const ids = new Set<string>();
  for (const rule of rules) {
    for (const cid of rule.targetCampaignIds ?? []) {
      ids.add(cid);
    }
  }
  return ids;
}

/**
 * Filter VK campaigns for a specific rule:
 * - must be in rule's targetCampaignIds
 * - must not be deleted
 * - must have positive daily budget
 */
export function filterCampaignsForRule(
  campaigns: VkCampaign[],
  rule: Pick<UzRule, "targetCampaignIds">
): VkCampaign[] {
  const targetIds = rule.targetCampaignIds ?? [];
  return campaigns.filter((c) => {
    // Match by campaign id OR by ad_plan_id (targetCampaignIds may store ad_plan IDs)
    const matchesDirect = targetIds.includes(String(c.id));
    const matchesAdPlan = c.ad_plan_id !== undefined && targetIds.includes(String(c.ad_plan_id));
    if (!matchesDirect && !matchesAdPlan) return false;
    if (c.status === "deleted") return false;
    if (Number(c.budget_limit_day || "0") <= 0) return false;
    return true;
  });
}

/**
 * Check if campaign budget should be increased.
 * Triggers when spent reaches (limit - step), where step defaults to 1₽.
 * This ensures budget is only increased when the campaign actually
 * spent up to the limit — not repeatedly while spent stays the same.
 *
 * Proactive: triggers regardless of delivery status, so budget is added
 * BEFORE VK stops the group. Dedup in hasRecentBudgetIncrease prevents
 * repeated increases when spent hasn't grown.
 */
export function shouldTriggerBudgetIncrease(
  _delivery: string | undefined,
  _status: string,
  spentToday: number,
  dailyLimitRubles: number,
  budgetStep: number = 1
): boolean {
  // Guard: if step >= limit, threshold would be ≤0 — always trigger
  if (budgetStep >= dailyLimitRubles) return spentToday > 0;
  // Trigger when spent is within one step of the limit
  return spentToday >= dailyLimitRubles - budgetStep;
}

/**
 * Calculate new budget limit after increase.
 * If spent exceeds current limit (e.g. after midnight reset), catch up in one jump.
 */
export function calculateNewBudget(
  currentLimit: number,
  spentToday: number,
  budgetStep: number,
  maxDailyBudget: number | undefined
): number {
  const gap = spentToday - currentLimit;
  const effectiveStep = gap > 0 ? gap + budgetStep : budgetStep;
  let newLimit = currentLimit + effectiveStep;
  if (maxDailyBudget) {
    newLimit = Math.min(newLimit, maxDailyBudget);
  }
  return newLimit;
}

// ─── Zero-spend detection ───────────────────────────────

export interface ZeroSpendCampaign {
  ruleId: Id<"rules">;
  ruleName: string;
  userId: Id<"users">;
  accountId: Id<"adAccounts">;
  campaignId: string;
  zeroDays: number;
}

/**
 * Find campaigns targeted by UZ rules that have 0₽ spend for N+ consecutive days.
 * Counts backwards from yesterday (today is incomplete).
 * Pure function — caller provides metrics data.
 */
export function getZeroSpendCampaigns(
  rules: UzRule[],
  metricsByAccountDate: Map<string, { campaignId: string; spent: number }[]>,
  today: string,
  minDays: number = 2
): ZeroSpendCampaign[] {
  const seen = new Map<string, ZeroSpendCampaign>();

  // Build date list: yesterday back 7 days
  const dates: string[] = [];
  const todayDate = new Date(today + "T00:00:00Z");
  for (let i = 1; i <= 7; i++) {
    const d = new Date(todayDate);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  for (const rule of rules) {
    if (!rule.conditions.resetDaily) continue;

    for (const accountId of rule.targetAccountIds) {
      const accIdStr = accountId as string;

      for (const campaignId of rule.targetCampaignIds ?? []) {
        let zeroDays = 0;

        for (const date of dates) {
          const key = `${accIdStr}|${date}`;
          const dayMetrics = metricsByAccountDate.get(key);
          // No data for this account+date means sync didn't run → stop counting
          if (!dayMetrics || dayMetrics.length === 0) break;
          const campaignMetrics = dayMetrics.filter((m) => m.campaignId === campaignId);
          const totalSpent = campaignMetrics.reduce((s, m) => s + m.spent, 0);

          if (totalSpent > 0) break;
          zeroDays++;
        }

        if (zeroDays >= minDays) {
          const existing = seen.get(campaignId);
          if (!existing || zeroDays > existing.zeroDays) {
            seen.set(campaignId, {
              ruleId: rule._id,
              ruleName: rule.name,
              userId: rule.userId,
              accountId,
              campaignId,
              zeroDays,
            });
          }
        }
      }
    }
  }

  return Array.from(seen.values());
}
