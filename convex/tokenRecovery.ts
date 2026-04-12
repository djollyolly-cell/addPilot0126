/**
 * Resilient Token Recovery — страховочная сетка поверх существующего каскада.
 *
 * Не модифицирует существующую логику auth.ts. Добавляет:
 * - quickTokenCheck: лёгкая проверка жизнеспособности токена
 * - tryRecoverToken: попытка восстановления через полный каскад + user-level fallback
 * - retryRecovery: повторные попытки для error-аккаунтов (7 дней)
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Lightweight token liveness check.
 * GET /api/v2/user.json — if 200, token is alive.
 * On network error/timeout → returns true (fail-safe: don't break working tokens).
 */
export async function quickTokenCheck(accessToken: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch("https://target.my.com/api/v2/user.json", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (resp.status === 200) return true;
    if (resp.status === 401 || resp.status === 403) return false;
    // Other status codes (429, 500, etc.) — assume alive, don't break
    return true;
  } catch {
    // Network error, timeout, abort — fail-safe: assume alive
    return true;
  }
}

// ─── Mutations for recovery state ───────────────────────────

export const markRecoverySuccess = internalMutation({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;
    await ctx.db.patch(args.accountId, {
      status: "active",
      lastError: undefined,
      tokenErrorSince: undefined,
      tokenRecoveryAttempts: undefined,
    });
    console.log(`[tokenRecovery] «${account.name}» (${args.accountId}): recovered successfully`);
  },
});

export const patchAccountToken = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    accessToken: v.string(),
    tokenExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (account) {
      const oldVal = account.accessToken as string | undefined;
      const newVal = args.accessToken;
      if (oldVal !== newVal) {
        const mask = (val: string | undefined) =>
          val && val.length > 8 ? val.slice(0, 4) + "..." + val.slice(-4) : val;
        await ctx.db.insert("credentialHistory", {
          accountId: args.accountId,
          field: "accessToken",
          oldValue: mask(oldVal),
          newValue: mask(newVal),
          changedAt: Date.now(),
          changedBy: "patchAccountToken",
        });
      }
    }
    await ctx.db.patch(args.accountId, {
      accessToken: args.accessToken,
      tokenExpiresAt: args.tokenExpiresAt,
      status: "active",
      lastError: undefined,
    });
  },
});

export const markRecoveryFailure = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;

    const attempts = (account.tokenRecoveryAttempts ?? 0) + 1;
    const tokenErrorSince = account.tokenErrorSince ?? Date.now();

    await ctx.db.patch(args.accountId, {
      status: "error",
      lastError: args.errorMessage,
      tokenErrorSince,
      tokenRecoveryAttempts: attempts,
    });
    console.log(
      `[tokenRecovery] «${account.name}» (${args.accountId}): recovery failed, attempt ${attempts}`
    );
  },
});

export const markRecoveryExpired = internalMutation({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;
    await ctx.db.patch(args.accountId, {
      tokenErrorSince: undefined,
      tokenRecoveryAttempts: undefined,
      lastError: "Автовосстановление не удалось за 7 дней. Переподключите кабинет.",
    });
    console.log(
      `[tokenRecovery] «${account.name}» (${args.accountId}): recovery window expired (7 days)`
    );
  },
});

// ─── Main recovery action ───────────────────────────────────

export const tryRecoverToken = internalAction({
  args: { accountId: v.id("adAccounts") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    // 1. Load account
    const account = await ctx.runQuery(api.adAccounts.get, {
      accountId: args.accountId,
    });
    if (!account) {
      console.log(`[tokenRecovery] Account ${args.accountId} not found`);
      return false;
    }

    // 2. Try full existing cascade via getValidTokenForAccount
    try {
      const token = await ctx.runAction(internal.auth.getValidTokenForAccount, {
        accountId: args.accountId,
      });
      if (token) {
        await ctx.runMutation(internal.tokenRecovery.markRecoverySuccess, {
          accountId: args.accountId,
        });
        try { await ctx.runMutation(internal.systemLogger.log, {
          accountId: args.accountId,
          level: "info",
          source: "tokenRecovery",
          message: `Token recovered via cascade for «${account.name}»`,
        }); } catch { /* non-critical */ }
        return true;
      }
    } catch (cascadeErr) {
      const cascadeMsg = cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr);
      console.log(
        `[tokenRecovery] «${account.name}» (${args.accountId}): cascade failed: ${cascadeMsg}`
      );
    }

    // 3. Try user-level VK Ads token as fallback
    try {
      const user = await ctx.runQuery(internal.users.getVkAdsTokens, {
        userId: account.userId as Id<"users">,
      });
      if (user?.accessToken) {
        const alive = await quickTokenCheck(user.accessToken);
        if (alive) {
          // Write user's token to account via simple patch
          await ctx.runMutation(internal.tokenRecovery.patchAccountToken, {
            accountId: args.accountId,
            accessToken: user.accessToken,
            tokenExpiresAt: user.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
          });
          await ctx.runMutation(internal.tokenRecovery.markRecoverySuccess, {
            accountId: args.accountId,
          });
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: args.accountId,
            level: "info",
            source: "tokenRecovery",
            message: `Token recovered via user-level fallback for «${account.name}»`,
          }); } catch { /* non-critical */ }
          console.log(
            `[tokenRecovery] «${account.name}» (${args.accountId}): recovered via user-level token`
          );
          return true;
        }
      }
    } catch (userErr) {
      console.log(
        `[tokenRecovery] «${account.name}» (${args.accountId}): user-level fallback failed: ${userErr}`
      );
    }

    // 4. All methods failed — mark as error with recovery tracking
    const isFirstAttempt = !account.tokenRecoveryAttempts || account.tokenRecoveryAttempts === 0;
    await ctx.runMutation(internal.tokenRecovery.markRecoveryFailure, {
      accountId: args.accountId,
      errorMessage: "Все методы восстановления токена исчерпаны",
    });
    try { await ctx.runMutation(internal.systemLogger.log, {
      accountId: args.accountId,
      level: "error",
      source: "tokenRecovery",
      message: `All recovery methods failed for «${account.name}» (attempt ${(account.tokenRecoveryAttempts ?? 0) + 1})`,
    }); } catch { /* non-critical */ }

    // Notify user on first failure via Telegram
    if (isFirstAttempt) {
      try {
        const user = await ctx.runQuery(api.users.get, {
          id: account.userId as Id<"users">,
        });
        if (user?.telegramChatId) {
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId: user.telegramChatId,
            text:
              `⚠️ <b>Кабинет «${account.name}»</b>\n\n` +
              `Токен недействителен. Мониторинг приостановлен.\n` +
              `Автовосстановление будет пытаться 7 дней.\n\n` +
              `Если не восстановится — переподключите кабинет в <a href="https://aipilot.by/accounts">настройках</a>.`,
          });
        }
      } catch (tgErr) {
        console.error(`[tokenRecovery] Failed to notify user: ${tgErr}`);
      }
    }

    return false;
  },
});

// ─── Periodic retry for error accounts ──────────────────────

export const retryRecovery = internalAction({
  args: {},
  handler: async (ctx) => {
    const allAccounts = await ctx.runQuery(internal.tokenRecovery.getRecoverableAccounts, {});

    if (allAccounts.length === 0) return;

    let recovered = 0;
    let expired = 0;
    let stillFailing = 0;

    for (const acc of allAccounts) {
      const age = Date.now() - (acc.tokenErrorSince ?? 0);

      // Recovery window expired (7 days)
      if (age > RECOVERY_WINDOW_MS) {
        await ctx.runMutation(internal.tokenRecovery.markRecoveryExpired, {
          accountId: acc._id,
        });
        expired++;
        continue;
      }

      // Try recovery
      const success = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, {
        accountId: acc._id,
      });
      if (success) {
        recovered++;
      } else {
        stillFailing++;
      }
    }

    if (recovered > 0 || expired > 0) {
      console.log(
        `[retryRecovery] Done: ${recovered} recovered, ${expired} expired, ${stillFailing} still failing`
      );
    }
  },
});

// ─── Queries ─────────────────────────────────────────────────

export const getRecoverableAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allAccounts = await ctx.db.query("adAccounts").collect();
    return allAccounts.filter(
      (a) => a.status === "error" && a.tokenErrorSince !== undefined
    );
  },
});

// ─── Utility mutations ──────────────────────────────────────

export const setTokenExpiry = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    tokenExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      tokenExpiresAt: args.tokenExpiresAt,
    });
  },
});
