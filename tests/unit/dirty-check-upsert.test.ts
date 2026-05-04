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

describe("hasAdChanged", () => {
  const base = {
    name: "Объявление 1",
    status: "active",
    approved: "yes",
    campaignId: "camp_1",
  };

  it("returns false when nothing changed", () => {
    expect(hasAdChanged(base, { ...base })).toBe(false);
  });

  it("detects name change", () => {
    expect(hasAdChanged(base, { ...base, name: "Другое объявление" })).toBe(true);
  });

  it("detects status change", () => {
    expect(hasAdChanged(base, { ...base, status: "blocked" })).toBe(true);
  });

  it("detects approved change", () => {
    expect(hasAdChanged(base, { ...base, approved: "no" })).toBe(true);
  });

  it("detects campaignId change", () => {
    expect(hasAdChanged(base, { ...base, campaignId: "camp_2" })).toBe(true);
  });

  it("ignores incoming approved=undefined", () => {
    const incoming = { name: base.name, status: base.status };
    expect(hasAdChanged(base, incoming)).toBe(false);
  });

  it("ignores incoming campaignId=undefined", () => {
    const incoming = { name: base.name, status: base.status };
    expect(hasAdChanged(base, incoming)).toBe(false);
  });

  it("returns false when all fields identical including approved and campaignId", () => {
    expect(hasAdChanged(
      { name: "Ad", status: "active", approved: "yes", campaignId: "camp_1" },
      { name: "Ad", status: "active", approved: "yes", campaignId: "camp_1" }
    )).toBe(false);
  });

  it("detects approved change from undefined to value", () => {
    expect(hasAdChanged(
      { name: "Ad", status: "active" },
      { name: "Ad", status: "active", approved: "yes" }
    )).toBe(true);
  });
});
