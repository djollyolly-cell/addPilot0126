# Token Recovery Recursion Fix (B′)

**Date:** 2026-05-01
**Status:** Design (rev 2 — incorporates review feedback from `-design-review-notes.md`)
**Related:** `fix_01-05.md`, `2026-04-10-resilient-token-recovery-design.md` (introduced the recursion), `2026-05-01-token-recovery-recursion-fix-design-review-notes.md` (review notes — already incorporated into this spec)

## Problem

After commit `1b96266` (12.04, resilient token recovery) Convex backend exhibits two recurring failure modes:

1. **Daily isolate restart** around 12:00 UTC:
   ```
   Restarting Isolate memory_carry_over: TooMuchMemoryCarryOver("63.99 MiB", "96 MiB"),
   last request: "Action: auth.js:getValidTokenForAccount"
   ```
   Verified events: 2026-04-27 12:55, 2026-04-30 12:07, 2026-05-01 12:51. 64 MiB carryover on a single accountId is consistent with a deep nested `runAction` stack (each level retains account/token closures); it could in principle also come from oversized API responses or large in-memory aggregations, but the recursive backedge is the only mechanism in this code path that scales with depth.

2. **OCC (optimistic concurrency control) failures:**
   ```
   markRecoveryFailure changed "adAccounts" while updateAccountTokens was retrying
   on every subsequent retry. Document j97dhxzfkqqa199nth8dhm52h184rde9.
   ```
   Two writers contend on the same `adAccounts` row.

The Postgres steady-state (23.77 GiB / 25% CPU continuous, 2 TB Convex⇄Postgres traffic) is a **separate concern** addressed in Phase 2 (out of scope for this spec).

## Root cause

**Recursive backedge** in `auth.ts`:

- `getValidTokenForAccount` (lines 965, 1043) calls `tokenRecovery.tryRecoverToken`.
- `tryRecoverToken` (line 185) calls back into `auth.getValidTokenForAccount`.
- Same backedge from `tokenRefreshOne` (line 1944) and `proactiveRefresh` (line 1737).
- `handleTokenExpired` (line 329) also calls `getValidTokenForAccount`, which on dead token re-enters `tryRecoverToken`.

When several entry points (`syncMetrics`, `ruleEngine`, `uzBudgetCron`, `tokenRefreshOne`, `retryRecovery` cron) hit the same dead-token account in one tick, fan-out × recursion-depth produces:
- 64 MiB heap retention per chain (isolate restart).
- Parallel writes to `adAccounts` from `markRecoveryFailure` and `updateAccountTokens` (OCC).

## Goals

- Eliminate the recursive backedge between `getValidTokenForAccount` and `tryRecoverToken`.
- Prevent more than one heavy recovery from running for the same `accountId` within a sync window.
- Stop `systemLogs` → `adminAlerts.notify` from firing on every repeated recovery failure.
- Stop unconditional patching in `markRecoveryFailure` when state is unchanged.

## Non-goals

- Restructuring the provider cascade (Vitamin/GetUNIQ/Click.ru/ZaleyCash).
- Diagnosing or fixing Postgres steady-state memory (Phase 2).
- Reworking `retryRecovery` cron or `abandoned` status flow.

## Design

### Layer responsibilities (after fix)

```
getValidTokenForAccount  →  refresh / provider cascade
                         →  return token | throw TOKEN_EXPIRED
                            (NEVER calls tokenRecovery.*)

handleTokenExpired       →  quickTokenCheck (cheap)
                         →  setTokenExpiry(0) if dead
                         →  delegate to tryRecoverToken
                            (NEVER calls getValidTokenForAccount directly)

tryRecoverToken          →  atomic claim via claimRecoveryAttempt mutation
                            (returns false if another caller already claimed
                             within COOLDOWN_MS, or if force=false and account
                             abandoned)
                         →  call getValidTokenForAccount once (bounded — no callback)
                         →  on fail: user-level fallback
                         →  on fail: markRecoveryFailure (conditional)

claimRecoveryAttempt     →  single mutation, atomic on the document:
                            read lastRecoveryAttemptAt → check cooldown → write+return
                            (Convex serializes mutations on one doc; no TOCTOU race)
```

Recursion is broken because `getValidTokenForAccount` no longer calls back. Concurrency is bounded because every heavy recovery is gated by an atomic claim.

### Schema addition

One optional field on `adAccounts`:

```ts
lastRecoveryAttemptAt: v.optional(v.number()),  // ms since epoch; written atomically by claimRecoveryAttempt
```

This is the only schema change. Existing documents have it absent (`undefined`); recovery code treats `undefined` as "never attempted" for gate purposes. No migration.

### `tokenExpiresAt` semantics (clarified)

The current code conflates three cases (`undefined`, `null`, `0`) into one branch. After this fix the meanings are explicit:

| Value | Meaning | Behavior in `getValidTokenForAccount` |
|---|---|---|
| `> now + BUFFER_MS` | Valid token | Return as-is. |
| `undefined` / `null` | Permanent / unknown expiry (e.g. provider with `hasApi=false`) | `quickTokenCheck` once. If alive → set far-future expiry, return. If dead → throw `TOKEN_EXPIRED` (no refresh available for permanent tokens). |
| `0` | **Invalidated marker** (set by `handleTokenExpired` before recovery) | Skip permanent-token treatment, route directly to refresh / provider cascade (refresh_token → agency_client_credentials → Vitamin → GetUNIQ → Click.ru → ZaleyCash). |
| Other number ≤ `now + BUFFER_MS` | Expired timestamp | Same refresh / provider cascade as `0`. |

**Why this matters for the fix:** `handleTokenExpired` writes `tokenExpiresAt = 0` before delegating to `tryRecoverToken`. If `getValidTokenForAccount` treats `0` like `undefined` (current behavior — quickCheck + throw), the provider cascade is unreachable from the recovery path and Vitamin/GetUNIQ refresh never runs. Separating `0` from `undefined/null` is therefore mandatory for the fix to work; it is not a cosmetic cleanup.

### Change 1 — Remove recursive backedge from `convex/auth.ts` and split `tokenExpiresAt` branches

**Hard rule:** after this change, `getValidTokenForAccount` MUST NOT contain any reference to `tokenRecovery.*`. This is a verification target (see Verification section).

Two modifications:

**a) Delete inline `tryRecoverToken` calls** at lines 957-973 and 1035-1051. The function's failure mode becomes pure `throw TOKEN_EXPIRED` — recovery is owned exclusively by callers (which already route through `handleTokenExpired`).

**b) Split the unified `undefined/null/0` branch** into two:

- `tokenExpiresAt === undefined || === null` → permanent-token path: `quickTokenCheck` once; alive → set far-future expiry and return; dead → throw `TOKEN_EXPIRED`.
- `tokenExpiresAt === 0` → fall through to the existing refresh / provider cascade (lines 1059+ for credentialed flow, 989-1013 for no-credentials flow). Do NOT call `quickTokenCheck` — the `0` marker means the caller already knows the token is dead.

This split is what makes `tryRecoverToken → getValidTokenForAccount` actually reach the Vitamin/GetUNIQ/Click.ru/ZaleyCash cascade, which is essential for non-recursive recovery to function.

**Affected code paths:** the dead-token narrow case (currently only 1 of 270 accounts hits it on production data — `undefined expiry` only; 0 accounts with `0` expiry, which makes sense since `0` is a transient invalidation marker that gets cleared by `markRecoverySuccess`).

**Caller behavior:**
- `syncMetrics` / `ruleEngine` / `uzBudgetCron` already catch `TOKEN_EXPIRED` and call `handleTokenExpired` — no change required.
- Other callers (`reports`, `vkApi`, `videoRotation`, `aiCabinet`, etc.) let the error bubble — recovery happens at the next `retryRecovery` cron tick (≤ 5 min). Acceptable: these are user-facing reads; fail-fast is preferable to silent inline recovery, and was already the existing behavior whenever inline recovery failed.

`tokenRefreshOne` (line 1944) and `proactiveRefresh` (line 1737) keep their `if (isUnrecoverable)` recovery calls — they don't run inside `getValidTokenForAccount` and don't create recursion.

### Change 2 — Atomic claim mutation `claimRecoveryAttempt`

The cooldown gate must be **atomic** — a `query` followed by a separate `mutation` has a TOCTOU race: two parallel actions can both read the old `lastRecoveryAttemptAt`, both pass the gate, both proceed to recovery. The fix is one mutation that performs read-and-write atomically:

```ts
export const claimRecoveryAttempt = internalMutation({
  args: { accountId: v.id("adAccounts") },
  returns: v.object({ claimed: v.boolean() }),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.status === "abandoned") return { claimed: false };
    const now = Date.now();
    const last = (account as any).lastRecoveryAttemptAt ?? 0;
    if (now - last < COOLDOWN_MS) return { claimed: false };
    await ctx.db.patch(args.accountId, { lastRecoveryAttemptAt: now });
    return { claimed: true };
  },
});
```

Convex serializes mutations on a single document, so two parallel `claimRecoveryAttempt` calls for the same `accountId` are ordered: the second sees the freshly-written timestamp and returns `claimed: false`. No race.

`COOLDOWN_MS = 5 * 60 * 1000` — matches sync cron interval; prevents same-tick contention from `syncMetrics`, `ruleEngine`, `uzBudgetCron`, `tokenRefreshOne`, and any other entry point.

### Change 3 — `handleTokenExpired` delegates to `tryRecoverToken`

In `convex/tokenRecovery.ts`, `handleTokenExpired` becomes:

```
1. Load account; if not found / abandoned / no accessToken → return false.
2. quickTokenCheck on current token; if alive → markRecoverySuccess, return true.
3. setTokenExpiry(0)  (invalidate marker; getValidTokenForAccount will route this to refresh cascade per Change 1.b).
4. return await tryRecoverToken(accountId, { force: false }).
```

No gate at this layer — the gate lives inside `tryRecoverToken` (next change), which is the single point where the heavy work begins. `handleTokenExpired` itself is cheap (one query + one quickTokenCheck + at most one setTokenExpiry + one delegate call), so even if multiple callers enter it concurrently the OCC pressure is limited and `claimRecoveryAttempt` blocks all but one from doing the recovery itself.

The previous direct call to `getValidTokenForAccount` (line 329) is replaced by delegation to `tryRecoverToken`. This centralizes recovery on a single internal action.

### Change 4 — `tryRecoverToken` uses atomic claim, accepts `force`

```ts
export const tryRecoverToken = internalAction({
  args: { accountId: v.id("adAccounts"), force: v.optional(v.boolean()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!args.force) {
      const { claimed } = await ctx.runMutation(
        internal.tokenRecovery.claimRecoveryAttempt,
        { accountId: args.accountId }
      );
      if (!claimed) return false;
    }
    // ... existing cascade (call getValidTokenForAccount once — bounded since it
    //     no longer calls back per Change 1) + user-level fallback ...
  },
});
```

`retryRecovery` cron is **exempt** from the claim — it is the explicit periodic retry. It calls `tryRecoverToken({ force: true })` which skips the claim. The cron itself iterates accounts sequentially, so it doesn't need the gate to prevent concurrency with itself.

The `setLastRecoveryAttempt` mutation from the previous draft is folded into `claimRecoveryAttempt` — a single mutation does both check and write.

### Change 5 — Conditional patch in `markRecoveryFailure`

Currently `markRecoveryFailure` always patches `status`, `lastError`, `tokenErrorSince`, `tokenRecoveryAttempts`. When called repeatedly with identical values, it produces OCC contention with `updateAccountTokens`.

New behavior:

```
Read account.
If account.status === "error" AND account.lastError === args.errorMessage:
  → skip patch entirely (return early). State already reflects this failure.
Else:
  → full patch as today (sets status=error, lastError, tokenErrorSince if unset, increments tokenRecoveryAttempts).
```

The `tokenRecoveryAttempts` counter is used by `retryRecovery` cron only as informational metadata; the 7-day expiry uses `tokenErrorSince`-age, not attempts count. Skipping the increment on identical-state calls is safe.

### Change 6 — Log severity downgrade for repeated failures

In `tryRecoverToken`'s failure path (line 255-260):
- First failure (when `account.tokenRecoveryAttempts` was `0`/`undefined` before this call) → `level: "error"` (current behavior; fires `adminAlerts.notify`).
- Subsequent failures → `level: "warn"` (no `adminAlerts.notify`).

`dedupKey` already includes `accountId` — no change needed there.

This stops alert spam for chronically failing accounts. They are already covered by the 7-day `retryRecovery` window and the `abandoned` flow (via `markRecoveryExpired`).

## Files modified

| File | Changes |
|---|---|
| `convex/schema.ts` | Add `lastRecoveryAttemptAt: v.optional(v.number())` to `adAccounts`. |
| `convex/auth.ts` | (a) Remove inline `tryRecoverToken` calls at 965, 1043. (b) Split the `undefined/null/0` branch: permanent (`undefined`/`null`) does quickCheck + return-or-throw; invalidated (`0`) falls through to refresh / provider cascade. |
| `convex/tokenRecovery.ts` | Add `claimRecoveryAttempt` internal mutation (atomic check-and-write). Add `force` arg to `tryRecoverToken`; first action of handler is `claimRecoveryAttempt` unless `force`. `handleTokenExpired` delegates to `tryRecoverToken` (no longer calls `getValidTokenForAccount`). `retryRecovery` cron — change its `tryRecoverToken` call at line 389 to pass `force: true`. Make `markRecoveryFailure` conditional (skip if status+lastError unchanged). Downgrade repeat-failure log to `warn`. |

No data migration. No new tables. `retryRecovery` is invoked **inside `tokenRecovery.ts` itself** (line 389), not from `crons.ts` — only the in-file call site needs the `force: true` argument.

## Verification

**Pre-deploy:**
1. `npx tsc --noEmit -p convex/tsconfig.json` — clean output.
2. `npm run test` — all unit/integration tests pass.
3. **Static recursion check:** `grep -n "tokenRecovery\." convex/auth.ts` inside the body of `getValidTokenForAccount` — expect 0 hits. Outside `getValidTokenForAccount` (e.g. in `tokenRefreshOne`, `proactiveRefresh`) hits are allowed because those don't create the recursive backedge.
4. Re-run `check-recovery-impact.cjs` (already exists) — capture baseline counters.

**Manual diagnostic before deploy** (against a synthesized dead-token state on a non-prod account or via dry-run script):
- `getValidTokenForAccount` on `tokenExpiresAt=undefined` + dead token → throws `TOKEN_EXPIRED` immediately (permanent path).
- `getValidTokenForAccount` on `tokenExpiresAt=0` + has credentials → routes to refresh / provider cascade (Vitamin/GetUNIQ/Click.ru/ZaleyCash) — does NOT throw before trying providers.
- Two parallel `handleTokenExpired` calls within 5 min on same accountId → exactly one obtains the claim and runs cascade; the other returns `false` immediately. Verified by counting cascade-entry log lines.
- `retryRecovery` cron with `force: true` bypasses the claim.

**Post-deploy (24-48h observation window):**

1. **Isolate restarts:**
   ```bash
   docker logs --since 48h adpilot-convex-backend 2>&1 \
     | grep "Restarting Isolate.*getValidTokenForAccount" | wc -l
   ```
   Expect: 0. Baseline: ~1/day.

2. **OCC errors:**
   ```bash
   docker logs --since 48h adpilot-convex-backend 2>&1 \
     | grep -E "Caught occ.*adAccounts.*markRecoveryFailure" | wc -l
   ```
   Expect: 0. Baseline: occasional bursts.

3. **systemLogs error spam:**
   Daily count of `level=error AND source=tokenRecovery` should drop to ≤ N(first-failures-per-day), not N(total-recovery-attempts).

4. **Account state distribution** (`check-recovery-impact.cjs`):
   `active`/`error`/`abandoned` counts should not change unexpectedly. Recovery still happens; just via a single non-recursive path.

**Phase 2 (after 48h, separate spec):**
Re-measure `docker stats` for `adpilot-postgres`. If memory/CPU unchanged, run pg diagnostic queries to find heavy `.filter()` queries on large tables (independent root cause).

## Risks

| Risk | Mitigation |
|---|---|
| Caller of `getValidTokenForAccount` that doesn't catch `TOKEN_EXPIRED` now sees an error where previously inline recovery succeeded. | Affected scope is narrow (1 of 270 accounts on current data); recovery still happens via `retryRecovery` cron (≤ 5 min later); user-facing reads showing an error briefly was already the existing behavior on recovery failure. |
| `tokenExpiresAt=0` route to refresh cascade attempts the cascade for genuinely-permanent tokens that some path mis-set to `0`. | The only writer of `tokenExpiresAt = 0` is `handleTokenExpired` (after `quickTokenCheck` says dead). For permanent providers (`hasApi=false`), `markRecoverySuccess` already resets `0 → undefined` (see `markRecoverySuccess` patch logic). Net invariant: `0` only appears transiently during recovery, and refresh cascade attempts on a permanent provider will fail fast (no clientId/clientSecret) → throw `TOKEN_EXPIRED` → caller flow continues unchanged. |
| Atomic claim mutation skips a legitimate recovery attempt for an account that genuinely needs immediate retry. | 5-min cooldown is short; `retryRecovery` cron (also 5 min) bypasses with `force: true`. Worst case: 10 min until first recovery on a freshly-died token. |
| `markRecoveryFailure` skip-when-unchanged logic loses an attempts increment. | Counter is informational; expiry logic uses `tokenErrorSince`-age (timestamp), not count. Verified in `retryRecovery` handler at line 380 (`age > RECOVERY_WINDOW_MS`). |
| `force: true` is accidentally added to a non-cron caller. | Static check + spec rule: only `tokenRecovery.retryRecovery` may pass `force: true`. Code-review checklist item. |
| Future contributor reintroduces a `tokenRecovery.*` call inside `getValidTokenForAccount`, restoring recursion. | Pre-deploy grep check (Verification step 3) catches this. Add an inline comment at the top of `getValidTokenForAccount` body: `// MUST NOT call tokenRecovery.* — see specs/2026-05-01-token-recovery-recursion-fix-design.md`. |

## Implementation order

1. `schema.ts`: add `lastRecoveryAttemptAt` optional field.
2. `tokenRecovery.ts`:
   a. Add `claimRecoveryAttempt` internal mutation.
   b. Add `force` arg to `tryRecoverToken`; first action is the claim.
   c. Rewrite `handleTokenExpired` to delegate to `tryRecoverToken`.
   d. Update `retryRecovery` (line 389) to pass `force: true`.
   e. Make `markRecoveryFailure` conditional.
   f. Downgrade repeat-failure log severity to `warn`.
3. `auth.ts`:
   a. Remove inline `tryRecoverToken` calls at 965, 1043.
   b. Split `undefined/null/0` branch into permanent (quickCheck) vs invalidated (`0` falls through to refresh cascade).
   c. Add `// MUST NOT call tokenRecovery.*` comment at top of `getValidTokenForAccount` body.
4. Typecheck (`npx tsc --noEmit -p convex/tsconfig.json`) + `npm run test`.
5. Static recursion check (grep verification).
6. Dry-run diagnostic against staging or a controlled dead-token account.
7. Deploy to prod.
8. Watch logs at 12:00 UTC the following day. Re-measure docker stats and decide on Phase 2 (Postgres).
