import { describe, it, expect } from "vitest";
import { getNextExpiredPhase } from "../../convex/loadUnits";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("getNextExpiredPhase (pure state machine)", () => {
  it("returns null when still in warnings window (day 0-13)", () => {
    expect(getNextExpiredPhase("warnings", 0)).toBeNull();
    expect(getNextExpiredPhase("warnings", 13 * DAY_MS)).toBeNull();
  });

  it("transitions warnings → read_only at day 14", () => {
    expect(getNextExpiredPhase("warnings", 14 * DAY_MS + 1)).toBe("read_only");
  });

  it("returns null when still in read_only window (day 14-44)", () => {
    expect(getNextExpiredPhase("read_only", 14 * DAY_MS + 1)).toBeNull();
    expect(getNextExpiredPhase("read_only", 44 * DAY_MS)).toBeNull();
  });

  it("transitions read_only → deep_read_only at day 45", () => {
    expect(getNextExpiredPhase("read_only", 45 * DAY_MS + 1)).toBe("deep_read_only");
  });

  it("returns null when still in deep_read_only window (day 45-59)", () => {
    expect(getNextExpiredPhase("deep_read_only", 45 * DAY_MS + 1)).toBeNull();
    expect(getNextExpiredPhase("deep_read_only", 59 * DAY_MS)).toBeNull();
  });

  it("transitions deep_read_only → frozen at day 60", () => {
    expect(getNextExpiredPhase("deep_read_only", 60 * DAY_MS + 1)).toBe("frozen");
  });

  it("returns null for frozen (terminal state)", () => {
    expect(getNextExpiredPhase("frozen", 200 * DAY_MS)).toBeNull();
  });
});
