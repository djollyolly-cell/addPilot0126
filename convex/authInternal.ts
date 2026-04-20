import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// Generate cryptographically secure session token
function generateSessionToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Create a new session for user (internal only)
export const createSession = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const token = generateSessionToken();
    const now = Date.now();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30 days

    await ctx.db.insert("sessions", {
      userId: args.userId,
      token,
      expiresAt,
      createdAt: now,
    });

    return token;
  },
});

/**
 * Revoke all sessions for a user. Called when:
 * - Manager removed from org
 * - Manager permissions changed (defensive)
 * - Manual security action
 */
export const revokeSessionsByUserId = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const s of sessions) {
      await ctx.db.delete(s._id);
    }
    return { revoked: sessions.length };
  },
});
