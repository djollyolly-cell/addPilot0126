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

/** Action log summary for daily digest (legacy — kept for getDigestActionLogs) */
export interface DigestActionLogSummary {
  adName: string;
  adId: string;
  accountId: string;
  actionType: string;
  reason: string;
  savedAmount: number;
  ruleName: string;
  metricsSnapshot: {
    spent: number;
    leads: number;
    cpl?: number;
    ctr?: number;
  };
}

// ─── Digest interfaces (v2 — per-account, leads/subscriptions split) ──────

export interface DigestMetrics {
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  subscriptions: number;
  cpl: number;
  costPerSub: number;
}

export interface DigestAccountData {
  name: string;
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
  const lower = packageName.toLowerCase();
  return ["подписк", "subscribe", "community", "join"].some(kw => lower.includes(kw));
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

    if (m.leads > 0) {
      lines.push(`🎯 Лиды: ${m.leads} | CPL: ${m.cpl}₽${showDelta && p!.cpl > 0 ? formatDelta(m.cpl, p!.cpl) : ""}`);
    }
    if (m.subscriptions > 0) {
      lines.push(`👥 Подписки: ${m.subscriptions} | Стоимость: ${m.costPerSub}₽${showDelta && p!.costPerSub > 0 ? formatDelta(m.costPerSub, p!.costPerSub) : ""}`);
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
  if (t.subscriptions > 0) totalsLine += `, подписки ${t.subscriptions}`;

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
 * Format daily digest message (LEGACY — will be removed in cleanup).
 * Always sends — even without rule events, shows metrics summary.
 */
export function formatDailyDigest(
  events: DigestActionLogSummary[],
  dateStr: string, // "DD.MM.YYYY"
  metrics?: DigestMetrics
): string {
  const lines: string[] = [
    `📊 <b>Дайджест за ${dateStr}</b>`,
    "",
  ];

  // Metrics summary (always shown)
  if (metrics) {
    lines.push("<b>Статистика за сутки:</b>");
    lines.push(`📈 Показы: ${metrics.impressions.toLocaleString("ru-RU")}`);
    lines.push(`👆 Клики: ${metrics.clicks.toLocaleString("ru-RU")}`);
    lines.push(`💰 Расход: ${metrics.spent.toFixed(0)}₽`);
    lines.push(`🎯 Лиды: ${metrics.leads}`);
    lines.push(`💵 CPL: ${metrics.cpl > 0 ? metrics.cpl.toFixed(0) + "₽" : "—"}`);
    lines.push("");
  }

  // Rule events (if any)
  if (events.length > 0) {
    const totalSaved = events.reduce((sum, e) => sum + e.savedAmount, 0);
    const stoppedCount = events.filter(
      (e) => e.actionType === "stopped" || e.actionType === "stopped_and_notified"
    ).length;
    const notifyCount = events.filter((e) => e.actionType === "notified").length;

    lines.push(`<b>Правила:</b>`);
    lines.push(`Сработало: ${events.length}`);

    if (stoppedCount > 0) {
      lines.push(`🛑 Остановлено: ${stoppedCount}`);
    }
    if (notifyCount > 0) {
      lines.push(`⚠️ Предупреждений: ${notifyCount}`);
    }
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
  } else {
    lines.push("✅ Правила не сработали за сутки");
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

/** Internal: get daily metrics summary for a user's accounts (spent, leads, CPL) */
export const getDigestMetricsSummary = internalQuery({
  args: {
    userId: v.id("users"),
    date: v.string(), // "YYYY-MM-DD"
  },
  handler: async (ctx, args) => {
    // Get user's accounts
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    let totalSpent = 0;
    let totalLeads = 0;
    let totalClicks = 0;
    let totalImpressions = 0;

    // Sum metrics per account for this date
    for (const account of accounts) {
      const metrics = await ctx.db
        .query("metricsDaily")
        .withIndex("by_accountId_date", (q) =>
          q.eq("accountId", account._id).eq("date", args.date)
        )
        .collect();
      for (const m of metrics) {
        totalSpent += m.spent || 0;
        totalLeads += m.leads || 0;
        totalClicks += m.clicks || 0;
        totalImpressions += m.impressions || 0;
      }
    }

    return {
      spent: Math.round(totalSpent * 100) / 100,
      leads: totalLeads,
      clicks: totalClicks,
      impressions: totalImpressions,
      cpl: totalLeads > 0 ? Math.round((totalSpent / totalLeads) * 100) / 100 : 0,
    };
  },
});

/** Internal: get end-of-day metrics for a specific ad */
export const getAdDailyMetrics = internalQuery({
  args: {
    adId: v.string(),
    date: v.string(), // "YYYY-MM-DD"
  },
  handler: async (ctx, args) => {
    const metric = await ctx.db
      .query("metricsDaily")
      .withIndex("by_adId_date", (q) =>
        q.eq("adId", args.adId).eq("date", args.date)
      )
      .first();
    if (!metric) return null;
    return {
      spent: metric.spent || 0,
      leads: metric.leads || 0,
      clicks: metric.clicks || 0,
      impressions: metric.impressions || 0,
    };
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
          totalImpressions += m.impressions || 0;
          totalClicks += m.clicks || 0;
          totalSpent += m.spent || 0;
          totalLeads += m.leads || 0;

          if (m.campaignId) {
            const existing = campaignMetrics.get(m.campaignId) || { impressions: 0, clicks: 0, spent: 0, leads: 0 };
            existing.impressions += m.impressions || 0;
            existing.clicks += m.clicks || 0;
            existing.spent += m.spent || 0;
            existing.leads += m.leads || 0;
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

    // For each account, fetch package mapping from VK API to classify leads vs subscriptions
    const accounts: DigestAccountData[] = [];

    for (const accMetrics of accountMetrics) {
      // Try to get VK API token for package classification
      let campaignTypeMap = new Map<string, "lead" | "subscription">();

      try {
        const accessToken = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId: accMetrics.accountId as Id<"adAccounts"> }
        );

        // Fetch campaign type map via VK API
        const typeMapArray = await ctx.runAction(
          internal.vkApi.getCampaignTypeMap,
          { accessToken }
        );

        for (const entry of typeMapArray) {
          campaignTypeMap.set(entry.campaignId, entry.type as "lead" | "subscription");
        }
      } catch {
        // Token expired or no access — all campaigns default to "lead"
      }

      // Split metrics by campaign type
      const campaignsData = accMetrics.campaigns;

      let leadSpent = 0, leadLeads = 0;
      let subSpent = 0, subLeads = 0;
      let totalImpressions = 0, totalClicks = 0, totalSpent = 0;

      for (const c of campaignsData) {
        totalImpressions += c.impressions;
        totalClicks += c.clicks;
        totalSpent += c.spent;

        const type = campaignTypeMap.get(c.campaignId) || "lead";
        if (type === "subscription") {
          subSpent += c.spent;
          subLeads += c.leads;
        } else {
          leadSpent += c.spent;
          leadLeads += c.leads;
        }
      }

      // If no campaign-level data, use account totals (all as leads)
      if (campaignsData.length === 0) {
        totalImpressions = accMetrics.impressions;
        totalClicks = accMetrics.clicks;
        totalSpent = accMetrics.spent;
        leadLeads = accMetrics.leads;
        leadSpent = accMetrics.spent;
      }

      const metrics: DigestMetrics = {
        impressions: totalImpressions,
        clicks: totalClicks,
        spent: Math.round(totalSpent * 100) / 100,
        leads: leadLeads,
        subscriptions: subLeads,
        cpl: leadLeads > 0 ? Math.round(leadSpent / leadLeads) : 0,
        costPerSub: subLeads > 0 ? Math.round(subSpent / subLeads) : 0,
      };

      // Previous period metrics
      let prevMetrics: DigestMetrics | undefined;
      if (prevAccountMetrics) {
        const prevAcc = prevAccountMetrics.find((a) => a.accountId === accMetrics.accountId);
        if (prevAcc) {
          const prevCampaigns = prevAcc.campaigns;
          let prevLeadSpent = 0, prevLeadLeads = 0;
          let prevSubSpent = 0, prevSubLeads = 0;
          let prevTotalImpressions = 0, prevTotalClicks = 0, prevTotalSpent = 0;

          for (const c of prevCampaigns) {
            prevTotalImpressions += c.impressions;
            prevTotalClicks += c.clicks;
            prevTotalSpent += c.spent;
            const type = campaignTypeMap.get(c.campaignId) || "lead";
            if (type === "subscription") {
              prevSubSpent += c.spent;
              prevSubLeads += c.leads;
            } else {
              prevLeadSpent += c.spent;
              prevLeadLeads += c.leads;
            }
          }

          if (prevCampaigns.length === 0) {
            prevTotalImpressions = prevAcc.impressions;
            prevTotalClicks = prevAcc.clicks;
            prevTotalSpent = prevAcc.spent;
            prevLeadLeads = prevAcc.leads;
            prevLeadSpent = prevAcc.spent;
          }

          prevMetrics = {
            impressions: prevTotalImpressions,
            clicks: prevTotalClicks,
            spent: Math.round(prevTotalSpent * 100) / 100,
            leads: prevLeadLeads,
            subscriptions: prevSubLeads,
            cpl: prevLeadLeads > 0 ? Math.round(prevLeadSpent / prevLeadLeads) : 0,
            costPerSub: prevSubLeads > 0 ? Math.round(prevSubSpent / prevSubLeads) : 0,
          };
        }
      }

      // Rule events for this account
      const accRules = accountRuleEvents.find((a) => a.accountId === accMetrics.accountId);

      accounts.push({
        name: accMetrics.accountName,
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
      subscriptions: accounts.reduce((s, a) => s + a.metrics.subscriptions, 0),
      cpl: 0,
      costPerSub: 0,
    };
    const totalLeadSpent = accounts.reduce((s, a) => s + (a.metrics.leads > 0 ? a.metrics.cpl * a.metrics.leads : 0), 0);
    totals.cpl = totals.leads > 0 ? Math.round(totalLeadSpent / totals.leads) : 0;
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
          subscriptions: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.subscriptions || 0), 0),
          cpl: 0,
          costPerSub: 0,
        };
        if (prevTotals.leads > 0) {
          const prevLeadSpent = accsWithPrev.reduce((s, a) => s + (a.prevMetrics ? a.prevMetrics.cpl * a.prevMetrics.leads : 0), 0);
          prevTotals.cpl = Math.round(prevLeadSpent / prevTotals.leads);
        }
        if (prevTotals.subscriptions > 0) {
          const prevSubSpent = accsWithPrev.reduce((s, a) => s + (a.prevMetrics ? a.prevMetrics.costPerSub * a.prevMetrics.subscriptions : 0), 0);
          prevTotals.costPerSub = Math.round(prevSubSpent / prevTotals.subscriptions);
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

    // Yesterday's date for metrics
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const since = now - dayMs;
    const until = now;

    // Yesterday's date strings
    const yesterday = new Date(since);
    const dateStr = `${String(yesterday.getDate()).padStart(2, "0")}.${String(yesterday.getMonth() + 1).padStart(2, "0")}.${yesterday.getFullYear()}`;
    const dateISO = yesterday.toISOString().slice(0, 10); // "YYYY-MM-DD"

    let sentCount = 0;

    for (const recipient of recipients) {
      // Fetch metrics for this user's accounts
      const metricsSummary = await ctx.runQuery(
        internal.telegram.getDigestMetricsSummary,
        { userId: recipient.userId, date: dateISO }
      );

      const logs = await ctx.runQuery(
        internal.telegram.getDigestActionLogs,
        { userId: recipient.userId, since, until }
      );

      const events: DigestActionLogSummary[] = logs.map((log: Doc<"actionLogs">) => ({
        adName: log.adName,
        adId: log.adId,
        accountId: log.accountId,
        actionType: log.actionType,
        reason: log.reason,
        savedAmount: log.savedAmount,
        metricsSnapshot: log.metricsSnapshot,
      }));

      // Update events with end-of-day metrics from metricsDaily
      for (const event of events) {
        const freshMetrics = await ctx.runQuery(
          internal.telegram.getAdDailyMetrics,
          { adId: event.adId, date: dateISO }
        );
        if (freshMetrics) {
          event.metricsSnapshot = {
            spent: freshMetrics.spent,
            leads: freshMetrics.leads,
            cpl: freshMetrics.leads > 0
              ? Math.round((freshMetrics.spent / freshMetrics.leads) * 100) / 100
              : undefined,
            ctr: freshMetrics.impressions > 0
              ? Math.round((freshMetrics.clicks / freshMetrics.impressions) * 10000) / 100
              : undefined,
          };
          // Update reason with end-of-day spend for new_lead events
          if (event.reason.includes("Новый лид!")) {
            event.reason = `Новый лид! Всего лидов: ${freshMetrics.leads}, расход: ${freshMetrics.spent.toFixed(2)}₽`;
          }
        }
      }

      const message = formatDailyDigest(events, dateStr, metricsSummary);

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
// Sprint — Weekly Digest
// ═══════════════════════════════════════════════════════════

/**
 * Format weekly digest message.
 * Shows aggregated metrics for 7 days + all rule events.
 */
export function formatWeeklyDigest(
  events: DigestActionLogSummary[],
  periodStr: string, // "08.03 — 14.03.2026"
  metrics?: DigestMetrics
): string {
  const lines: string[] = [
    `📊 <b>Дайджест за неделю</b>`,
    `${periodStr}`,
    "",
  ];

  // Metrics summary
  if (metrics) {
    lines.push("<b>Статистика за неделю:</b>");
    lines.push(`📈 Показы: ${metrics.impressions.toLocaleString("ru-RU")}`);
    lines.push(`👆 Клики: ${metrics.clicks.toLocaleString("ru-RU")}`);
    lines.push(`💰 Расход: ${metrics.spent.toFixed(0)}₽`);
    lines.push(`🎯 Лиды: ${metrics.leads}`);
    lines.push(`💵 CPL: ${metrics.cpl > 0 ? metrics.cpl.toFixed(0) + "₽" : "—"}`);
    lines.push("");
  }

  // Rule events
  if (events.length > 0) {
    const totalSaved = events.reduce((sum, e) => sum + e.savedAmount, 0);
    const stoppedCount = events.filter(
      (e) => e.actionType === "stopped" || e.actionType === "stopped_and_notified"
    ).length;
    const notifyCount = events.filter((e) => e.actionType === "notified").length;

    lines.push(`<b>Правила:</b>`);
    lines.push(`Сработало: ${events.length}`);

    if (stoppedCount > 0) {
      lines.push(`🛑 Остановлено: ${stoppedCount}`);
    }
    if (notifyCount > 0) {
      lines.push(`⚠️ Предупреждений: ${notifyCount}`);
    }
    if (totalSaved > 0) {
      lines.push(`✅ Сэкономлено: ~${totalSaved.toFixed(0)}₽`);
    }

    lines.push("");
    lines.push("<b>Детали:</b>");

    for (const event of events.slice(0, 20)) {
      const emoji =
        event.actionType === "stopped" || event.actionType === "stopped_and_notified"
          ? "🛑"
          : "⚠️";
      lines.push(`${emoji} ${event.adName} — ${event.reason}`);
    }

    if (events.length > 20) {
      lines.push(`...и ещё ${events.length - 20}`);
    }
  } else {
    lines.push("✅ Правила не сработали за неделю");
  }

  return lines.join("\n");
}

/** Internal: get aggregated metrics for a user's accounts over multiple dates */
export const getWeeklyMetricsSummary = internalQuery({
  args: {
    userId: v.id("users"),
    dates: v.array(v.string()), // ["YYYY-MM-DD", ...]
  },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    let totalSpent = 0;
    let totalLeads = 0;
    let totalClicks = 0;
    let totalImpressions = 0;

    for (const account of accounts) {
      for (const date of args.dates) {
        const metrics = await ctx.db
          .query("metricsDaily")
          .withIndex("by_accountId_date", (q) =>
            q.eq("accountId", account._id).eq("date", date)
          )
          .collect();
        for (const m of metrics) {
          totalSpent += m.spent || 0;
          totalLeads += m.leads || 0;
          totalClicks += m.clicks || 0;
          totalImpressions += m.impressions || 0;
        }
      }
    }

    return {
      spent: Math.round(totalSpent * 100) / 100,
      leads: totalLeads,
      clicks: totalClicks,
      impressions: totalImpressions,
      cpl: totalLeads > 0 ? Math.round((totalSpent / totalLeads) * 100) / 100 : 0,
    };
  },
});

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
    let sentCount = 0;

    for (const recipient of recipients) {
      // Get user's timezone
      const settings: Doc<"userSettings"> | null = await ctx.runQuery(
        internal.userSettings.getInternal,
        { userId: recipient.userId }
      );
      const tz = settings?.timezone || "Europe/Moscow";

      // Check if it's Monday 08:30-08:59 in user's timezone
      // Use formatToParts for reliable parsing across runtimes
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const timeParts = formatter.formatToParts(nowDate);
      const dayOfWeek = timeParts.find((p) => p.type === "weekday")?.value;
      const hour = parseInt(
        timeParts.find((p) => p.type === "hour")?.value || "-1",
        10
      );
      const minute = parseInt(
        timeParts.find((p) => p.type === "minute")?.value || "-1",
        10
      );

      // Only send on Monday at 08:30-08:59 (cron runs every 30 min)
      if (dayOfWeek !== "Mon" || hour !== 8 || minute < 30) continue;

      // Build 7-day date range (Mon-Sun of previous week)
      // Find last Monday in user's timezone
      const dates: string[] = [];
      for (let i = 7; i >= 1; i--) {
        const d = new Date(now - i * 24 * 60 * 60 * 1000);
        dates.push(d.toISOString().slice(0, 10));
      }

      const since = now - 7 * 24 * 60 * 60 * 1000;
      const until = now;

      // Period string for header: "08.03 — 14.03.2026"
      const startDate = new Date(since);
      const endDate = new Date(until - 24 * 60 * 60 * 1000); // yesterday
      const periodStr = `${String(startDate.getDate()).padStart(2, "0")}.${String(startDate.getMonth() + 1).padStart(2, "0")} — ${String(endDate.getDate()).padStart(2, "0")}.${String(endDate.getMonth() + 1).padStart(2, "0")}.${endDate.getFullYear()}`;

      // Fetch weekly metrics
      const metricsSummary = await ctx.runQuery(
        internal.telegram.getWeeklyMetricsSummary,
        { userId: recipient.userId, dates }
      );

      // Fetch action logs for the week
      const logs = await ctx.runQuery(
        internal.telegram.getDigestActionLogs,
        { userId: recipient.userId, since, until }
      );

      const events: DigestActionLogSummary[] = logs.map((log: Doc<"actionLogs">) => ({
        adName: log.adName,
        adId: log.adId,
        accountId: log.accountId,
        actionType: log.actionType,
        reason: log.reason,
        savedAmount: log.savedAmount,
        metricsSnapshot: log.metricsSnapshot,
      }));

      // Update events with end-of-day metrics (same fix as daily digest)
      for (const event of events) {
        // Find the date of the event from actionLog createdAt
        const logEntry = logs.find((l: Doc<"actionLogs">) => l.adId === event.adId && l.reason === event.reason);
        const eventDate = logEntry
          ? new Date(logEntry.createdAt).toISOString().slice(0, 10)
          : dates[dates.length - 1];

        const freshMetrics = await ctx.runQuery(
          internal.telegram.getAdDailyMetrics,
          { adId: event.adId, date: eventDate }
        );
        if (freshMetrics) {
          event.metricsSnapshot = {
            spent: freshMetrics.spent,
            leads: freshMetrics.leads,
            cpl: freshMetrics.leads > 0
              ? Math.round((freshMetrics.spent / freshMetrics.leads) * 100) / 100
              : undefined,
            ctr: freshMetrics.impressions > 0
              ? Math.round((freshMetrics.clicks / freshMetrics.impressions) * 10000) / 100
              : undefined,
          };
          if (event.reason.includes("Новый лид!")) {
            event.reason = `Новый лид! Всего лидов: ${freshMetrics.leads}, расход: ${freshMetrics.spent.toFixed(2)}₽`;
          }
        }
      }

      const message = formatWeeklyDigest(events, periodStr, metricsSummary);

      try {
        await ctx.runAction(internal.telegram.sendMessageWithRetry, {
          chatId: recipient.chatId,
          text: message,
        });
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

// ═══════════════════════════════════════════════════════════
// Sprint — Monthly Digest
// ═══════════════════════════════════════════════════════════

const MONTH_NAMES_RU = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/**
 * Format monthly digest message.
 * Shows aggregated metrics for the previous month + all rule events.
 */
export function formatMonthlyDigest(
  events: DigestActionLogSummary[],
  monthName: string, // "март 2026"
  metrics?: DigestMetrics
): string {
  const lines: string[] = [
    `📅 <b>Отчёт за месяц</b>`,
    `${monthName}`,
    "",
  ];

  // Metrics summary
  if (metrics) {
    lines.push("<b>Статистика за месяц:</b>");
    lines.push(`📈 Показы: ${metrics.impressions.toLocaleString("ru-RU")}`);
    lines.push(`👆 Клики: ${metrics.clicks.toLocaleString("ru-RU")}`);
    lines.push(`💰 Расход: ${metrics.spent.toFixed(0)}₽`);
    lines.push(`🎯 Лиды: ${metrics.leads}`);
    lines.push(`💵 CPL: ${metrics.cpl > 0 ? metrics.cpl.toFixed(0) + "₽" : "—"}`);
    lines.push("");
  }

  // Rule events
  if (events.length > 0) {
    const totalSaved = events.reduce((sum, e) => sum + e.savedAmount, 0);
    const stoppedCount = events.filter(
      (e) => e.actionType === "stopped" || e.actionType === "stopped_and_notified"
    ).length;
    const notifyCount = events.filter((e) => e.actionType === "notified").length;

    lines.push(`<b>Правила:</b>`);
    lines.push(`Сработало: ${events.length}`);

    if (stoppedCount > 0) {
      lines.push(`🛑 Остановлено: ${stoppedCount}`);
    }
    if (notifyCount > 0) {
      lines.push(`⚠️ Предупреждений: ${notifyCount}`);
    }
    if (totalSaved > 0) {
      lines.push(`✅ Сэкономлено: ~${totalSaved.toFixed(0)}₽`);
    }

    lines.push("");
    lines.push("<b>Топ событий:</b>");

    for (const event of events.slice(0, 30)) {
      const emoji =
        event.actionType === "stopped" || event.actionType === "stopped_and_notified"
          ? "🛑"
          : "⚠️";
      lines.push(`${emoji} ${event.adName} — ${event.reason}`);
    }

    if (events.length > 30) {
      lines.push(`...и ещё ${events.length - 30}`);
    }
  } else {
    lines.push("✅ Правила не сработали за месяц");
  }

  return lines.join("\n");
}

/** Internal: get aggregated metrics for a user's accounts over multiple dates (reusable) */
export const getMonthlyMetricsSummary = internalQuery({
  args: {
    userId: v.id("users"),
    dates: v.array(v.string()), // ["YYYY-MM-DD", ...]
  },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    let totalSpent = 0;
    let totalLeads = 0;
    let totalClicks = 0;
    let totalImpressions = 0;

    for (const account of accounts) {
      for (const date of args.dates) {
        const metrics = await ctx.db
          .query("metricsDaily")
          .withIndex("by_accountId_date", (q) =>
            q.eq("accountId", account._id).eq("date", date)
          )
          .collect();
        for (const m of metrics) {
          totalSpent += m.spent || 0;
          totalLeads += m.leads || 0;
          totalClicks += m.clicks || 0;
          totalImpressions += m.impressions || 0;
        }
      }
    }

    return {
      spent: Math.round(totalSpent * 100) / 100,
      leads: totalLeads,
      clicks: totalClicks,
      impressions: totalImpressions,
      cpl: totalLeads > 0 ? Math.round((totalSpent / totalLeads) * 100) / 100 : 0,
    };
  },
});

/**
 * Send monthly digest to users whose local time is 1st of the month at 09:00-09:29.
 * Called by cron every 30 minutes — checks each user's timezone.
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
      // Get user's timezone
      const settings: Doc<"userSettings"> | null = await ctx.runQuery(
        internal.userSettings.getInternal,
        { userId: recipient.userId }
      );
      const tz = settings?.timezone || "Europe/Moscow";

      // Use formatToParts for reliable parsing across runtimes
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        day: "numeric",
        month: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const parts = formatter.formatToParts(nowDate);
      const day = parseInt(
        parts.find((p) => p.type === "day")?.value || "0",
        10
      );
      const hour = parseInt(
        parts.find((p) => p.type === "hour")?.value || "-1",
        10
      );

      // Only send on the 1st of the month at 09:00-09:59 (cron runs every hour)
      if (day !== 1 || hour !== 9) continue;

      // Compute previous month's date range
      const localMonth = parseInt(
        parts.find((p) => p.type === "month")?.value || "1",
        10
      );
      const localYear = parseInt(
        parts.find((p) => p.type === "year")?.value || "2026",
        10
      );

      // Previous month
      const prevMonth = localMonth === 1 ? 12 : localMonth - 1;
      const prevYear = localMonth === 1 ? localYear - 1 : localYear;

      // Days in previous month
      const daysInPrevMonth = new Date(prevYear, prevMonth, 0).getDate();

      // Build date strings for every day of previous month
      const dates: string[] = [];
      for (let d = 1; d <= daysInPrevMonth; d++) {
        const dateStr = `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        dates.push(dateStr);
      }

      const monthName = `${MONTH_NAMES_RU[prevMonth - 1]} ${prevYear}`;

      // Time range for action logs
      const sinceDate = new Date(Date.UTC(prevYear, prevMonth - 1, 1, 0, 0, 0));
      const untilDate = new Date(Date.UTC(localYear, localMonth - 1, 1, 0, 0, 0));
      const since = sinceDate.getTime();
      const until = untilDate.getTime();

      // Fetch monthly metrics
      const metricsSummary = await ctx.runQuery(
        internal.telegram.getMonthlyMetricsSummary,
        { userId: recipient.userId, dates }
      );

      // Fetch action logs for the month
      const logs = await ctx.runQuery(
        internal.telegram.getDigestActionLogs,
        { userId: recipient.userId, since, until }
      );

      const events: DigestActionLogSummary[] = logs.map((log: Doc<"actionLogs">) => ({
        adName: log.adName,
        adId: log.adId,
        accountId: log.accountId,
        actionType: log.actionType,
        reason: log.reason,
        savedAmount: log.savedAmount,
        metricsSnapshot: log.metricsSnapshot,
      }));

      const message = formatMonthlyDigest(events, monthName, metricsSummary);

      try {
        await ctx.runAction(internal.telegram.sendMessageWithRetry, {
          chatId: recipient.chatId,
          text: message,
        });
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
      v.literal("reset")
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
    }

    await ctx.runAction(internal.telegram.sendMessage, {
      chatId,
      text: message,
    });
  },
});
