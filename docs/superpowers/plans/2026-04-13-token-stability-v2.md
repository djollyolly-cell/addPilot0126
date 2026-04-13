# Token Stability v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить каскадный отказ токенов, закрыв все 3 пути к ложной инвалидации (syncMetrics, ruleEngine, uzBudgetCron) и исправив 4 бага в token lifecycle.

**Architecture:** Точечные фиксы в существующих файлах + новая централизованная internalAction `handleTokenExpired` в `tokenRecovery.ts`, которая заменяет 3 inline-обработчика TOKEN_EXPIRED. Ни один фикс не пишет и не затирает `accessToken`, `refreshToken`, credentials или agency-поля.

**Tech Stack:** Convex (TypeScript), VK myTarget API v2

**Spec:** `docs/superpowers/specs/2026-04-13-token-stability-v2-design.md`

---

### Task 1: Fix `tokenExpiresAt=0` как permanent token в `auth.ts`

**Files:**
- Modify: `convex/auth.ts:921` (первый блок — no credentials)
- Modify: `convex/auth.ts:996` (второй блок — has credentials)
- Test: `tests/unit/tokenStability.test.ts`

- [ ] **Step 1: Создать тест-файл**

```typescript
// tests/unit/tokenStability.test.ts
import { describe, it, expect } from "vitest";

/**
 * Helper: проверяет, является ли tokenExpiresAt "бессрочным".
 * undefined, null, 0 — все считаются permanent.
 */
function isPermanentToken(tokenExpiresAt: number | undefined | null): boolean {
  return (
    tokenExpiresAt === undefined ||
    tokenExpiresAt === null ||
    tokenExpiresAt === 0
  );
}

describe("isPermanentToken", () => {
  it("undefined → permanent", () => {
    expect(isPermanentToken(undefined)).toBe(true);
  });

  it("null → permanent", () => {
    expect(isPermanentToken(null)).toBe(true);
  });

  it("0 → permanent (invalidated, treat as permanent)", () => {
    expect(isPermanentToken(0)).toBe(true);
  });

  it("future timestamp → NOT permanent", () => {
    expect(isPermanentToken(Date.now() + 86400000)).toBe(false);
  });

  it("past timestamp → NOT permanent (expired, not permanent)", () => {
    expect(isPermanentToken(Date.now() - 86400000)).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест**

Run: `npm run test -- tests/unit/tokenStability.test.ts`
Expected: 5 passed

- [ ] **Step 3: Исправить первый блок в `auth.ts:921`**

В файле `convex/auth.ts`, строка 921, заменить:
```typescript
      if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null) {
```
на:
```typescript
      if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null || account.tokenExpiresAt === 0) {
```

- [ ] **Step 4: Исправить второй блок в `auth.ts:996`**

В файле `convex/auth.ts`, строка 996, заменить:
```typescript
    if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null) {
```
на:
```typescript
    if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null || account.tokenExpiresAt === 0) {
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add convex/auth.ts tests/unit/tokenStability.test.ts
git commit -m "fix(auth): treat tokenExpiresAt=0 as permanent token

Previously, tokenExpiresAt=0 (set by invalidateAccountToken) was not
recognized as permanent — it fell through to the 'expired' branch,
causing cascading failures. Now 0 is treated identically to
undefined/null: check liveness, use if alive.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: `markRecoverySuccess` сбрасывает `tokenExpiresAt`

**Files:**
- Modify: `convex/tokenRecovery.ts:47-60`

- [ ] **Step 1: Изменить `markRecoverySuccess`**

В файле `convex/tokenRecovery.ts`, строки 47-60, заменить:

```typescript
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
```

на:

```typescript
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: no errors (существующие вызовы без `tokenExpiresAt` валидны — аргумент optional)

- [ ] **Step 3: Commit**

```bash
git add convex/tokenRecovery.ts
git commit -m "fix(tokenRecovery): markRecoverySuccess resets tokenExpiresAt

After successful recovery, tokenExpiresAt was left at 0 (from
invalidateAccountToken), causing the token to appear 'expired' on
the next sync cycle. Now resets to undefined (permanent) or to the
actual expiry of the new token.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Retry 401 в `vkApi.ts` перед выбросом TOKEN_EXPIRED

**Files:**
- Modify: `convex/vkApi.ts:234` (callMtApi)
- Modify: `convex/vkApi.ts:276` (postMtApi)
- Modify: `convex/vkApi.ts:313` (uploadToMt)
- Modify: `convex/vkApi.ts:641` (stopAd)
- Modify: `convex/vkApi.ts:687` (restartAd)

5 мест с `response.status === 401`. Во всех — один retry через 2с.

- [ ] **Step 1: Добавить retry на 401 в `callMtApi` (строка 234)**

Заменить:
```typescript
    if (response.status === 401) {
      throw new Error("TOKEN_EXPIRED");
    }
```

на:
```typescript
    if (response.status === 401) {
      if (attempt < 1) {
        console.log(`[callMtApi] ${endpoint}: got 401, retrying once in 2s`);
        await sleep(2000);
        continue;
      }
      throw new Error("TOKEN_EXPIRED");
    }
```

- [ ] **Step 2: Добавить retry на 401 в `postMtApi` (строка 276)**

Заменить:
```typescript
    if (response.status === 401) {
      throw new Error("TOKEN_EXPIRED");
    }
```

на:
```typescript
    if (response.status === 401) {
      if (attempt < 1) {
        console.log(`[postMtApi] ${endpoint}: got 401, retrying once in 2s`);
        await sleep(2000);
        continue;
      }
      throw new Error("TOKEN_EXPIRED");
    }
```

- [ ] **Step 3: Добавить retry на 401 в `uploadToMt` (строка 313)**

Эта функция не имеет retry-цикла. Обернуть в retry:

Заменить:
```typescript
  if (response.status === 401) throw new Error("TOKEN_EXPIRED");
```

на:
```typescript
  if (response.status === 401) {
    // One retry for upload — refetch
    console.log(`[uploadToMt] ${endpoint}: got 401, retrying once in 2s`);
    await sleep(2000);
    const retryResponse = await fetchWithTimeout(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    }, UPLOAD_TIMEOUT_MS);
    if (retryResponse.status === 401) throw new Error("TOKEN_EXPIRED");
    if (!retryResponse.ok) {
      const text = await retryResponse.text();
      throw new Error(`VK Ads upload error ${retryResponse.status}: ${text}`);
    }
    return retryResponse.json();
  }
```

- [ ] **Step 4: Добавить retry на 401 в `stopAd` (строка 641)**

Заменить:
```typescript
      if (response.status === 401) {
        throw new Error("TOKEN_EXPIRED");
      }
```

на:
```typescript
      if (response.status === 401) {
        if (attempt < 1) {
          console.log(`[stopAd] banner ${args.adId}: got 401, retrying once in 2s`);
          await sleep(2000);
          continue;
        }
        throw new Error("TOKEN_EXPIRED");
      }
```

- [ ] **Step 5: Добавить retry на 401 в `restartAd` (строка 687)**

Заменить:
```typescript
      if (response.status === 401) {
        throw new Error("TOKEN_EXPIRED");
      }
```

на:
```typescript
      if (response.status === 401) {
        if (attempt < 1) {
          console.log(`[restartAd] banner ${args.adId}: got 401, retrying once in 2s`);
          await sleep(2000);
          continue;
        }
        throw new Error("TOKEN_EXPIRED");
      }
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add convex/vkApi.ts
git commit -m "fix(vkApi): retry once on 401 before throwing TOKEN_EXPIRED

VK API can return transient 401 errors. Previously any 401 immediately
threw TOKEN_EXPIRED, triggering cascading token invalidation. Now
retries once after 2s delay in all 5 API call points.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Централизованный `handleTokenExpired` в `tokenRecovery.ts`

**Files:**
- Modify: `convex/tokenRecovery.ts` (добавить новую internalAction)
- Modify: `convex/syncMetrics.ts:311-324` (заменить inline-обработку)
- Modify: `convex/ruleEngine.ts:1960-1964` (заменить inline-обработку)
- Modify: `convex/uzBudgetCron.ts:95-99` (заменить inline-обработку)

- [ ] **Step 1: Добавить `handleTokenExpired` в `tokenRecovery.ts`**

Вставить перед строкой `// ─── Periodic retry for error accounts ──────`:

```typescript
// ─── Centralized TOKEN_EXPIRED handler ──────────────────────

export const handleTokenExpired = internalAction({
  args: { accountId: v.id("adAccounts") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    // 1. Load account to get current token
    const account = await ctx.runQuery(api.adAccounts.get, {
      accountId: args.accountId,
    });
    if (!account || !account.accessToken) {
      console.log(`[handleTokenExpired] Account ${args.accountId}: not found or no token`);
      return false;
    }

    // 2. Verify token is actually dead (VK may have returned false 401)
    const tokenStillAlive = await quickTokenCheck(account.accessToken);
    if (tokenStillAlive) {
      console.log(
        `[handleTokenExpired] «${account.name}» (${args.accountId}): false TOKEN_EXPIRED — token still alive, skipping invalidation`
      );
      // Clear error status since token is fine
      await ctx.runMutation(internal.tokenRecovery.markRecoverySuccess, {
        accountId: args.accountId,
      });
      return true;
    }

    // 3. Token is really dead — try recovery BEFORE invalidation
    try {
      const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, {
        accountId: args.accountId,
      });
      if (recovered) {
        console.log(
          `[handleTokenExpired] «${account.name}» (${args.accountId}): recovered successfully`
        );
        return true;
      }
    } catch (recErr) {
      console.log(
        `[handleTokenExpired] «${account.name}» (${args.accountId}): recovery failed: ${recErr}`
      );
    }

    // 4. Recovery failed — only NOW invalidate
    await ctx.runMutation(internal.adAccounts.invalidateAccountToken, {
      accountId: args.accountId,
    });
    console.log(
      `[handleTokenExpired] «${account.name}» (${args.accountId}): token dead, invalidated after failed recovery`
    );
    return false;
  },
});
```

- [ ] **Step 2: Typecheck после добавления**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: no errors

- [ ] **Step 3: Заменить inline-обработку в `syncMetrics.ts:311-324`**

Заменить:
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

на:
```typescript
        // If TOKEN_EXPIRED — centralized handler: verify → recover → invalidate
        if (msg.includes("TOKEN_EXPIRED")) {
          try {
            await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
              accountId: account._id,
            });
          } catch (handleErr) {
            console.log(`[syncMetrics] handleTokenExpired for ${account._id} failed: ${handleErr}`);
          }
        }
```

- [ ] **Step 4: Заменить inline-обработку в `ruleEngine.ts:1960-1964`**

Заменить:
```typescript
            if (tokenMsg.includes("TOKEN_EXPIRED")) {
              await ctx.runMutation(internal.adAccounts.invalidateAccountToken, {
                accountId: accountId as Id<"adAccounts">,
              });
            }
```

на:
```typescript
            if (tokenMsg.includes("TOKEN_EXPIRED")) {
              try {
                await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
                  accountId: accountId as Id<"adAccounts">,
                });
              } catch (handleErr) {
                console.log(`[uz_budget] handleTokenExpired for ${accountId} failed: ${handleErr}`);
              }
            }
```

- [ ] **Step 5: Заменить inline-обработку в `uzBudgetCron.ts:95-99`**

Заменить:
```typescript
            if (tokenMsg.includes("TOKEN_EXPIRED")) {
              await ctx.runMutation(internal.adAccounts.invalidateAccountToken, {
                accountId,
              });
            }
```

на:
```typescript
            if (tokenMsg.includes("TOKEN_EXPIRED")) {
              try {
                await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
                  accountId,
                });
              } catch (handleErr) {
                console.log(`[uz_budget_reset] handleTokenExpired for ${accountId} failed: ${handleErr}`);
              }
            }
```

- [ ] **Step 6: Проверить imports**

Убедиться что `syncMetrics.ts`, `ruleEngine.ts`, `uzBudgetCron.ts` уже импортируют `internal` из `./_generated/api`. Если нет — добавить.

Проверить что `syncMetrics.ts` больше не использует `internal.adAccounts.invalidateAccountToken` — если это был единственный вызов, import можно оставить (другие internal вызовы есть).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add convex/tokenRecovery.ts convex/syncMetrics.ts convex/ruleEngine.ts convex/uzBudgetCron.ts
git commit -m "fix(tokenRecovery): centralized handleTokenExpired for all 3 entry points

Replaces 3 different TOKEN_EXPIRED handlers (syncMetrics, ruleEngine,
uzBudgetCron) with a single handleTokenExpired action that follows
verify → recover → invalidate order. Previously syncMetrics did
invalidate → recover, and ruleEngine/uzBudgetCron did invalidate
without any recovery attempt.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Permanent-токены в proactive refresh

**Files:**
- Modify: `convex/auth.ts:1786-1804` (`getExpiringAccounts`)

- [ ] **Step 1: Расширить `getExpiringAccounts`**

В файле `convex/auth.ts`, строки 1786-1804, заменить:

```typescript
export const getExpiringAccounts = internalQuery({
  args: { threshold: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const MAX_EXPIRED_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const accounts = await ctx.db.query("adAccounts").collect();
    return accounts.filter(
      (a) =>
        (a.status === "active" || a.status === "error") &&
        a.tokenExpiresAt &&
        a.refreshToken &&
        (
          // About to expire (within proactive window)
          (a.tokenExpiresAt > now && a.tokenExpiresAt < args.threshold) ||
          // Already expired but within 30 days (refresh token still usable)
          (a.tokenExpiresAt <= now && a.tokenExpiresAt > now - MAX_EXPIRED_AGE_MS)
        )
    );
  },
});
```

на:

```typescript
export const getExpiringAccounts = internalQuery({
  args: { threshold: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const MAX_EXPIRED_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const accounts = await ctx.db.query("adAccounts").collect();
    return accounts.filter(
      (a) =>
        (a.status === "active" || a.status === "error") &&
        (
          // Has refresh token and about to expire or already expired
          (a.refreshToken && a.tokenExpiresAt && a.tokenExpiresAt > 0 && (
            // About to expire (within proactive window)
            (a.tokenExpiresAt > now && a.tokenExpiresAt < args.threshold) ||
            // Already expired but within 30 days (refresh token still usable)
            (a.tokenExpiresAt <= now && a.tokenExpiresAt > now - MAX_EXPIRED_AGE_MS)
          )) ||
          // Permanent tokens (undefined/null/0) — include for periodic refresh
          (a.tokenExpiresAt === undefined || a.tokenExpiresAt === null || a.tokenExpiresAt === 0)
        )
    );
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add convex/auth.ts
git commit -m "fix(auth): include permanent tokens in proactive refresh

Permanent tokens (tokenExpiresAt undefined/null/0) were excluded from
getExpiringAccounts, meaning they were never proactively refreshed.
Now included so proactiveTokenRefresh maintains them every 4 hours.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Финальная проверка

**Files:** все изменённые файлы

- [ ] **Step 1: Полный typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: no errors

- [ ] **Step 2: Запустить тесты**

Run: `npm run test`
Expected: all pass

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: 0 errors (warnings ≤ 50)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: success

- [ ] **Step 5: Ревью изменённых файлов**

Проверить что ни один фикс не затрагивает:
- `accessToken`, `refreshToken` (кроме существующей логики recovery)
- `clientId`, `clientSecret`
- `agencyProviderId`, `agencyCabinetId`, `vitaminCabinetId`
- `mtAdvertiserId`
- Agency refresh-функции (`tryVitaminRefresh`, `tryGetuniqRefresh`, `tryClickruRefresh`, `tryZaleycashRefresh`)

Run: `git diff --stat` — список файлов должен быть:
```
convex/auth.ts            — 2 строки (=== 0) + getExpiringAccounts
convex/tokenRecovery.ts   — markRecoverySuccess + handleTokenExpired
convex/vkApi.ts           — 5 мест retry 401
convex/syncMetrics.ts     — замена на handleTokenExpired
convex/ruleEngine.ts      — замена на handleTokenExpired
convex/uzBudgetCron.ts    — замена на handleTokenExpired
tests/unit/tokenStability.test.ts — новый тест
```

Никаких других файлов быть не должно.
