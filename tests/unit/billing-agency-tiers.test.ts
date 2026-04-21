import { describe, it, expect } from "vitest";
import { calculateUpgradePrice, calculateUpgradePriceWithFallback, TIERS, isAgencyTier } from "../../convex/billing";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("TIERS — agency entries", () => {
  it("agency_s/m/l/xl have includedLoadUnits and overagePrice", () => {
    expect(TIERS.agency_s.includedLoadUnits).toBe(30);
    expect(TIERS.agency_m.includedLoadUnits).toBe(60);
    expect(TIERS.agency_l.includedLoadUnits).toBe(120);
    expect(TIERS.agency_xl.includedLoadUnits).toBe(200);
    expect(TIERS.agency_s.overagePrice).toBe(600);
  });

  it("individual tiers have 0 loadUnits", () => {
    expect(TIERS.freemium.includedLoadUnits).toBe(0);
    expect(TIERS.start.includedLoadUnits).toBe(0);
    expect(TIERS.pro.includedLoadUnits).toBe(0);
  });
});

describe("isAgencyTier", () => {
  it("returns true for agency tiers", () => {
    expect(isAgencyTier("agency_s")).toBe(true);
    expect(isAgencyTier("agency_xl")).toBe(true);
  });
  it("returns false for individual tiers", () => {
    expect(isAgencyTier("freemium")).toBe(false);
    expect(isAgencyTier("pro")).toBe(false);
  });
});

describe("calculateUpgradePrice — existing behavior preserved", () => {
  it("returns credit for pro user with payment history", () => {
    const result = calculateUpgradePrice({
      currentTier: "pro",
      newTier: "agency_m",
      subscriptionExpiresAt: Date.now() + 12 * DAY_MS,
      lastPaymentAmount: 2990,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "RUB",
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.credit).toBeGreaterThan(0);
    expect(result.credit).toBeCloseTo(1196, -1);
  });

  it("returns credit reduced by promo (60-day coverage)", () => {
    const result = calculateUpgradePrice({
      currentTier: "pro",
      newTier: "agency_m",
      subscriptionExpiresAt: Date.now() + 30 * DAY_MS,
      lastPaymentAmount: 1495,
      lastPaymentBonusDays: 30,
      lastPaymentCurrency: "RUB",
      now: Date.now(),
    });
    expect(result.credit).toBeCloseTo(747, -1);
  });

  it("returns no upgrade for freemium → pro (no payment history)", () => {
    const result = calculateUpgradePrice({
      currentTier: "freemium",
      newTier: "pro",
      subscriptionExpiresAt: undefined,
      lastPaymentAmount: undefined,
      lastPaymentBonusDays: undefined,
      lastPaymentCurrency: undefined,
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(false);
    expect(result.credit).toBe(0);
  });
});

describe("calculateUpgradePriceWithFallback — Решение 2", () => {
  it("primary path: uses lastPayment when present", () => {
    const result = calculateUpgradePriceWithFallback({
      currentTier: "pro",
      newTier: "agency_m",
      subscriptionExpiresAt: Date.now() + 12 * DAY_MS,
      lastPaymentAmount: 2990,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "RUB",
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.credit).toBeCloseTo(1196, -1);
  });

  it("fallback path: uses catalog price when lastPayment is missing (admin-granted)", () => {
    const result = calculateUpgradePriceWithFallback({
      currentTier: "pro",
      newTier: "agency_m",
      subscriptionExpiresAt: Date.now() + 15 * DAY_MS,
      lastPaymentAmount: undefined,
      lastPaymentBonusDays: undefined,
      lastPaymentCurrency: undefined,
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.credit).toBeCloseTo(1495, -1);
    expect(result.currency).toBe("RUB");
  });

  it("fallback returns no upgrade if currentTier is freemium", () => {
    const result = calculateUpgradePriceWithFallback({
      currentTier: "freemium",
      newTier: "agency_s",
      subscriptionExpiresAt: undefined,
      lastPaymentAmount: undefined,
      lastPaymentBonusDays: undefined,
      lastPaymentCurrency: undefined,
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(false);
  });

  it("agency_s → agency_m fallback uses agency_s catalog price", () => {
    const result = calculateUpgradePriceWithFallback({
      currentTier: "agency_s",
      newTier: "agency_m",
      subscriptionExpiresAt: Date.now() + 10 * DAY_MS,
      lastPaymentAmount: undefined,
      lastPaymentBonusDays: undefined,
      lastPaymentCurrency: undefined,
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(true);
    // 10/30 * 14900 ≈ 4967
    expect(result.credit).toBeCloseTo(4967, -1);
  });
});
