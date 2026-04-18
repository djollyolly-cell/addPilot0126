/**
 * Unit tests for rule engine pure functions:
 * evaluateCondition, calculateSavings, minutesUntilEndOfDay
 */

import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  evaluateConditionTrace,
  calculateSavings,
  minutesUntilEndOfDay,
  matchesCampaignFilter,
  shouldSkipDailyDedup,
  ActionLogEntry,
  MetricsSnapshot,
  RuleCondition,
} from "../../convex/ruleEngine";

// ═══════════════════════════════════════════════════════════
// evaluateCondition — all 7 rule types
// ═══════════════════════════════════════════════════════════

describe("evaluateCondition", () => {
  // ─── cpl_limit ───
  describe("cpl_limit", () => {
    const condition: RuleCondition = { metric: "cpl", operator: ">", value: 500 };

    it("triggers when CPL exceeds limit", () => {
      const metrics: MetricsSnapshot = { spent: 1200, leads: 2, impressions: 1000, clicks: 50 };
      // CPL = 1200/2 = 600 > 500
      expect(evaluateCondition("cpl_limit", condition, metrics)).toBe(true);
    });

    it("does not trigger when CPL is within limit", () => {
      const metrics: MetricsSnapshot = { spent: 800, leads: 2, impressions: 1000, clicks: 50 };
      // CPL = 800/2 = 400 < 500
      expect(evaluateCondition("cpl_limit", condition, metrics)).toBe(false);
    });

    it("triggers when leads=0 and spent exceeds CPL limit", () => {
      const metrics: MetricsSnapshot = { spent: 600, leads: 0, impressions: 500, clicks: 30 };
      // leads=0, spent 600 > порог 500 → даже 1 лид даст CPL 600 > 500
      expect(evaluateCondition("cpl_limit", condition, metrics)).toBe(true);
    });

    it("does not trigger when leads=0 and spent within CPL limit", () => {
      const metrics: MetricsSnapshot = { spent: 400, leads: 0, impressions: 500, clicks: 30 };
      // leads=0, spent 400 ≤ порог 500 → 1 лид даст CPL 400 < 500
      expect(evaluateCondition("cpl_limit", condition, metrics)).toBe(false);
    });

    it("does not trigger when leads=0 and spent equals CPL limit", () => {
      const metrics: MetricsSnapshot = { spent: 500, leads: 0, impressions: 500, clicks: 30 };
      // leads=0, spent 500 = порог 500 → не превышает (строго >)
      expect(evaluateCondition("cpl_limit", condition, metrics)).toBe(false);
    });
  });

  // ─── min_ctr ───
  describe("min_ctr", () => {
    const condition: RuleCondition = { metric: "ctr", operator: "<", value: 1.0 };

    it("triggers when CTR is below minimum", () => {
      const metrics: MetricsSnapshot = { spent: 100, leads: 0, impressions: 1000, clicks: 5 };
      // CTR = 5/1000 * 100 = 0.5% < 1.0%
      expect(evaluateCondition("min_ctr", condition, metrics)).toBe(true);
    });

    it("does not trigger when CTR is above minimum", () => {
      const metrics: MetricsSnapshot = { spent: 100, leads: 0, impressions: 1000, clicks: 15 };
      // CTR = 15/1000 * 100 = 1.5% > 1.0%
      expect(evaluateCondition("min_ctr", condition, metrics)).toBe(false);
    });

    it("does not trigger when no impressions", () => {
      const metrics: MetricsSnapshot = { spent: 0, leads: 0, impressions: 0, clicks: 0 };
      expect(evaluateCondition("min_ctr", condition, metrics)).toBe(false);
    });
  });

  // ─── fast_spend ───
  describe("fast_spend", () => {
    const condition: RuleCondition = { metric: "spent_speed", operator: ">", value: 50 };

    it("triggers when spend exceeds budget percentage", () => {
      const metrics: MetricsSnapshot = { spent: 0, leads: 0, impressions: 0, clicks: 0 };
      const context = {
        spendHistory: [
          { spent: 100, timestamp: 1000 },
          { spent: 700, timestamp: 2000 },
        ],
        dailyBudget: 1000,
      };
      // Diff = 600, percent = 60% > 50%
      expect(evaluateCondition("fast_spend", condition, metrics, context)).toBe(true);
    });

    it("does not trigger when spend is within budget", () => {
      const metrics: MetricsSnapshot = { spent: 0, leads: 0, impressions: 0, clicks: 0 };
      const context = {
        spendHistory: [
          { spent: 100, timestamp: 1000 },
          { spent: 300, timestamp: 2000 },
        ],
        dailyBudget: 1000,
      };
      // Diff = 200, percent = 20% < 50%
      expect(evaluateCondition("fast_spend", condition, metrics, context)).toBe(false);
    });

    it("does not trigger without spend history", () => {
      const metrics: MetricsSnapshot = { spent: 500, leads: 0, impressions: 0, clicks: 0 };
      expect(evaluateCondition("fast_spend", condition, metrics)).toBe(false);
    });

    it("does not trigger with single history point", () => {
      const metrics: MetricsSnapshot = { spent: 0, leads: 0, impressions: 0, clicks: 0 };
      const context = {
        spendHistory: [{ spent: 100, timestamp: 1000 }],
        dailyBudget: 1000,
      };
      expect(evaluateCondition("fast_spend", condition, metrics, context)).toBe(false);
    });

    it("does not trigger without daily budget", () => {
      const metrics: MetricsSnapshot = { spent: 0, leads: 0, impressions: 0, clicks: 0 };
      const context = {
        spendHistory: [
          { spent: 100, timestamp: 1000 },
          { spent: 700, timestamp: 2000 },
        ],
        dailyBudget: 0,
      };
      expect(evaluateCondition("fast_spend", condition, metrics, context)).toBe(false);
    });
  });

  // ─── spend_no_leads ───
  describe("spend_no_leads", () => {
    const condition: RuleCondition = { metric: "spent_no_leads", operator: ">", value: 300 };

    it("triggers when spent exceeds threshold with 0 leads", () => {
      const metrics: MetricsSnapshot = { spent: 500, leads: 0, impressions: 1000, clicks: 50 };
      expect(evaluateCondition("spend_no_leads", condition, metrics)).toBe(true);
    });

    it("does not trigger when there are leads", () => {
      const metrics: MetricsSnapshot = { spent: 500, leads: 1, impressions: 1000, clicks: 50 };
      expect(evaluateCondition("spend_no_leads", condition, metrics)).toBe(false);
    });

    it("does not trigger when spent is below threshold", () => {
      const metrics: MetricsSnapshot = { spent: 200, leads: 0, impressions: 500, clicks: 20 };
      expect(evaluateCondition("spend_no_leads", condition, metrics)).toBe(false);
    });
  });

  // ─── budget_limit ───
  describe("budget_limit", () => {
    const condition: RuleCondition = { metric: "spent", operator: ">", value: 1000 };

    it("triggers when spent exceeds budget", () => {
      const metrics: MetricsSnapshot = { spent: 1200, leads: 5, impressions: 5000, clicks: 200 };
      expect(evaluateCondition("budget_limit", condition, metrics)).toBe(true);
    });

    it("does not trigger when spent is within budget", () => {
      const metrics: MetricsSnapshot = { spent: 800, leads: 3, impressions: 3000, clicks: 100 };
      expect(evaluateCondition("budget_limit", condition, metrics)).toBe(false);
    });
  });

  // ─── low_impressions ───
  describe("low_impressions", () => {
    const condition: RuleCondition = { metric: "impressions", operator: "<", value: 100 };

    it("triggers when impressions below minimum", () => {
      const metrics: MetricsSnapshot = { spent: 50, leads: 0, impressions: 30, clicks: 2 };
      expect(evaluateCondition("low_impressions", condition, metrics)).toBe(true);
    });

    it("does not trigger when impressions are sufficient", () => {
      const metrics: MetricsSnapshot = { spent: 100, leads: 1, impressions: 500, clicks: 20 };
      expect(evaluateCondition("low_impressions", condition, metrics)).toBe(false);
    });

    it("does not trigger when all metrics are zero (no data)", () => {
      const metrics: MetricsSnapshot = { spent: 0, leads: 0, impressions: 0, clicks: 0 };
      expect(evaluateCondition("low_impressions", condition, metrics)).toBe(false);
    });

    it("triggers when impressions=0 but has spend (real problem)", () => {
      const metrics: MetricsSnapshot = { spent: 50, leads: 0, impressions: 0, clicks: 0 };
      expect(evaluateCondition("low_impressions", condition, metrics)).toBe(true);
    });

    it("triggers when impressions=0 but has clicks (real problem)", () => {
      const metrics: MetricsSnapshot = { spent: 0, leads: 0, impressions: 0, clicks: 5 };
      expect(evaluateCondition("low_impressions", condition, metrics)).toBe(true);
    });

    it("does not trigger at exact threshold", () => {
      const metrics: MetricsSnapshot = { spent: 10, leads: 0, impressions: 100, clicks: 5 };
      expect(evaluateCondition("low_impressions", condition, metrics)).toBe(false);
    });
  });

  // ─── clicks_no_leads (daily — default) ───
  describe("clicks_no_leads (daily)", () => {
    const condition: RuleCondition = { metric: "clicks_no_leads", operator: ">=", value: 15 };

    it("triggers when clicks >= threshold with 0 leads", () => {
      const metrics: MetricsSnapshot = { spent: 200, leads: 0, impressions: 1000, clicks: 20 };
      expect(evaluateCondition("clicks_no_leads", condition, metrics)).toBe(true);
    });

    it("triggers at exact threshold", () => {
      const metrics: MetricsSnapshot = { spent: 150, leads: 0, impressions: 800, clicks: 15 };
      expect(evaluateCondition("clicks_no_leads", condition, metrics)).toBe(true);
    });

    it("does not trigger when there are leads", () => {
      const metrics: MetricsSnapshot = { spent: 300, leads: 1, impressions: 2000, clicks: 30 };
      expect(evaluateCondition("clicks_no_leads", condition, metrics)).toBe(false);
    });

    it("does not trigger when clicks below threshold", () => {
      const metrics: MetricsSnapshot = { spent: 100, leads: 0, impressions: 500, clicks: 10 };
      expect(evaluateCondition("clicks_no_leads", condition, metrics)).toBe(false);
    });
  });

  // ─── clicks_no_leads with timeWindow (since_launch / 24h) ───
  // Note: timeWindow affects which metrics are passed by checkAllRules,
  // not the evaluateCondition logic itself. These tests verify that
  // the evaluation works correctly with aggregated metrics.
  describe("clicks_no_leads (aggregated — since_launch / 24h)", () => {
    const condition: RuleCondition = {
      metric: "clicks_no_leads",
      operator: ">=",
      value: 15,
      timeWindow: "since_launch",
    };

    it("triggers with aggregated metrics exceeding threshold", () => {
      // Simulates sum of clicks across multiple days
      const aggregatedMetrics: MetricsSnapshot = {
        spent: 800,
        leads: 0,
        impressions: 5000,
        clicks: 25, // e.g. 5+8+12 across 3 days
      };
      expect(evaluateCondition("clicks_no_leads", condition, aggregatedMetrics)).toBe(true);
    });

    it("does not trigger when aggregated leads > 0", () => {
      const aggregatedMetrics: MetricsSnapshot = {
        spent: 800,
        leads: 2, // got some leads across days
        impressions: 5000,
        clicks: 30,
      };
      expect(evaluateCondition("clicks_no_leads", condition, aggregatedMetrics)).toBe(false);
    });

    it("does not trigger when aggregated clicks below threshold", () => {
      const aggregatedMetrics: MetricsSnapshot = {
        spent: 200,
        leads: 0,
        impressions: 1000,
        clicks: 10, // still below 15
      };
      expect(evaluateCondition("clicks_no_leads", condition, aggregatedMetrics)).toBe(false);
    });

    it("works with 24h timeWindow the same way", () => {
      const condition24h: RuleCondition = {
        metric: "clicks_no_leads",
        operator: ">=",
        value: 15,
        timeWindow: "24h",
      };
      // Yesterday + today aggregated
      const metrics: MetricsSnapshot = {
        spent: 400,
        leads: 0,
        impressions: 3000,
        clicks: 18,
      };
      expect(evaluateCondition("clicks_no_leads", condition24h, metrics)).toBe(true);
    });
  });

  // ─── unknown rule type ───
  describe("unknown rule type", () => {
    it("returns false for unknown type", () => {
      const condition: RuleCondition = { metric: "x", operator: ">", value: 1 };
      const metrics: MetricsSnapshot = { spent: 1000, leads: 10, impressions: 5000, clicks: 200 };
      expect(evaluateCondition("nonexistent_rule", condition, metrics)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// calculateSavings
// ═══════════════════════════════════════════════════════════

describe("calculateSavings", () => {
  it("returns spentToday as saved amount", () => {
    expect(calculateSavings(1500)).toBe(1500);
  });

  it("returns 0 when spending is 0", () => {
    expect(calculateSavings(0)).toBe(0);
  });

  it("returns 0 when negative spending", () => {
    expect(calculateSavings(-5)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// minutesUntilEndOfDay
// ═══════════════════════════════════════════════════════════

describe("minutesUntilEndOfDay", () => {
  it("returns correct minutes before 18:00", () => {
    const noon = new Date("2026-02-25T12:00:00");
    expect(minutesUntilEndOfDay(noon)).toBe(360); // 6 hours = 360 min
  });

  it("returns 0 after 18:00", () => {
    const evening = new Date("2026-02-25T19:30:00");
    expect(minutesUntilEndOfDay(evening)).toBe(0);
  });

  it("returns 0 at exactly 18:00", () => {
    const sixPm = new Date("2026-02-25T18:00:00");
    expect(minutesUntilEndOfDay(sixPm)).toBe(0);
  });

  it("returns full day at midnight", () => {
    const midnight = new Date("2026-02-25T00:00:00");
    expect(minutesUntilEndOfDay(midnight)).toBe(1080); // 18 hours = 1080 min
  });
});

// ═══════════════════════════════════════════════════════════
// matchesCampaignFilter — dual matching (ad_group_id OR ad_plan_id)
// ═══════════════════════════════════════════════════════════

describe("matchesCampaignFilter", () => {
  it("matches by adGroupId", () => {
    expect(matchesCampaignFilter(["100", "200"], "100", null)).toBe(true);
  });

  it("matches by adPlanId", () => {
    expect(matchesCampaignFilter(["500"], null, "500")).toBe(true);
  });

  it("matches by adPlanId when adGroupId doesn't match", () => {
    expect(matchesCampaignFilter(["500"], "999", "500")).toBe(true);
  });

  it("returns false when neither matches", () => {
    expect(matchesCampaignFilter(["100", "200"], "300", "400")).toBe(false);
  });

  it("returns false when both are null", () => {
    expect(matchesCampaignFilter(["100"], null, null)).toBe(false);
  });

  it("matches when both adGroupId and adPlanId match", () => {
    expect(matchesCampaignFilter(["100", "200"], "100", "200")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// evaluateConditionTrace — returns step code + reason
// ═══════════════════════════════════════════════════════════

describe("evaluateConditionTrace", () => {
  describe("cpl_limit", () => {
    const condition: RuleCondition = { metric: "cpl", operator: ">", value: 500 };

    it("returns triggered when CPL exceeds limit", () => {
      const metrics: MetricsSnapshot = { spent: 1200, leads: 2, impressions: 1000, clicks: 50 };
      const result = evaluateConditionTrace("cpl_limit", condition, metrics);
      expect(result.triggered).toBe(true);
      expect(result.stoppedAt).toBe("triggered");
      expect(result.reason).toContain("600");
    });

    it("returns triggered when leads=0 and spent exceeds limit", () => {
      const metrics: MetricsSnapshot = { spent: 600, leads: 0, impressions: 500, clicks: 30 };
      const result = evaluateConditionTrace("cpl_limit", condition, metrics);
      expect(result.triggered).toBe(true);
      expect(result.stoppedAt).toBe("triggered");
      expect(result.reason).toContain("600");
      expect(result.reason).toContain("лидов: 0");
    });

    it("returns condition_not_met when leads=0 and spent within limit", () => {
      const metrics: MetricsSnapshot = { spent: 400, leads: 0, impressions: 500, clicks: 30 };
      const result = evaluateConditionTrace("cpl_limit", condition, metrics);
      expect(result.triggered).toBe(false);
      expect(result.stoppedAt).toBe("step6_condition_not_met");
    });

    it("returns condition_not_met when CPL within limit", () => {
      const metrics: MetricsSnapshot = { spent: 800, leads: 2, impressions: 1000, clicks: 50 };
      const result = evaluateConditionTrace("cpl_limit", condition, metrics);
      expect(result.triggered).toBe(false);
      expect(result.stoppedAt).toBe("step6_condition_not_met");
      expect(result.reason).toContain("400");
    });
  });

  describe("spend_no_leads", () => {
    const condition: RuleCondition = { metric: "spent", operator: ">", value: 1000 };

    it("returns triggered when spent > value and leads=0", () => {
      const metrics: MetricsSnapshot = { spent: 1500, leads: 0, impressions: 500, clicks: 30 };
      const result = evaluateConditionTrace("spend_no_leads", condition, metrics);
      expect(result.triggered).toBe(true);
      expect(result.stoppedAt).toBe("triggered");
    });

    it("returns condition_not_met when has leads", () => {
      const metrics: MetricsSnapshot = { spent: 1500, leads: 1, impressions: 500, clicks: 30 };
      const result = evaluateConditionTrace("spend_no_leads", condition, metrics);
      expect(result.triggered).toBe(false);
      expect(result.stoppedAt).toBe("step6_condition_not_met");
    });
  });

  describe("clicks_no_leads", () => {
    const condition: RuleCondition = { metric: "clicks", operator: ">=", value: 100 };

    it("returns triggered when clicks >= value and leads=0", () => {
      const metrics: MetricsSnapshot = { spent: 500, leads: 0, impressions: 1000, clicks: 150 };
      const result = evaluateConditionTrace("clicks_no_leads", condition, metrics);
      expect(result.triggered).toBe(true);
      expect(result.stoppedAt).toBe("triggered");
    });

    it("returns condition_not_met when clicks below threshold", () => {
      const metrics: MetricsSnapshot = { spent: 500, leads: 0, impressions: 1000, clicks: 50 };
      const result = evaluateConditionTrace("clicks_no_leads", condition, metrics);
      expect(result.triggered).toBe(false);
      expect(result.stoppedAt).toBe("step6_condition_not_met");
    });
  });

  describe("fast_spend", () => {
    const condition: RuleCondition = { metric: "spent", operator: ">", value: 50 };

    it("returns condition_not_met when no spend history", () => {
      const metrics: MetricsSnapshot = { spent: 500, leads: 0, impressions: 100, clicks: 10 };
      const result = evaluateConditionTrace("fast_spend", condition, metrics);
      expect(result.triggered).toBe(false);
      expect(result.stoppedAt).toBe("step6_condition_not_met");
    });

    it("returns triggered when percent exceeds value", () => {
      const metrics: MetricsSnapshot = { spent: 500, leads: 0, impressions: 100, clicks: 10 };
      const context = {
        spendHistory: [
          { spent: 100, timestamp: 1000 },
          { spent: 700, timestamp: 2000 },
        ],
        dailyBudget: 1000,
      };
      const result = evaluateConditionTrace("fast_spend", condition, metrics, context);
      expect(result.triggered).toBe(true);
      expect(result.stoppedAt).toBe("triggered");
    });
  });

  describe("low_impressions", () => {
    const condition: RuleCondition = { metric: "impressions", operator: "<", value: 100 };

    it("returns triggered when impressions below minimum", () => {
      const metrics: MetricsSnapshot = { spent: 50, leads: 0, impressions: 30, clicks: 2 };
      const result = evaluateConditionTrace("low_impressions", condition, metrics);
      expect(result.triggered).toBe(true);
      expect(result.stoppedAt).toBe("triggered");
      expect(result.reason).toContain("30");
    });

    it("returns no_data when all metrics zero", () => {
      const metrics: MetricsSnapshot = { spent: 0, leads: 0, impressions: 0, clicks: 0 };
      const result = evaluateConditionTrace("low_impressions", condition, metrics);
      expect(result.triggered).toBe(false);
      expect(result.stoppedAt).toBe("step6_no_data");
      expect(result.reason).toContain("нет данных");
    });

    it("returns triggered when impressions=0 but has spend", () => {
      const metrics: MetricsSnapshot = { spent: 50, leads: 0, impressions: 0, clicks: 0 };
      const result = evaluateConditionTrace("low_impressions", condition, metrics);
      expect(result.triggered).toBe(true);
      expect(result.stoppedAt).toBe("triggered");
    });

    it("returns condition_not_met when impressions sufficient", () => {
      const metrics: MetricsSnapshot = { spent: 100, leads: 1, impressions: 500, clicks: 20 };
      const result = evaluateConditionTrace("low_impressions", condition, metrics);
      expect(result.triggered).toBe(false);
      expect(result.stoppedAt).toBe("step6_condition_not_met");
    });
  });

  describe("min_ctr", () => {
    const condition: RuleCondition = { metric: "ctr", operator: "<", value: 1.0 };

    it("returns triggered when CTR below minimum", () => {
      const metrics: MetricsSnapshot = { spent: 100, leads: 0, impressions: 1000, clicks: 5 };
      const result = evaluateConditionTrace("min_ctr", condition, metrics);
      expect(result.triggered).toBe(true);
      expect(result.stoppedAt).toBe("triggered");
    });

    it("returns ctr_undefined when no impressions", () => {
      const metrics: MetricsSnapshot = { spent: 0, leads: 0, impressions: 0, clicks: 0 };
      const result = evaluateConditionTrace("min_ctr", condition, metrics);
      expect(result.triggered).toBe(false);
      expect(result.stoppedAt).toBe("step6_ctr_undefined");
    });
  });

  describe("new_lead", () => {
    const condition: RuleCondition = { metric: "leads", operator: ">", value: 0 };

    it("returns triggered when leads > 0", () => {
      const metrics: MetricsSnapshot = { spent: 100, leads: 1, impressions: 1000, clicks: 50 };
      const result = evaluateConditionTrace("new_lead", condition, metrics);
      expect(result.triggered).toBe(true);
    });

    it("returns condition_not_met when no leads", () => {
      const metrics: MetricsSnapshot = { spent: 100, leads: 0, impressions: 1000, clicks: 50 };
      const result = evaluateConditionTrace("new_lead", condition, metrics);
      expect(result.triggered).toBe(false);
      expect(result.stoppedAt).toBe("step6_condition_not_met");
    });
  });
});

// ═══════════════════════════════════════════════════════════
// shouldSkipDailyDedup — daily dedup + failed retry limit
// ═══════════════════════════════════════════════════════════

describe("shouldSkipDailyDedup", () => {
  const adId = "12345";
  const todayStart = new Date("2026-04-18T00:00:00Z").getTime();
  const now = new Date("2026-04-18T10:00:00Z").getTime();

  // --- Daily dedup (successful triggers today) ---

  it("skips when successfully notified today (daily dedup)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "success", actionType: "notified", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(true);
  });

  // --- Failed retry logic ---

  it("does NOT skip when only failed stop today (should retry)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "stopped_and_notified", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });

  it("does NOT skip when 2 failed attempts today (under limit)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "stopped", createdAt: now - 600000 },
      { adId, status: "failed", actionType: "stopped", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });

  it("skips after 3 failed attempts today (hit retry limit)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "stopped", createdAt: now - 1200000 },
      { adId, status: "failed", actionType: "stopped", createdAt: now - 600000 },
      { adId, status: "failed", actionType: "stopped", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(true);
  });

  it("allows retry for failed notify-only rule", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "notified", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });

  // --- Mixed scenarios ---

  it("skips after failed then success today (daily dedup)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "stopped", createdAt: now - 600000 },
      { adId, status: "success", actionType: "stopped", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(true);
  });

  it("skips when successful notify exists after failures (daily dedup)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "notified", createdAt: now - 600000 },
      { adId, status: "failed", actionType: "notified", createdAt: now - 300000 },
      { adId, status: "success", actionType: "notified", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(true);
  });

  // --- Edge cases ---

  it("ignores reverted logs", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "reverted", actionType: "stopped", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });

  it("ignores logs for other ads", () => {
    const logs: ActionLogEntry[] = [
      { adId: "99999", status: "success", actionType: "stopped", createdAt: now },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });

  it("does NOT skip when no logs exist", () => {
    expect(shouldSkipDailyDedup([], adId, todayStart)).toBe(false);
  });

  it("does NOT skip when only yesterday's 3 failed logs (new day)", () => {
    const logs: ActionLogEntry[] = [
      { adId, status: "failed", actionType: "stopped", createdAt: todayStart - 3000 },
      { adId, status: "failed", actionType: "stopped", createdAt: todayStart - 2000 },
      { adId, status: "failed", actionType: "stopped", createdAt: todayStart - 1000 },
    ];
    expect(shouldSkipDailyDedup(logs, adId, todayStart)).toBe(false);
  });
});
