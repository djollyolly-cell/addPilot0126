# Abandoned Account Status — Design Spec

## Problem

Accounts with permanently expired tokens (deleted in agency provider, no refresh token, no OAuth credentials) stay in `error` status forever. This generates infinite alerts:
- Escalation every 2h (`syncMetrics.ts:820`)
- `systemLogger.log(level: "error")` on every sync cycle → `adminAlerts.notify` → Telegram
- `tokenRecovery` retry attempts → error logs

Real cases: "Милород Челябинск" (Vitamin cabinet deleted), "GURU" (recovery expired 7 days ago), "СтолПлит" (Vitamin cabinet status: deleted).

## Solution

New account status `abandoned` — accounts that have been in `error` for 7+ days with unrecoverable token errors are moved to `abandoned`. No sync, no alerts, no recovery attempts.

## Schema Changes

### `convex/schema.ts` — adAccounts table

Add `"abandoned"` to status union:
```
status: v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("error"),
  v.literal("archived"),
  v.literal("deleting"),
  v.literal("abandoned")
),
```

Add tracking field:
```
abandonedAt: v.optional(v.number()),
```

## Auto-Transition: error → abandoned

### Location: `convex/syncMetrics.ts` — `syncSingleAccount()`

**Before** the existing escalation block (line 819), add:

```typescript
if (
  account.status === "error" &&
  account.lastSyncAt &&
  Date.now() - account.lastSyncAt > 7 * 24 * 60 * 60 * 1000 &&
  (account.lastError?.includes("TOKEN_EXPIRED") ||
   account.lastError?.includes("Автовосстановление не удалось") ||
   account.lastError?.includes("refreshToken отсутствует"))
) {
  // Mark as abandoned — stops all sync, alerts, recovery
  await ctx.runMutation(internal.adAccounts.markAbandoned, { accountId: account._id });
  return;
}
```

### New mutation: `convex/adAccounts.ts` — `markAbandoned`

```typescript
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

### Notifications on transition

One-time Telegram to user:
```
Кабинет «{name}» отключён от мониторинга

Токен был недействителен более 7 дней, автовосстановление не удалось.
Переподключите кабинет: https://aipilot.by/accounts
```

One-time admin alert:
```
Кабинет «{name}» переведён в abandoned
Пользователь: {userName}
Причина: {lastError}
```

After this — silence. No more alerts.

## What Gets Skipped Automatically (no code changes)

These already filter `active || error` — abandoned is excluded:
- `syncMetrics.ts:815` — `if (status !== "active" && status !== "error") return`
- `syncMetrics.ts:643,665,687` — sync account lists
- `ruleEngine.ts:2934` — `if (account.status !== "active") return`
- `tokenRecovery.ts:407` — `a.status === "error" && a.tokenErrorSince`
- `healthCheck.ts:122` — `filter(active || error)`

## Resurrection: abandoned → active

When a new token arrives (OAuth reconnect, agency provider refresh), the account automatically returns to `active`.

### Locations to add resurrection check:

1. `convex/tokenRecovery.ts` — `patchAccountToken` mutation (line 76): if `status === "abandoned"`, patch to active and clear abandoned fields
2. `convex/auth.ts` — `updateAccountToken` mutation: same check
3. `convex/adAccounts.ts` — any connect/reconnect mutation that writes a new accessToken

```typescript
if (account.status === "abandoned") {
  patchFields.status = "active";
  patchFields.abandonedAt = undefined;
  patchFields.lastError = undefined;
  patchFields.tokenErrorSince = undefined;
  patchFields.tokenRecoveryAttempts = undefined;
}
```

## Admin Controls

### `convex/admin.ts` — new mutations

**abandonAccount**: manually move any error account to abandoned (bypass 7-day wait)
```typescript
export const abandonAccount = mutation({
  args: { sessionToken: v.string(), accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    // calls internal.adAccounts.markAbandoned
  },
});
```

**reactivateAccount**: move abandoned back to error (retry recovery)
```typescript
export const reactivateAccount = mutation({
  args: { sessionToken: v.string(), accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);
    await ctx.db.patch(args.accountId, {
      status: "error",
      abandonedAt: undefined,
    });
  },
});
```

### Admin UI

On error account cards — button "Заглушить" → calls abandonAccount.
On abandoned account cards — button "Вернуть в error" → calls reactivateAccount.

## UI Changes

### `src/components/AccountCard.tsx` — statusConfig

```typescript
abandoned: {
  icon: XCircle,
  label: 'Требует переподключения',
  color: 'text-muted-foreground',
  bg: 'bg-muted/50',
},
```

For abandoned accounts:
- Show message: "Токен недействителен более 7 дней. Переподключите кабинет."
- Hide "Синхронизировать" button
- Keep "Отключить" button

### Dashboard stats (`adAccounts.ts`)

Add `abandonedCount` — show in dashboard if > 0.

### Health report (`healthCheck.ts`)

Add "Abandoned: N" line to health report output.

## Billing

Abandoned accounts **occupy a tier slot**. Change billing filter:

`convex/billing.ts:1037`:
```typescript
// Before:
.filter((a) => a.status === "active")
// After:
.filter((a) => a.status === "active" || a.status === "abandoned")
```

## Related Tables — No Changes Needed

| Table/System | Why no change |
|---|---|
| campaigns, ads | Data preserved, sync resumes on resurrection |
| metricsDaily, metricsRealtime | Historical data stays |
| rules | Stay isActive=true, work immediately on resurrection |
| deleteUser cascade | Iterates all accounts regardless of status |
| retryRecovery | Filters `status === "error"` — abandoned excluded |
| notifications | No recurring notifications for abandoned |

## Edge Cases

1. **Admin wants to silence before 7 days** — uses "Заглушить" button manually
2. **Agency provider restores cabinet** — no auto-resurrection (sync doesn't run for abandoned). User must reconnect, or admin reactivates to error first
3. **Multiple accounts abandon simultaneously** — each sends one Telegram message (not grouped, rare case)
4. **Existing error accounts (Милород, GURU)** — auto-transition on first sync cycle after deploy (lastSyncAt > 7 days + matching lastError)
