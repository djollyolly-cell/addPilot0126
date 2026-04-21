import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  getMetricValue,
  evaluateCustomConditions,
  type MetricsSnapshot,
} from "../../convex/ruleEngine";

describe("getMetricValue", () => {
  const m: MetricsSnapshot = {
    spent: 1000, leads: 5, impressions: 5000, clicks: 50,
    cpl: 200, ctr: 1.0, cpc: 20, reach: 4500,
  };

  it("returns spent", () => expect(getMetricValue("spent", m)).toBe(1000));
  it("returns leads", () => expect(getMetricValue("leads", m)).toBe(5));
  it("returns clicks", () => expect(getMetricValue("clicks", m)).toBe(50));
  it("returns impressions", () => expect(getMetricValue("impressions", m)).toBe(5000));
  it("returns cpl from snapshot", () => expect(getMetricValue("cpl", m)).toBe(200));
  it("returns reach", () => expect(getMetricValue("reach", m)).toBe(4500));
  it("returns cpc from snapshot", () => expect(getMetricValue("cpc", m)).toBe(20));

  it("computes cpl when not pre-computed", () => {
    expect(getMetricValue("cpl", { spent: 100, leads: 2, impressions: 0, clicks: 0 })).toBe(50);
  });

  it("returns undefined for cpl when leads=0", () => {
    expect(getMetricValue("cpl", { spent: 100, leads: 0, impressions: 0, clicks: 0 })).toBeUndefined();
  });

  it("computes cpc when not pre-computed", () => {
    expect(getMetricValue("cpc", { spent: 100, leads: 0, impressions: 0, clicks: 5 })).toBe(20);
  });

  it("returns undefined for unknown metric", () => {
    expect(getMetricValue("xyz", m)).toBeUndefined();
  });
});

describe("evaluateCustomConditions", () => {
  const m: MetricsSnapshot = {
    spent: 1000, leads: 5, impressions: 5000, clicks: 50, cpc: 20, reach: 4500,
  };

  it("returns false for empty array", () => {
    expect(evaluateCustomConditions([], m)).toBe(false);
  });

  it("returns true when all conditions pass", () => {
    expect(evaluateCustomConditions([
      { metric: "spent", operator: ">", value: 500 },
      { metric: "cpc", operator: ">", value: 10 },
    ], m)).toBe(true);
  });

  it("returns false when any condition fails", () => {
    expect(evaluateCustomConditions([
      { metric: "spent", operator: ">", value: 500 },
      { metric: "cpc", operator: ">", value: 100 },
    ], m)).toBe(false);
  });
});

describe("evaluateCondition with type='custom' (L2)", () => {
  const m: MetricsSnapshot = {
    spent: 1000, leads: 5, impressions: 5000, clicks: 50, cpc: 20, reach: 4500,
  };

  it("triggers when single condition is true", () => {
    const result = evaluateCondition(
      "custom",
      [{ metric: "spent", operator: ">", value: 500 }] as any,
      m
    );
    expect(result).toBe(true);
  });

  it("does not trigger when single condition is false", () => {
    const result = evaluateCondition(
      "custom",
      [{ metric: "spent", operator: ">", value: 5000 }] as any,
      m
    );
    expect(result).toBe(false);
  });

  it("AND: triggers when all conditions are true", () => {
    const result = evaluateCondition(
      "custom",
      [
        { metric: "spent", operator: ">", value: 500 },
        { metric: "cpc", operator: ">", value: 10 },
      ] as any,
      m
    );
    expect(result).toBe(true);
  });

  it("AND: does not trigger when any condition is false", () => {
    const result = evaluateCondition(
      "custom",
      [
        { metric: "spent", operator: ">", value: 500 },
        { metric: "cpc", operator: ">", value: 100 },  // false
      ] as any,
      m
    );
    expect(result).toBe(false);
  });

  it("returns false if any metric is undefined", () => {
    const mNoReach: MetricsSnapshot = {
      spent: 1000, leads: 5, impressions: 5000, clicks: 50,
      // no cpc, no reach
    };
    const result = evaluateCondition(
      "custom",
      [{ metric: "reach", operator: ">", value: 100 }] as any,
      mNoReach
    );
    expect(result).toBe(false);
  });

  it("supports all operators", () => {
    expect(evaluateCondition("custom", [{ metric: "spent", operator: ">=", value: 1000 }] as any, m)).toBe(true);
    expect(evaluateCondition("custom", [{ metric: "spent", operator: "<=", value: 1000 }] as any, m)).toBe(true);
    expect(evaluateCondition("custom", [{ metric: "spent", operator: "==", value: 1000 }] as any, m)).toBe(true);
    expect(evaluateCondition("custom", [{ metric: "spent", operator: "<", value: 2000 }] as any, m)).toBe(true);
  });

  it("returns false for non-array condition when type=custom", () => {
    const result = evaluateCondition(
      "custom",
      { metric: "spent", operator: ">", value: 500 },
      m
    );
    expect(result).toBe(false);
  });

  it("returns false for empty array", () => {
    const result = evaluateCondition(
      "custom",
      [] as any,
      m
    );
    expect(result).toBe(false);
  });

  it("computes cpl on-the-fly when not in snapshot", () => {
    const mNoCpl: MetricsSnapshot = {
      spent: 500, leads: 2, impressions: 1000, clicks: 10,
    };
    const result = evaluateCondition(
      "custom",
      [{ metric: "cpl", operator: ">", value: 200 }] as any,
      mNoCpl
    );
    // cpl = 500/2 = 250 > 200 = true
    expect(result).toBe(true);
  });
});

describe("existing L1 rules still work after L2 changes", () => {
  it("cpl_limit triggers correctly", () => {
    const m: MetricsSnapshot = { spent: 1000, leads: 2, impressions: 100, clicks: 10 };
    // cpl = 500 > 300 → trigger
    expect(evaluateCondition("cpl_limit", { metric: "cpl", operator: ">", value: 300 }, m)).toBe(true);
  });

  it("spend_no_leads triggers correctly", () => {
    const m: MetricsSnapshot = { spent: 500, leads: 0, impressions: 100, clicks: 10 };
    expect(evaluateCondition("spend_no_leads", { metric: "spent", operator: ">", value: 200 }, m)).toBe(true);
  });
});
