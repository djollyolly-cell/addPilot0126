import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { extractRateLimitHeaders } from "./vkApi";

/**
 * Record VK API rate-limit headers from a single response.
 * Called by callMtApi after parsing X-RateLimit-* headers.
 * Skips insert if all 6 numeric fields are undefined (no headers).
 */
export const recordRateLimit = internalMutation({
  args: {
    accountId: v.optional(v.id("adAccounts")),
    endpoint: v.string(),
    rpsLimit: v.optional(v.number()),
    rpsRemaining: v.optional(v.number()),
    hourlyLimit: v.optional(v.number()),
    hourlyRemaining: v.optional(v.number()),
    dailyLimit: v.optional(v.number()),
    dailyRemaining: v.optional(v.number()),
    statusCode: v.number(),
  },
  handler: async (_ctx, _args) => {
    // EMERGENCY DRAIN MODE: no-op. Restore body after pending queue drains.
    return null;
  },
});

/** Get all active adAccounts with tokens for throttling probe. */
export const listAccountsForProbe = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    const now = Date.now();
    return accounts
      .filter((a) =>
        a.status === "active" &&
        a.accessToken &&
        (!a.tokenExpiresAt || a.tokenExpiresAt > now)
      )
      .map((a) => ({
        _id: a._id,
        accessToken: a.accessToken!,
        name: a.name,
      }));
  },
});

/**
 * Probe VK API throttling.json for all active accounts.
 * Logs result to vkApiLimits. Limited to first 30 accounts per run
 * to avoid hammering VK (cron runs every 15 min, full coverage in ~2h).
 */
export const probeThrottling = internalAction({
  args: {},
  handler: async (ctx): Promise<{ logged: number; errors: number; batchSize: number; totalAccounts: number }> => {
    const accounts: Array<{ _id: Id<"adAccounts">; accessToken: string; name: string }> =
      await ctx.runQuery(internal.vkApiLimits.listAccountsForProbe);
    const batch = accounts.slice(0, 30);

    let logged = 0;
    let errors = 0;
    for (const account of batch) {
      try {
        const url = "https://ads.vk.com/api/v2/throttling.json";
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${account.accessToken}` },
          signal: AbortSignal.timeout(15_000),
        });

        const rateLimits = extractRateLimitHeaders(response.headers);
        await ctx.runMutation(internal.vkApiLimits.recordRateLimit, {
          accountId: account._id,
          endpoint: "throttling.json",
          ...rateLimits,
          statusCode: response.status,
        });
        logged++;
      } catch {
        errors++;
      }
    }

    console.log(`[vk-throttling-probe] logged=${logged}, errors=${errors}, batch=${batch.length}`);
    return { logged, errors, batchSize: batch.length, totalAccounts: accounts.length };
  },
});
