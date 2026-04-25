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
import { Doc, Id } from "./_generated/dataModel";

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
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
    contact?: {
      phone_number: string;
      first_name: string;
      last_name?: string;
      user_id?: number;
    };
    reply_to_message?: {
      message_id: number;
      from?: { id: number; is_bot: boolean; first_name: string };
    };
    date: number;
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      last_name?: string;
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

// ─── Digest interfaces ──────────────────────────────────────────────

export interface DigestMetrics {
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  messages: number;
  subscriptions: number;
  views: number;
  cpl: number;
  costPerMsg: number;
  costPerSub: number;
}

export interface DigestCampaignData {
  adPlanId: number;
  adPlanName: string;
  type: CampaignType;
  impressions: number;
  clicks: number;
  spent: number;
  results: number;
  costPerResult: number;
}

export interface DigestAccountData {
  name: string;
  campaigns: DigestCampaignData[];
  metrics: DigestMetrics;
  prevMetrics?: DigestMetrics;
  ruleEvents: { ruleName: string; count: number }[];
  savedAmount: number;
}

export interface DigestData {
  accounts: DigestAccountData[];
  totals: DigestMetrics;
  prevTotals?: DigestMetrics;
}

// ─── Digest pure helpers ─────────────────────────────────────────────

export function isSubscriptionPackage(packageName: string): boolean {
  return classifyCampaignPackage(packageName) === "subscription";
}

export type CampaignType = "lead" | "message" | "subscription" | "awareness";

export function classifyCampaignPackage(packageName: string): CampaignType {
  const lower = packageName.toLowerCase();
  // branding/awareness FIRST — before video_and_live which also appears in branding packages
  if (["branding", "reach", "video_view"].some(kw => lower.includes(kw))) return "awareness";
  if (["join", "subscri", "подписк", "pricedGoals_engage"].some(kw => lower.includes(kw))) return "subscription";
  if (["contact", "clip", "video_and_live", "socialvideo", "сообщени"].some(kw => lower.includes(kw))) return "message";
  return "lead";
}

export function formatDelta(current: number, previous: number): string {
  if (previous === 0) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "";
  return pct > 0 ? ` (↑${pct}%)` : ` (↓${Math.abs(pct)}%)`;
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** Unified digest message formatter for daily/weekly/monthly */
export function formatDigestMessage(
  type: "daily" | "weekly" | "monthly",
  data: DigestData,
  periodStr: string,
  prevPeriodStr?: string,
): string {
  const lines: string[] = [];

  // Header
  if (type === "daily") {
    lines.push(`📊 <b>Дайджест за ${periodStr}</b>`);
  } else if (type === "weekly") {
    lines.push(`📊 <b>Сводка за неделю (${periodStr})</b>`);
  } else {
    lines.push(`📅 <b>Отчёт за ${periodStr}</b>`);
  }

  // Comparison header for weekly/monthly
  if (type !== "daily" && data.prevTotals && prevPeriodStr) {
    if (type === "weekly") {
      lines.push(`📉 Сравнение с прошлой неделей (${prevPeriodStr})`);
    } else {
      lines.push(`📉 Сравнение с ${prevPeriodStr}`);
    }
  }

  lines.push("");

  // Per-account blocks
  for (const account of data.accounts) {
    lines.push(`📋 <b>${account.name}:</b>`);

    const m = account.metrics;
    const p = account.prevMetrics;
    const showDelta = type !== "daily" && !!p;

    lines.push(`📈 Показы: ${m.impressions.toLocaleString("ru-RU")}${showDelta ? formatDelta(m.impressions, p!.impressions) : ""} | 👆 Клики: ${m.clicks.toLocaleString("ru-RU")}${showDelta ? formatDelta(m.clicks, p!.clicks) : ""}`);
    lines.push(`💰 Расход: ${m.spent.toLocaleString("ru-RU")}₽${showDelta ? formatDelta(m.spent, p!.spent) : ""}`);

    // Per-campaign breakdown
    if (account.campaigns && account.campaigns.length > 0) {
      lines.push("");
      for (const camp of account.campaigns) {
        const icon = { lead: "🎯", message: "💬", subscription: "👥", awareness: "👁" }[camp.type];
        const label = { lead: "лиды", message: "сообщения", subscription: "подписки", awareness: "просмотры" }[camp.type];
        const costStr = camp.results > 0 ? ` | стоимость: ${camp.costPerResult}₽` : "";
        lines.push(`${icon} ${camp.adPlanName} — ${label}: ${camp.results}${costStr}`);
      }
    } else {
      // Fallback: show aggregate metrics without campaign breakdown
      if (m.leads > 0) {
        lines.push(`🎯 Лиды: ${m.leads} | CPL: ${m.cpl}₽${showDelta && p!.cpl > 0 ? formatDelta(m.cpl, p!.cpl) : ""}`);
      }
      if (m.messages > 0) {
        lines.push(`💬 Сообщения: ${m.messages} | Стоимость: ${m.costPerMsg}₽${showDelta && p!.costPerMsg > 0 ? formatDelta(m.costPerMsg, p!.costPerMsg) : ""}`);
      }
      if (m.subscriptions > 0) {
        lines.push(`👥 Подписки: ${m.subscriptions} | Стоимость: ${m.costPerSub}₽${showDelta && p!.costPerSub > 0 ? formatDelta(m.costPerSub, p!.costPerSub) : ""}`);
      }
      if (m.views > 0) {
        lines.push(`👁 Просмотры: ${m.views}`);
      }
    }

    lines.push("");

    // Rule events
    if (account.ruleEvents.length > 0) {
      const totalEvents = account.ruleEvents.reduce((s, e) => s + e.count, 0);
      lines.push(`⚙️ Правила: сработало ${totalEvents} ${pluralRu(totalEvents, "раз", "раза", "раз")}`);
      for (const event of account.ruleEvents) {
        lines.push(`• ${event.ruleName} — ${event.count} ${pluralRu(event.count, "раз", "раза", "раз")}`);
      }
      if (account.savedAmount > 0) {
        lines.push(`✅ Сэкономлено: ~${account.savedAmount.toLocaleString("ru-RU")}₽`);
      }
    } else {
      lines.push("✅ Правила не сработали");
    }

    lines.push("");
  }

  // Totals
  const t = data.totals;
  const pt = data.prevTotals;
  const showTotalDelta = type !== "daily" && !!pt;

  let totalsLine = `<b>Итого:</b> расход ${t.spent.toLocaleString("ru-RU")}₽${showTotalDelta ? formatDelta(t.spent, pt!.spent) : ""}`;
  if (t.leads > 0) totalsLine += `, лиды ${t.leads}`;
  if (t.messages > 0) totalsLine += `, сообщения ${t.messages}`;
  if (t.subscriptions > 0) totalsLine += `, подписки ${t.subscriptions}`;
  if (t.views > 0) totalsLine += `, просмотры ${t.views}`;

  lines.push(totalsLine);

  return lines.join("\n");
}

/** Split long Telegram message into chunks (max 4096 chars) */
export function splitTelegramMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const messages: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > maxLen && current.length > 0) {
      messages.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) messages.push(current);
  return messages;
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

    // Check if chatId is already used by another user
    const existingOwner = await ctx.db
      .query("users")
      .withIndex("by_telegramChatId", (q) => q.eq("telegramChatId", args.chatId))
      .filter((q) => q.neq(q.field("_id"), link.userId))
      .first();
    if (existingOwner) {
      return { linked: false, reason: "chatid_taken" };
    }

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
            actionLogId: parsed.actionLogId as Id<"actionLogs">,
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
          { actionLogId: parsed.actionLogId as Id<"actionLogs"> }
        );

        if (actionLog) {
          try {
            const accessToken = await ctx.runAction(
              internal.auth.getValidTokenForAccount,
              { accountId: actionLog.accountId }
            );
            await ctx.runAction(api.vkApi.restartAd, {
              accessToken,
              adId: actionLog.adId,
              accountId: actionLog.accountId,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(
              `[telegram] Failed to restart ad ${actionLog.adId}:`,
              errMsg
            );
            try { await ctx.runMutation(internal.systemLogger.log, {
              level: "error",
              source: "telegram",
              message: `Failed to restart ad ${actionLog.adId}: ${errMsg.slice(0, 150)}`,
            }); } catch { /* non-critical */ }
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

    // ── Handle contact sharing (phone number) ──
    if (update.message?.contact) {
      const chatId = String(update.message.chat.id);
      const contact = update.message.contact;
      // Only save if user shared their own contact (not someone else's)
      if (contact.user_id === update.message.from.id) {
        await ctx.runMutation(internal.telegram.saveTelegramPhone, {
          chatId,
          phone: contact.phone_number,
        });
        // Remove the keyboard and confirm
        await ctx.runAction(internal.telegram.sendMessageWithKeyboard, {
          chatId,
          text: "📱 Спасибо! Номер сохранён.",
          replyMarkup: { remove_keyboard: true },
        });
      }
      return { ok: true };
    }

    // ── Forward non-text private messages (photos, voice, stickers) to support ──
    if (!update.message?.text && update.message?.chat?.type === "private") {
      const chatId = String(update.message.chat.id);
      const supportGroupId = process.env.SUPPORT_GROUP_CHAT_ID;
      const supportTopicId = process.env.SUPPORT_TOPIC_ID;
      if (supportGroupId && supportTopicId) {
        try {
          const forwardedId = await ctx.runAction(
            internal.telegram.forwardToSupport,
            { fromChatId: chatId, messageId: update.message.message_id }
          );
          if (forwardedId) {
            const fromUser = update.message.from;
            const userName = [fromUser?.first_name, fromUser?.last_name].filter(Boolean).join(" ")
              + (fromUser?.username ? ` (@${fromUser.username})` : "");
            await ctx.runMutation(internal.telegram.saveSupportMapping, {
              forwardedMessageId: forwardedId,
              originalChatId: chatId,
              originalMessageId: update.message.message_id,
              userName: userName || undefined,
            });
          }
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId,
            text: "✉️ Сообщение передано администратору. Ожидайте ответа.",
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error("[telegram] Failed to forward non-text to support:", errMsg);
          try { await ctx.runMutation(internal.systemLogger.log, {
            level: "warn",
            source: "telegram",
            message: `Forward to support failed: ${errMsg.slice(0, 180)}`,
          }); } catch { /* non-critical */ }
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId,
            text: "⚠️ Не удалось переслать сообщение. Попробуйте позже или напишите текстом.",
          }).catch(() => {});
        }
      }
      return { ok: true };
    }

    // ── Handle text messages ──
    if (!update.message?.text) return { ok: true };

    const chatId = String(update.message.chat.id);
    const text = update.message.text;
    const from = update.message.from;

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
          // Save chatId + Telegram profile data to user
          const saveResult = await ctx.runMutation(internal.telegram.saveChatId, {
            userId: link.userId,
            chatId,
            telegramUserId: from.id,
            telegramFirstName: from.first_name,
            telegramLastName: from.last_name,
            telegramUsername: from.username,
          }) as { saved: boolean; reason?: string; existingUserName?: string } | null;

          if (saveResult && !saveResult.saved) {
            // chatId already belongs to another user
            try { await ctx.runMutation(internal.auditLog.log, {
              userId: link.userId,
              category: "telegram",
              action: "bot_connect_failed",
              status: "failed",
              details: { error: "chatid_taken" },
            }); } catch { /* non-critical */ }
            await ctx.runAction(internal.telegram.sendMessage, {
              chatId,
              text: `⚠️ <b>Этот Telegram уже привязан к другому аккаунту</b> (${saveResult.existingUserName || "другой пользователь"}).\n\nКаждый пользователь должен подключать бота из <b>своего</b> Telegram. Попросите владельца аккаунта нажать ссылку подключения самостоятельно.`,
            });
            return { ok: true, linked: false, reason: "chatid_taken" };
          }

          // Delete used token
          await ctx.runMutation(internal.telegram.deleteLinkToken, {
            linkId: link.linkId,
          });

          // Audit log: bot connected
          try { await ctx.runMutation(internal.auditLog.log, {
            userId: link.userId,
            category: "telegram",
            action: "bot_connected",
            status: "success",
          }); } catch { /* non-critical */ }

          // Send confirmation + request phone via contact button
          await ctx.runAction(internal.telegram.sendMessageWithKeyboard, {
            chatId,
            text: "✅ <b>Подключено!</b>\n\nAddPilot будет отправлять уведомления в этот чат.\n\n📱 Поделитесь номером телефона, чтобы мы могли связаться с вами при необходимости (необязательно):",
            replyMarkup: {
              keyboard: [[{ text: "📱 Поделиться номером", request_contact: true }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
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

    // ── Support: forward private messages to admin topic ──
    const chatType = update.message.chat.type;
    if (chatType === "private") {
      try {
        const forwardedId = await ctx.runAction(
          internal.telegram.forwardToSupport,
          { fromChatId: chatId, messageId: update.message.message_id }
        );
        if (forwardedId) {
          const fromUser = update.message.from;
          const userName = [fromUser?.first_name, fromUser?.last_name].filter(Boolean).join(" ")
            + (fromUser?.username ? ` (@${fromUser.username})` : "");
          await ctx.runMutation(internal.telegram.saveSupportMapping, {
            forwardedMessageId: forwardedId,
            originalChatId: chatId,
            originalMessageId: update.message.message_id,
            userName: userName || undefined,
          });
        }
        await ctx.runAction(internal.telegram.sendMessage, {
          chatId,
          text: "✉️ Сообщение передано администратору. Ожидайте ответа.",
        });
      } catch (err) {
        console.error("[telegram] Failed to forward to support:", err);
        await ctx.runAction(internal.telegram.sendMessage, {
          chatId,
          text: "⚠️ Не удалось переслать сообщение. Попробуйте позже.",
        }).catch(() => {});
      }
      return { ok: true, action: "forwarded_to_support" };
    }

    // ── Support: forward admin reply back to user ──
    const supportGroupId = process.env.SUPPORT_GROUP_CHAT_ID;
    if (
      chatType === "supergroup" &&
      supportGroupId &&
      String(update.message.chat.id) === supportGroupId &&
      update.message.reply_to_message
    ) {
      try {
        const replyToId = update.message.reply_to_message.message_id;
        const mapping = await ctx.runQuery(
          internal.telegram.getSupportMapping,
          { forwardedMessageId: replyToId }
        );
        if (mapping) {
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId: mapping.originalChatId,
            text: `💬 <b>Ответ администратора:</b>\n\n${text}`,
          });
        }
      } catch (err) {
        console.error("[telegram] Failed to forward admin reply:", err);
      }
      return { ok: true, action: "admin_reply_forwarded" };
    }

    return { ok: true };
  },
});

/** Internal: save chatId and Telegram profile data to user */
export const saveChatId = internalMutation({
  args: {
    userId: v.id("users"),
    chatId: v.string(),
    telegramUserId: v.optional(v.number()),
    telegramFirstName: v.optional(v.string()),
    telegramLastName: v.optional(v.string()),
    telegramUsername: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check if this chatId is already used by ANOTHER user
    const existingOwner = await ctx.db
      .query("users")
      .withIndex("by_telegramChatId", (q) => q.eq("telegramChatId", args.chatId))
      .filter((q) => q.neq(q.field("_id"), args.userId))
      .first();
    if (existingOwner) {
      // chatId already belongs to another user — reject
      return {
        saved: false,
        reason: "chatid_taken",
        existingUserName: existingOwner.name || existingOwner.email,
      };
    }

    const patch: Record<string, unknown> = {
      telegramChatId: args.chatId,
      updatedAt: Date.now(),
    };
    if (args.telegramUserId !== undefined) patch.telegramUserId = args.telegramUserId;
    if (args.telegramFirstName !== undefined) patch.telegramFirstName = args.telegramFirstName;
    if (args.telegramLastName !== undefined) patch.telegramLastName = args.telegramLastName;
    if (args.telegramUsername !== undefined) patch.telegramUsername = args.telegramUsername;
    await ctx.db.patch(args.userId, patch);
    return { saved: true };
  },
});

/** TEMP: Fix duplicate chatIds — remove chatId from users who don't own it */
export const fixDuplicateChatIds = mutation({
  args: {},
  handler: async (ctx) => {
    const allUsers = await ctx.db.query("users").collect();
    const chatIdMap = new Map<string, typeof allUsers>();
    for (const u of allUsers) {
      if (u.telegramChatId) {
        const list = chatIdMap.get(u.telegramChatId) || [];
        list.push(u);
        chatIdMap.set(u.telegramChatId, list);
      }
    }
    const fixed: string[] = [];
    for (const [chatId, users] of chatIdMap) {
      if (users.length <= 1) continue;
      // Keep the oldest user (first registered), clear others
      const sorted = users.sort((a, b) => (a._creationTime || 0) - (b._creationTime || 0));
      for (let i = 1; i < sorted.length; i++) {
        await ctx.db.patch(sorted[i]._id, {
          telegramChatId: undefined,
          updatedAt: Date.now(),
        });
        fixed.push(`Cleared chatId ${chatId} from ${sorted[i].name || sorted[i].email} (kept ${sorted[0].name || sorted[0].email})`);
      }
    }
    return { fixed, count: fixed.length };
  },
});

/** Internal: save phone number from Telegram contact sharing */
export const saveTelegramPhone = internalMutation({
  args: {
    chatId: v.string(),
    phone: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("telegramChatId"), args.chatId))
      .first();
    if (user) {
      await ctx.db.patch(user._id, {
        telegramPhone: args.phone,
        updatedAt: Date.now(),
      });
    }
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
      telegramUserId: user.telegramUserId,
      telegramFirstName: user.telegramFirstName,
      telegramLastName: user.telegramLastName,
      telegramUsername: user.telegramUsername,
      telegramPhone: user.telegramPhone,
    };
  },
});

/** Disconnect Telegram bot — clear chatId from user */
export const disconnectTelegram = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      telegramChatId: undefined,
      telegramUserId: undefined,
      telegramFirstName: undefined,
      telegramLastName: undefined,
      telegramUsername: undefined,
      telegramPhone: undefined,
      updatedAt: Date.now(),
    });
    return { disconnected: true };
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
      console.error(
        `[telegram] User ${args.userId} has no telegramChatId, skipping notification. Rule: ${args.event.ruleName}, Ad: ${args.event.adName}`
      );
      return { sent: false, reason: "no_chat_id" };
    }

    console.log(
      `[telegram] Sending notification to chatId=${chatId} for ad ${args.event.adName}, priority=${args.priority}`
    );

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
      .map((n: Doc<"notifications">) => n.data as RuleNotificationEvent | null)
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
        notificationIds: pending.map((n: Doc<"notifications">) => n._id),
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


/** Get metrics grouped by account for given dates, with campaignId for classification */
export const getMetricsByAccount = internalQuery({
  args: {
    userId: v.id("users"),
    dates: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const result: Array<{
      accountId: string;
      accountName: string;
      campaigns: Array<{ campaignId: string; impressions: number; clicks: number; spent: number; leads: number }>;
      impressions: number;
      clicks: number;
      spent: number;
      leads: number;
    }> = [];

    for (const account of accounts) {
      let totalImpressions = 0;
      let totalClicks = 0;
      let totalSpent = 0;
      let totalLeads = 0;
      const campaignMetrics = new Map<string, { impressions: number; clicks: number; spent: number; leads: number }>();

      for (const date of args.dates) {
        const metrics = await ctx.db
          .query("metricsDaily")
          .withIndex("by_accountId_date", (q) =>
            q.eq("accountId", account._id).eq("date", date)
          )
          .collect();

        for (const m of metrics) {
          // Use vkResult for digest accuracy (fallback to leads for old records)
          const reportLeads = (m as Record<string, unknown>).vkResult as number | undefined ?? m.leads ?? 0;
          totalImpressions += m.impressions || 0;
          totalClicks += m.clicks || 0;
          totalSpent += m.spent || 0;
          totalLeads += reportLeads;

          if (m.campaignId) {
            const existing = campaignMetrics.get(m.campaignId) || { impressions: 0, clicks: 0, spent: 0, leads: 0 };
            existing.impressions += m.impressions || 0;
            existing.clicks += m.clicks || 0;
            existing.spent += m.spent || 0;
            existing.leads += reportLeads;
            campaignMetrics.set(m.campaignId, existing);
          }
        }
      }

      const campaignsArray: Array<{ campaignId: string; impressions: number; clicks: number; spent: number; leads: number }> = [];
      campaignMetrics.forEach((v, k) => campaignsArray.push({ campaignId: k, ...v }));

      result.push({
        accountId: account._id,
        accountName: account.name,
        campaigns: campaignsArray,
        impressions: totalImpressions,
        clicks: totalClicks,
        spent: Math.round(totalSpent * 100) / 100,
        leads: totalLeads,
      });
    }

    return result;
  },
});

/** Get action logs grouped by account + rule for digest period */
export const getActionLogsByAccount = internalQuery({
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

    const filtered = logs.filter((l) => l.createdAt < args.until);

    // Pre-fetch all rules referenced by logs
    const ruleIds = [...new Set(filtered.map((l) => l.ruleId))];
    const ruleMap = new Map<string, string>();
    for (const ruleId of ruleIds) {
      const rule = await ctx.db.get(ruleId);
      if (rule) ruleMap.set(ruleId, rule.name);
    }

    // Group by accountId → ruleName → count
    const byAccount = new Map<string, { events: Map<string, number>; savedAmount: number }>();

    for (const log of filtered) {
      const accId = log.accountId as string;
      if (!byAccount.has(accId)) {
        byAccount.set(accId, { events: new Map(), savedAmount: 0 });
      }
      const acc = byAccount.get(accId)!;

      const ruleName = ruleMap.get(log.ruleId) || log.reason.split("—")[0].trim();
      acc.events.set(ruleName, (acc.events.get(ruleName) || 0) + 1);
      acc.savedAmount += log.savedAmount;
    }

    // Convert to serializable
    const result: Array<{
      accountId: string;
      ruleEvents: Array<{ ruleName: string; count: number }>;
      savedAmount: number;
    }> = [];

    byAccount.forEach((data, accountId) => {
      const ruleEvents: Array<{ ruleName: string; count: number }> = [];
      data.events.forEach((count, ruleName) => {
        ruleEvents.push({ ruleName, count });
      });
      ruleEvents.sort((a, b) => b.count - a.count);
      result.push({ accountId, ruleEvents, savedAmount: data.savedAmount });
    });

    return result;
  },
});

/** Internal: get all users with Telegram connected and digest enabled */
export const getDigestRecipients = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Full-scan intentional: Convex indexes don't support "all non-null" queries.
    // With agency model this may need restructuring (e.g., separate telegramConnections table).
    // Current 88 users is acceptable; revisit if >500 users.
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

/** Collect digest data for a user: metrics + rule events, per account, with lead/subscription split */
export const collectDigestData = internalAction({
  args: {
    userId: v.id("users"),
    dates: v.array(v.string()),
    prevDates: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<DigestData> => {
    // Time range for action logs
    const sinceDate = new Date(args.dates[0] + "T00:00:00Z");
    const untilDate = new Date(args.dates[args.dates.length - 1] + "T23:59:59Z");
    const since = sinceDate.getTime();
    const until = untilDate.getTime() + 1000;

    // Fetch metrics and rule events in parallel
    const [accountMetrics, accountRuleEvents] = await Promise.all([
      ctx.runQuery(internal.telegram.getMetricsByAccount, {
        userId: args.userId,
        dates: args.dates,
      }),
      ctx.runQuery(internal.telegram.getActionLogsByAccount, {
        userId: args.userId,
        since,
        until,
      }),
    ]);

    // Fetch previous period metrics if requested
    let prevAccountMetrics: typeof accountMetrics | null = null;
    if (args.prevDates && args.prevDates.length > 0) {
      prevAccountMetrics = await ctx.runQuery(internal.telegram.getMetricsByAccount, {
        userId: args.userId,
        dates: args.prevDates,
      });
    }

    // For each account, fetch VK API mapping and aggregate by ad_plan (VK campaign)
    const accounts: DigestAccountData[] = [];

    for (const accMetrics of accountMetrics) {
      // adGroupId → { adPlanId, type }
      type GroupMapping = { adPlanId: number; type: CampaignType };
      const groupMap = new Map<string, GroupMapping>();
      // adPlanId → name
      const planNameMap = new Map<number, string>();

      try {
        const accessToken = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId: accMetrics.accountId as Id<"adAccounts"> }
        );

        const [typeMapArray, adPlanNames] = await Promise.all([
          ctx.runAction(internal.vkApi.getCampaignTypeMap, { accessToken }),
          ctx.runAction(internal.vkApi.getAdPlanNames, { accessToken }),
        ]);

        for (const entry of typeMapArray) {
          groupMap.set(entry.adGroupId, {
            adPlanId: entry.adPlanId,
            type: entry.type as CampaignType,
          });
        }
        for (const plan of adPlanNames) {
          planNameMap.set(plan.id, plan.name);
        }
      } catch {
        // Token expired or no access — all campaigns default to "lead"
      }

      // Aggregate metrics by ad_plan (VK campaign), not by ad_group
      const campaignsData = accMetrics.campaigns; // campaignId = ad_group_id
      const byPlan = new Map<number, {
        name: string; type: CampaignType;
        imp: number; cl: number; sp: number; results: number;
      }>();

      let totalImpressions = 0, totalClicks = 0, totalSpent = 0;

      for (const c of campaignsData) {
        totalImpressions += c.impressions;
        totalClicks += c.clicks;
        totalSpent += c.spent;

        const mapping = groupMap.get(c.campaignId);
        const planId = mapping?.adPlanId || 0;
        const type = mapping?.type || "lead";
        const planName = planNameMap.get(planId) || "Неизвестная";

        if (!byPlan.has(planId)) {
          byPlan.set(planId, { name: planName, type, imp: 0, cl: 0, sp: 0, results: 0 });
        }
        const p = byPlan.get(planId)!;
        p.imp += c.impressions;
        p.cl += c.clicks;
        p.sp += c.spent;
        p.results += c.leads; // leads already uses vkResult ?? m.leads in getMetricsByAccount
      }

      // Build campaign list and split results by type
      const digestCampaigns: DigestCampaignData[] = [];
      let leadSpent = 0, leadResults = 0;
      let msgSpent = 0, msgResults = 0;
      let subSpent = 0, subResults = 0;
      let viewResults = 0;

      for (const [planId, d] of byPlan) {
        if (!d.sp && !d.results) continue;
        digestCampaigns.push({
          adPlanId: planId,
          adPlanName: d.name,
          type: d.type,
          impressions: d.imp,
          clicks: d.cl,
          spent: d.sp,
          results: d.results,
          costPerResult: d.results > 0 ? Math.round(d.sp / d.results) : 0,
        });
        if (d.type === "lead") { leadSpent += d.sp; leadResults += d.results; }
        else if (d.type === "message") { msgSpent += d.sp; msgResults += d.results; }
        else if (d.type === "subscription") { subSpent += d.sp; subResults += d.results; }
        else if (d.type === "awareness") { viewResults += d.results; }
      }

      // Sort campaigns by spent descending
      digestCampaigns.sort((a, b) => b.spent - a.spent);

      // If no campaign-level data, use account totals (all as leads)
      if (campaignsData.length === 0) {
        totalImpressions = accMetrics.impressions;
        totalClicks = accMetrics.clicks;
        totalSpent = accMetrics.spent;
        leadResults = accMetrics.leads;
        leadSpent = accMetrics.spent;
      }

      const metrics: DigestMetrics = {
        impressions: totalImpressions,
        clicks: totalClicks,
        spent: Math.round(totalSpent * 100) / 100,
        leads: leadResults,
        messages: msgResults,
        subscriptions: subResults,
        views: viewResults,
        cpl: leadResults > 0 ? Math.round(leadSpent / leadResults) : 0,
        costPerMsg: msgResults > 0 ? Math.round(msgSpent / msgResults) : 0,
        costPerSub: subResults > 0 ? Math.round(subSpent / subResults) : 0,
      };

      // Previous period metrics (aggregate by ad_plan using same mapping)
      let prevMetrics: DigestMetrics | undefined;
      if (prevAccountMetrics) {
        const prevAcc = prevAccountMetrics.find((a: { accountId: string }) => a.accountId === accMetrics.accountId);
        if (prevAcc) {
          const prevByType = { lead: { sp: 0, r: 0 }, message: { sp: 0, r: 0 }, subscription: { sp: 0, r: 0 }, awareness: { sp: 0, r: 0 } };
          let prevImp = 0, prevCl = 0, prevSp = 0;

          for (const c of prevAcc.campaigns) {
            prevImp += c.impressions;
            prevCl += c.clicks;
            prevSp += c.spent;
            const type = groupMap.get(c.campaignId)?.type || "lead";
            prevByType[type].sp += c.spent;
            prevByType[type].r += c.leads;
          }

          if (prevAcc.campaigns.length === 0) {
            prevImp = prevAcc.impressions;
            prevCl = prevAcc.clicks;
            prevSp = prevAcc.spent;
            prevByType.lead.r = prevAcc.leads;
            prevByType.lead.sp = prevAcc.spent;
          }

          prevMetrics = {
            impressions: prevImp,
            clicks: prevCl,
            spent: Math.round(prevSp * 100) / 100,
            leads: prevByType.lead.r,
            messages: prevByType.message.r,
            subscriptions: prevByType.subscription.r,
            views: prevByType.awareness.r,
            cpl: prevByType.lead.r > 0 ? Math.round(prevByType.lead.sp / prevByType.lead.r) : 0,
            costPerMsg: prevByType.message.r > 0 ? Math.round(prevByType.message.sp / prevByType.message.r) : 0,
            costPerSub: prevByType.subscription.r > 0 ? Math.round(prevByType.subscription.sp / prevByType.subscription.r) : 0,
          };
        }
      }

      // Rule events for this account
      const accRules = accountRuleEvents.find((a: { accountId: string }) => a.accountId === accMetrics.accountId);

      accounts.push({
        name: accMetrics.accountName,
        campaigns: digestCampaigns,
        metrics,
        prevMetrics,
        ruleEvents: accRules?.ruleEvents || [],
        savedAmount: accRules?.savedAmount || 0,
      });
    }

    // Calculate totals
    const totals: DigestMetrics = {
      impressions: accounts.reduce((s, a) => s + a.metrics.impressions, 0),
      clicks: accounts.reduce((s, a) => s + a.metrics.clicks, 0),
      spent: Math.round(accounts.reduce((s, a) => s + a.metrics.spent, 0) * 100) / 100,
      leads: accounts.reduce((s, a) => s + a.metrics.leads, 0),
      messages: accounts.reduce((s, a) => s + a.metrics.messages, 0),
      subscriptions: accounts.reduce((s, a) => s + a.metrics.subscriptions, 0),
      views: accounts.reduce((s, a) => s + a.metrics.views, 0),
      cpl: 0,
      costPerMsg: 0,
      costPerSub: 0,
    };
    const totalLeadSpent = accounts.reduce((s, a) => s + (a.metrics.leads > 0 ? a.metrics.cpl * a.metrics.leads : 0), 0);
    totals.cpl = totals.leads > 0 ? Math.round(totalLeadSpent / totals.leads) : 0;
    const totalMsgSpent = accounts.reduce((s, a) => s + (a.metrics.messages > 0 ? a.metrics.costPerMsg * a.metrics.messages : 0), 0);
    totals.costPerMsg = totals.messages > 0 ? Math.round(totalMsgSpent / totals.messages) : 0;
    const totalSubSpent = accounts.reduce((s, a) => s + (a.metrics.subscriptions > 0 ? a.metrics.costPerSub * a.metrics.subscriptions : 0), 0);
    totals.costPerSub = totals.subscriptions > 0 ? Math.round(totalSubSpent / totals.subscriptions) : 0;

    // Previous totals
    let prevTotals: DigestMetrics | undefined;
    if (args.prevDates && args.prevDates.length > 0) {
      const accsWithPrev = accounts.filter((a) => a.prevMetrics);
      if (accsWithPrev.length > 0) {
        prevTotals = {
          impressions: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.impressions || 0), 0),
          clicks: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.clicks || 0), 0),
          spent: Math.round(accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.spent || 0), 0) * 100) / 100,
          leads: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.leads || 0), 0),
          messages: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.messages || 0), 0),
          subscriptions: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.subscriptions || 0), 0),
          views: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.views || 0), 0),
          cpl: 0,
          costPerMsg: 0,
          costPerSub: 0,
        };
        if (prevTotals.leads > 0) {
          const pls = accsWithPrev.reduce((s, a) => s + (a.prevMetrics ? a.prevMetrics.cpl * a.prevMetrics.leads : 0), 0);
          prevTotals.cpl = Math.round(pls / prevTotals.leads);
        }
        if (prevTotals.messages > 0) {
          const pms = accsWithPrev.reduce((s, a) => s + (a.prevMetrics ? a.prevMetrics.costPerMsg * a.prevMetrics.messages : 0), 0);
          prevTotals.costPerMsg = Math.round(pms / prevTotals.messages);
        }
        if (prevTotals.subscriptions > 0) {
          const pss = accsWithPrev.reduce((s, a) => s + (a.prevMetrics ? a.prevMetrics.costPerSub * a.prevMetrics.subscriptions : 0), 0);
          prevTotals.costPerSub = Math.round(pss / prevTotals.subscriptions);
        }
      }
    }

    return { accounts, totals, prevTotals };
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

    // Yesterday's date
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dateISO = yesterday.toISOString().slice(0, 10);
    const dateStr = `${String(yesterday.getDate()).padStart(2, "0")}.${String(yesterday.getMonth() + 1).padStart(2, "0")}.${yesterday.getFullYear()}`;

    let sentCount = 0;

    for (const recipient of recipients) {
      try {
        const data = await ctx.runAction(internal.telegram.collectDigestData, {
          userId: recipient.userId,
          dates: [dateISO],
        });

        if (data.accounts.length === 0) continue;

        const message = formatDigestMessage("daily", data, dateStr);
        const messages = splitTelegramMessage(message);

        for (const msg of messages) {
          await ctx.runAction(internal.telegram.sendMessageWithRetry, {
            chatId: recipient.chatId,
            text: msg,
          });
        }
        sentCount++;
      } catch (err) {
        console.error(
          `[telegram] Failed to send daily digest to ${recipient.userId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return { sent: sentCount };
  },
});

// ═══════════════════════════════════════════════════════════
// Weekly Digest
// ═══════════════════════════════════════════════════════════

/**
 * Send weekly digest to users whose local time is Monday 08:30.
 * Called by cron every 30 minutes — checks each user's timezone.
 */
export const sendWeeklyDigest = internalAction({
  args: {},
  handler: async (ctx) => {
    const recipients = await ctx.runQuery(
      internal.telegram.getDigestRecipients,
      {}
    );

    if (recipients.length === 0) return { sent: 0 };

    const now = Date.now();
    const nowDate = new Date(now);
    const dayMs = 24 * 60 * 60 * 1000;
    let sentCount = 0;

    for (const recipient of recipients) {
      const settings: Doc<"userSettings"> | null = await ctx.runQuery(
        internal.userSettings.getInternal,
        { userId: recipient.userId }
      );
      const tz = settings?.timezone || "Europe/Moscow";

      // Check if Monday 08:30-08:59 in user's timezone
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const timeParts = formatter.formatToParts(nowDate);
      const dayOfWeek = timeParts.find((p) => p.type === "weekday")?.value;
      const hour = parseInt(timeParts.find((p) => p.type === "hour")?.value || "-1", 10);
      const minute = parseInt(timeParts.find((p) => p.type === "minute")?.value || "-1", 10);

      if (dayOfWeek !== "Mon" || hour !== 8 || minute < 30) continue;

      // Current week: 7 days ago through yesterday
      const dates: string[] = [];
      for (let i = 7; i >= 1; i--) {
        dates.push(new Date(now - i * dayMs).toISOString().slice(0, 10));
      }

      // Previous week: 14 days ago through 8 days ago
      const prevDates: string[] = [];
      for (let i = 14; i >= 8; i--) {
        prevDates.push(new Date(now - i * dayMs).toISOString().slice(0, 10));
      }

      // Period strings
      const startDate = new Date(now - 7 * dayMs);
      const endDate = new Date(now - 1 * dayMs);
      const periodStr = `${fmtDD(startDate)}.${fmtMM(startDate)} — ${fmtDD(endDate)}.${fmtMM(endDate)}.${endDate.getFullYear()}`;

      const prevStart = new Date(now - 14 * dayMs);
      const prevEnd = new Date(now - 8 * dayMs);
      const prevPeriodStr = `${fmtDD(prevStart)}.${fmtMM(prevStart)} — ${fmtDD(prevEnd)}.${fmtMM(prevEnd)}`;

      try {
        const data = await ctx.runAction(internal.telegram.collectDigestData, {
          userId: recipient.userId,
          dates,
          prevDates,
        });

        if (data.accounts.length === 0) continue;

        const message = formatDigestMessage("weekly", data, periodStr, prevPeriodStr);
        const messages = splitTelegramMessage(message);

        for (const msg of messages) {
          await ctx.runAction(internal.telegram.sendMessageWithRetry, {
            chatId: recipient.chatId,
            text: msg,
          });
        }
        sentCount++;
      } catch (err) {
        console.error(
          `[telegram] Failed to send weekly digest to ${recipient.userId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return { sent: sentCount };
  },
});

function fmtDD(d: Date): string { return String(d.getDate()).padStart(2, "0"); }
function fmtMM(d: Date): string { return String(d.getMonth() + 1).padStart(2, "0"); }

// ═══════════════════════════════════════════════════════════
// Sprint — Monthly Digest
// ═══════════════════════════════════════════════════════════

const MONTH_NAMES_RU = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

const MONTH_NAMES_GENITIVE_RU = [
  "январём", "февралём", "мартом", "апрелем", "маем", "июнем",
  "июлем", "августом", "сентябрём", "октябрём", "ноябрём", "декабрём",
];

/**
 * Send monthly digest to users whose local time is 1st of the month at 09:00-09:59.
 * Called by cron every hour — checks each user's timezone.
 */
export const sendMonthlyDigest = internalAction({
  args: {},
  handler: async (ctx) => {
    const recipients = await ctx.runQuery(
      internal.telegram.getDigestRecipients,
      {}
    );

    if (recipients.length === 0) return { sent: 0 };

    const now = Date.now();
    const nowDate = new Date(now);
    let sentCount = 0;

    for (const recipient of recipients) {
      const settings: Doc<"userSettings"> | null = await ctx.runQuery(
        internal.userSettings.getInternal,
        { userId: recipient.userId }
      );
      const tz = settings?.timezone || "Europe/Moscow";

      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        day: "numeric",
        month: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const parts = formatter.formatToParts(nowDate);
      const day = parseInt(parts.find((p) => p.type === "day")?.value || "0", 10);
      const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "-1", 10);

      if (day !== 1 || hour !== 9) continue;

      const localMonth = parseInt(parts.find((p) => p.type === "month")?.value || "1", 10);
      const localYear = parseInt(parts.find((p) => p.type === "year")?.value || "2026", 10);

      // Previous month
      const prevMonth = localMonth === 1 ? 12 : localMonth - 1;
      const prevYear = localMonth === 1 ? localYear - 1 : localYear;
      const daysInPrevMonth = new Date(prevYear, prevMonth, 0).getDate();

      // Build date arrays for previous month
      const dates: string[] = [];
      for (let d = 1; d <= daysInPrevMonth; d++) {
        dates.push(`${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      }

      // Month before that (for comparison)
      const prevPrevMonth = prevMonth === 1 ? 12 : prevMonth - 1;
      const prevPrevYear = prevMonth === 1 ? prevYear - 1 : prevYear;
      const daysInPrevPrevMonth = new Date(prevPrevYear, prevPrevMonth, 0).getDate();

      const prevDates: string[] = [];
      for (let d = 1; d <= daysInPrevPrevMonth; d++) {
        prevDates.push(`${prevPrevYear}-${String(prevPrevMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      }

      const monthName = `${MONTH_NAMES_RU[prevMonth - 1]} ${prevYear}`;
      const prevMonthName = `${MONTH_NAMES_GENITIVE_RU[prevPrevMonth - 1]} ${prevPrevYear}`;

      try {
        const data = await ctx.runAction(internal.telegram.collectDigestData, {
          userId: recipient.userId,
          dates,
          prevDates,
        });

        if (data.accounts.length === 0) continue;

        const message = formatDigestMessage("monthly", data, monthName, prevMonthName);
        const messages = splitTelegramMessage(message);

        for (const msg of messages) {
          await ctx.runAction(internal.telegram.sendMessageWithRetry, {
            chatId: recipient.chatId,
            text: msg,
          });
        }
        sentCount++;
      } catch (err) {
        console.error(
          `[telegram] Failed to send monthly digest to ${recipient.userId}:`,
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

// ═══════════════════════════════════════════════════════════
// UZ Budget Management Notifications
// ═══════════════════════════════════════════════════════════

export const sendBudgetNotification = internalAction({
  args: {
    userId: v.id("users"),
    type: v.union(
      v.literal("increase"),
      v.literal("first_increase"),
      v.literal("max_reached"),
      v.literal("reset"),
      v.literal("uncovered_paused")
    ),
    campaignName: v.string(),
    oldBudget: v.optional(v.number()),
    newBudget: v.optional(v.number()),
    step: v.optional(v.number()),
    currentBudget: v.optional(v.number()),
    maxBudget: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const chatId = await ctx.runQuery(internal.telegram.getUserChatId, {
      userId: args.userId,
    });
    if (!chatId) return;

    let message = "";
    switch (args.type) {
      case "increase":
        message = `📊 <b>Бюджет увеличен</b>\nГруппа: ${args.campaignName}\nБюджет: ${args.oldBudget}₽ → ${args.newBudget}₽ (+${args.step}₽)`;
        break;
      case "first_increase":
        message = `📊 <b>Первое увеличение бюджета за день</b>\nГруппа: ${args.campaignName}\nБюджет: ${args.oldBudget}₽ → ${args.newBudget}₽`;
        break;
      case "max_reached":
        message = `⚠️ <b>Достигнут максимальный бюджет</b>\nГруппа: ${args.campaignName}\nТекущий бюджет: ${args.currentBudget}₽ / ${args.maxBudget}₽`;
        break;
      case "reset":
        message = `🔄 <b>Бюджет сброшен</b>\nГруппа: ${args.campaignName}\nБюджет: ${args.newBudget}₽`;
        break;
      case "uncovered_paused":
        message = `⚠️ <b>Группа «${args.campaignName}»</b> приостановлена по дневному бюджету (${args.currentBudget}₽), но не добавлена в правило увеличения бюджета.\n\nДобавьте её в правило, чтобы бюджет увеличивался автоматически.`;
        break;
    }

    await ctx.runAction(internal.telegram.sendMessage, {
      chatId,
      text: message,
    });
  },
});

// ═══════════════════════════════════════════════════════════
// Referral notifications
// ═══════════════════════════════════════════════════════════

export const sendReferralNotification = internalAction({
  args: {
    referrerId: v.id("users"),
    bonusDays: v.number(),
    totalReferrals: v.number(),
    milestone3: v.boolean(),
    milestone10: v.boolean(),
  },
  handler: async (ctx, args) => {
    const chatId = await ctx.runQuery(internal.telegram.getUserChatId, {
      userId: args.referrerId,
    });
    if (!chatId) return;

    // Base message: new referral bonus
    const message = `🎁 <b>Новый реферал!</b>\nПо вашему коду оплатил подписку новый пользователь.\nВам начислено <b>+${args.bonusDays} дней</b> к подписке.\nВсего оплативших рефералов: ${args.totalReferrals}.`;

    await ctx.runAction(internal.telegram.sendMessage, { chatId, text: message });

    // Milestone 3: free month (7×3 + 9 bonus = 30 days total)
    if (args.milestone3) {
      const milestoneMsg = `🎉 <b>3 реферала!</b> Бонус +9 дней — итого 30 дней бесплатного использования!`;
      await ctx.runAction(internal.telegram.sendMessage, { chatId, text: milestoneMsg });
    }

    // Milestone 10: 15% discount
    if (args.milestone10) {
      const milestoneMsg = `🏆 <b>10 рефералов!</b> Теперь вы получаете скидку 15% на все оплаты.`;
      await ctx.runAction(internal.telegram.sendMessage, { chatId, text: milestoneMsg });
    }
  },
});

// ═══════════════════════════════════════════════════════════
// TEMP: Debug — send digest manually (remove after testing)
// ═══════════════════════════════════════════════════════════

export const debugSendDigest = internalAction({
  args: {
    type: v.union(v.literal("weekly"), v.literal("monthly")),
  },
  handler: async (ctx, args): Promise<{ sent: boolean; accounts?: number; messages?: number; reason?: string }> => {
    const userId = "kx7djrrpr67bry6zxehzx0e65x8141ct" as Id<"users">;
    const chatId = "325307765";
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    let dates: string[];
    let prevDates: string[];
    let periodStr: string;
    let prevPeriodStr: string;

    if (args.type === "weekly") {
      // Last 7 days
      dates = [];
      for (let i = 7; i >= 1; i--) {
        dates.push(new Date(now - i * dayMs).toISOString().slice(0, 10));
      }
      prevDates = [];
      for (let i = 14; i >= 8; i--) {
        prevDates.push(new Date(now - i * dayMs).toISOString().slice(0, 10));
      }
      const startDate = new Date(now - 7 * dayMs);
      const endDate = new Date(now - 1 * dayMs);
      periodStr = `${fmtDD(startDate)}.${fmtMM(startDate)} — ${fmtDD(endDate)}.${fmtMM(endDate)}.${endDate.getFullYear()}`;
      const prevStart = new Date(now - 14 * dayMs);
      const prevEnd = new Date(now - 8 * dayMs);
      prevPeriodStr = `${fmtDD(prevStart)}.${fmtMM(prevStart)} — ${fmtDD(prevEnd)}.${fmtMM(prevEnd)}`;
    } else {
      // Previous month (March 2026)
      const nowDate = new Date(now);
      const curMonth = nowDate.getMonth() + 1; // 1-based
      const curYear = nowDate.getFullYear();
      const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
      const prevYear = curMonth === 1 ? curYear - 1 : curYear;
      const daysInPrevMonth = new Date(prevYear, prevMonth, 0).getDate();
      dates = [];
      for (let d = 1; d <= daysInPrevMonth; d++) {
        dates.push(`${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      }
      // Month before that (for comparison)
      const prevPrevMonth = prevMonth === 1 ? 12 : prevMonth - 1;
      const prevPrevYear = prevMonth === 1 ? prevYear - 1 : prevYear;
      const daysInPrevPrevMonth = new Date(prevPrevYear, prevPrevMonth, 0).getDate();
      prevDates = [];
      for (let d = 1; d <= daysInPrevPrevMonth; d++) {
        prevDates.push(`${prevPrevYear}-${String(prevPrevMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      }
      periodStr = `${MONTH_NAMES_RU[prevMonth - 1]} ${prevYear}`;
      prevPeriodStr = `${MONTH_NAMES_GENITIVE_RU[prevPrevMonth - 1]} ${prevPrevYear}`;
    }

    const data = await ctx.runAction(internal.telegram.collectDigestData, {
      userId,
      dates,
      prevDates,
    }) as DigestData;

    if (data.accounts.length === 0) {
      await ctx.runAction(internal.telegram.sendMessageWithRetry, {
        chatId,
        text: `⚠️ Нет данных для ${args.type === "weekly" ? "недельного" : "месячного"} дайджеста за период ${periodStr}`,
      });
      return { sent: false, reason: "no data" };
    }

    const message = formatDigestMessage(args.type, data, periodStr, prevPeriodStr);
    const messages = splitTelegramMessage(message);

    for (const msg of messages) {
      await ctx.runAction(internal.telegram.sendMessageWithRetry, {
        chatId,
        text: msg,
      });
    }

    return { sent: true, accounts: data.accounts.length, messages: messages.length };
  },
});

// ═══════════════════════════════════════════════════════════
// Support chat: forward user messages to admin topic
// ═══════════════════════════════════════════════════════════

/** Forward a message from user's private chat to the support group topic */
export const forwardToSupport = internalAction({
  args: {
    fromChatId: v.string(),
    messageId: v.number(),
  },
  handler: async (_ctx, args) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN not configured");

    const groupChatId = process.env.SUPPORT_GROUP_CHAT_ID;
    const topicId = process.env.SUPPORT_TOPIC_ID;
    if (!groupChatId || !topicId) throw new Error("SUPPORT_GROUP_CHAT_ID or SUPPORT_TOPIC_ID not configured");

    const response = await fetch(
      `${TELEGRAM_API_BASE}${botToken}/forwardMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: groupChatId,
          from_chat_id: args.fromChatId,
          message_id: args.messageId,
          message_thread_id: parseInt(topicId, 10),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram forwardMessage failed ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    return result.result?.message_id as number | undefined;
  },
});

/** Save mapping: forwarded message ID → original user chat */
export const saveSupportMapping = internalMutation({
  args: {
    forwardedMessageId: v.number(),
    originalChatId: v.string(),
    originalMessageId: v.optional(v.number()),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("supportMessages", {
      forwardedMessageId: args.forwardedMessageId,
      originalChatId: args.originalChatId,
      originalMessageId: args.originalMessageId,
      userName: args.userName,
      createdAt: Date.now(),
    });
  },
});

/** Find original user chat by forwarded message ID */
export const getSupportMapping = internalQuery({
  args: { forwardedMessageId: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("supportMessages")
      .withIndex("by_forwardedMessageId", (q) =>
        q.eq("forwardedMessageId", args.forwardedMessageId)
      )
      .first();
  },
});

/** Stub: notify owner that a manager accepted their invite. Plan 6 impl. */
// ═══════════════════════════════════════════════════════════
// Load monitoring & grace notifications (Plan 4 stubs — Plan 6 impl)
// ═══════════════════════════════════════════════════════════

export const sendOverageStartNotification = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (_ctx, args) => {
    console.log(`[telegram] TODO: send overage start notification for ${args.orgId}`);
  },
});

export const sendOverageRecoveryNotification = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (_ctx, args) => {
    console.log(`[telegram] TODO: send overage recovery for ${args.orgId}`);
  },
});

export const sendFeaturesDisabledNotification = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (_ctx, args) => {
    console.log(`[telegram] TODO: features-disabled notification for ${args.orgId}`);
  },
});

export const sendExpiredWarningNotification = internalAction({
  args: {
    orgId: v.id("organizations"),
    phase: v.union(
      v.literal("warnings"),
      v.literal("read_only"),
      v.literal("deep_read_only"),
      v.literal("frozen")
    ),
  },
  handler: async (_ctx, args) => {
    console.log(`[telegram] TODO: expired ${args.phase} notification for ${args.orgId}`);
  },
});

export const sendOwnerInviteAcceptedNotification = internalAction({
  args: {
    ownerId: v.id("users"),
    managerEmail: v.string(),
    transferredCount: v.number(),
    inviteId: v.id("orgInvites"),
  },
  handler: async (_ctx, args) => {
    console.log(`[telegram] TODO: notify owner ${args.ownerId} — ${args.managerEmail} accepted invite, ${args.transferredCount} cabinets offered`);
  },
});
