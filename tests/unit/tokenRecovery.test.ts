import { describe, it, expect, vi, beforeEach } from "vitest";
import { quickTokenCheck } from "../../convex/tokenRecovery";

describe("quickTokenCheck", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true for valid token (200)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 200 })
    );
    const result = await quickTokenCheck("valid-token");
    expect(result).toBe(true);
  });

  it("returns false for invalid token (401)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 401 })
    );
    const result = await quickTokenCheck("dead-token");
    expect(result).toBe(false);
  });

  it("returns false for forbidden token (403)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 403 })
    );
    const result = await quickTokenCheck("forbidden-token");
    expect(result).toBe(false);
  });

  it("returns true on network error (fail-safe)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    const result = await quickTokenCheck("some-token");
    expect(result).toBe(true);
  });

  it("returns true on timeout (fail-safe)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10))
    );
    const result = await quickTokenCheck("some-token");
    expect(result).toBe(true);
  });
});
