import { describe, it, expect } from "vitest";

/**
 * Helper: проверяет, является ли tokenExpiresAt "бессрочным".
 * undefined, null, 0 — все считаются permanent.
 */
function isPermanentToken(tokenExpiresAt: number | undefined | null): boolean {
  return (
    tokenExpiresAt === undefined ||
    tokenExpiresAt === null ||
    tokenExpiresAt === 0
  );
}

describe("isPermanentToken", () => {
  it("undefined → permanent", () => {
    expect(isPermanentToken(undefined)).toBe(true);
  });

  it("null → permanent", () => {
    expect(isPermanentToken(null)).toBe(true);
  });

  it("0 → permanent (invalidated, treat as permanent)", () => {
    expect(isPermanentToken(0)).toBe(true);
  });

  it("future timestamp → NOT permanent", () => {
    expect(isPermanentToken(Date.now() + 86400000)).toBe(false);
  });

  it("past timestamp → NOT permanent (expired, not permanent)", () => {
    expect(isPermanentToken(Date.now() - 86400000)).toBe(false);
  });
});
