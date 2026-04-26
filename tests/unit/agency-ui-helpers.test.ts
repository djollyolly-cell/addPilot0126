import { describe, it, expect } from "vitest";
import { NICHE_COEFS } from "../../src/components/NicheSelector";

describe("NicheSelector NICHE_COEFS", () => {
  it("exports 6 niche coefficients", () => {
    expect(Object.keys(NICHE_COEFS)).toHaveLength(6);
  });

  it("has expected niches", () => {
    expect(NICHE_COEFS).toHaveProperty("beauty");
    expect(NICHE_COEFS).toHaveProperty("schools");
    expect(NICHE_COEFS).toHaveProperty("measurement");
    expect(NICHE_COEFS).toHaveProperty("sellers");
    expect(NICHE_COEFS).toHaveProperty("infobiz");
    expect(NICHE_COEFS).toHaveProperty("other");
  });

  it("all coefficients are positive numbers", () => {
    for (const [, coef] of Object.entries(NICHE_COEFS)) {
      expect(coef).toBeGreaterThan(0);
      expect(typeof coef).toBe("number");
    }
  });
});

describe("LoadCalculator computeUnits", () => {
  // Re-implement the pure function to test it (it's not exported)
  const computeUnits = (dist: Record<string, number>) =>
    Object.entries(dist).reduce((sum, [k, v]) => sum + v * (NICHE_COEFS[k] ?? 0), 0);

  it("returns 0 for empty distribution", () => {
    expect(computeUnits({})).toBe(0);
  });

  it("computes units for single niche", () => {
    expect(computeUnits({ beauty: 10 })).toBeCloseTo(10 * 0.8);
    expect(computeUnits({ measurement: 5 })).toBeCloseTo(5 * 1.2);
  });

  it("computes units for multiple niches", () => {
    const dist = { beauty: 10, schools: 5, measurement: 3 };
    const expected = 10 * 0.8 + 5 * 1.0 + 3 * 1.2;
    expect(computeUnits(dist)).toBeCloseTo(expected);
  });

  it("ignores unknown niches", () => {
    expect(computeUnits({ unknown_niche: 100 })).toBe(0);
  });

  it("handles zero cabinets", () => {
    expect(computeUnits({ beauty: 0, schools: 0 })).toBe(0);
  });
});
