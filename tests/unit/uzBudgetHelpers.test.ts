/**
 * Unit tests for UZ budget helper pure functions.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import {
  groupRulesByAccount,
  collectTargetCampaignIds,
  filterCampaignsForRule,
  shouldTriggerBudgetIncrease,
  calculateNewBudget,
  type UzRule,
  type VkCampaign,
} from "../../convex/uzBudgetHelpers";

// ═══════════════════════════════════════════════════════════
// groupRulesByAccount
// ═══════════════════════════════════════════════════════════

describe("groupRulesByAccount", () => {
  const makeRule = (id: string, accountIds: string[], campaignIds: string[]): UzRule => ({
    _id: id as any,
    userId: "user1" as any,
    name: `rule-${id}`,
    targetAccountIds: accountIds as any[],
    targetCampaignIds: campaignIds,
    conditions: { initialBudget: 100, budgetStep: 1, maxDailyBudget: 200, metric: "budget_manage", operator: ">", value: 1 },
    actions: { notify: true, stopAd: false, notifyOnEveryIncrease: false, notifyOnKeyEvents: true },
  });

  it("groups rules by accountId", () => {
    const rules = [
      makeRule("r1", ["acc1"], ["c1", "c2"]),
      makeRule("r2", ["acc1"], ["c3"]),
      makeRule("r3", ["acc2"], ["c4"]),
    ];
    const grouped = groupRulesByAccount(rules);
    expect(grouped.size).toBe(2);
    expect(grouped.get("acc1")!.length).toBe(2);
    expect(grouped.get("acc2")!.length).toBe(1);
  });

  it("handles rule targeting multiple accounts", () => {
    const rules = [makeRule("r1", ["acc1", "acc2"], ["c1"])];
    const grouped = groupRulesByAccount(rules);
    expect(grouped.size).toBe(2);
    expect(grouped.get("acc1")!.length).toBe(1);
    expect(grouped.get("acc2")!.length).toBe(1);
  });

  it("returns empty map for empty input", () => {
    expect(groupRulesByAccount([]).size).toBe(0);
  });

  it("skips rules with missing initialBudget", () => {
    const rule: UzRule = {
      _id: "r1" as any, userId: "u1" as any, name: "test",
      targetAccountIds: ["a1" as any],
      targetCampaignIds: ["c1"],
      conditions: { budgetStep: 1, metric: "budget_manage", operator: ">", value: 1 },
      actions: { notify: true, stopAd: false },
    };
    expect(groupRulesByAccount([rule]).size).toBe(0);
  });

  it("skips rules with missing budgetStep", () => {
    const rule: UzRule = {
      _id: "r1" as any, userId: "u1" as any, name: "test",
      targetAccountIds: ["a1" as any],
      targetCampaignIds: ["c1"],
      conditions: { initialBudget: 100, metric: "budget_manage", operator: ">", value: 1 },
      actions: { notify: true, stopAd: false },
    };
    expect(groupRulesByAccount([rule]).size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// collectTargetCampaignIds
// ═══════════════════════════════════════════════════════════

describe("collectTargetCampaignIds", () => {
  const makeRule = (campaignIds: string[]): UzRule => ({
    _id: "r1" as any,
    userId: "u1" as any,
    name: "test",
    targetAccountIds: ["a1" as any],
    targetCampaignIds: campaignIds,
    conditions: { initialBudget: 100, budgetStep: 1, metric: "budget_manage", operator: ">", value: 1 },
    actions: { notify: true, stopAd: false },
  });

  it("collects unique campaign IDs from multiple rules", () => {
    const rules = [makeRule(["c1", "c2"]), makeRule(["c2", "c3"])];
    const ids = collectTargetCampaignIds(rules);
    expect(ids).toEqual(new Set(["c1", "c2", "c3"]));
  });

  it("handles rules with no targetCampaignIds", () => {
    const rule: UzRule = {
      _id: "r1" as any, userId: "u1" as any, name: "test",
      targetAccountIds: ["a1" as any],
      conditions: { initialBudget: 100, budgetStep: 1, metric: "budget_manage", operator: ">", value: 1 },
      actions: { notify: true, stopAd: false },
    };
    expect(collectTargetCampaignIds([rule]).size).toBe(0);
  });

  it("returns empty set for empty input", () => {
    expect(collectTargetCampaignIds([]).size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// filterCampaignsForRule
// ═══════════════════════════════════════════════════════════

describe("filterCampaignsForRule", () => {
  const campaign = (id: number, status: string, delivery: string, budget: string): VkCampaign => ({
    id, name: `camp-${id}`, status, budget_limit_day: budget, delivery,
  });

  it("filters by targetCampaignIds", () => {
    const campaigns = [campaign(1, "active", "delivering", "100"), campaign(2, "active", "delivering", "100")];
    const rule = { targetCampaignIds: ["1"] };
    expect(filterCampaignsForRule(campaigns, rule).length).toBe(1);
    expect(filterCampaignsForRule(campaigns, rule)[0].id).toBe(1);
  });

  it("excludes deleted campaigns", () => {
    const campaigns = [campaign(1, "deleted", "not_delivering", "100")];
    const rule = { targetCampaignIds: ["1"] };
    expect(filterCampaignsForRule(campaigns, rule).length).toBe(0);
  });

  it("excludes campaigns with no budget", () => {
    const campaigns = [campaign(1, "active", "not_delivering", "0")];
    const rule = { targetCampaignIds: ["1"] };
    expect(filterCampaignsForRule(campaigns, rule).length).toBe(0);
  });

  it("returns empty when no targetCampaignIds match", () => {
    const campaigns = [campaign(1, "active", "delivering", "100")];
    const rule = { targetCampaignIds: ["999"] };
    expect(filterCampaignsForRule(campaigns, rule).length).toBe(0);
  });

  it("returns empty when targetCampaignIds is empty", () => {
    const campaigns = [campaign(1, "active", "delivering", "100")];
    const rule = { targetCampaignIds: [] as string[] };
    expect(filterCampaignsForRule(campaigns, rule).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// shouldTriggerBudgetIncrease
// ═══════════════════════════════════════════════════════════

describe("shouldTriggerBudgetIncrease", () => {
  // New logic: triggers when spent >= limit - budgetStep (default step=1)
  // Threshold for limit=100, step=1 is 99

  it("triggers when spent reaches limit - step", () => {
    expect(shouldTriggerBudgetIncrease("not_delivering", "active", 99, 100, 1)).toBe(true);
  });

  it("triggers when spent equals limit", () => {
    expect(shouldTriggerBudgetIncrease("delivering", "blocked", 100, 100, 1)).toBe(true);
  });

  it("triggers when spent exceeds limit", () => {
    expect(shouldTriggerBudgetIncrease("delivering", "active", 105, 100, 1)).toBe(true);
  });

  it("does not trigger when spent below threshold", () => {
    expect(shouldTriggerBudgetIncrease("not_delivering", "active", 98, 100, 1)).toBe(false);
  });

  it("uses default budgetStep=1 when not provided", () => {
    expect(shouldTriggerBudgetIncrease("not_delivering", "active", 99, 100)).toBe(true);
    expect(shouldTriggerBudgetIncrease("not_delivering", "active", 98, 100)).toBe(false);
  });

  it("works with larger budgetStep", () => {
    // step=10, limit=100 → threshold=90
    expect(shouldTriggerBudgetIncrease(undefined, "active", 90, 100, 10)).toBe(true);
    expect(shouldTriggerBudgetIncrease(undefined, "active", 89, 100, 10)).toBe(false);
  });

  it("does not trigger when spent is zero", () => {
    expect(shouldTriggerBudgetIncrease("not_delivering", "blocked", 0, 100, 1)).toBe(false);
  });

  it("handles budgetStep >= limit (triggers if spent > 0)", () => {
    // step=100, limit=100 → guard: triggers if spent > 0
    expect(shouldTriggerBudgetIncrease("active", "active", 1, 100, 100)).toBe(true);
    expect(shouldTriggerBudgetIncrease("active", "active", 0, 100, 100)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// calculateNewBudget
// ═══════════════════════════════════════════════════════════

describe("calculateNewBudget", () => {
  it("increases by step when spent equals budget", () => {
    expect(calculateNewBudget(100, 100, 1, 200)).toBe(101);
  });

  it("catches up when spent exceeds budget (gap)", () => {
    // gap = 105 - 100 = 5, effectiveStep = 5 + 1 = 6
    expect(calculateNewBudget(100, 105, 1, 200)).toBe(106);
  });

  it("caps at maxDailyBudget", () => {
    expect(calculateNewBudget(199, 199, 5, 200)).toBe(200);
  });

  it("normal step when no gap", () => {
    expect(calculateNewBudget(100, 90, 1, undefined)).toBe(101);
  });

  it("no cap when maxDailyBudget is undefined", () => {
    expect(calculateNewBudget(100, 100, 50, undefined)).toBe(150);
  });

  it("handles large gap correctly", () => {
    // gap = 200 - 100 = 100, effectiveStep = 100 + 10 = 110
    expect(calculateNewBudget(100, 200, 10, 300)).toBe(210);
  });
});
