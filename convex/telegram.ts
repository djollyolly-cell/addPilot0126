import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

// ═══════════════════════════════════════════════════════════
// Pure functions — exported for direct unit testing
// ═══════════════════════════════════════════════════════════

/** Telegram update type */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
    date: number;
  };
}

/**
 * Parse /start command and extract the payload token.
 * "/start abc123" -> "abc123"
 * "/start" (no payload) -> null
 */
export function parseStartCommand(text: string): string | null {
  const match = text.match(/^\/start\s+(.+)$/);
  return match ? match[1].trim() : null;
}

/**
 * Generate a random 32-character alphanumeric token.
 */
export function generateRandomToken(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Build the Telegram deep link URL for connecting the bot.
 */
export function buildBotLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername}?start=${token}`;
}

// ═══════════════════════════════════════════════════════════
// Link Token Management
// ═══════════════════════════════════════════════════════════

/** Generate a unique link token for connecting Telegram */
export const generateLinkToken = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    // Delete any existing tokens for this user
    const existing = await ctx.db
      .query("telegramLinks")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const link of existing) {
      await ctx.db.delete(link._id);
    }

    const token = generateRandomToken();

    await ctx.db.insert("telegramLinks", {
      userId: args.userId,
      token,
      createdAt: Date.now(),
    });

    return token;
  },
});

/** Get existing link token for a user */
export const getLinkToken = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("telegramLinks")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    return link?.token ?? null;
  },
});

/** Internal: validate link token and return userId */
export const validateToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("telegramLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (!link) return null;
    return { userId: link.userId, linkId: link._id };
  },
});

/** Internal: delete used link token */
export const deleteLinkToken = internalMutation({
  args: { linkId: v.id("telegramLinks") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.linkId);
  },
});

// ═══════════════════════════════════════════════════════════
// Process /start command (testable mutation)
// ═══════════════════════════════════════════════════════════

/**
 * Process /start command: validate token, save chatId, delete token.
 * Returns { linked: true, userId } on success, or { linked: false } on failure.
 */
export const processStartCommand = mutation({
  args: {
    chatId: v.string(),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    // Validate token
    const link = await ctx.db
      .query("telegramLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (!link) return { linked: false, reason: "invalid_token" };

    // Save chatId to user
    await ctx.db.patch(link.userId, {
      telegramChatId: args.chatId,
      updatedAt: Date.now(),
    });

    // Delete used token
    await ctx.db.delete(link._id);

    return { linked: true, userId: link.userId };
  },
});

// ═══════════════════════════════════════════════════════════
// Telegram Bot API — sendMessage
// ═══════════════════════════════════════════════════════════

/** Send a message via Telegram Bot API (internal) */
export const sendMessage = internalAction({
  args: {
    chatId: v.string(),
    text: v.string(),
  },
  handler: async (_ctx, args) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN not configured");
    }

    const response = await fetch(
      `${TELEGRAM_API_BASE}${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: args.chatId,
          text: args.text,
          parse_mode: "HTML",
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Telegram API Error ${response.status}: ${errorText}`
      );
    }

    return await response.json();
  },
});

/** Send a message via Telegram Bot API (public, for testing) */
export const sendMessagePublic = action({
  args: {
    chatId: v.string(),
    text: v.string(),
  },
  handler: async (_ctx, args) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN not configured");
    }

    const url = `${TELEGRAM_API_BASE}${botToken}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: args.chatId,
        text: args.text,
        parse_mode: "HTML",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Telegram API Error ${response.status}: ${errorText}`
      );
    }

    return await response.json();
  },
});

// ═══════════════════════════════════════════════════════════
// Webhook Handler — called from HTTP endpoint
// ═══════════════════════════════════════════════════════════

/** Handle incoming Telegram webhook update */
export const handleWebhook = internalAction({
  args: {
    body: v.any(),
  },
  handler: async (ctx, args) => {
    const update: TelegramUpdate = args.body;

    if (!update.message?.text) return { ok: true };

    const chatId = String(update.message.chat.id);
    const text = update.message.text;

    // Handle /start command
    if (text.startsWith("/start")) {
      const token = parseStartCommand(text);

      if (token) {
        // Validate token and get userId
        const link = await ctx.runQuery(
          internal.telegram.validateToken,
          { token }
        );

        if (link) {
          // Save chatId to user
          await ctx.runMutation(internal.telegram.saveChatId, {
            userId: link.userId,
            chatId,
          });

          // Delete used token
          await ctx.runMutation(internal.telegram.deleteLinkToken, {
            linkId: link.linkId,
          });

          // Send confirmation
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId,
            text: "\u2705 <b>\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E!</b>\n\nAdPilot \u0431\u0443\u0434\u0435\u0442 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0442\u044C \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u0432 \u044D\u0442\u043E\u0442 \u0447\u0430\u0442.",
          });

          return { ok: true, linked: true };
        }
      }

      // /start without valid token or bare /start
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId,
        text: "\uD83D\uDC4B \u041F\u0440\u0438\u0432\u0435\u0442! \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0441\u0441\u044B\u043B\u043A\u0443 \u0438\u0437 \u043B\u0438\u0447\u043D\u043E\u0433\u043E \u043A\u0430\u0431\u0438\u043D\u0435\u0442\u0430 AdPilot \u0434\u043B\u044F \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F \u0431\u043E\u0442\u0430.",
      });

      return { ok: true, linked: false };
    }

    return { ok: true };
  },
});

/** Internal: save chatId to user (direct DB patch) */
export const saveChatId = internalMutation({
  args: {
    userId: v.id("users"),
    chatId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      telegramChatId: args.chatId,
      updatedAt: Date.now(),
    });
  },
});

/** Get Telegram connection status for a user */
export const getConnectionStatus = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { connected: false };
    return {
      connected: !!user.telegramChatId,
      chatId: user.telegramChatId,
    };
  },
});

// ═══════════════════════════════════════════════════════════
// Sprint 10 — Rule Notifications
// ═══════════════════════════════════════════════════════════

/** Notification event data */
export interface RuleNotificationEvent {
  ruleName: string;
  adName: string;
  campaignName?: string;
  reason: string;
  actionType: "stopped" | "notified" | "stopped_and_notified";
  savedAmount: number;
  metrics: {
    spent: number;
    leads: number;
    cpl?: number;
    ctr?: number;
  };
}

/**
 * Format a single rule notification message (pure function).
 * Uses PRD-specified format with emoji.
 */
export function formatRuleNotification(event: RuleNotificationEvent): string {
  const actionEmoji =
    event.actionType === "stopped" || event.actionType === "stopped_and_notified"
      ? "🛑"
      : "⚠️";

  const actionText =
    event.actionType === "stopped" || event.actionType === "stopped_and_notified"
      ? "Остановлено"
      : "Требует внимания";

  const lines: string[] = [
    `${actionEmoji} <b>${actionText}</b>`,
    "",
    `📋 Правило: ${event.ruleName}`,
    `📢 Объявление: ${event.adName}`,
  ];

  if (event.campaignName) {
    lines.push(`📁 Кампания: ${event.campaignName}`);
  }

  lines.push(`💡 Причина: ${event.reason}`);
  lines.push("");
  lines.push(`💰 Потрачено: ${event.metrics.spent}₽`);

  if (event.metrics.cpl !== undefined) {
    lines.push(`📊 CPL: ${event.metrics.cpl.toFixed(0)}₽`);
  }
  if (event.metrics.ctr !== undefined) {
    lines.push(`📈 CTR: ${event.metrics.ctr.toFixed(2)}%`);
  }

  if (event.savedAmount > 0) {
    lines.push("");
    lines.push(`✅ Сэкономлено: ~${event.savedAmount.toFixed(0)}₽`);
  }

  return lines.join("\n");
}

/**
 * Format a grouped notification for multiple events (pure function).
 */
export function formatGroupedNotification(
  events: RuleNotificationEvent[]
): string {
  if (events.length === 0) return "";
  if (events.length === 1) return formatRuleNotification(events[0]);

  const totalSaved = events.reduce((sum, e) => sum + e.savedAmount, 0);
  const stoppedCount = events.filter(
    (e) => e.actionType === "stopped" || e.actionType === "stopped_and_notified"
  ).length;

  const lines: string[] = [
    `🔔 <b>Сработало правил: ${events.length}</b>`,
    "",
  ];

  for (const event of events) {
    const emoji =
      event.actionType === "stopped" || event.actionType === "stopped_and_notified"
        ? "🛑"
        : "⚠️";
    lines.push(`${emoji} ${event.adName} — ${event.reason}`);
  }

  lines.push("");
  if (stoppedCount > 0) {
    lines.push(`Остановлено: ${stoppedCount} объявлений`);
  }
  if (totalSaved > 0) {
    lines.push(`✅ Сэкономлено: ~${totalSaved.toFixed(0)}₽`);
  }

  return lines.join("\n");
}

/** Internal: get user's chatId */
export const getUserChatId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    return user?.telegramChatId ?? null;
  },
});

/** Internal: store a pending notification event for grouping */
export const storePendingNotification = internalMutation({
  args: {
    userId: v.id("users"),
    event: v.object({
      ruleName: v.string(),
      adName: v.string(),
      campaignName: v.optional(v.string()),
      reason: v.string(),
      actionType: v.union(
        v.literal("stopped"),
        v.literal("notified"),
        v.literal("stopped_and_notified")
      ),
      savedAmount: v.number(),
      metrics: v.object({
        spent: v.number(),
        leads: v.number(),
        cpl: v.optional(v.number()),
        ctr: v.optional(v.number()),
      }),
    }),
    priority: v.union(v.literal("critical"), v.literal("standard")),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      userId: args.userId,
      type: args.priority === "critical" ? "critical" : "standard",
      channel: "telegram",
      title: `Правило: ${args.event.ruleName}`,
      message: formatRuleNotification(args.event),
      data: args.event,
      status: "pending",
      createdAt: args.createdAt,
    });
  },
});

/** Internal: get pending Telegram notifications for a user within a time window */
export const getPendingNotifications = internalQuery({
  args: {
    userId: v.id("users"),
    since: v.number(),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("notifications")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    return all.filter(
      (n) =>
        n.channel === "telegram" &&
        n.status === "pending" &&
        n.createdAt >= args.since
    );
  },
});

/** Internal: mark notifications as sent */
export const markNotificationsSent = internalMutation({
  args: {
    notificationIds: v.array(v.id("notifications")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const id of args.notificationIds) {
      await ctx.db.patch(id, { status: "sent", sentAt: now });
    }
  },
});

/** Internal: mark notification as failed */
export const markNotificationFailed = internalMutation({
  args: {
    notificationId: v.id("notifications"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.notificationId, {
      status: "failed",
      errorMessage: args.errorMessage,
    });
  },
});

/**
 * Send a rule notification via Telegram.
 * - critical priority → send immediately
 * - standard priority → store as pending, flush grouped later
 * - missing chatId → skip silently
 */
export const sendRuleNotification = internalAction({
  args: {
    userId: v.id("users"),
    event: v.object({
      ruleName: v.string(),
      adName: v.string(),
      campaignName: v.optional(v.string()),
      reason: v.string(),
      actionType: v.union(
        v.literal("stopped"),
        v.literal("notified"),
        v.literal("stopped_and_notified")
      ),
      savedAmount: v.number(),
      metrics: v.object({
        spent: v.number(),
        leads: v.number(),
        cpl: v.optional(v.number()),
        ctr: v.optional(v.number()),
      }),
    }),
    priority: v.union(v.literal("critical"), v.literal("standard")),
  },
  handler: async (ctx, args) => {
    // Check if user has Telegram connected
    const chatId = await ctx.runQuery(internal.telegram.getUserChatId, {
      userId: args.userId,
    });

    if (!chatId) {
      console.warn(
        `[telegram] User ${args.userId} has no telegramChatId, skipping notification`
      );
      return { sent: false, reason: "no_chat_id" };
    }

    const now = Date.now();

    if (args.priority === "critical") {
      // Critical → send immediately
      const notifId = await ctx.runMutation(
        internal.telegram.storePendingNotification,
        {
          userId: args.userId,
          event: args.event,
          priority: args.priority,
          createdAt: now,
        }
      );

      const message = formatRuleNotification(args.event);

      try {
        await ctx.runAction(internal.telegram.sendMessageWithRetry, {
          chatId,
          text: message,
        });
        await ctx.runMutation(internal.telegram.markNotificationsSent, {
          notificationIds: [notifId],
        });
        return { sent: true, grouped: false };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        await ctx.runMutation(internal.telegram.markNotificationFailed, {
          notificationId: notifId,
          errorMessage: errorMsg,
        });
        return { sent: false, reason: errorMsg };
      }
    }

    // Standard → store pending, then check if we should flush
    await ctx.runMutation(internal.telegram.storePendingNotification, {
      userId: args.userId,
      event: args.event,
      priority: args.priority,
      createdAt: now,
    });

    // Flush pending notifications (group within 5-min window)
    await ctx.runAction(internal.telegram.flushPendingNotifications, {
      userId: args.userId,
    });

    return { sent: true, grouped: true };
  },
});

/** Flush pending notifications for a user — group into one message */
export const flushPendingNotifications = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const chatId = await ctx.runQuery(internal.telegram.getUserChatId, {
      userId: args.userId,
    });
    if (!chatId) return;

    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const pending = await ctx.runQuery(
      internal.telegram.getPendingNotifications,
      { userId: args.userId, since: fiveMinAgo }
    );

    if (pending.length === 0) return;

    // Reconstruct events from stored data
    const events: RuleNotificationEvent[] = pending
      .map((n) => n.data as RuleNotificationEvent | null)
      .filter((e): e is RuleNotificationEvent => e !== null);

    const message =
      events.length > 1
        ? formatGroupedNotification(events)
        : events.length === 1
          ? formatRuleNotification(events[0])
          : pending[0].message;

    try {
      await ctx.runAction(internal.telegram.sendMessageWithRetry, {
        chatId,
        text: message,
      });
      await ctx.runMutation(internal.telegram.markNotificationsSent, {
        notificationIds: pending.map((n) => n._id),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      for (const n of pending) {
        await ctx.runMutation(internal.telegram.markNotificationFailed, {
          notificationId: n._id,
          errorMessage: errorMsg,
        });
      }
    }
  },
});

/**
 * Send a Telegram message with retry on 429 (rate limit).
 * Retries up to 3 times with Retry-After delay.
 */
export const sendMessageWithRetry = internalAction({
  args: {
    chatId: v.string(),
    text: v.string(),
  },
  handler: async (_ctx, args) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN not configured");
    }

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(
        `${TELEGRAM_API_BASE}${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: args.chatId,
            text: args.text,
            parse_mode: "HTML",
          }),
        }
      );

      if (response.ok) {
        return await response.json();
      }

      if (response.status === 429 && attempt < maxRetries) {
        // Parse Retry-After header
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfterSec = retryAfterHeader
          ? parseInt(retryAfterHeader, 10)
          : 1 + attempt;
        const delayMs = Math.min(retryAfterSec * 1000, 30000);

        console.warn(
          `[telegram] Rate limited (429), retry after ${retryAfterSec}s (attempt ${attempt + 1}/${maxRetries})`
        );

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      const errorText = await response.text();
      lastError = new Error(
        `Telegram API Error ${response.status}: ${errorText}`
      );
      break;
    }

    throw lastError ?? new Error("Telegram send failed");
  },
});
