# Token Recovery Recursion Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the recursive backedge `getValidTokenForAccount ↔ tryRecoverToken` that causes daily Convex isolate restarts and OCC contention; add an atomic per-account recovery claim so multiple entry points cannot run heavy recovery in parallel.

**Architecture:** One-directional cut: `getValidTokenForAccount` no longer calls `tokenRecovery.*`. Recovery delegates from `handleTokenExpired` → `tryRecoverToken` → `getValidTokenForAccount` (single non-recursive call). Concurrency gated by an atomic mutation `claimRecoveryAttempt` keyed on a new optional field `lastRecoveryAttemptAt`. `retryRecovery` cron bypasses the gate via `force: true`. `tokenExpiresAt` semantics split: `undefined/null` = permanent token, `0` = invalidated marker that routes to refresh cascade.

**Tech Stack:** Convex backend (TypeScript), self-hosted at `https://convex.aipilot.by`. Tests via Vitest. No frontend changes.

**Spec:** `docs/superpowers/specs/2026-05-01-token-recovery-recursion-fix-design.md`

---

## File Map

| File | Type | Responsibility |
|---|---|---|
| `convex/schema.ts` | Modify | Add optional `lastRecoveryAttemptAt` to `adAccounts`. |
| `convex/tokenRecovery.ts` | Modify | New `claimRecoveryAttempt` mutation; `force` arg on `tryRecoverToken`; rewrite `handleTokenExpired` to delegate; conditional `markRecoveryFailure`; log-level downgrade; `retryRecovery` passes `force`. |
| `convex/auth.ts` | Modify | Remove two inline `tryRecoverToken` calls; split `undefined/null/0` branch in `getValidTokenForAccount`; add inline guard comment. |

No new files. No test changes (no existing unit tests target recovery flow; verification is via typecheck + grep + post-deploy log monitoring).

---

## Task 1: Schema field for recovery claim timestamp

**Files:**
- Modify: `convex/schema.ts:112` (add line after `tokenRecoveryAttempts`)

- [ ] **Step 1.1: Add `lastRecoveryAttemptAt` field**

In `convex/schema.ts`, find the `adAccounts` table definition. After `tokenRecoveryAttempts: v.optional(v.number()),` (line 112), add:

```ts
    // Atomic claim timestamp for tokenRecovery.tryRecoverToken — prevents parallel recovery on same accountId
    lastRecoveryAttemptAt: v.optional(v.number()),
```

- [ ] **Step 1.2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output, no errors.

---

## Task 2: `claimRecoveryAttempt` atomic mutation

**Files:**
- Modify: `convex/tokenRecovery.ts` (add new mutation near top of file, after imports)

- [ ] **Step 2.1: Add `COOLDOWN_MS` constant and `claimRecoveryAttempt` mutation**

In `convex/tokenRecovery.ts`, after the existing `RECOVERY_WINDOW_MS` constant (line 15), add:

```ts
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes — matches sync cron interval
```

After the `quickTokenCheck` function (around line 43, before `markRecoverySuccess`), add the new mutation:

```ts
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
    const last = (account as { lastRecoveryAttemptAt?: number }).lastRecoveryAttemptAt ?? 0;
    if (now - last < COOLDOWN_MS) {
      return { claimed: false };
    }
    await ctx.db.patch(args.accountId, { lastRecoveryAttemptAt: now });
    return { claimed: true };
  },
});
```

- [ ] **Step 2.2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

---

## Task 3: Add `force` arg to `tryRecoverToken` and call claim

**Files:**
- Modify: `convex/tokenRecovery.ts:170-175` (`tryRecoverToken` signature and start of handler)

- [ ] **Step 3.1: Add `force` arg and claim check at start of `tryRecoverToken`**

In `convex/tokenRecovery.ts`, find the `tryRecoverToken` definition (line 170). Replace:

```ts
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
```

with:

```ts
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
```

- [ ] **Step 3.2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

---

## Task 4: `retryRecovery` passes `force: true`

**Files:**
- Modify: `convex/tokenRecovery.ts:389` (call inside `retryRecovery`)

- [ ] **Step 4.1: Add `force: true` to the cron's `tryRecoverToken` call**

In `convex/tokenRecovery.ts`, find inside `retryRecovery` (around line 389):

```ts
      // Try recovery
      const success = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, {
        accountId: acc._id,
      });
```

Replace with:

```ts
      // Try recovery — force=true bypasses the atomic claim (this IS the periodic retry)
      const success = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, {
        accountId: acc._id,
        force: true,
      });
```

- [ ] **Step 4.2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

---

## Task 5: Rewrite `handleTokenExpired` to delegate to `tryRecoverToken`

**Files:**
- Modify: `convex/tokenRecovery.ts:289-361` (entire `handleTokenExpired` body)

- [ ] **Step 5.1: Replace `handleTokenExpired` body**

In `convex/tokenRecovery.ts`, find the `handleTokenExpired` definition. Replace the entire body (the handler, lines 292-360) with:

```ts
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
    await ctx.runMutation(internal.tokenRecovery.setTokenExpiry, {
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
```

- [ ] **Step 5.2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

---

## Task 6: Conditional `markRecoveryFailure`

**Files:**
- Modify: `convex/tokenRecovery.ts:115-137` (`markRecoveryFailure` body)

- [ ] **Step 6.1: Skip patch when state already reflects this failure**

In `convex/tokenRecovery.ts`, find `markRecoveryFailure` (line 115). Replace its handler body:

```ts
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.status === "abandoned") return;

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
```

with:

```ts
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
```

- [ ] **Step 6.2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

---

## Task 7: Downgrade repeat-failure log severity

**Files:**
- Modify: `convex/tokenRecovery.ts:255-260` (log inside `tryRecoverToken` failure path)

- [ ] **Step 7.1: First failure → error, subsequent → warn**

In `convex/tokenRecovery.ts`, find inside `tryRecoverToken` after `markRecoveryFailure` (around line 255). Replace:

```ts
    try { await ctx.runMutation(internal.systemLogger.log, {
      accountId: args.accountId,
      level: "error",
      source: "tokenRecovery",
      message: `All recovery methods failed for «${account.name}» (attempt ${(account.tokenRecoveryAttempts ?? 0) + 1})`,
    }); } catch { /* non-critical */ }
```

with:

```ts
    // First failure (attempts was 0/undefined) fires admin alert; subsequent
    // failures log as warn to suppress alert spam for chronically failing accounts.
    const isFirstFailure = !account.tokenRecoveryAttempts || account.tokenRecoveryAttempts === 0;
    try { await ctx.runMutation(internal.systemLogger.log, {
      accountId: args.accountId,
      level: isFirstFailure ? "error" : "warn",
      source: "tokenRecovery",
      message: `All recovery methods failed for «${account.name}» (attempt ${(account.tokenRecoveryAttempts ?? 0) + 1})`,
    }); } catch { /* non-critical */ }
```

Note: there's already a local `isFirstAttempt` variable at line 250 (`const isFirstAttempt = !account.tokenRecoveryAttempts || account.tokenRecoveryAttempts === 0;`). Reuse it instead of redeclaring. Adjust:

```ts
    const isFirstAttempt = !account.tokenRecoveryAttempts || account.tokenRecoveryAttempts === 0;
    await ctx.runMutation(internal.tokenRecovery.markRecoveryFailure, {
      accountId: args.accountId,
      errorMessage: "Все методы восстановления токена исчерпаны",
    });
    try { await ctx.runMutation(internal.systemLogger.log, {
      accountId: args.accountId,
      level: isFirstAttempt ? "error" : "warn",
      source: "tokenRecovery",
      message: `All recovery methods failed for «${account.name}» (attempt ${(account.tokenRecoveryAttempts ?? 0) + 1})`,
    }); } catch { /* non-critical */ }
```

- [ ] **Step 7.2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

---

## Task 8: Remove inline `tryRecoverToken` from `getValidTokenForAccount` (no-credentials branch)

**Files:**
- Modify: `convex/auth.ts:963-973` (no-credentials branch dead-token recovery)

- [ ] **Step 8.1: Replace inline recovery with throw**

In `convex/auth.ts`, find inside `getValidTokenForAccount` the no-credentials branch (around line 963). Replace:

```ts
        // Token is dead — try recovery
        try {
          const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: args.accountId });
          if (recovered) {
            const fresh = await ctx.runQuery(api.adAccounts.get, { accountId: args.accountId });
            if (fresh?.accessToken) return fresh.accessToken;
          }
        } catch (recErr) {
          console.log(`[getValidTokenForAccount] «${account.name}» (${args.accountId}): recovery failed: ${recErr}`);
        }
        throw new Error("TOKEN_EXPIRED: токен недействителен и не удалось восстановить");
```

with:

```ts
        // Token is dead and no credentials — caller must handle recovery via
        // handleTokenExpired (NOT recursively from here, see specs/2026-05-01-token-recovery-recursion-fix-design.md).
        throw new Error("TOKEN_EXPIRED: токен недействителен");
```

- [ ] **Step 8.2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

---

## Task 9: Split `tokenExpiresAt` branches in has-credentials path + remove inline recovery

**Files:**
- Modify: `convex/auth.ts:1020-1052` (has-credentials branch with `undefined/null/0` check)

- [ ] **Step 9.1: Change condition from `undefined/null/0` to `undefined/null` and remove inline recovery**

This is the critical change that makes `tokenExpiresAt=0` route to the refresh cascade instead of throwing.

In `convex/auth.ts`, find (around line 1020):

```ts
    // Has credentials — check if token is still valid
    // Note: tokenExpiresAt=0 means "invalidated by TOKEN_EXPIRED", NOT "no expiry"
    if (account.tokenExpiresAt && account.tokenExpiresAt > now + BUFFER_MS) {
      return account.accessToken;
    }

    // Token without expiry (undefined/null/0) — check liveness before returning
    if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null || account.tokenExpiresAt === 0) {
      const alive = await quickTokenCheck(account.accessToken);
      if (alive) {
        // Providers with API (hasApi=true) → 24h expiry, proactive refresh possible
        // Providers without API (hasApi=false: TargetHunter, Cerebro, KotBot, eLama) → permanent 2099
        const newExpiry = account.providerHasApi
          ? Date.now() + 24 * 60 * 60 * 1000
          : new Date("2099-01-01").getTime();
        await ctx.runMutation(internal.tokenRecovery.setTokenExpiry, {
          accountId: args.accountId,
          tokenExpiresAt: newExpiry,
        });
        return account.accessToken;
      }
      // Token is dead — try recovery
      try {
        const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: args.accountId });
        if (recovered) {
          const fresh = await ctx.runQuery(api.adAccounts.get, { accountId: args.accountId });
          if (fresh?.accessToken) return fresh.accessToken;
        }
      } catch (recErr) {
        console.log(`[getValidTokenForAccount] «${account.name}» (${args.accountId}): recovery failed: ${recErr}`);
      }
      throw new Error("TOKEN_EXPIRED: токен недействителен и не удалось восстановить");
    }
```

Replace with:

```ts
    // Has credentials — check if token is still valid
    if (account.tokenExpiresAt && account.tokenExpiresAt > now + BUFFER_MS) {
      return account.accessToken;
    }

    // Permanent / unknown expiry path: undefined or null only.
    // tokenExpiresAt=0 is the "invalidated" marker set by handleTokenExpired
    // and intentionally falls through to the refresh / provider cascade below
    // (see specs/2026-05-01-token-recovery-recursion-fix-design.md).
    if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null) {
      const alive = await quickTokenCheck(account.accessToken);
      if (alive) {
        // Providers with API (hasApi=true) → 24h expiry, proactive refresh possible
        // Providers without API (hasApi=false: TargetHunter, Cerebro, KotBot, eLama) → permanent 2099
        const newExpiry = account.providerHasApi
          ? Date.now() + 24 * 60 * 60 * 1000
          : new Date("2099-01-01").getTime();
        await ctx.runMutation(internal.tokenRecovery.setTokenExpiry, {
          accountId: args.accountId,
          tokenExpiresAt: newExpiry,
        });
        return account.accessToken;
      }
      // Permanent token is dead and there's no refresh path for it — caller
      // must handle via handleTokenExpired. NOT recursively from here.
      throw new Error("TOKEN_EXPIRED: токен недействителен");
    }
    // tokenExpiresAt = 0 OR expired timestamp falls through to refresh cascade below.
```

- [ ] **Step 9.2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

---

## Task 10: Add MUST-NOT guard comment at top of `getValidTokenForAccount`

**Files:**
- Modify: `convex/auth.ts:911-913` (function header)

- [ ] **Step 10.1: Add inline comment**

In `convex/auth.ts`, find the `getValidTokenForAccount` definition (line 911). Replace:

```ts
// Get a valid token for a specific adAccount (per-account credentials)
// Falls back to user-level credentials if per-account ones are missing
export const getValidTokenForAccount = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<string> => {
```

with:

```ts
// Get a valid token for a specific adAccount (per-account credentials)
// Falls back to user-level credentials if per-account ones are missing
//
// MUST NOT call tokenRecovery.* — that creates a recursive backedge through
// tryRecoverToken → getValidTokenForAccount and causes Convex isolate restarts
// (memory_carry_over). On dead/expired token throw TOKEN_EXPIRED; callers
// (syncMetrics/ruleEngine/uzBudgetCron) handle it via handleTokenExpired.
// See specs/2026-05-01-token-recovery-recursion-fix-design.md.
export const getValidTokenForAccount = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<string> => {
```

- [ ] **Step 10.2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean output.

---

## Task 11: Static recursion grep verification

**Files:**
- None (verification only)

- [ ] **Step 11.1: Confirm no `tokenRecovery.*` calls inside `getValidTokenForAccount` body**

Run:

```bash
awk '/^export const getValidTokenForAccount = internalAction/,/^export const [A-Za-z]/' convex/auth.ts | grep -nE "tokenRecovery\." || echo "OK: no tokenRecovery.* references in getValidTokenForAccount body"
```

Expected output: `OK: no tokenRecovery.* references in getValidTokenForAccount body`

If anything else prints, the recursion has been reintroduced — stop and re-do the offending task.

---

## Task 12: Run unit/integration tests

**Files:**
- None (test run only)

- [ ] **Step 12.1: Run full test suite**

Run: `npm run test`
Expected: all tests pass. If any test was checking the old recovery behavior inside `getValidTokenForAccount`, it would fail here — read the failure carefully; the fix moves recovery to callers, so the test expectation may be obsolete.

---

## Task 13: Final pre-deploy verification

**Files:**
- None (verification)

- [ ] **Step 13.1: Re-run baseline diagnostic**

Run: `node check-recovery-impact.cjs`
Capture output. Expected: same shape as before (this is a baseline read; it queries prod, so don't expect changes here — this run captures pre-deploy state for after-deploy comparison).

- [ ] **Step 13.2: Final typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: clean.

---

## Task 14: Implementation report

**Files:**
- Create: `docs/superpowers/reports/2026-05-01-token-recovery-fix-report.md`

- [ ] **Step 14.1: Write the report**

After all code changes are committed/applied, create a report describing:

1. Files modified (with line ranges).
2. Each change mapped back to its corresponding section in the design spec.
3. Pre-deploy verification results (typecheck, tests, grep, baseline diagnostic).
4. What to monitor post-deploy and where (commands ready to copy-paste).
5. Phase 2 reminder: re-measure docker stats for adpilot-postgres after 48h; if memory unchanged, proceed to pg diagnostic queries.

Format: markdown. Filename: `docs/superpowers/reports/2026-05-01-token-recovery-fix-report.md`.

---

## Self-Review Notes

- Spec coverage: every change in spec sections "Change 1-6" maps to Tasks 8-9 (Change 1), 2 (Change 2), 5 (Change 3), 3-4 (Change 4), 6 (Change 5), 7 (Change 6). Schema addition → Task 1. Verification → Tasks 11-13. Report → Task 14.
- Type consistency: `claimRecoveryAttempt` returns `{ claimed: boolean }` consistently between Task 2 (definition) and Task 3 (call site). `force: v.optional(v.boolean())` declared in Task 3, set to `true` in Task 4 (`retryRecovery`), set to `false` (default) in Task 5 (`handleTokenExpired`).
- Placeholder scan: no TBDs/TODOs. All code blocks contain literal target code.
- One known fragile path: Task 9's text-replace block is large (~30 lines) — if the surrounding code drifts, the `Edit` may not match. Mitigation: if Edit fails, read the file at the target line range and re-quote precisely.
