import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// Helper function to generate session token
function generateSessionToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 64; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
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
