# Resilient Token Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить страховочную сетку поверх существующего каскада обновления токенов — автовосстановление при полном провале, retry 7 дней, уведомления пользователю, in-app баннер.

**Architecture:** Новый файл `convex/tokenRecovery.ts` с 4 функциями (tryRecoverToken, retryRecovery, quickTokenCheck, migrateUndefinedExpiry). Минимальные вставки в существующие файлы — только вызовы tryRecoverToken() в catch-блоках. Существующий каскад из 6 методов в auth.ts НЕ модифицируется.

**Tech Stack:** Convex (internalAction, internalMutation), VK API (target.my.com), Telegram notifications

**Spec:** `docs/superpowers/specs/2026-04-10-resilient-token-recovery-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `convex/tokenRecovery.ts` | Create | Вся логика восстановления: tryRecoverToken, retryRecovery, quickTokenCheck, migrateUndefinedExpiry |
| `convex/schema.ts` | Modify (2 fields) | Новые поля `tokenErrorSince`, `tokenRecoveryAttempts` в adAccounts |
| `convex/auth.ts` | Modify (~20 lines) | Вызов tryRecoverToken в isUnrecoverable блоке + quickTokenCheck для undefined expiry |
| `convex/syncMetrics.ts` | Modify (~2 lines) | Вызов tryRecoverToken при TOKEN_EXPIRED |
| `src/pages/AccountsPage.tsx` | Modify (~25 lines) | Warning-баннер для аккаунтов в режиме автовосстановления |
| `tests/unit/tokenRecovery.test.ts` | Create | Тесты для quickTokenCheck и retryRecovery логики |

---

### Task 1: Schema — добавить поля tokenErrorSince и tokenRecoveryAttempts

**Files:**
- Modify: `convex/schema.ts:68-100` (adAccounts table)

- [ ] **Step 1: Добавить два optional поля в adAccounts**

В `convex/schema.ts`, внутри `adAccounts: defineTable({...})`, после поля `lastError` (строка 96) и перед `createdAt` (строка 97), добавить:

```typescript
    // Token recovery tracking
    tokenErrorSince: v.optional(v.number()),
    tokenRecoveryAttempts: v.optional(v.number()),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(schema): add tokenErrorSince and tokenRecoveryAttempts to adAccounts"
```

---

### Task 2: tokenRecovery.ts — quickTokenCheck

**Files:**
- Create: `convex/tokenRecovery.ts`

- [ ] **Step 1: Write test for quickTokenCheck**

Create `tests/unit/tokenRecovery.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { quickTokenCheck } from "../../convex/tokenRecovery";

describe("quickTokenCheck", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true for valid token (200)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 200 })
    );
    const result = await quickTokenCheck("valid-token");
    expect(result).toBe(true);
  });

  it("returns false for invalid token (401)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 401 })
    );
    const result = await quickTokenCheck("dead-token");
    expect(result).toBe(false);
  });

  it("returns false for forbidden token (403)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 403 })
    );
    const result = await quickTokenCheck("forbidden-token");
    expect(result).toBe(false);
  });

  it("returns true on network error (fail-safe)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    const result = await quickTokenCheck("some-token");
    expect(result).toBe(true);
  });

  it("returns true on timeout (fail-safe)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10))
    );
    const result = await quickTokenCheck("some-token");
    expect(result).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/tokenRecovery.test.ts`
Expected: FAIL — `quickTokenCheck` not found

- [ ] **Step 3: Create tokenRecovery.ts with quickTokenCheck**

Create `convex/tokenRecovery.ts`:

```typescript
/**
 * Resilient Token Recovery — страховочная сетка поверх существующего каскада.
 *
 * Не модифицирует существующую логику auth.ts. Добавляет:
 * - quickTokenCheck: лёгкая проверка жизнеспособности токена
 * - tryRecoverToken: попытка восстановления через полный каскад + user-level fallback
 * - retryRecovery: повторные попытки для error-аккаунтов (7 дней)
 * - migrateUndefinedExpiry: одноразовая миграция аккаунтов без tokenExpiresAt
 */

import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const ADMIN_CHAT_ID = "325307765";
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/unit/tokenRecovery.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add convex/tokenRecovery.ts tests/unit/tokenRecovery.test.ts
git commit -m "feat(tokenRecovery): add quickTokenCheck with fail-safe behavior"
```

---

### Task 3: tokenRecovery.ts — tryRecoverToken

**Files:**
- Modify: `convex/tokenRecovery.ts`

- [ ] **Step 1: Add markRecoverySuccess mutation**

Append to `convex/tokenRecovery.ts`:

```typescript
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
```

- [ ] **Step 2: Add tryRecoverToken internalAction**

Append to `convex/tokenRecovery.ts`:

```typescript
// ─── Main recovery action ───────────────────────────────────

export const tryRecoverToken = internalAction({
  args: { accountId: v.id("adAccounts") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    // 1. Load account
    const account = await ctx.runQuery(internal.adAccounts.get, {
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

    // Notify user on first failure via Telegram
    if (isFirstAttempt) {
      try {
        const user = await ctx.runQuery(internal.users.get, {
          userId: account.userId as Id<"users">,
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
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors. If `updateAccountCredentials` doesn't accept these args, check `convex/adAccounts.ts` for the exact signature and adjust.

- [ ] **Step 4: Commit**

```bash
git add convex/tokenRecovery.ts
git commit -m "feat(tokenRecovery): add tryRecoverToken with cascade + user-level fallback"
```

---

### Task 4: tokenRecovery.ts — retryRecovery

**Files:**
- Modify: `convex/tokenRecovery.ts`

- [ ] **Step 1: Add retryRecovery internalAction**

Append to `convex/tokenRecovery.ts`:

```typescript
// ─── Periodic retry for error accounts ──────────────────────

export const retryRecovery = internalAction({
  args: {},
  handler: async (ctx) => {
    // Find all accounts in error state with active recovery window
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
```

- [ ] **Step 2: Add getRecoverableAccounts query**

Append to `convex/tokenRecovery.ts`:

```typescript
// ─── Queries ─────────────────────────────────────────────────

export const getRecoverableAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Get all accounts with status "error" that have tokenErrorSince set
    const allAccounts = await ctx.db.query("adAccounts").collect();
    return allAccounts.filter(
      (a) => a.status === "error" && a.tokenErrorSince !== undefined
    );
  },
});
```

- [ ] **Step 3: Add setTokenExpiry mutation and missing import**

Add the missing import at the top of the file:

```typescript
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
```

Append to `convex/tokenRecovery.ts`:

```typescript
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
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add convex/tokenRecovery.ts
git commit -m "feat(tokenRecovery): add retryRecovery, setTokenExpiry, getRecoverableAccounts"
```

---

### Task 5: auth.ts — вызов tryRecoverToken в proactiveTokenRefresh

**Files:**
- Modify: `convex/auth.ts:1513-1516` (isUnrecoverable block)
- Modify: `convex/auth.ts:1595-1602` (end of proactiveTokenRefresh)

- [ ] **Step 1: Modify isUnrecoverable block for account-level refresh**

In `convex/auth.ts`, find the block at line ~1513:

```typescript
        if (isUnrecoverable(err)) {
          // Clear refresh token so we don't retry forever
          await ctx.runMutation(internal.auth.clearAccountRefreshToken, { accountId: acc._id });
          failures.push(`Account "${acc.name}": НЕИСПРАВИМО — ${errMsg}. Refresh token очищен.`);
        }
```

Replace with:

```typescript
        if (isUnrecoverable(err)) {
          // Clear refresh token so we don't retry forever
          await ctx.runMutation(internal.auth.clearAccountRefreshToken, { accountId: acc._id });
          // Try full recovery cascade before giving up
          try {
            const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: acc._id });
            if (recovered) {
              successes.push(`Account "${acc.name}": восстановлен через каскад после ${errMsg}`);
              failed--; // Undo the fail count since we recovered
              refreshed++;
            } else {
              failures.push(`Account "${acc.name}": НЕИСПРАВИМО — ${errMsg}. Автовосстановление запущено (7 дней).`);
            }
          } catch (recoveryErr) {
            failures.push(`Account "${acc.name}": НЕИСПРАВИМО — ${errMsg}. Recovery error: ${recoveryErr}`);
          }
        }
```

- [ ] **Step 2: Add retryRecovery call at end of proactiveTokenRefresh**

In `convex/auth.ts`, find the block at line ~1597 (after retry scheduling, before heartbeat):

```typescript
    if (failed > 0 && !isRetry) {
      console.log(`[proactiveRefresh] ${failed} failures — scheduling retry in 30 min`);
      await ctx.runMutation(internal.auth.scheduleProactiveRetry, {
        delayMs: 30 * 60_000,
      });
    }

    // Record heartbeat — completed (even with partial failures, the cron itself ran)
```

Add between retry scheduling and heartbeat:

```typescript
    // Retry recovery for accounts stuck in error state
    try {
      await ctx.runAction(internal.tokenRecovery.retryRecovery, {});
    } catch (retryErr) {
      console.error(`[proactiveRefresh] retryRecovery failed: ${retryErr}`);
    }
```

- [ ] **Step 3: Add import for tokenRecovery**

Verify that `internal.tokenRecovery` is auto-generated by Convex. Since `convex/tokenRecovery.ts` exports registered functions, the `internal` object should include them automatically. No manual import needed.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add convex/auth.ts
git commit -m "feat(auth): integrate tryRecoverToken into proactiveTokenRefresh"
```

---

### Task 6: auth.ts — quickTokenCheck для undefined expiry + автопроставление

**Files:**
- Modify: `convex/auth.ts:895-901` (no-credentials + undefined expiry)
- Modify: `convex/auth.ts:953-957` (has-credentials + undefined expiry)

- [ ] **Step 1: Add quickTokenCheck import**

At the top of `convex/auth.ts`, add:

```typescript
import { quickTokenCheck } from "./tokenRecovery";
```

- [ ] **Step 2: Modify no-credentials undefined expiry block (line ~899)**

Find:

```typescript
      if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null) {
        return account.accessToken;
      }
```

Replace with:

```typescript
      if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null) {
        const alive = await quickTokenCheck(account.accessToken);
        if (alive) {
          // Auto-set expiry so proactiveRefresh picks it up — no more blind returns
          await ctx.runMutation(internal.tokenRecovery.setTokenExpiry, {
            accountId: args.accountId,
            tokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
          });
          return account.accessToken;
        }
        // Token is dead — try recovery
        try {
          const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: args.accountId });
          if (recovered) {
            const fresh = await ctx.runQuery(internal.adAccounts.get, { accountId: args.accountId });
            if (fresh?.accessToken) return fresh.accessToken;
          }
        } catch (recErr) {
          console.log(`[getValidTokenForAccount] «${account.name}» (${args.accountId}): recovery failed: ${recErr}`);
        }
        throw new Error("TOKEN_EXPIRED: токен недействителен и не удалось восстановить");
      }
```

- [ ] **Step 3: Modify has-credentials undefined expiry block (line ~955)**

Find:

```typescript
    if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null) {
      return account.accessToken;
    }
```

Replace with:

```typescript
    if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null) {
      const alive = await quickTokenCheck(account.accessToken);
      if (alive) {
        // Auto-set expiry so proactiveRefresh picks it up — no more blind returns
        await ctx.runMutation(internal.tokenRecovery.setTokenExpiry, {
          accountId: args.accountId,
          tokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        });
        return account.accessToken;
      }
      // Token is dead — try recovery
      try {
        const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: args.accountId });
        if (recovered) {
          const fresh = await ctx.runQuery(internal.adAccounts.get, { accountId: args.accountId });
          if (fresh?.accessToken) return fresh.accessToken;
        }
      } catch (recErr) {
        console.log(`[getValidTokenForAccount] «${account.name}» (${args.accountId}): recovery failed: ${recErr}`);
      }
      throw new Error("TOKEN_EXPIRED: токен недействителен и не удалось восстановить");
    }
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add convex/auth.ts
git commit -m "feat(auth): add quickTokenCheck for undefined tokenExpiresAt"
```

---

### Task 7: syncMetrics.ts — вызов tryRecoverToken при TOKEN_EXPIRED

**Files:**
- Modify: `convex/syncMetrics.ts:290-295`

- [ ] **Step 1: Add tryRecoverToken call after invalidateAccountToken**

Find in `convex/syncMetrics.ts` (line ~290):

```typescript
        // If TOKEN_EXPIRED — invalidate tokenExpiresAt so next call triggers refresh
        if (msg.includes("TOKEN_EXPIRED")) {
          await ctx.runMutation(internal.adAccounts.invalidateAccountToken, {
            accountId: account._id,
          });
        }
```

Replace with:

```typescript
        // If TOKEN_EXPIRED — invalidate tokenExpiresAt so next call triggers refresh
        if (msg.includes("TOKEN_EXPIRED")) {
          await ctx.runMutation(internal.adAccounts.invalidateAccountToken, {
            accountId: account._id,
          });
          // Try immediate recovery
          try {
            await ctx.runAction(internal.tokenRecovery.tryRecoverToken, {
              accountId: account._id,
            });
          } catch (recErr) {
            console.log(`[syncMetrics] Recovery for ${account._id} failed: ${recErr}`);
          }
        }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add convex/syncMetrics.ts
git commit -m "feat(syncMetrics): trigger tryRecoverToken on TOKEN_EXPIRED"
```

---

### Task 8: AccountsPage — warning-баннер для аккаунтов в режиме восстановления

**Files:**
- Modify: `src/pages/AccountsPage.tsx`

- [ ] **Step 1: Add recovery warning banner**

In `src/pages/AccountsPage.tsx`, after the existing error/success message blocks (after line ~30 area, inside the JSX return), before the `AccountList` or accounts grid, add:

```tsx
      {/* Token recovery warnings */}
      {accounts && accounts.filter(a => a.status === "error" && a.tokenErrorSince).map(acc => {
        const daysPassed = Math.floor((Date.now() - (acc.tokenErrorSince ?? 0)) / (24 * 60 * 60 * 1000));
        const daysLeft = Math.max(0, 7 - daysPassed);
        return (
          <div key={acc._id} className="flex items-start gap-3 p-4 rounded-lg bg-warning/10 border border-warning/20">
            <AlertCircle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                Кабинет «{acc.name}» — токен недействителен
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {daysLeft > 0
                  ? `Автовосстановление: попытка ${acc.tokenRecoveryAttempts ?? 1}, осталось ${daysLeft} дн.`
                  : "Автовосстановление не удалось. Переподключите кабинет."}
              </p>
            </div>
          </div>
        );
      })}
```

Note: Verify that `accounts` query returns `tokenErrorSince` and `tokenRecoveryAttempts` fields. Since these are optional fields in adAccounts and `list` query returns all fields, they should be available automatically.

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/pages/AccountsPage.tsx
git commit -m "feat(ui): add token recovery warning banner on AccountsPage"
```

---

### Task 9: Lint + typecheck + test — финальная проверка

**Files:** All modified files

- [ ] **Step 1: Run full typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 2: Run linter**

Run: `npm run lint`
Expected: Max 50 warnings, no errors

- [ ] **Step 3: Run all unit tests**

Run: `npm run test`
Expected: All tests pass including new tokenRecovery tests

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Final commit if any fixes needed**

If lint/typecheck required fixes:
```bash
git add -A
git commit -m "fix: lint and typecheck fixes for token recovery"
```

---

## Post-Deploy Checklist

After deploying to production:

1. **Monitor logs:** Watch for `[tokenRecovery]` log entries during next proactiveTokenRefresh cycle (every 4h)
2. **Check AccountsPage:** Verify no false-positive warning banners appear for healthy accounts
3. **Verify auto-expiry:** Accounts with `tokenExpiresAt === undefined` should get `tokenExpiresAt` auto-set after first syncMetrics cycle (5 min)
