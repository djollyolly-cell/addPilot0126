import { describe, it, expect } from "vitest";
import { hasCampaignChanged, hasAdChanged } from "../../convex/adAccounts";

describe("hasCampaignChanged", () => {
  const base = {
    name: "Кампания 1",
    status: "active",
    adPlanId: "plan_1",
    dailyLimit: 1000,
    allLimit: 30000,
  };

  it("returns false when nothing changed", () => {
    expect(hasCampaignChanged(base, { ...base })).toBe(false);
  });

  it("detects name change", () => {
    expect(hasCampaignChanged(base, { ...base, name: "Другое имя" })).toBe(true);
  });

  it("detects status change", () => {
    expect(hasCampaignChanged(base, { ...base, status: "blocked" })).toBe(true);
  });

  it("detects dailyLimit change", () => {
    expect(hasCampaignChanged(base, { ...base, dailyLimit: 2000 })).toBe(true);
  });

  it("detects allLimit change", () => {
    expect(hasCampaignChanged(base, { ...base, allLimit: 50000 })).toBe(true);
  });

  it("detects adPlanId change", () => {
    expect(hasCampaignChanged(base, { ...base, adPlanId: "plan_2" })).toBe(true);
  });

  it("ignores incoming dailyLimit=undefined when existing has value", () => {
    // incoming did not pass dailyLimit — not considered a change
    const incoming = { name: base.name, status: base.status };
    expect(hasCampaignChanged(base, incoming)).toBe(false);
  });

  it("detects dailyLimit change to 0", () => {
    // 0 is an explicit new value, not undefined; must be detected as a change
    expect(hasCampaignChanged(base, { ...base, dailyLimit: 0 })).toBe(true);
  });
});

// TODO Task 2: hasAdChanged tests go here
