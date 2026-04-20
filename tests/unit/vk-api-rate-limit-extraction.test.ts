import { describe, it, expect } from "vitest";
import { extractRateLimitHeaders } from "../../convex/vkApi";

describe("extractRateLimitHeaders", () => {
  it("parses all standard X-RateLimit-* headers", () => {
    const headers = new Headers({
      "X-RateLimit-RPS-Limit": "10",
      "X-RateLimit-RPS-Remaining": "7",
      "X-RateLimit-Hourly-Limit": "5000",
      "X-RateLimit-Hourly-Remaining": "4321",
      "X-RateLimit-Daily-Limit": "100000",
      "X-RateLimit-Daily-Remaining": "95000",
    });
    const result = extractRateLimitHeaders(headers);
    expect(result).toEqual({
      rpsLimit: 10,
      rpsRemaining: 7,
      hourlyLimit: 5000,
      hourlyRemaining: 4321,
      dailyLimit: 100000,
      dailyRemaining: 95000,
    });
  });

  it("returns undefined for missing headers", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
    });
    const result = extractRateLimitHeaders(headers);
    expect(result).toEqual({
      rpsLimit: undefined,
      rpsRemaining: undefined,
      hourlyLimit: undefined,
      hourlyRemaining: undefined,
      dailyLimit: undefined,
      dailyRemaining: undefined,
    });
  });

  it("ignores non-numeric header values gracefully", () => {
    const headers = new Headers({
      "X-RateLimit-RPS-Limit": "not-a-number",
      "X-RateLimit-Daily-Remaining": "5000",
    });
    const result = extractRateLimitHeaders(headers);
    expect(result.rpsLimit).toBeUndefined();
    expect(result.dailyRemaining).toBe(5000);
  });
});
