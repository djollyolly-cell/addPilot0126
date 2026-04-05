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
    if (!targetIds.includes(String(c.id))) return false;
    if (c.status === "deleted") return false;
    if (Number(c.budget_limit_day || "0") <= 0) return false;
    return true;
  });
}

/**
 * Check if campaign budget is exhausted and should be increased.
 * Matches original logic: (delivery paused OR blocked) AND spent >= 90% of budget.
 */
export function shouldTriggerBudgetIncrease(
  delivery: string | undefined,
  status: string,
  spentToday: number,
  dailyLimitRubles: number
): boolean {
  const isDeliveryPaused = delivery === "not_delivering";
  const isBlocked = status === "blocked";
  const isSpentNearLimit = spentToday >= dailyLimitRubles * 0.90;
  return (isDeliveryPaused || isBlocked) && isSpentNearLimit;
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
