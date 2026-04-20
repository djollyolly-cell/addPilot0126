import { describe, it, expect } from "vitest";
import { TIERS } from "../../convex/billing";
import { TIER_RULE_LIMITS } from "../../convex/rules";

const toLimit = (v: number) => (v === -1 ? Infinity : v);

describe("Rule tier limits consistency", () => {
  it("TIER_RULE_LIMITS.freemium matches TIERS.freemium.rulesLimit", () => {
    expect(TIER_RULE_LIMITS.freemium).toBe(TIERS.freemium.rulesLimit);
    expect(TIER_RULE_LIMITS.freemium).toBe(3);
  });

  it("TIER_RULE_LIMITS.start matches TIERS.start.rulesLimit", () => {
    expect(TIER_RULE_LIMITS.start).toBe(TIERS.start.rulesLimit);
    expect(TIER_RULE_LIMITS.start).toBe(10);
  });

  it("TIER_RULE_LIMITS.pro is Infinity (matches TIERS.pro.rulesLimit=-1)", () => {
    expect(TIER_RULE_LIMITS.pro).toBe(toLimit(TIERS.pro.rulesLimit));
    expect(TIER_RULE_LIMITS.pro).toBe(Infinity);
  });

  it("all individual tier keys present in TIER_RULE_LIMITS", () => {
    for (const tier of ["freemium", "start", "pro"]) {
      expect(TIER_RULE_LIMITS).toHaveProperty(tier);
      expect(typeof TIER_RULE_LIMITS[tier]).toBe("number");
    }
  });
});
