# Abandoned Account Status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `abandoned` status to silence sync/alerts for accounts with permanently broken tokens (7+ days in error with unrecoverable token), with auto-resurrection on reconnect, admin controls, and UI display.

**Architecture:** New schema status `abandoned` auto-transitions from `error` after 7 days with unrecoverable token errors. Existing sync/alert/recovery filters already exclude non-active/error statuses, so abandoned is silenced automatically. Resurrection happens when new token arrives via any reconnect path.

**Tech Stack:** Convex (schema, mutations, actions), React (AccountCard component), Vitest (convex-test)

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `convex/schema.ts:99-105` | Add `"abandoned"` to status union, add `abandonedAt` field |
| Modify | `convex/adAccounts.ts` | New `markAbandoned` internalMutation, update `updateStatus` args |
| Modify | `convex/syncMetrics.ts:819` | Auto-transition check before escalation block |
| Modify | `convex/tokenRecovery.ts:100-105` | Resurrection in `patchAccountToken` |
| Modify | `convex/auth.ts:1502-1507` | Resurrection in `updateAccountToken` |
| Modify | `convex/auth.ts:1548-1553` | Resurrection in `updateAccountTokens` |
| Modify | `convex/admin.ts` | `abandonAccount` + `reactivateAccount` mutations |
| Modify | `convex/billing.ts:1036-1037` | Include abandoned in tier slot counting |
| Modify | `convex/healthCheck.ts:121-122` | Add abandoned count to health report |
| Modify | `convex/adAccounts.ts:1940-1958` | Add `abandonedCount` to dashboard stats |
| Modify | `src/components/AccountCard.tsx:14-54` | Add `abandoned` to props type + statusConfig + UI |
| Modify | `convex/adAccounts.test.ts` | Tests for markAbandoned, resurrection, billing |

---

### Task 1: Schema — Add `abandoned` status and `abandonedAt` field

**Files:**
- Modify: `convex/schema.ts:99-105,125`

- [ ] **Step 1: Add `abandoned` to status union and `abandonedAt` field**

In `convex/schema.ts`, change the status union at lines 99-105 from:

```typescript
status: v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("error"),
  v.literal("archived"),
  v.literal("deleting")
),
```

to:

```typescript
status: v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("error"),
  v.literal("archived"),
  v.literal("deleting"),
  v.literal("abandoned")
),
```

After line 113 (`lastSyncError: v.optional(v.string()),`), add:

```typescript
// Abandoned: account silenced after 7+ days in error with unrecoverable token
abandonedAt: v.optional(v.number()),
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS (adding a new literal to union is backwards-compatible; `abandonedAt` is optional)

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(schema): add abandoned status and abandonedAt field to adAccounts"
```

---

### Task 2: `markAbandoned` internalMutation

**Files:**
- Modify: `convex/adAccounts.ts` (add after `updateStatus` mutation at line 1448)

- [ ] **Step 1: Write the test for markAbandoned**

In `convex/adAccounts.test.ts`, add at the end of the `describe("adAccounts")` block:

```typescript
describe("markAbandoned", () => {
  test("transitions error account to abandoned", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "abandon-1",
      name: "Test Abandon",
      accessToken: "token_a",
    });

    const accounts = await t.query(api.adAccounts.list, { userId });
    const accountId = accounts[0]._id;

    // Set to error first
    await t.mutation(api.adAccounts.updateStatus, {
      accountId,
      status: "error",
      lastError: "TOKEN_EXPIRED",
    });

    // Mark as abandoned
    await t.run(async (ctx) => {
      const { markAbandoned } = await import("./adAccounts");
      // Use internal mutation directly
      await (markAbandoned as any).handler(ctx, { accountId });
    });

    const after = await t.query(api.adAccounts.list, { userId });
    const abandoned = after.find((a: any) => a._id === accountId);
    expect(abandoned?.status).toBe("abandoned");
    expect(abandoned?.abandonedAt).toBeGreaterThan(0);
    expect(abandoned?.tokenErrorSince).toBeUndefined();
    expect(abandoned?.tokenRecoveryAttempts).toBeUndefined();
    expect(abandoned?.consecutiveSyncErrors).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- --grep "markAbandoned"`
Expected: FAIL — `markAbandoned` not yet defined

- [ ] **Step 3: Write markAbandoned internalMutation**

In `convex/adAccounts.ts`, after the `updateStatus` mutation (line 1448), add:

```typescript
/** Mark an error account as abandoned — stops all sync, alerts, recovery */
export const markAbandoned = internalMutation({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return;
    await ctx.db.patch(args.accountId, {
      status: "abandoned",
      abandonedAt: Date.now(),
      tokenErrorSince: undefined,
      tokenRecoveryAttempts: undefined,
      consecutiveSyncErrors: undefined,
    });
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- --grep "markAbandoned"`
Expected: PASS

- [ ] **Step 5: Run full typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add convex/adAccounts.ts convex/adAccounts.test.ts
git commit -m "feat(adAccounts): add markAbandoned internalMutation"
```

---

### Task 3: Auto-transition in syncSingleAccount

**Files:**
- Modify: `convex/syncMetrics.ts:818-846`

- [ ] **Step 1: Add auto-abandon check before escalation block**

In `convex/syncMetrics.ts`, BEFORE the escalation block at line 819 (after the status filter at line 817), add:

```typescript
    // Auto-abandon: error accounts with unrecoverable token errors for 7+ days
    if (
      account.status === "error" &&
      account.lastSyncAt &&
      Date.now() - account.lastSyncAt > 7 * 24 * 60 * 60 * 1000 &&
      (account.lastError?.includes("TOKEN_EXPIRED") ||
       account.lastError?.includes("Автовосстановление не удалось") ||
       account.lastError?.includes("refreshToken отсутствует"))
    ) {
      await ctx.runMutation(internal.adAccounts.markAbandoned, { accountId: account._id });

      // One-time Telegram to user
      try {
        const user = await ctx.runQuery(internal.users.getById, { userId: account.userId });
        if (user?.telegramChatId) {
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId: user.telegramChatId,
            text: [
              `Кабинет «${account.name}» отключён от мониторинга`,
              ``,
              `Токен был недействителен более 7 дней, автовосстановление не удалось.`,
              `Переподключите кабинет: https://aipilot.by/accounts`,
            ].join("\n"),
          });
        }
      } catch { /* non-critical */ }

      // One-time admin alert
      try {
        await ctx.runMutation(internal.syncMetrics.scheduleEscalationAlert, {
          accountId: account._id,
          text: [
            `<b>Кабинет переведён в abandoned</b>`,
            ``,
            `<b>Кабинет:</b> ${account.name}`,
            `<b>Причина:</b> ${(account.lastError || "неизвестно").slice(0, 200)}`,
          ].join("\n"),
          dedupKey: `abandoned:${account._id}`,
        });
      } catch { /* non-critical */ }

      return;
    }
```

- [ ] **Step 2: Verify `internal.users.getById` exists**

Run: `grep -n "export const getById" convex/users.ts`
Expected: match found (this is the existing internalQuery used throughout syncMetrics.ts for getting user by ID)

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 4: Run all tests**

Run: `npm run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/syncMetrics.ts
git commit -m "feat(sync): auto-transition error accounts to abandoned after 7 days"
```

---

### Task 4: Resurrection logic — patchAccountToken

**Files:**
- Modify: `convex/tokenRecovery.ts:100-105`

- [ ] **Step 1: Write the test for resurrection via patchAccountToken**

In `convex/adAccounts.test.ts`, add inside the `describe("markAbandoned")` block:

```typescript
test("resurrection: patchAccountToken restores abandoned to active", async () => {
  const t = convexTest(schema);
  const userId = await createTestUser(t);

  await t.mutation(api.adAccounts.connect, {
    userId,
    vkAccountId: "resurrect-1",
    name: "Test Resurrect",
    accessToken: "old_token",
  });

  const accounts = await t.query(api.adAccounts.list, { userId });
  const accountId = accounts[0]._id;

  // Manually set to abandoned
  await t.run(async (ctx) => {
    await ctx.db.patch(accountId, {
      status: "abandoned",
      abandonedAt: Date.now(),
    });
  });

  // Patch with new token
  await t.run(async (ctx) => {
    const { patchAccountToken } = await import("./tokenRecovery");
    await (patchAccountToken as any).handler(ctx, {
      accountId,
      accessToken: "new_token",
      tokenExpiresAt: Date.now() + 86400000,
    });
  });

  const after = await t.query(api.adAccounts.list, { userId });
  const resurrected = after.find((a: any) => a._id === accountId);
  expect(resurrected?.status).toBe("active");
  expect(resurrected?.abandonedAt).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- --grep "resurrection"`
Expected: FAIL — `abandonedAt` not cleared

- [ ] **Step 3: Add resurrection logic to patchAccountToken**

In `convex/tokenRecovery.ts`, replace the patch at lines 100-105:

```typescript
    await ctx.db.patch(args.accountId, {
      accessToken: args.accessToken,
      tokenExpiresAt: args.tokenExpiresAt,
      status: "active",
      lastError: undefined,
    });
```

with:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- --grep "resurrection"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/tokenRecovery.ts convex/adAccounts.test.ts
git commit -m "feat(tokenRecovery): resurrect abandoned accounts on new token"
```

---

### Task 5: Resurrection logic — updateAccountToken

**Files:**
- Modify: `convex/auth.ts:1502-1507`

- [ ] **Step 1: Add resurrection to updateAccountToken**

In `convex/auth.ts`, replace the patch at lines 1502-1507:

```typescript
    await ctx.db.patch(args.accountId, {
      accessToken: args.accessToken,
      tokenExpiresAt,
      status: "active",
      lastError: undefined,
    });
```

with:

```typescript
    const patchFields: Record<string, unknown> = {
      accessToken: args.accessToken,
      tokenExpiresAt,
      status: "active",
      lastError: undefined,
    };
    const account = await ctx.db.get(args.accountId);
    if (account && account.status === "abandoned") {
      patchFields.abandonedAt = undefined;
      patchFields.tokenErrorSince = undefined;
      patchFields.tokenRecoveryAttempts = undefined;
    }
    await ctx.db.patch(args.accountId, patchFields);
```

Note: `account` is already loaded at line 1474. So move the existing `const account = await ctx.db.get(args.accountId);` if it's not already available above the patch, or reuse the existing reference. Check that `account` variable is in scope — it is: line 1474.

Actually, looking at the code again, `account` is already loaded at line 1474. So just add the resurrection fields conditionally before the patch. The cleaner approach:

In `convex/auth.ts`, replace lines 1502-1507:

```typescript
    const patchFields: Record<string, unknown> = {
      accessToken: args.accessToken,
      tokenExpiresAt,
      status: "active",
      lastError: undefined,
    };
    if (account?.status === "abandoned") {
      patchFields.abandonedAt = undefined;
      patchFields.tokenErrorSince = undefined;
      patchFields.tokenRecoveryAttempts = undefined;
    }
    await ctx.db.patch(args.accountId, patchFields);
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/auth.ts
git commit -m "feat(auth): resurrect abandoned accounts in updateAccountToken"
```

---

### Task 6: Resurrection logic — updateAccountTokens

**Files:**
- Modify: `convex/auth.ts:1548-1553`

- [ ] **Step 1: Add resurrection to updateAccountTokens loop**

In `convex/auth.ts`, in the `updateAccountTokens` function, inside the `for (const account of sameClientAccounts)` loop at line 1530, after the audit logging and before the patch at line 1548, add resurrection fields.

Replace the patch at lines 1548-1552:

```typescript
      await ctx.db.patch(account._id, {
        accessToken: args.accessToken,
        refreshToken: args.refreshToken ?? account.refreshToken,
        tokenExpiresAt: tokenExpiresAt ?? account.tokenExpiresAt,
      });
```

with:

```typescript
      const patchFields: Record<string, unknown> = {
        accessToken: args.accessToken,
        refreshToken: args.refreshToken ?? account.refreshToken,
        tokenExpiresAt: tokenExpiresAt ?? account.tokenExpiresAt,
      };
      if (account.status === "abandoned") {
        patchFields.status = "active";
        patchFields.abandonedAt = undefined;
        patchFields.lastError = undefined;
        patchFields.tokenErrorSince = undefined;
        patchFields.tokenRecoveryAttempts = undefined;
      }
      await ctx.db.patch(account._id, patchFields);
```

Also do the same for the fallback single-account patch at line 1576-1580. Replace:

```typescript
      await ctx.db.patch(args.accountId, {
        accessToken: args.accessToken,
```

Check lines 1576-1580 and add the same resurrection logic there.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `npm run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add convex/auth.ts
git commit -m "feat(auth): resurrect abandoned accounts in updateAccountTokens"
```

---

### Task 7: Admin mutations — abandonAccount + reactivateAccount

**Files:**
- Modify: `convex/admin.ts` (add after `toggleVideoRotation` at line 465)

- [ ] **Step 1: Add abandonAccount mutation**

In `convex/admin.ts`, after the `toggleVideoRotation` mutation (line 465), add:

```typescript
/** Admin: manually move error account to abandoned (bypass 7-day wait) */
export const abandonAccount = mutation({
  args: {
    sessionToken: v.string(),
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Кабинет не найден");
    if (account.status !== "error") throw new Error("Только error-кабинеты можно заглушить");
    await ctx.db.patch(args.accountId, {
      status: "abandoned",
      abandonedAt: Date.now(),
      tokenErrorSince: undefined,
      tokenRecoveryAttempts: undefined,
      consecutiveSyncErrors: undefined,
    });
    return { success: true };
  },
});

/** Admin: move abandoned account back to error (retry recovery) */
export const reactivateAccount = mutation({
  args: {
    sessionToken: v.string(),
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Кабинет не найден");
    if (account.status !== "abandoned") throw new Error("Только abandoned-кабинеты можно реактивировать");
    await ctx.db.patch(args.accountId, {
      status: "error",
      abandonedAt: undefined,
    });
    return { success: true };
  },
});
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `npm run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add convex/admin.ts
git commit -m "feat(admin): add abandonAccount and reactivateAccount mutations"
```

---

### Task 8: Billing — abandoned accounts occupy tier slot

**Files:**
- Modify: `convex/billing.ts:1036-1037`

- [ ] **Step 1: Write the test for billing counting abandoned accounts**

In `convex/adAccounts.test.ts`, add:

```typescript
describe("billing slot counting", () => {
  test("abandoned accounts count toward tier limit", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Connect one account (freemium limit = 1)
    await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "billing-1",
      name: "Billing Test",
      accessToken: "token_b",
    });

    const accounts = await t.query(api.adAccounts.list, { userId });
    const accountId = accounts[0]._id;

    // Mark as abandoned
    await t.run(async (ctx) => {
      await ctx.db.patch(accountId, {
        status: "abandoned",
        abandonedAt: Date.now(),
      });
    });

    // Try to connect another — should fail (slot occupied by abandoned)
    await expect(
      t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "billing-2",
        name: "Billing Test 2",
        accessToken: "token_b2",
      })
    ).rejects.toThrow("Лимит кабинетов");
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (already works)**

Run: `npm run test -- --grep "billing slot"`
Expected: PASS — because `connect` at line 336 checks `accounts.length >= limit` (total count, not just active). Abandoned accounts are still in the list. The test should already pass without code changes.

If it passes, good — the `connect` mutation's account limit check already counts all accounts regardless of status.

- [ ] **Step 3: Update billing downgrade filter**

In `convex/billing.ts`, line 1036-1037, change:

```typescript
    const activeAccounts = accounts
      .filter((a) => a.status === "active")
```

to:

```typescript
    const activeAccounts = accounts
      .filter((a) => a.status === "active" || a.status === "abandoned")
```

This ensures that when downgrading tiers, abandoned accounts are counted as "occupying a slot" and excess accounts get paused.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/billing.ts convex/adAccounts.test.ts
git commit -m "fix(billing): abandoned accounts occupy tier slot on downgrade"
```

---

### Task 9: Health report — add abandoned count

**Files:**
- Modify: `convex/healthCheck.ts:121-131`

- [ ] **Step 1: Add abandoned count to checkCronSyncResults**

In `convex/healthCheck.ts`, after line 122 (`const activeAccounts = ...`), add:

```typescript
    const abandonedCount = allAccounts.filter((a) => a.status === "abandoned").length;
```

After line 131 (before the `return`), add:

```typescript
    if (abandonedCount > 0) {
      issues.push(`abandoned: ${abandonedCount}`);
    }
```

The full function becomes:

```typescript
export const checkCronSyncResults = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    const allAccounts = await ctx.db.query("adAccounts").collect();
    const activeAccounts = allAccounts.filter((a) => a.status === "active" || a.status === "error");
    const abandonedCount = allAccounts.filter((a) => a.status === "abandoned").length;
    const now = Date.now();
    const syncedCount = activeAccounts.filter((a) => a.lastSyncAt && now - a.lastSyncAt < 20 * 60_000).length;

    if (activeAccounts.length > 0 && syncedCount < activeAccounts.length) {
      issues.push(`sync: ${syncedCount}/${activeAccounts.length} синхронизированы`);
      if (status === "ok") status = "warning";
    }

    if (abandonedCount > 0) {
      issues.push(`abandoned: ${abandonedCount}`);
    }

    return { name: "Кроны (sync)", status, message: issues.length ? issues[0] : "ок", details: issues };
  },
});
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/healthCheck.ts
git commit -m "feat(health): show abandoned account count in health report"
```

---

### Task 10: Dashboard stats — add abandonedCount

**Files:**
- Modify: `convex/adAccounts.ts:1940-1958`

- [ ] **Step 1: Add abandonedCount to getTokenStatus**

In `convex/adAccounts.ts`, in the `getTokenStatus` query handler, after line 1947 (`const hasErrors = accounts.some((a) => a.status === "error");`), add:

```typescript
      const abandonedCount = accounts.filter((a) => a.status === "abandoned").length;
```

In the return object (lines 1953-1958), add `abandonedCount`:

```typescript
      return {
        connected: true,
        expired: activeAccounts.length === 0 && hasErrors,
        tokenExpiresAt: user.vkAdsTokenExpiresAt,
        lastSyncAt: lastSync || undefined,
        abandonedCount,
      };
```

Also add `abandonedCount: 0` to the fallback return at lines 1967-1972:

```typescript
    return {
      connected: hasToken,
      expired: hasToken && expired,
      tokenExpiresAt: user.vkAdsTokenExpiresAt,
      lastSyncAt: undefined as number | undefined,
      abandonedCount: 0,
    };
```

And to the early return at line 1937:

```typescript
    if (!user) return { connected: false, expired: false, abandonedCount: 0 };
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/adAccounts.ts
git commit -m "feat(adAccounts): add abandonedCount to getTokenStatus"
```

---

### Task 11: UI — AccountCard abandoned status

**Files:**
- Modify: `src/components/AccountCard.tsx:2,18,29-54,94-202`

- [ ] **Step 1: Add XCircle import**

In `src/components/AccountCard.tsx`, line 2, add `XCircle` to the lucide-react import:

```typescript
import { Building2, AlertTriangle, CheckCircle2, PauseCircle, Loader2, Trash2, ChevronDown, ChevronRight, Pencil, Check, X, XCircle } from 'lucide-react';
```

- [ ] **Step 2: Add `abandoned` to AccountCardProps status type**

In `src/components/AccountCard.tsx`, line 18, change:

```typescript
    status: 'active' | 'paused' | 'error' | 'deleting';
```

to:

```typescript
    status: 'active' | 'paused' | 'error' | 'deleting' | 'abandoned';
```

- [ ] **Step 3: Add `abandoned` to statusConfig**

In `src/components/AccountCard.tsx`, after the `deleting` entry (line 53), add:

```typescript
  abandoned: {
    icon: XCircle,
    label: 'Требует переподключения',
    color: 'text-muted-foreground',
    bg: 'bg-muted/50',
  },
```

- [ ] **Step 4: Add abandoned-specific UI message and hide sync button**

In `src/components/AccountCard.tsx`, after the error message block (line 202), add:

```typescript
              {account.status === 'abandoned' && (
                <p className="text-xs text-muted-foreground mt-1" data-testid="account-abandoned-message">
                  Токен недействителен более 7 дней. Переподключите кабинет.
                </p>
              )}
```

For the sync button section (lines 231-236), wrap it to hide for abandoned:

```typescript
        {account.status !== 'abandoned' && (
          <div className="mt-3 pt-3 border-t">
            <SyncButton
              onSync={() => onSync(account._id)}
              lastSyncAt={account.lastSyncAt}
            />
          </div>
        )}
```

- [ ] **Step 5: Also handle `abandoned` in the card opacity**

Line 98 has `account.status === 'deleting'` for opacity. Add abandoned:

```typescript
className={cn((account.status === 'deleting' || account.status === 'abandoned') && 'opacity-60')}
```

But note: abandoned should NOT have `pointer-events-none` (user needs to click disconnect). So separate them:

```typescript
className={cn(
  account.status === 'deleting' && 'opacity-60 pointer-events-none',
  account.status === 'abandoned' && 'opacity-75'
)}
```

- [ ] **Step 6: Run build to verify no type errors**

Run: `npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/AccountCard.tsx
git commit -m "feat(ui): add abandoned status display to AccountCard"
```

---

### Task 12: Update updateStatus mutation args

**Files:**
- Modify: `convex/adAccounts.ts:1436-1448`

- [ ] **Step 1: Add `abandoned` to updateStatus args**

In `convex/adAccounts.ts`, line 1439, change:

```typescript
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("error"), v.literal("archived")),
```

to:

```typescript
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("error"), v.literal("archived"), v.literal("abandoned")),
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `npm run test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add convex/adAccounts.ts
git commit -m "fix(adAccounts): add abandoned to updateStatus args union"
```

---

### Task 13: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS — no type errors

- [ ] **Step 2: Run all tests**

Run: `npm run test`
Expected: ALL PASS

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Verify no broken imports**

Run: `grep -rn "abandoned" convex/ src/ --include="*.ts" --include="*.tsx" | head -30`
Verify all references are consistent.

- [ ] **Step 5: Final commit (if any remaining changes)**

If there are uncommitted changes from fixing issues found in verification:

```bash
git add -A
git commit -m "fix: final adjustments for abandoned account status"
```
