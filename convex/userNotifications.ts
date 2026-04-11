import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// TEMP: send in-app notification to a user
export const sendSystemNotification = mutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    message: v.string(),
    type: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("userNotifications", {
      userId: args.userId,
      title: args.title,
      message: args.message,
      type: args.type as "info" | "warning" | "payment" | "feedback",
      direction: "admin_to_user",
      isRead: false,
      createdAt: Date.now(),
    });
  },
});

// Get unread notifications for current user (admin → user only)
export const getUnread = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("userNotifications")
      .withIndex("by_userId_unread", (q) =>
        q.eq("userId", args.userId).eq("isRead", false)
      )
      .collect();
    // Only show admin→user notifications on dashboard (exclude user's own feedback)
    return all.filter((n) => n.direction !== "user_to_admin");
  },
});

// Mark notification as read — marks root + all unread user_to_admin replies in thread
export const markRead = mutation({
  args: { notificationId: v.id("userNotifications") },
  handler: async (ctx, args) => {
    // Mark the root message
    await ctx.db.patch(args.notificationId, { isRead: true });

    // Also mark all unread user_to_admin replies in this thread
    const replies = await ctx.db
      .query("userNotifications")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.notificationId))
      .collect();
    for (const reply of replies) {
      if (!reply.isRead && reply.direction === "user_to_admin") {
        await ctx.db.patch(reply._id, { isRead: true });
      }
    }
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

// TEMP: Mark all price change notifications as read for all users
export const markPriceNotificationsRead = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("userNotifications").collect();
    let count = 0;
    for (const n of all) {
      if (n.title === "Цены меняются с 5 апреля" && !n.isRead) {
        await ctx.db.patch(n._id, { isRead: true });
        count++;
      }
    }
    return { marked: count };
  },
});

// Send feedback from user to admin (new thread or reply)
export const sendFeedback = mutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    message: v.string(),
    threadId: v.optional(v.id("userNotifications")),
  },
  handler: async (ctx, args) => {
    if (!args.message.trim()) throw new Error("Введите сообщение");

    await ctx.db.insert("userNotifications", {
      userId: args.userId,
      title: args.title.trim() || "Обратная связь",
      message: args.message.trim(),
      type: "feedback",
      direction: "user_to_admin",
      threadId: args.threadId,
      isRead: false,
      createdAt: Date.now(),
    });

    return { success: true };
  },
});

// Admin replies to a feedback thread
export const replyToFeedback = mutation({
  args: {
    rootMessageId: v.id("userNotifications"),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.message.trim()) throw new Error("Введите сообщение");

    const root = await ctx.db.get(args.rootMessageId);
    if (!root) throw new Error("Сообщение не найдено");

    // The threadId is the root message (first in thread)
    const threadId = root.threadId ?? root._id;

    await ctx.db.insert("userNotifications", {
      userId: root.userId,
      title: root.title,
      message: args.message.trim(),
      type: "feedback",
      direction: "admin_to_user",
      threadId,
      isRead: false,
      createdAt: Date.now(),
    });

    // Mark the root message as read (admin has seen it)
    if (!root.isRead) {
      await ctx.db.patch(root._id, { isRead: true });
    }

    return { success: true };
  },
});

// Get thread messages (all messages in a conversation)
export const getThread = query({
  args: { threadId: v.id("userNotifications") },
  handler: async (ctx, args) => {
    // Get root message
    const root = await ctx.db.get(args.threadId);
    if (!root) return [];

    // Get all replies
    const replies = await ctx.db
      .query("userNotifications")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .collect();

    return [root, ...replies].sort((a, b) => a.createdAt - b.createdAt);
  },
});

// Get feedback threads for user (shows their conversations in settings)
export const getUserThreads = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    // Get all feedback messages for this user
    const all = await ctx.db
      .query("userNotifications")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const feedbackMessages = all.filter((n) => n.type === "feedback");

    // Group by thread: root messages (no threadId) are thread starters
    const rootMessages = feedbackMessages.filter((m) => !m.threadId);
    const replies = feedbackMessages.filter((m) => m.threadId);

    const threads = rootMessages.map((root) => {
      const threadReplies = replies.filter(
        (r) => r.threadId === root._id
      );
      const allMessages = [root, ...threadReplies].sort(
        (a, b) => a.createdAt - b.createdAt
      );
      const lastMessage = allMessages[allMessages.length - 1];
      const unreadCount = allMessages.filter(
        (m) => !m.isRead && m.direction === "admin_to_user"
      ).length;

      return {
        threadId: root._id,
        title: root.title,
        lastMessage: lastMessage.message,
        lastMessageAt: lastMessage.createdAt,
        lastDirection: lastMessage.direction,
        messageCount: allMessages.length,
        unreadCount,
        createdAt: root.createdAt,
      };
    });

    return threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  },
});

// Count unread user→admin messages (for admin sidebar badge)
export const getUnreadFeedbackCount = query({
  args: {},
  handler: async (ctx) => {
    const unread = await ctx.db
      .query("userNotifications")
      .withIndex("by_direction", (q) =>
        q.eq("direction", "user_to_admin").eq("isRead", false)
      )
      .collect();
    return unread.length;
  },
});

// Get all feedback threads (for admin panel)
export const listFeedback = query({
  args: {},
  handler: async (ctx) => {
    // Get all feedback root messages (no threadId = thread starters)
    const allFeedback = await ctx.db
      .query("userNotifications")
      .withIndex("by_direction", (q) =>
        q.eq("direction", "user_to_admin")
      )
      .collect();

    // Root messages only (thread starters)
    const rootMessages = allFeedback.filter((m) => !m.threadId);

    const result = await Promise.all(
      rootMessages.map(async (f) => {
        const user = await ctx.db.get(f.userId);

        // Count replies in thread
        const replies = await ctx.db
          .query("userNotifications")
          .withIndex("by_threadId", (q) => q.eq("threadId", f._id))
          .collect();

        const allInThread = [f, ...replies];
        const lastMessage = allInThread.sort(
          (a, b) => b.createdAt - a.createdAt
        )[0];
        const unreadFromUser = allInThread.filter(
          (m) => !m.isRead && m.direction === "user_to_admin"
        ).length;

        return {
          ...f,
          userName: user?.name || user?.email || "—",
          userEmail: user?.email || "—",
          replyCount: replies.length,
          lastMessageAt: lastMessage.createdAt,
          lastDirection: lastMessage.direction,
          unreadFromUser,
        };
      })
    );

    return result.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  },
});
