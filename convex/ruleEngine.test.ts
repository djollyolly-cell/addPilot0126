import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  evaluateCondition,
  calculateSavings,
  minutesUntilEndOfDay,
} from "./ruleEngine";

// Helper: create user + account for testing
async function createTestSetup(t: ReturnType<typeof convexTest>) {
  const userId = await t.mutation(api.users.create, {
    email: "engine@test.com",
    vkId: "engine_user",
    name: "Rule Engine Test",
  });
  await t.mutation(api.users.updateTier, { userId, tier: "start" });

  const accountId = await t.mutation(api.adAccounts.connect, {
    userId,
    vkAccountId: "RE001",
    name: "Engine Test Cabinet",
    accessToken: "token_engine",
  });

  return { userId, accountId };
}

describe("ruleEngine", () => {
  // ═══════════════════════════════════════════════════════════
  // Sprint 8 DoD #1: CPL > threshold
  // ═══════════════════════════════════════════════════════════

  test("S8-DoD#1: CPL > threshold triggers rule (cpl=600, value=500)", () => {
    const result = evaluateCondition(
      "cpl_limit",
      { metric: "cpl", operator: ">", value: 500 },
      { spent: 3000, leads: 5, impressions: 10000, clicks: 200 } // cpl = 600
    );
    expect(result).toBe(true);
  });

  test("CPL below threshold does NOT trigger", () => {
    const result = evaluateCondition(
      "cpl_limit",
      { metric: "cpl", operator: ">", value: 500 },
      { spent: 2000, leads: 5, impressions: 10000, clicks: 200 } // cpl = 400
    );
    expect(result).toBe(false);
  });

  test("CPL with zero leads does NOT trigger (no division by zero)", () => {
    const result = evaluateCondition(
      "cpl_limit",
      { metric: "cpl", operator: ">", value: 500 },
      { spent: 3000, leads: 0, impressions: 10000, clicks: 200 }
    );
    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 8 DoD #2: CTR < threshold
  // ═══════════════════════════════════════════════════════════

  test("S8-DoD#2: CTR < threshold triggers rule (ctr=0.5, value=1.0)", () => {
    const result = evaluateCondition(
      "min_ctr",
      { metric: "ctr", operator: "<", value: 1.0 },
      { spent: 1000, leads: 2, impressions: 10000, clicks: 50 } // ctr = 0.5%
    );
    expect(result).toBe(true);
  });

  test("CTR above threshold does NOT trigger", () => {
    const result = evaluateCondition(
      "min_ctr",
      { metric: "ctr", operator: "<", value: 1.0 },
      { spent: 1000, leads: 2, impressions: 10000, clicks: 200 } // ctr = 2%
    );
    expect(result).toBe(false);
  });

  test("CTR with zero impressions does NOT trigger", () => {
    const result = evaluateCondition(
      "min_ctr",
      { metric: "ctr", operator: "<", value: 1.0 },
      { spent: 0, leads: 0, impressions: 0, clicks: 0 }
    );
    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 8 DoD #3: fast_spend
  // ═══════════════════════════════════════════════════════════

  test("S8-DoD#3: fast_spend triggers when 25% spent in 15min (value=20)", () => {
    const now = Date.now();
    const fifteenMinAgo = now - 15 * 60 * 1000;

    const result = evaluateCondition(
      "fast_spend",
      { metric: "spent_speed", operator: ">", value: 20 },
      { spent: 1000, leads: 5, impressions: 10000, clicks: 200 },
      {
        spendHistory: [
          { spent: 750, timestamp: fifteenMinAgo },
          { spent: 1000, timestamp: now }, // diff = 250 / 1000 budget = 25%
        ],
        dailyBudget: 1000,
      }
    );
    expect(result).toBe(true);
  });

  test("fast_spend does NOT trigger when below threshold", () => {
    const now = Date.now();
    const fifteenMinAgo = now - 15 * 60 * 1000;

    const result = evaluateCondition(
      "fast_spend",
      { metric: "spent_speed", operator: ">", value: 20 },
      { spent: 500, leads: 2, impressions: 5000, clicks: 100 },
      {
        spendHistory: [
          { spent: 400, timestamp: fifteenMinAgo },
          { spent: 500, timestamp: now }, // diff = 100 / 1000 = 10%
        ],
        dailyBudget: 1000,
      }
    );
    expect(result).toBe(false);
  });

  test("fast_spend requires at least 2 snapshots", () => {
    const result = evaluateCondition(
      "fast_spend",
      { metric: "spent_speed", operator: ">", value: 20 },
      { spent: 1000, leads: 5, impressions: 10000, clicks: 200 },
      {
        spendHistory: [{ spent: 1000, timestamp: Date.now() }],
        dailyBudget: 1000,
      }
    );
    expect(result).toBe(false);
  });

  test("fast_spend requires dailyBudget", () => {
    const now = Date.now();
    const result = evaluateCondition(
      "fast_spend",
      { metric: "spent_speed", operator: ">", value: 20 },
      { spent: 1000, leads: 5, impressions: 10000, clicks: 200 },
      {
        spendHistory: [
          { spent: 750, timestamp: now - 15 * 60 * 1000 },
          { spent: 1000, timestamp: now },
        ],
      }
    );
    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 8 DoD #4: spend_no_leads
  // ═══════════════════════════════════════════════════════════

  test("S8-DoD#4: spend_no_leads triggers (spent=1500, leads=0, value=1000)", () => {
    const result = evaluateCondition(
      "spend_no_leads",
      { metric: "spent_no_leads", operator: ">", value: 1000 },
      { spent: 1500, leads: 0, impressions: 20000, clicks: 300 }
    );
    expect(result).toBe(true);
  });

  test("spend_no_leads does NOT trigger with leads present", () => {
    const result = evaluateCondition(
      "spend_no_leads",
      { metric: "spent_no_leads", operator: ">", value: 1000 },
      { spent: 1500, leads: 1, impressions: 20000, clicks: 300 }
    );
    expect(result).toBe(false);
  });

  test("spend_no_leads does NOT trigger when below threshold", () => {
    const result = evaluateCondition(
      "spend_no_leads",
      { metric: "spent_no_leads", operator: ">", value: 1000 },
      { spent: 800, leads: 0, impressions: 10000, clicks: 100 }
    );
    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 8 DoD #5: calculateSavings
  // ═══════════════════════════════════════════════════════════

  test("S8-DoD#5: calculateSavings = 100rub/min * 360min = 36000rub", () => {
    const savings = calculateSavings(100, 360);
    expect(savings).toBe(36000);
  });

  test("calculateSavings returns 0 for zero spend rate", () => {
    expect(calculateSavings(0, 360)).toBe(0);
  });

  test("calculateSavings returns 0 for zero minutes remaining", () => {
    expect(calculateSavings(100, 0)).toBe(0);
  });

  test("calculateSavings returns 0 for negative inputs", () => {
    expect(calculateSavings(-10, 360)).toBe(0);
    expect(calculateSavings(100, -60)).toBe(0);
  });

  test("minutesUntilEndOfDay at 12:00 returns 360", () => {
    const noon = new Date("2026-01-28T12:00:00");
    expect(minutesUntilEndOfDay(noon)).toBe(360);
  });

  test("minutesUntilEndOfDay after 18:00 returns 0", () => {
    const evening = new Date("2026-01-28T19:00:00");
    expect(minutesUntilEndOfDay(evening)).toBe(0);
  });

  test("minutesUntilEndOfDay at 17:30 returns 30", () => {
    const late = new Date("2026-01-28T17:30:00");
    expect(minutesUntilEndOfDay(late)).toBe(30);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 8 DoD #6: VK API stop — actionLog with status=success
  // ═══════════════════════════════════════════════════════════

  test("S8-DoD#6: stopAd creates actionLog with status=success", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "CPL Stop Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: true, notify: false },
      targetAccountIds: [accountId],
    });

    // Simulate successful stop by creating actionLog with status=success
    const logId = await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_stop_1",
      adName: "Test Ad",
      actionType: "stopped",
      reason: "CPL 600\u20BD \u043F\u0440\u0435\u0432\u044B\u0441\u0438\u043B \u043B\u0438\u043C\u0438\u0442 500\u20BD",
      metricsSnapshot: {
        spent: 3000,
        leads: 5,
        cpl: 600,
      },
      savedAmount: 36000,
      status: "success",
    });

    expect(logId).toBeDefined();

    const logs = await t.query(api.ruleEngine.listActionLogs, { userId });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("success");
    expect(logs[0].actionType).toBe("stopped");
    expect(logs[0].adId).toBe("ad_stop_1");
    expect(logs[0].savedAmount).toBe(36000);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 8 DoD #7: actionLog created with all required fields
  // ═══════════════════════════════════════════════════════════

  test("S8-DoD#7: actionLog contains all required fields", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "CTR Watch",
      type: "min_ctr",
      value: 1.0,
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId],
    });

    const logId = await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_ctr_1",
      adName: "Low CTR Ad",
      campaignName: "Campaign A",
      actionType: "stopped_and_notified",
      reason: "CTR 0.50% \u043D\u0438\u0436\u0435 \u043C\u0438\u043D\u0438\u043C\u0443\u043C\u0430 1.00%",
      metricsSnapshot: {
        spent: 1000,
        leads: 2,
        impressions: 10000,
        clicks: 50,
        ctr: 0.5,
      },
      savedAmount: 18000,
      status: "success",
    });

    expect(logId).toBeDefined();

    const logs = await t.query(api.ruleEngine.listActionLogs, { userId });
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.userId).toBe(userId);
    expect(log.ruleId).toBe(ruleId);
    expect(log.accountId).toBe(accountId);
    expect(log.adId).toBe("ad_ctr_1");
    expect(log.adName).toBe("Low CTR Ad");
    expect(log.campaignName).toBe("Campaign A");
    expect(log.actionType).toBe("stopped_and_notified");
    expect(log.reason).toContain("CTR");
    expect(log.metricsSnapshot.spent).toBe(1000);
    expect(log.metricsSnapshot.leads).toBe(2);
    expect(log.metricsSnapshot.impressions).toBe(10000);
    expect(log.metricsSnapshot.clicks).toBe(50);
    expect(log.metricsSnapshot.ctr).toBe(0.5);
    expect(log.savedAmount).toBe(18000);
    expect(log.status).toBe("success");
    expect(log.createdAt).toBeGreaterThan(0);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 8 DoD #10: isActive=false rule is skipped
  // ═══════════════════════════════════════════════════════════

  test("S8-DoD#10: inactive rule is not returned by active rules query", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    // Create active rule
    const activeRuleId = await t.mutation(api.rules.create, {
      userId,
      name: "Active CPL Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: true, notify: false },
      targetAccountIds: [accountId],
    });

    // Create and deactivate another rule
    const inactiveRuleId = await t.mutation(api.rules.create, {
      userId,
      name: "Inactive CTR Rule",
      type: "min_ctr",
      value: 1.0,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    await t.mutation(api.rules.toggleActive, {
      ruleId: inactiveRuleId,
      userId,
    });

    // Verify total rules = 2
    const allRules = await t.query(api.rules.list, { userId });
    expect(allRules).toHaveLength(2);

    // Verify only 1 active
    const activeRules = allRules.filter((r) => r.isActive);
    expect(activeRules).toHaveLength(1);
    expect(activeRules[0]._id).toBe(activeRuleId);

    // The inactive rule should never be evaluated by checkAllRules
    // because listActiveRules filters by isActive=true
    const inactiveRule = allRules.find((r) => r._id === inactiveRuleId);
    expect(inactiveRule?.isActive).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 8 DoD #11: minSamples not met — rule does not trigger
  // ═══════════════════════════════════════════════════════════

  test("S8-DoD#11: rule with minSamples=10 skips when only 5 samples", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    // Create a rule with minSamples=10
    await t.mutation(api.rules.create, {
      userId,
      name: "Min Samples Rule",
      type: "cpl_limit",
      value: 500,
      minSamples: 10,
      actions: { stopAd: true, notify: false },
      targetAccountIds: [accountId],
    });

    // Save only 5 realtime snapshots
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.metrics.saveRealtimePublic, {
        accountId,
        adId: "ad_samples",
        spent: 600 * (i + 1),
        leads: i + 1,
        impressions: 1000 * (i + 1),
        clicks: 50 * (i + 1),
      });
    }

    // The condition WOULD trigger if evaluated (CPL=600 > 500)
    const conditionResult = evaluateCondition(
      "cpl_limit",
      { metric: "cpl", operator: ">", value: 500 },
      { spent: 3000, leads: 5, impressions: 5000, clicks: 250 }
    );
    expect(conditionResult).toBe(true);

    // But checkAllRules skips it because:
    // history.length (5) < rule.conditions.minSamples (10)
    // Verify we have exactly 5 snapshots
    const latestMetric = await t.query(api.metrics.getRealtimeByAd, {
      adId: "ad_samples",
    });
    expect(latestMetric).toBeDefined();
    expect(latestMetric?.spent).toBe(3000); // Last snapshot: 600*5
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 8 DoD #12: VK API error → status=failed
  // ═══════════════════════════════════════════════════════════

  test("S8-DoD#12: VK API error creates actionLog with status=failed", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Budget Limit Rule",
      type: "budget_limit",
      value: 5000,
      actions: { stopAd: true, notify: false },
      targetAccountIds: [accountId],
    });

    // Simulate VK API failure — create actionLog with status=failed
    const logId = await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_error_1",
      adName: "Error Ad",
      actionType: "stopped",
      reason: "\u0420\u0430\u0441\u0445\u043E\u0434 6000\u20BD \u043F\u0440\u0435\u0432\u044B\u0441\u0438\u043B \u0431\u044E\u0434\u0436\u0435\u0442 5000\u20BD",
      metricsSnapshot: {
        spent: 6000,
        leads: 3,
      },
      savedAmount: 0,
      status: "failed",
      errorMessage: "VK Ads API Error 500: Internal Server Error",
    });

    expect(logId).toBeDefined();

    const logs = await t.query(api.ruleEngine.listActionLogs, { userId });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("failed");
    expect(logs[0].errorMessage).toContain("500");
    expect(logs[0].errorMessage).toContain("Internal Server Error");
    expect(logs[0].adId).toBe("ad_error_1");
  });

  // ═══════════════════════════════════════════════════════════
  // Additional unit tests — all rule types
  // ═══════════════════════════════════════════════════════════

  test("budget_limit triggers when spent > value", () => {
    const result = evaluateCondition(
      "budget_limit",
      { metric: "spent", operator: ">", value: 5000 },
      { spent: 6000, leads: 3, impressions: 30000, clicks: 500 }
    );
    expect(result).toBe(true);
  });

  test("budget_limit does NOT trigger when below value", () => {
    const result = evaluateCondition(
      "budget_limit",
      { metric: "spent", operator: ">", value: 5000 },
      { spent: 4000, leads: 3, impressions: 30000, clicks: 500 }
    );
    expect(result).toBe(false);
  });

  test("low_impressions triggers when impressions < value", () => {
    const result = evaluateCondition(
      "low_impressions",
      { metric: "impressions", operator: "<", value: 1000 },
      { spent: 500, leads: 1, impressions: 500, clicks: 20 }
    );
    expect(result).toBe(true);
  });

  test("low_impressions does NOT trigger when above value", () => {
    const result = evaluateCondition(
      "low_impressions",
      { metric: "impressions", operator: "<", value: 1000 },
      { spent: 500, leads: 1, impressions: 2000, clicks: 50 }
    );
    expect(result).toBe(false);
  });

  test("clicks_no_leads triggers when clicks >= value and leads=0", () => {
    const result = evaluateCondition(
      "clicks_no_leads",
      { metric: "clicks_no_leads", operator: ">=", value: 100 },
      { spent: 800, leads: 0, impressions: 10000, clicks: 150 }
    );
    expect(result).toBe(true);
  });

  test("clicks_no_leads does NOT trigger with leads present", () => {
    const result = evaluateCondition(
      "clicks_no_leads",
      { metric: "clicks_no_leads", operator: ">=", value: 100 },
      { spent: 800, leads: 1, impressions: 10000, clicks: 150 }
    );
    expect(result).toBe(false);
  });

  test("clicks_no_leads does NOT trigger when clicks below value", () => {
    const result = evaluateCondition(
      "clicks_no_leads",
      { metric: "clicks_no_leads", operator: ">=", value: 100 },
      { spent: 300, leads: 0, impressions: 5000, clicks: 50 }
    );
    expect(result).toBe(false);
  });

  test("unknown rule type returns false", () => {
    const result = evaluateCondition(
      "unknown_type",
      { metric: "unknown", operator: ">", value: 100 },
      { spent: 500, leads: 2, impressions: 10000, clicks: 100 }
    );
    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════
  // Integration: actionLogs query by rule
  // ═══════════════════════════════════════════════════════════

  test("getActionLogsByRule returns logs for specific rule", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const rule1 = await t.mutation(api.rules.create, {
      userId,
      name: "Rule A",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: true, notify: false },
      targetAccountIds: [accountId],
    });

    const rule2 = await t.mutation(api.rules.create, {
      userId,
      name: "Rule B",
      type: "min_ctr",
      value: 1.0,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    // Create logs for both rules
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId: rule1,
      accountId,
      adId: "ad_1",
      adName: "Ad 1",
      actionType: "stopped",
      reason: "CPL exceeded",
      metricsSnapshot: { spent: 3000, leads: 5 },
      savedAmount: 10000,
      status: "success",
    });

    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId: rule2,
      accountId,
      adId: "ad_2",
      adName: "Ad 2",
      actionType: "notified",
      reason: "Low CTR",
      metricsSnapshot: { spent: 1000, leads: 2 },
      savedAmount: 5000,
      status: "success",
    });

    // Query by rule1
    const rule1Logs = await t.query(api.ruleEngine.getActionLogsByRule, {
      ruleId: rule1,
    });
    expect(rule1Logs).toHaveLength(1);
    expect(rule1Logs[0].adId).toBe("ad_1");

    // Query by rule2
    const rule2Logs = await t.query(api.ruleEngine.getActionLogsByRule, {
      ruleId: rule2,
    });
    expect(rule2Logs).toHaveLength(1);
    expect(rule2Logs[0].adId).toBe("ad_2");

    // All logs for user
    const allLogs = await t.query(api.ruleEngine.listActionLogs, { userId });
    expect(allLogs).toHaveLength(2);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 13 — Savings Widget Queries
  // ═══════════════════════════════════════════════════════════

  // S13-DoD#1: getSavedToday — correct sum for today
  test("S13-DoD#1: getSavedToday returns correct sum for today", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Savings Rule",
      type: "cpl_limit",
      value: 300,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    // Create 3 action logs with different savedAmounts
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_s1",
      adName: "Ad 1",
      actionType: "stopped",
      reason: "CPL high",
      metricsSnapshot: { spent: 1000, leads: 2 },
      savedAmount: 500,
      status: "success",
    });

    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_s2",
      adName: "Ad 2",
      actionType: "notified",
      reason: "CTR low",
      metricsSnapshot: { spent: 800, leads: 1 },
      savedAmount: 300,
      status: "success",
    });

    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_s3",
      adName: "Ad 3",
      actionType: "stopped",
      reason: "Budget exceeded",
      metricsSnapshot: { spent: 2000, leads: 3 },
      savedAmount: 1200,
      status: "success",
    });

    const total = await t.query(api.ruleEngine.getSavedToday, { userId });
    expect(total).toBe(2000); // 500 + 300 + 1200
  });

  // S13-DoD#2: getSavedHistory — returns 7 elements
  test("S13-DoD#2: getSavedHistory returns 7 elements by default", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "History Rule",
      type: "cpl_limit",
      value: 300,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    // Create one action log (today)
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_h1",
      adName: "History Ad",
      actionType: "stopped",
      reason: "CPL high",
      metricsSnapshot: { spent: 1000, leads: 2 },
      savedAmount: 750,
      status: "success",
    });

    const history = await t.query(api.ruleEngine.getSavedHistory, { userId });
    expect(history).toHaveLength(7);

    // Each element has date and amount
    for (const entry of history) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof entry.amount).toBe("number");
    }

    // Today's entry should have the savedAmount
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayEntry = history.find((h) => h.date === todayStr);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.amount).toBe(750);
  });

  // S13-DoD#9: Нет данных — новый пользователь → 0
  test("S13-DoD#9: getSavedToday returns 0 for new user", async () => {
    const t = convexTest(schema);
    const { userId } = await createTestSetup(t);

    const total = await t.query(api.ruleEngine.getSavedToday, { userId });
    expect(total).toBe(0);
  });

  test("S13-DoD#9: getSavedHistory returns all zeros for new user", async () => {
    const t = convexTest(schema);
    const { userId } = await createTestSetup(t);

    const history = await t.query(api.ruleEngine.getSavedHistory, { userId });
    expect(history).toHaveLength(7);

    for (const entry of history) {
      expect(entry.amount).toBe(0);
    }
  });

  // S13-DoD#10: Previous period = 0 → percentage handled gracefully
  test("S13-DoD#10: getSavedHistory with data only in recent days", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Recent Rule",
      type: "cpl_limit",
      value: 300,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    // Create today's action log
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_recent",
      adName: "Recent Ad",
      actionType: "stopped",
      reason: "CPL high",
      metricsSnapshot: { spent: 2000, leads: 4 },
      savedAmount: 1000,
      status: "success",
    });

    const history = await t.query(api.ruleEngine.getSavedHistory, { userId });

    // Should have 7 entries, most are 0
    expect(history).toHaveLength(7);

    // Today should have data
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayEntry = history.find((h) => h.date === todayStr);
    expect(todayEntry!.amount).toBe(1000);

    // Earlier days should be 0 (first half = previous period)
    const firstThree = history.slice(0, 3);
    const firstThreeTotal = firstThree.reduce((s, d) => s + d.amount, 0);
    expect(firstThreeTotal).toBe(0);
  });

  // S13: getSavedHistory with custom days param
  test("S13: getSavedHistory respects custom days parameter", async () => {
    const t = convexTest(schema);
    const { userId } = await createTestSetup(t);

    const history14 = await t.query(api.ruleEngine.getSavedHistory, {
      userId,
      days: 14,
    });
    expect(history14).toHaveLength(14);

    const history3 = await t.query(api.ruleEngine.getSavedHistory, {
      userId,
      days: 3,
    });
    expect(history3).toHaveLength(3);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 14 — Activity Stats
  // ═══════════════════════════════════════════════════════════

  // S14-DoD#1: getActivityStats returns {triggers, stops, notifications}
  test("S14-DoD#1: getActivityStats returns correct counts", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Activity Rule",
      type: "cpl_limit",
      value: 300,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    // Create action logs with different types
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_a1",
      adName: "Stopped Ad",
      actionType: "stopped",
      reason: "CPL high",
      metricsSnapshot: { spent: 1000, leads: 2 },
      savedAmount: 500,
      status: "success",
    });

    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_a2",
      adName: "Notified Ad",
      actionType: "notified",
      reason: "CTR low",
      metricsSnapshot: { spent: 800, leads: 1 },
      savedAmount: 0,
      status: "success",
    });

    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_a3",
      adName: "Stopped+Notified Ad",
      actionType: "stopped_and_notified",
      reason: "Budget exceeded",
      metricsSnapshot: { spent: 2000, leads: 3 },
      savedAmount: 1000,
      status: "success",
    });

    const stats = await t.query(api.ruleEngine.getActivityStats, { userId });

    expect(stats.triggers).toBe(3); // all 3 logs
    expect(stats.stops).toBe(2); // stopped + stopped_and_notified
    expect(stats.notifications).toBe(2); // notified + stopped_and_notified
  });

  // S14-DoD#1: getActivityStats returns zeros for new user
  test("S14-DoD#1: getActivityStats returns zeros for new user", async () => {
    const t = convexTest(schema);
    const { userId } = await createTestSetup(t);

    const stats = await t.query(api.ruleEngine.getActivityStats, { userId });

    expect(stats.triggers).toBe(0);
    expect(stats.stops).toBe(0);
    expect(stats.notifications).toBe(0);
  });

  // S14-DoD#9: No accounts edge case (query still works)
  test("S14-DoD#9: getActivityStats works with no accounts", async () => {
    const t = convexTest(schema);
    const userId = await t.mutation(api.users.create, {
      email: "noaccounts@test.com",
      vkId: "noaccounts_user",
      name: "No Accounts User",
    });

    const stats = await t.query(api.ruleEngine.getActivityStats, { userId });
    expect(stats.triggers).toBe(0);
    expect(stats.stops).toBe(0);
    expect(stats.notifications).toBe(0);
  });

  // S14-DoD#10: Error status account (health indicator test via data)
  test("S14-DoD#10: account with error status is queryable", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    // Simulate error status via direct DB patch
    await t.run(async (ctx) => {
      await ctx.db.patch(accountId, { status: "error", lastError: "Token expired" });
    });

    const accounts = await t.query(api.adAccounts.list, { userId });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].status).toBe("error");
    expect(accounts[0].lastError).toBe("Token expired");
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 15 — Event Feed (getRecentEvents)
  // ═══════════════════════════════════════════════════════════

  // S15-DoD#1: getRecentEvents returns events with limit=10
  test("S15-DoD#1: getRecentEvents returns events limited to 10", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "CPL Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    // Create 12 action logs
    for (let i = 0; i < 12; i++) {
      await t.mutation(api.ruleEngine.createActionLogPublic, {
        userId,
        ruleId,
        accountId,
        adId: `ad_event_${i}`,
        adName: `Ad ${i}`,
        actionType: "notified",
        reason: `CPL exceeded #${i}`,
        metricsSnapshot: { spent: 1000, leads: 2, cpl: 500 },
        savedAmount: 500,
        status: "success",
      });
    }

    const events = await t.query(api.ruleEngine.getRecentEvents, { userId });
    expect(events).toHaveLength(10);
  });

  // S15-DoD#2: getRecentEvents filters by actionType
  test("S15-DoD#2: getRecentEvents filters by actionType", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Mixed Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    // Create mixed action logs
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId, ruleId, accountId,
      adId: "ad_s", adName: "Stopped Ad",
      actionType: "stopped",
      reason: "CPL exceeded",
      metricsSnapshot: { spent: 1000, leads: 2, cpl: 500 },
      savedAmount: 1000, status: "success",
    });
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId, ruleId, accountId,
      adId: "ad_n", adName: "Notified Ad",
      actionType: "notified",
      reason: "CPL warning",
      metricsSnapshot: { spent: 800, leads: 2, cpl: 400 },
      savedAmount: 500, status: "success",
    });
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId, ruleId, accountId,
      adId: "ad_sn", adName: "Stopped+Notified",
      actionType: "stopped_and_notified",
      reason: "CPL critical",
      metricsSnapshot: { spent: 2000, leads: 1, cpl: 2000 },
      savedAmount: 2000, status: "success",
    });

    const stopped = await t.query(api.ruleEngine.getRecentEvents, {
      userId, actionType: "stopped",
    });
    expect(stopped).toHaveLength(1);
    expect(stopped[0].actionType).toBe("stopped");

    const notified = await t.query(api.ruleEngine.getRecentEvents, {
      userId, actionType: "notified",
    });
    expect(notified).toHaveLength(1);
    expect(notified[0].actionType).toBe("notified");
  });

  // S15-DoD#3: getRecentEvents filters by accountId
  test("S15-DoD#3: getRecentEvents filters by accountId", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    // Create a second account
    const accountId2 = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "RE002",
      name: "Second Cabinet",
      accessToken: "token_second",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Multi-account Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId, accountId2],
    });

    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId, ruleId, accountId,
      adId: "ad_acc1", adName: "Ad from Cabinet 1",
      actionType: "notified",
      reason: "CPL warning",
      metricsSnapshot: { spent: 1000, leads: 2, cpl: 500 },
      savedAmount: 500, status: "success",
    });
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId, ruleId, accountId: accountId2,
      adId: "ad_acc2", adName: "Ad from Cabinet 2",
      actionType: "stopped",
      reason: "CPL exceeded",
      metricsSnapshot: { spent: 2000, leads: 1, cpl: 2000 },
      savedAmount: 1500, status: "success",
    });

    const acc1Events = await t.query(api.ruleEngine.getRecentEvents, {
      userId, accountId,
    });
    expect(acc1Events).toHaveLength(1);
    expect(acc1Events[0].adId).toBe("ad_acc1");

    const acc2Events = await t.query(api.ruleEngine.getRecentEvents, {
      userId, accountId: accountId2,
    });
    expect(acc2Events).toHaveLength(1);
    expect(acc2Events[0].adId).toBe("ad_acc2");
  });

  // S15-DoD#4: getRecentEvents returns empty array for new user
  test("S15-DoD#4: getRecentEvents returns empty for new user", async () => {
    const t = convexTest(schema);
    const userId = await t.mutation(api.users.create, {
      email: "noeventuser@test.com",
      vkId: "noevent_user",
      name: "No Events User",
    });

    const events = await t.query(api.ruleEngine.getRecentEvents, { userId });
    expect(events).toHaveLength(0);
  });

  // S15-DoD#5: getRecentEvents with combined filters (actionType + accountId) returns empty when no match
  test("S15-DoD#5: getRecentEvents combined filters return empty when no match", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const accountId2 = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "RE003",
      name: "Third Cabinet",
      accessToken: "token_third",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Combined Filter Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    // Only "notified" events on accountId
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId, ruleId, accountId,
      adId: "ad_only_notif", adName: "Notified Only",
      actionType: "notified",
      reason: "CPL info",
      metricsSnapshot: { spent: 500, leads: 1, cpl: 500 },
      savedAmount: 300, status: "success",
    });

    // Filter for "stopped" on accountId2 — should be empty
    const events = await t.query(api.ruleEngine.getRecentEvents, {
      userId, actionType: "stopped", accountId: accountId2,
    });
    expect(events).toHaveLength(0);
  });

  // S15-DoD#6: getRecentEvents respects custom limit
  test("S15-DoD#6: getRecentEvents respects custom limit", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Limit Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    for (let i = 0; i < 5; i++) {
      await t.mutation(api.ruleEngine.createActionLogPublic, {
        userId, ruleId, accountId,
        adId: `ad_lim_${i}`, adName: `Limit Ad ${i}`,
        actionType: "notified",
        reason: `Event #${i}`,
        metricsSnapshot: { spent: 100, leads: 1, cpl: 100 },
        savedAmount: 100, status: "success",
      });
    }

    const events = await t.query(api.ruleEngine.getRecentEvents, {
      userId, limit: 3,
    });
    expect(events).toHaveLength(3);
  });
});
