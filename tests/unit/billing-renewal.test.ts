import { describe, test, expect } from "vitest";
import { calculateRenewalExpiresAt, isRenewalEligible } from "../../convex/billing";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * DAY_MS;
const now = 1_700_000_000_000; // фиксированное "сейчас"

describe("calculateRenewalExpiresAt", () => {
  test("active subscription: extends from currentExpiresAt", () => {
    const currentExpiresAt = now + 5 * DAY_MS;
    const result = calculateRenewalExpiresAt({
      currentExpiresAt,
      totalDays: 30,
      now,
    });
    expect(result).toBe(currentExpiresAt + 30 * DAY_MS);
  });

  test("expired-not-downgraded: extends from now", () => {
    const currentExpiresAt = now - 2 * DAY_MS;
    const result = calculateRenewalExpiresAt({
      currentExpiresAt,
      totalDays: 30,
      now,
    });
    expect(result).toBe(now + 30 * DAY_MS);
  });

  test("with bonus days from promo", () => {
    const currentExpiresAt = now + 3 * DAY_MS;
    const result = calculateRenewalExpiresAt({
      currentExpiresAt,
      totalDays: 37, // 30 + 7
      now,
    });
    expect(result).toBe(currentExpiresAt + 37 * DAY_MS);
  });

  test("expiresAt exactly equals now: extends from now", () => {
    const result = calculateRenewalExpiresAt({
      currentExpiresAt: now,
      totalDays: 30,
      now,
    });
    expect(result).toBe(now + 30 * DAY_MS);
  });

  test("undefined currentExpiresAt: extends from now (treated as fresh purchase)", () => {
    const result = calculateRenewalExpiresAt({
      currentExpiresAt: undefined,
      totalDays: 30,
      now,
    });
    expect(result).toBe(now + 30 * DAY_MS);
  });
});

describe("isRenewalEligible", () => {
  test("same tier, 5 days left: true", () => {
    expect(
      isRenewalEligible({
        currentTier: "pro",
        paymentTier: "pro",
        currentExpiresAt: now + 5 * DAY_MS,
        now,
      })
    ).toBe(true);
  });

  test("same tier, 25 days left: false (outside window)", () => {
    expect(
      isRenewalEligible({
        currentTier: "pro",
        paymentTier: "pro",
        currentExpiresAt: now + 25 * DAY_MS,
        now,
      })
    ).toBe(false);
  });

  test("freemium: false even within 7d", () => {
    expect(
      isRenewalEligible({
        currentTier: "freemium",
        paymentTier: "pro",
        currentExpiresAt: now + 3 * DAY_MS,
        now,
      })
    ).toBe(false);
  });

  test("different tier (upgrade): false", () => {
    expect(
      isRenewalEligible({
        currentTier: "start",
        paymentTier: "pro",
        currentExpiresAt: now + 3 * DAY_MS,
        now,
      })
    ).toBe(false);
  });

  test("expired but not yet downgraded: true", () => {
    expect(
      isRenewalEligible({
        currentTier: "pro",
        paymentTier: "pro",
        currentExpiresAt: now - 1 * DAY_MS,
        now,
      })
    ).toBe(true);
  });

  test("no expiresAt: false", () => {
    expect(
      isRenewalEligible({
        currentTier: "pro",
        paymentTier: "pro",
        currentExpiresAt: undefined,
        now,
      })
    ).toBe(false);
  });

  test("exactly 7 days left: true (boundary inclusive)", () => {
    expect(
      isRenewalEligible({
        currentTier: "pro",
        paymentTier: "pro",
        currentExpiresAt: now + SEVEN_DAYS,
        now,
      })
    ).toBe(true);
  });

  test("7 days + 1ms: false", () => {
    expect(
      isRenewalEligible({
        currentTier: "pro",
        paymentTier: "pro",
        currentExpiresAt: now + SEVEN_DAYS + 1,
        now,
      })
    ).toBe(false);
  });
});
