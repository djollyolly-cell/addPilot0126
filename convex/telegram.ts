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
