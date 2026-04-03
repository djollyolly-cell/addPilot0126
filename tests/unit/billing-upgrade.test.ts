import { describe, test, expect } from "vitest";
import { calculateUpgradePrice } from "../../convex/billing";

describe("calculateUpgradePrice", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  test("Start → Pro with 20 remaining days, 35 BYN payment", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "pro",
      subscriptionExpiresAt: now + 20 * DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.remainingDays).toBe(20);
    // dailyRate = 35/30 = 1.1667, credit = 1.1667 * 20 = 23.33
    expect(result.credit).toBeCloseTo(23.33, 1);
    expect(result.currency).toBe("BYN");
  });

  test("freemium → Pro returns no upgrade", () => {
    const result = calculateUpgradePrice({
      currentTier: "freemium",
      newTier: "pro",
      subscriptionExpiresAt: now + 20 * DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(false);
    expect(result.credit).toBe(0);
  });

  test("expired subscription returns no upgrade", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "pro",
      subscriptionExpiresAt: now - DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(false);
  });

  test("Pro → Pro (renewal) returns no upgrade", () => {
    const result = calculateUpgradePrice({
      currentTier: "pro",
      newTier: "pro",
      subscriptionExpiresAt: now + 15 * DAY_MS,
      lastPaymentAmount: 88,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(false);
  });

  test("Start → Start (renewal) returns no upgrade", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "start",
      subscriptionExpiresAt: now + 15 * DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(false);
  });

  test("payment with promo bonus days adjusts daily rate", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "pro",
      subscriptionExpiresAt: now + 25 * DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 7,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.remainingDays).toBe(25);
    // totalDays = 37, dailyRate = 35/37 = 0.9459, credit = 0.9459 * 25 = 23.65
    expect(result.credit).toBeCloseTo(23.65, 1);
  });

  test("no previous payment returns no upgrade", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "pro",
      subscriptionExpiresAt: now + 20 * DAY_MS,
      lastPaymentAmount: undefined,
      lastPaymentBonusDays: undefined,
      lastPaymentCurrency: undefined,
      now,
    });
    expect(result.isUpgrade).toBe(false);
  });

  test("1 remaining day gives minimal credit", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "pro",
      subscriptionExpiresAt: now + 0.5 * DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.remainingDays).toBe(1);
    // dailyRate = 35/30 = 1.1667, credit = 1.17
    expect(result.credit).toBeCloseTo(1.17, 1);
  });
});

describe("upgradeCost calculation (frontend logic)", () => {
  test("upgradeCost = max(ceil(newTierPriceBYN - credit), 1)", () => {
    const newTierPriceBYN = 88;
    const credit = 23.33;
    const upgradeCost = Math.max(Math.ceil(newTierPriceBYN - credit), 1);
    expect(upgradeCost).toBe(65);
  });

  test("upgradeCost minimum is 1 BYN even if credit > price", () => {
    const newTierPriceBYN = 20;
    const credit = 30;
    const upgradeCost = Math.max(Math.ceil(newTierPriceBYN - credit), 1);
    expect(upgradeCost).toBe(1);
  });

  test("exact match rounds to 0 → clamped to 1", () => {
    const newTierPriceBYN = 88;
    const credit = 88;
    const upgradeCost = Math.max(Math.ceil(newTierPriceBYN - credit), 1);
    expect(upgradeCost).toBe(1);
  });
});
