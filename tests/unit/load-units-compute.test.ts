import { describe, it, expect } from "vitest";
import { computeLoadUnitsFromAccountStats } from "../../convex/loadUnits";

describe("computeLoadUnitsFromAccountStats", () => {
  it("returns 0 for empty input", () => {
    expect(computeLoadUnitsFromAccountStats([])).toBe(0);
  });

  it("counts 1 unit per cabinet with 1-100 active groups (ceil)", () => {
    expect(computeLoadUnitsFromAccountStats([{ accountId: "a", activeGroups: 50 }])).toBe(1);
    expect(computeLoadUnitsFromAccountStats([{ accountId: "a", activeGroups: 100 }])).toBe(1);
    expect(computeLoadUnitsFromAccountStats([{ accountId: "a", activeGroups: 1 }])).toBe(1);
  });

  it("counts 2 units for 101-200 groups", () => {
    expect(computeLoadUnitsFromAccountStats([{ accountId: "a", activeGroups: 101 }])).toBe(2);
    expect(computeLoadUnitsFromAccountStats([{ accountId: "a", activeGroups: 200 }])).toBe(2);
  });

  it("sums across cabinets", () => {
    expect(
      computeLoadUnitsFromAccountStats([
        { accountId: "a", activeGroups: 50 },   // 1
        { accountId: "b", activeGroups: 150 },  // 2
        { accountId: "c", activeGroups: 250 },  // 3
      ])
    ).toBe(6);
  });

  it("ignores cabinets with 0 active groups", () => {
    expect(
      computeLoadUnitsFromAccountStats([
        { accountId: "a", activeGroups: 0 },    // 0
        { accountId: "b", activeGroups: 100 },  // 1
      ])
    ).toBe(1);
  });
});
