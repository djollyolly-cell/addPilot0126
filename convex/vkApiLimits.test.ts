import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

describe("vkApiLimits.recordRateLimit", () => {
  it("skips insert for 200 even when limit headers are present (D2a 429-only)", async () => {
    const t = convexTest(schema);
    const id = await t.mutation(internal.vkApiLimits.recordRateLimit, {
      endpoint: "statistics/banners/day.json",
      rpsLimit: 10,
      rpsRemaining: 7,
      dailyLimit: 100000,
      dailyRemaining: 95000,
      statusCode: 200,
    });
    expect(id).toBeNull();
  });

  it("skips insert when no headers and statusCode is 200", async () => {
    const t = convexTest(schema);
    const id = await t.mutation(internal.vkApiLimits.recordRateLimit, {
      endpoint: "user.json",
      statusCode: 200,
    });
    expect(id).toBeNull();
  });

  it("inserts on 429 even without headers", async () => {
    const t = convexTest(schema);
    const id = await t.mutation(internal.vkApiLimits.recordRateLimit, {
      endpoint: "user.json",
      statusCode: 429,
    });
    expect(id).toBeTruthy();
  });
});
