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
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes — atomic recovery claim window

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

/**
 * Atomic claim mutation for token recovery.
 * Returns { claimed: true } if this caller acquired the recovery slot,
 * { claimed: false } if another caller claimed within COOLDOWN_MS or account is abandoned.
 *
 * Convex serializes mutations on a single document — parallel calls for the same
 * accountId are ordered, so the second sees the freshly-written timestamp.
 */
export const claimRecoveryAttempt = internalMutation({
  args: { accountId: v.id("adAccounts") },
  returns: v.object({ claimed: v.boolean() }),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.status === "abandoned") {
      return { claimed: false };
    }
    const now = Date.now();
    const last = account.lastRecoveryAttemptAt ?? 0;
    if (now - last < COOLDOWN_MS) {
      return { claimed: false };
    }
    await ctx.db.patch(args.accountId, { lastRecoveryAttemptAt: now });
    return { claimed: true };
  },
});

export const markRecoverySuccess = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    tokenExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;

    const patch: Record<string, unknown> = {
      status: "active",
      lastError: undefined,
      tokenErrorSince: undefined,
      tokenRecoveryAttempts: undefined,
    };

    // Сбросить tokenExpiresAt: если передан — используем, иначе чистим артефакт инвалидации
    if (args.tokenExpiresAt !== undefined) {
      patch.tokenExpiresAt = args.tokenExpiresAt;
    } else if (account.tokenExpiresAt === 0) {
      // tokenExpiresAt=0 — артефакт инвалидации, сбросить в undefined (permanent)
      patch.tokenExpiresAt = undefined;
    }

    await ctx.db.patch(args.accountId, patch);
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
    const patchFields: Record<string, unknown> = {
      accessToken: args.accessToken,
      tokenExpiresAt: args.tokenExpiresAt,
      status: "active",
      lastError: undefined,
    };
    if (account && account.status === "abandoned") {
      patchFields.abandonedAt = undefined;
      patchFields.tokenErrorSince = undefined;
      patchFields.tokenRecoveryAttempts = undefined;
    }
    await ctx.db.patch(args.accountId, patchFields);
  },
});

export const markRecoveryFailure = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.status === "abandoned") return;

    // Skip patch when state already reflects this failure — eliminates OCC
    // contention with concurrent updateAccountTokens. tokenRecoveryAttempts is
    // informational; the 7-day expiry uses tokenErrorSince-age, not count.
    if (account.status === "error" && account.lastError === args.errorMessage) {
      return;
    }

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

// Check if account's provider has permanent (non-expiring) tokens
export const isAccountPermanentToken = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<boolean> => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return false;
    const agencyProviderId = (account as Record<string, unknown>).agencyProviderId as string | undefined;
    if (!agencyProviderId) return false;
    const provider = await ctx.db.get(agencyProviderId as Id<"agencyProviders">);
    return provider ? !provider.hasApi : false;
  },
});

// ─── Main recovery action ───────────────────────────────────

export const tryRecoverToken = internalAction({
  args: {
    accountId: v.id("adAccounts"),
    // force=true skips the atomic claim — only retryRecovery cron should pass this.
    force: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    // Atomic claim: prevents multiple parallel recoveries on same accountId.
    // retryRecovery cron passes force=true (it's the periodic retry).
    if (!args.force) {
      const { claimed } = await ctx.runMutation(
        internal.tokenRecovery.claimRecoveryAttempt,
        { accountId: args.accountId }
      );
      if (!claimed) {
        console.log(`[tokenRecovery] ${args.accountId}: recovery claim denied (cooldown active)`);
        return false;
      }
    }

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
          // Resolve expiry: permanent providers (hasApi=false) → 2099, others → 24h
          const isPermanent = await ctx.runQuery(internal.tokenRecovery.isAccountPermanentToken, {
            accountId: args.accountId,
          });
          const fallbackExpiry = isPermanent
            ? new Date("2099-01-01").getTime()
            : Date.now() + 24 * 60 * 60 * 1000;
          // Write user's token to account via simple patch
          await ctx.runMutation(internal.tokenRecovery.patchAccountToken, {
            accountId: args.accountId,
            accessToken: user.accessToken,
            tokenExpiresAt: user.expiresAt ?? fallbackExpiry,
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
    // First failure (attempts was 0/undefined) fires admin alert; subsequent
    // failures log as warn to suppress alert spam for chronically failing accounts.
    try { await ctx.runMutation(internal.systemLogger.log, {
      accountId: args.accountId,
      level: isFirstAttempt ? "error" : "warn",
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

// ─── Centralized TOKEN_EXPIRED handler ──────────────────────

export const handleTokenExpired = internalAction({
  args: { accountId: v.id("adAccounts") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    // 1. Load account
    const account = await ctx.runQuery(api.adAccounts.get, {
      accountId: args.accountId,
    });
    if (!account || !account.accessToken || account.status === "abandoned") {
      console.log(
        `[handleTokenExpired] Account ${args.accountId}: not found, no token, or abandoned`
      );
      return false;
    }

    // 2. Verify token is actually dead (VK may have returned false 401)
    const tokenStillAlive = await quickTokenCheck(account.accessToken);
    if (tokenStillAlive) {
      console.log(
        `[handleTokenExpired] «${account.name}» (${args.accountId}): false TOKEN_EXPIRED — token still alive, skipping invalidation`
      );
      await ctx.runMutation(internal.tokenRecovery.markRecoverySuccess, {
        accountId: args.accountId,
      });
      return true;
    }

    // 3. Token is really dead — invalidate so getValidTokenForAccount routes
    //    to refresh / provider cascade (see auth.ts: tokenExpiresAt=0 → cascade)
    await ctx.runMutation(internal.adAccounts.setTokenExpiry, {
      accountId: args.accountId,
      tokenExpiresAt: 0,
    });
    console.log(
      `[handleTokenExpired] «${account.name}» (${args.accountId}): token dead, set tokenExpiresAt=0`
    );

    // 4. Delegate to tryRecoverToken (atomic claim + cascade + user-level fallback).
    //    No `force` — gate enforced. Multiple parallel handleTokenExpired calls
    //    on same accountId result in exactly one cascade run per COOLDOWN_MS window.
    return await ctx.runAction(internal.tokenRecovery.tryRecoverToken, {
      accountId: args.accountId,
    });
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

      // Try recovery — force=true bypasses the atomic claim (this IS the periodic retry)
      const success = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, {
        accountId: acc._id,
        force: true,
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

// Note: setTokenExpiry moved to convex/adAccounts.ts so getValidTokenForAccount
// can stay clear of any internal.tokenRecovery.* reference. See the guard
// comment on getValidTokenForAccount in auth.ts.
