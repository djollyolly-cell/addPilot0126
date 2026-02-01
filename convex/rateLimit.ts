import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Rate limit configurations
export const RATE_LIMITS = {
  oauth_auth_url: { maxAttempts: 10, windowMs: 60 * 1000 }, // 10 per minute
  oauth_exchange: { maxAttempts: 5, windowMs: 60 * 1000 }, // 5 per minute
  api_call: { maxAttempts: 100, windowMs: 60 * 1000 }, // 100 per minute
} as const;

export type RateLimitType = keyof typeof RATE_LIMITS;

/**
 * Check if a key is rate limited.
 * Returns { allowed: true } if request can proceed,
 * or { allowed: false, retryAfterMs } if blocked.
 */
export const checkRateLimit = internalQuery({
  args: {
    key: v.string(),
    type: v.string(),
  },
  handler: async (ctx, args) => {
    const config = RATE_LIMITS[args.type as RateLimitType];
    if (!config) {
      return { allowed: true };
    }

    const record = await ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (!record) {
      return { allowed: true, attemptsLeft: config.maxAttempts };
    }

    const now = Date.now();

    // If blocked, check if block has expired
    if (record.blockedUntil) {
      if (record.blockedUntil > now) {
        return {
          allowed: false,
          retryAfterMs: record.blockedUntil - now,
          attemptsLeft: 0,
        };
      }
      // Block expired, allow
      return { allowed: true, attemptsLeft: config.maxAttempts };
    }

    // Check if window has passed since last attempt
    if (now - record.lastAttemptAt > config.windowMs) {
      // Window expired, reset
      return { allowed: true, attemptsLeft: config.maxAttempts };
    }

    // Within window, check attempts
    if (record.attempts >= config.maxAttempts) {
      return {
        allowed: false,
        retryAfterMs: config.windowMs - (now - record.lastAttemptAt),
        attemptsLeft: 0,
      };
    }

    return {
      allowed: true,
      attemptsLeft: config.maxAttempts - record.attempts,
    };
  },
});

/**
 * Record an attempt for rate limiting.
 * Call this after each request to track usage.
 */
export const recordAttempt = internalMutation({
  args: {
    key: v.string(),
    type: v.string(),
  },
  handler: async (ctx, args) => {
    const config = RATE_LIMITS[args.type as RateLimitType];
    if (!config) return;

    const now = Date.now();
    const record = await ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (!record) {
      await ctx.db.insert("rateLimits", {
        key: args.key,
        attempts: 1,
        lastAttemptAt: now,
      });
      return;
    }

    // Check if window expired - reset counter
    if (now - record.lastAttemptAt > config.windowMs) {
      await ctx.db.patch(record._id, {
        attempts: 1,
        lastAttemptAt: now,
        blockedUntil: undefined,
      });
      return;
    }

    // Increment attempts
    const newAttempts = record.attempts + 1;
    const shouldBlock = newAttempts >= config.maxAttempts;

    await ctx.db.patch(record._id, {
      attempts: newAttempts,
      lastAttemptAt: now,
      blockedUntil: shouldBlock ? now + config.windowMs : undefined,
    });
  },
});

/**
 * Clear rate limit for a key (e.g., after successful login).
 */
export const clearRateLimit = internalMutation({
  args: {
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();

    if (record) {
      await ctx.db.delete(record._id);
    }
  },
});
