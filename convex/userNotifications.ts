import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Get unread notifications for current user
export const getUnread = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("userNotifications")
      .withIndex("by_userId_unread", (q) =>
        q.eq("userId", args.userId).eq("isRead", false)
      )
      .collect();
  },
});

// Mark notification as read
export const markRead = mutation({
  args: { notificationId: v.id("userNotifications") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.notificationId, { isRead: true });
  },
});

// Mark all notifications as read for a user
export const markAllRead = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const unread = await ctx.db
      .query("userNotifications")
      .withIndex("by_userId_unread", (q) =>
        q.eq("userId", args.userId).eq("isRead", false)
      )
      .collect();
    for (const n of unread) {
      await ctx.db.patch(n._id, { isRead: true });
    }
  },
});
