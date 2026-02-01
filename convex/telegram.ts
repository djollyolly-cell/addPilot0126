import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";

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
  callback_query?: {
    id: string;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: {
        id: number;
        type: string;
      };
    };
    data?: string;
  };
}

/** Telegram inline keyboard button */
export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/**
 * Build inline keyboard reply_markup for a stopped ad notification.
 * Returns 2 buttons: "Отменить остановку" (revert) and "ОК" (dismiss).
 */
export function buildInlineKeyboard(
  actionLogId: string
): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [
        { text: "↩️ Отменить остановку", callback_data: `revert:${actionLogId}` },
        { text: "✅ ОК", callback_data: `dismiss:${actionLogId}` },
      ],
    ],
  };
}

/**
 * Parse callback_data from inline button press.
 * "revert:abc123" -> { action: "revert", actionLogId: "abc123" }
 * "dismiss:abc123" -> { action: "dismiss", actionLogId: "abc123" }
 */
export function parseCallbackData(
  data: string
): { action: string; actionLogId: string } | null {
  const match = data.match(/^(revert|dismiss):(.+)$/);
  if (!match) return null;
  return { action: match[1], actionLogId: match[2] };
}

/**
 * Check if the current time falls within quiet hours.
 * Supports overnight ranges (e.g., 23:00 - 07:00).
 * "00:00"-"00:00" means quiet hours are disabled.
 * Returns true if notifications should be suppressed.
 */
export function isQuietHours(
  nowHHMM: string, // "HH:MM"
  startHHMM: string, // "HH:MM"
  endHHMM: string // "HH:MM"
): boolean {
  // "00:00"-"00:00" = disabled
  if (startHHMM === "00:00" && endHHMM === "00:00") return false;
  // Same start and end (but not 00:00) = 24h quiet
  if (startHHMM === endHHMM) return true;

  if (startHHMM <= endHHMM) {
    // Same-day range: e.g. 09:00 - 18:00
    return nowHHMM >= startHHMM && nowHHMM < endHHMM;
  }
  // Overnight range: e.g. 23:00 - 07:00
  return nowHHMM >= startHHMM || nowHHMM < endHHMM;
}

/** Action log summary for daily digest */
export interface DigestActionLogSummary {
  adName: string;
  actionType: string;
  reason: string;
  savedAmount: number;
  metricsSnapshot: {
    spent: number;
    leads: number;
    cpl?: number;
    ctr?: number;
  };
}

/**
 * Format daily digest message from action log summaries.
 * Returns empty string if no events.
 */
export function formatDailyDigest(
  events: DigestActionLogSummary[],
  dateStr: string // "DD.MM.YYYY"
): string {
  if (events.length === 0) return "";

  const totalSaved = events.reduce((sum, e) => sum + e.savedAmount, 0);
  const totalSpent = events.reduce((sum, e) => sum + e.metricsSnapshot.spent, 0);
  const stoppedCount = events.filter(
    (e) => e.actionType === "stopped" || e.actionType === "stopped_and_notified"
  ).length;
  const notifyCount = events.filter((e) => e.actionType === "notified").length;

  const lines: string[] = [
    `📊 <b>Дайджест за ${dateStr}</b>`,
    "",
    `Сработало правил: ${events.length}`,
  ];

  if (stoppedCount > 0) {
    lines.push(`🛑 Остановлено: ${stoppedCount}`);
  }
  if (notifyCount > 0) {
    lines.push(`⚠️ Предупреждений: ${notifyCount}`);
  }

  lines.push("");
  lines.push(`💰 Общий расход: ${totalSpent.toFixed(0)}₽`);
  if (totalSaved > 0) {
    lines.push(`✅ Сэкономлено: ~${totalSaved.toFixed(0)}₽`);
  }

  lines.push("");
  lines.push("<b>Детали:</b>");

  for (const event of events.slice(0, 10)) {
    const emoji =
      event.actionType === "stopped" || event.actionType === "stopped_and_notified"
        ? "🛑"
        : "⚠️";
    lines.push(`${emoji} ${event.adName} — ${event.reason}`);
  }

  if (events.length > 10) {
    lines.push(`...и ещё ${events.length - 10}`);
  }

  return lines.join("\n");
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

/** Send a message with inline keyboard via Telegram Bot API (internal) */
export const sendMessageWithKeyboard = internalAction({
  args: {
    chatId: v.string(),
    text: v.string(),
    replyMarkup: v.any(),
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
          reply_markup: args.replyMarkup,
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

/** Answer a callback query via Telegram Bot API (internal) */
export const answerCallbackQuery = internalAction({
  args: {
    callbackQueryId: v.string(),
    text: v.optional(v.string()),
    showAlert: v.optional(v.boolean()),
  },
  handler: async (_ctx, args) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN not configured");
    }

    const body: Record<string, unknown> = {
      callback_query_id: args.callbackQueryId,
    };
    if (args.text) body.text = args.text;
    if (args.showAlert) body.show_alert = args.showAlert;

    const response = await fetch(
      `${TELEGRAM_API_BASE}${botToken}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
  handler: async (ctx, args): Promise<{ ok: boolean; linked?: boolean; action?: string; reason?: string }> => {
    const update: TelegramUpdate = args.body;

    // ── Handle callback_query (inline button press) ──
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbData = cb.data;
      const chatId = cb.message?.chat?.id
        ? String(cb.message.chat.id)
        : null;

      if (!cbData) {
        return { ok: true };
      }

      const parsed = parseCallbackData(cbData);
      if (!parsed) {
        return { ok: true };
      }

      if (parsed.action === "dismiss") {
        // Just acknowledge the button press
        await ctx.runAction(internal.telegram.answerCallbackQuery, {
          callbackQueryId: cb.id,
          text: "👌",
        });
        return { ok: true, action: "dismissed" };
      }

      if (parsed.action === "revert") {
        // Try to revert the action
        const result = await ctx.runMutation(
          internal.ruleEngine.revertAction,
          {
            actionLogId: parsed.actionLogId as any,
            revertedBy: `telegram:${cb.from.id}`,
          }
        );

        if (result.reason === "already_reverted") {
          await ctx.runAction(internal.telegram.answerCallbackQuery, {
            callbackQueryId: cb.id,
            text: "⚠️ Уже отменено",
            showAlert: true,
          });
          return { ok: true, action: "already_reverted" };
        }

        if (result.reason === "timeout") {
          await ctx.runAction(internal.telegram.answerCallbackQuery, {
            callbackQueryId: cb.id,
            text: "⏰ Время истекло (более 5 минут)",
            showAlert: true,
          });
          return { ok: true, action: "timeout" };
        }

        if (!result.success) {
          await ctx.runAction(internal.telegram.answerCallbackQuery, {
            callbackQueryId: cb.id,
            text: "❌ Не удалось отменить",
            showAlert: true,
          });
          return { ok: true, action: "failed", reason: result.reason };
        }

        // Revert succeeded — restart the ad via VK API
        const actionLog = await ctx.runQuery(
          internal.ruleEngine.getActionLog,
          { actionLogId: parsed.actionLogId as any }
        );

        if (actionLog) {
          try {
            const accessToken = await ctx.runAction(
              internal.auth.getValidVkAdsToken,
              { userId: actionLog.userId }
            );
            await ctx.runAction(api.vkApi.restartAd, {
              accessToken,
              adId: actionLog.adId,
              accountId: actionLog.accountId,
            });
          } catch (err) {
            console.error(
              `[telegram] Failed to restart ad ${actionLog.adId}:`,
              err instanceof Error ? err.message : err
            );
          }
        }

        await ctx.runAction(internal.telegram.answerCallbackQuery, {
          callbackQueryId: cb.id,
          text: "✅ Отменено! Объявление запущено.",
        });

        // Send confirmation message to chat
        if (chatId) {
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId,
            text: "✅ <b>Остановка отменена</b>\n\nОбъявление снова запущено.",
          });
        }

        return { ok: true, action: "reverted" };
      }

      return { ok: true };
    }

    // ── Handle text messages ──
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
            text: "✅ <b>Подключено!</b>\n\nAddPilot будет отправлять уведомления в этот чат.",
          });

          return { ok: true, linked: true };
        }
      }

      // /start without valid token or bare /start
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId,
        text: "👋 Привет! Используйте ссылку из личного кабинета AddPilot для подключения бота.",
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
    actionLogId: v.optional(v.string()),
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

    // Check quiet hours (non-critical only)
    if (args.priority !== "critical") {
      const settings = await ctx.runQuery(
        internal.userSettings.getInternal,
        { userId: args.userId }
      );
      if (
        settings?.quietHoursEnabled &&
        settings.quietHoursStart &&
        settings.quietHoursEnd
      ) {
        // Get current time in user's timezone (default MSK)
        const tz = settings.timezone || "Europe/Moscow";
        const nowDate = new Date(now);
        const timeStr = nowDate.toLocaleTimeString("en-GB", {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        if (isQuietHours(timeStr, settings.quietHoursStart, settings.quietHoursEnd)) {
          // Store notification but don't send — will be included in digest
          await ctx.runMutation(internal.telegram.storePendingNotification, {
            userId: args.userId,
            event: args.event,
            priority: args.priority,
            createdAt: now,
          });
          return { sent: false, reason: "quiet_hours" };
        }
      }
    }

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

      // Include inline keyboard for stopped ads
      const isStopped =
        args.event.actionType === "stopped" ||
        args.event.actionType === "stopped_and_notified";

      try {
        if (isStopped && args.actionLogId) {
          // Send with inline keyboard (revert / ok buttons)
          const replyMarkup = buildInlineKeyboard(args.actionLogId);
          await ctx.runAction(internal.telegram.sendMessageWithKeyboard, {
            chatId,
            text: message,
            replyMarkup,
          });
        } else {
          await ctx.runAction(internal.telegram.sendMessageWithRetry, {
            chatId,
            text: message,
          });
        }
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
      .map((n: any) => n.data as RuleNotificationEvent | null)
      .filter((e: RuleNotificationEvent | null): e is RuleNotificationEvent => e !== null);

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
        notificationIds: pending.map((n: any) => n._id),
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

// ═══════════════════════════════════════════════════════════
// Sprint 12 — Daily Digest & Quiet Hours
// ═══════════════════════════════════════════════════════════

/** Internal: get action logs for a user within a date range */
export const getDigestActionLogs = internalQuery({
  args: {
    userId: v.id("users"),
    since: v.number(),
    until: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", args.userId).gte("createdAt", args.since)
      )
      .collect();
    return logs.filter((l) => l.createdAt < args.until);
  },
});

/** Internal: get all users with Telegram connected and digest enabled */
export const getDigestRecipients = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Get all users with telegramChatId
    const users = await ctx.db.query("users").collect();
    const connectedUsers = users.filter((u) => !!u.telegramChatId);

    const result: Array<{
      userId: typeof connectedUsers[0]["_id"];
      chatId: string;
    }> = [];

    for (const user of connectedUsers) {
      // Check if user has digest enabled (default: true)
      const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .first();

      // If no settings exist, default to digest enabled
      if (!settings || settings.digestEnabled) {
        result.push({
          userId: user._id,
          chatId: user.telegramChatId!,
        });
      }
    }

    return result;
  },
});

/**
 * Send daily digest to all users with Telegram connected.
 * Called by cron at 09:00 MSK (06:00 UTC).
 */
export const sendDailyDigest = internalAction({
  args: {},
  handler: async (ctx) => {
    const recipients = await ctx.runQuery(
      internal.telegram.getDigestRecipients,
      {}
    );

    if (recipients.length === 0) return { sent: 0 };

    // Yesterday 00:00 to today 00:00 (UTC-based, approximation for MSK)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const since = now - dayMs;
    const until = now;

    // Format date string for digest header
    const date = new Date(since);
    const dateStr = `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()}`;

    let sentCount = 0;

    for (const recipient of recipients) {
      const logs = await ctx.runQuery(
        internal.telegram.getDigestActionLogs,
        { userId: recipient.userId, since, until }
      );

      if (logs.length === 0) continue; // S12-DoD#7: No events → no digest

      const events: DigestActionLogSummary[] = logs.map((log: any) => ({
        adName: log.adName,
        actionType: log.actionType,
        reason: log.reason,
        savedAmount: log.savedAmount,
        metricsSnapshot: log.metricsSnapshot,
      }));

      const message = formatDailyDigest(events, dateStr);
      if (!message) continue;

      try {
        await ctx.runAction(internal.telegram.sendMessageWithRetry, {
          chatId: recipient.chatId,
          text: message,
        });
        sentCount++;
      } catch (err) {
        console.error(
          `[telegram] Failed to send digest to ${recipient.userId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return { sent: sentCount };
  },
});

// ═══════════════════════════════════════════════════════════
// Webhook Setup
// ═══════════════════════════════════════════════════════════

/** Set up Telegram webhook (run once) */
export const setupWebhook = action({
  args: {
    siteUrl: v.string(), // e.g., "https://resilient-terrier-567.convex.site"
  },
  handler: async (_ctx, args) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return { success: false, error: "TELEGRAM_BOT_TOKEN not configured" };
    }

    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    const webhookUrl = `${args.siteUrl}/telegram`;

    const webhookParams: Record<string, string> = { url: webhookUrl };
    if (webhookSecret) {
      // Set secret_token for webhook verification (CSRF protection)
      // Telegram will include this in X-Telegram-Bot-Api-Secret-Token header
      webhookParams.secret_token = webhookSecret;
    }

    const response = await fetch(
      `${TELEGRAM_API_BASE}${botToken}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookParams),
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      return { success: false, error: result.description || "Failed to set webhook" };
    }

    return {
      success: true,
      webhookUrl,
      secretConfigured: !!webhookSecret,
    };
  },
});

/** Get current webhook info */
export const getWebhookInfo = action({
  args: {},
  handler: async () => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return { success: false, error: "TELEGRAM_BOT_TOKEN not configured" };
    }

    const response = await fetch(
      `${TELEGRAM_API_BASE}${botToken}/getWebhookInfo`
    );

    const result = await response.json();
    return result;
  },
});
