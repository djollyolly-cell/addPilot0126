# Token Recovery Recursion Fix — Implementation Report

**Date:** 2026-05-01
**Plan:** `docs/superpowers/plans/2026-05-01-token-recovery-recursion-fix-plan.md`
**Spec:** `docs/superpowers/specs/2026-05-01-token-recovery-recursion-fix-design.md`

---

## Summary

Eliminated the recursive backedge `getValidTokenForAccount ↔ tokenRecovery.tryRecoverToken` and centralised heavy recovery behind an atomic per-account claim. This addresses daily Convex isolate restarts (`memory_carry_over` ~64 MiB), OCC contention on `adAccounts`, and admin-alert spam from chronically failing accounts.

After the fix:
- `getValidTokenForAccount` no longer calls `tryRecoverToken` / `handleTokenExpired`. On dead/expired token without refresh path it throws `TOKEN_EXPIRED`. Callers (`syncMetrics`, `ruleEngine`, `uzBudgetCron`, `tokenRefreshOne`, `proactiveRefresh`) handle that via `handleTokenExpired`.
- `handleTokenExpired` no longer runs its own cascade — it does the cheap liveness check, sets `tokenExpiresAt=0` (the invalidation marker), then delegates to `tryRecoverToken`.
- `tryRecoverToken` enforces an atomic claim through `claimRecoveryAttempt` (5-min cooldown, keyed on `lastRecoveryAttemptAt`). The `retryRecovery` cron passes `force: true` to bypass the gate.
- `markRecoveryFailure` skips the patch when state already reflects the failure → eliminates the OCC contention with concurrent `updateAccountTokens`.
- Repeat-failure log severity downgrades from `error` → `warn` after the first attempt, suppressing admin-alert spam.

---

## Files Modified

### `convex/schema.ts`
| Lines | Change |
|---|---|
| 113–114 | Added optional `lastRecoveryAttemptAt: v.optional(v.number())` to `adAccounts` (atomic claim timestamp). |

### `convex/tokenRecovery.ts`
| Lines | Change |
|---|---|
| 16 | Added `COOLDOWN_MS = 5 * 60 * 1000` (5-minute claim window — matches sync cron interval). |
| 56–72 | New `claimRecoveryAttempt` internalMutation: returns `{ claimed: boolean }`; refuses claim if account abandoned or last claim within `COOLDOWN_MS`. |
| 142–172 | `markRecoveryFailure`: added conditional skip when `account.status === "error" && account.lastError === args.errorMessage` to remove unnecessary patches. |
| 204–212, 213–225 | `tryRecoverToken`: added `force: v.optional(v.boolean())` arg; on `!force` calls `claimRecoveryAttempt` and returns `false` on denial. |
| 305–312 | Final-failure log: severity now `isFirstAttempt ? "error" : "warn"`. |
| 342–384 | `handleTokenExpired`: rewritten to delegate to `tryRecoverToken` instead of running its own `getValidTokenForAccount` + recovery cascade. |
| 412–417 | `retryRecovery` cron: passes `force: true` to `tryRecoverToken` (the periodic retry IS the cron). |

### `convex/auth.ts`
| Lines | Change |
|---|---|
| 909–917 | Added `MUST NOT call tokenRecovery.*` guard comment block above `getValidTokenForAccount`. |
| ~963 (no-credentials branch) | Removed inline `tryRecoverToken` block + `recovered` re-fetch; now throws `Error("TOKEN_EXPIRED: токен недействителен")`. |
| ~1027 (has-credentials branch) | Changed condition `tokenExpiresAt === 0 OR null OR undefined` → `tokenExpiresAt === undefined OR null` only. `tokenExpiresAt === 0` now intentionally falls through to the refresh / provider cascade. Inline `tryRecoverToken` block removed. |

---

## Mapping to Spec Sections

| Spec change | Tasks |
|---|---|
| Change 1 — Remove recursive backedge in `auth.ts`, split `tokenExpiresAt` branches | Tasks 8, 9, 10 |
| Change 2 — `claimRecoveryAttempt` atomic mutation | Tasks 1, 2 |
| Change 3 — `handleTokenExpired` delegates to `tryRecoverToken` | Task 5 |
| Change 4 — `tryRecoverToken` accepts `force` + claim, `retryRecovery` passes `force:true` | Tasks 3, 4 |
| Change 5 — Conditional `markRecoveryFailure` | Task 6 |
| Change 6 — Downgrade log level for repeat failures | Task 7 |

---

## Verification (pre-deploy)

| Check | Result |
|---|---|
| `npx tsc --noEmit -p convex/tsconfig.json` (run after every task + final) | ✅ clean (no output) |
| `npm run test` | ✅ 10 tests passed across 2 files (agency-lifecycle, agency-ui-flows) |
| Static recursion grep — `tryRecoverToken` / `handleTokenExpired` calls inside `getValidTokenForAccount` body | ✅ only 3 hits, all in comment lines (`// MUST NOT…`, `// must handle via handleTokenExpired`, `// invalidated marker set by handleTokenExpired`). No actual calls. |
| `node check-recovery-impact.cjs` baseline | Captured. Snapshot: 270 accounts (267 active, 3 abandoned). 1 with undefined expiry, 0 with `tokenExpiresAt=0`, 2 expired, 267 valid. 144 recovery log entries / 24h, 5 unique accountIds, top-5 each at 28–29 entries (chronic failures — these will quiet down to `warn` after this deploy). |

Note on the plan's awk-based static recursion check: as written, `awk '/^export const getValidTokenForAccount = internalAction/,/^export const [A-Za-z]/'` collapses immediately because both patterns match the same line. We re-ran with a corrected pump:
```bash
awk 'BEGIN{p=0} /^export const getValidTokenForAccount = internalAction/{p=1; next} p && /^export const [A-Za-z]/{p=0} p' convex/auth.ts | grep -nE "tryRecoverToken|handleTokenExpired"
```
Returns only comment-line matches; no live calls remain.

Two `internal.tokenRecovery.setTokenExpiry` calls remain inside `getValidTokenForAccount` (they extend expiry on confirmed-alive permanent tokens). They are simple DB patches and do not create recursion. The plan did not request their removal; the spec's "MUST NOT" rule was scoped against the recursive backedge.

---

## What to Monitor Post-Deploy

Run after deploy and again at ~12:00 UTC the next day (the daily restart window):

```bash
# 1. Did the daily isolate restart go away?
ssh deploy@178.172.235.49 "docker logs --since 24h convex-prod 2>&1 | grep -c memory_carry_over"
# Expected: 0 (was 1+/day)

# 2. Recovery activity — chronic failers should now log warn, not error
node check-recovery-impact.cjs
# Watch: "Top-N chattiest accounts" — total log entries should drop substantially
# (most repeat failures stop firing admin alerts after the first)

# 3. OCC failures on adAccounts in the last hour
ssh deploy@178.172.235.49 "docker logs --since 1h convex-prod 2>&1 | grep -ic 'OCC.*adAccounts'"
# Expected: order-of-magnitude lower than before

# 4. Confirm claim gate is working — should see "recovery claim denied" entries
#    proportional to fan-out attempts (good signal)
ssh deploy@178.172.235.49 "docker logs --since 1h convex-prod 2>&1 | grep -c 'recovery claim denied'"
# Expected: > 0 during sync ticks. If 0, the gate isn't being exercised.

# 5. Successful recoveries still happen
ssh deploy@178.172.235.49 "docker logs --since 24h convex-prod 2>&1 | grep -c 'recovered successfully\\|recovered via cascade\\|recovered via user-level'"
# Expected: > 0 (matches the user-token cascade firing under the gate).
```

If `memory_carry_over` is still present after 48h, see Phase 2 below.

---

## Phase 2 Reminder

After 48h of post-deploy observation:

1. Re-measure docker stats for `adpilot-postgres`:
   ```bash
   ssh deploy@178.172.235.49 "docker stats --no-stream adpilot-postgres"
   ```
   - If memory pressure unchanged, the recursion fix wasn't the root cause of the carry-over → proceed to Phase 2.
   - If memory dropped, no further action needed.

2. Phase 2 = Postgres-side diagnostic queries (see spec — bloat checks, vacuum status, write-amplification on `adAccounts`).

---

## Known Follow-ups (not in scope of this plan)

- The plan's Task 11 verification command is buggy as written (awk start/end patterns collide). Worth fixing in the plan template for future plans — replace with the BEGIN-state pump shown above. (Caught during this run; verification still performed correctly.)

---

## Post-Plan Polish (review pass)

After the plan completed, the following small refinements were applied based on review feedback:

### Polish 1 — Sharper guard comment in `auth.ts`
The `MUST NOT call tokenRecovery.*` block above `getValidTokenForAccount` was overly broad. Replaced with:
> `MUST NOT call tokenRecovery.tryRecoverToken or tokenRecovery.handleTokenExpired` — these are the calls that create the recursive backedge. Side-effect mutations on `adAccounts` (e.g. `internal.adAccounts.setTokenExpiry`) are explicitly allowed.

### Polish 2 — `setTokenExpiry` moved to `convex/adAccounts.ts`
Previously `getValidTokenForAccount` still imported `internal.tokenRecovery.setTokenExpiry` (a simple non-recursive DB patch). For architectural cleanliness — and to make the strict spec check `grep -n "tokenRecovery\." convex/auth.ts` inside the function body return zero — the mutation was relocated to `convex/adAccounts.ts` (next to `setMtAdvertiserId`). All three call-sites updated:
- `convex/auth.ts:963` → `internal.adAccounts.setTokenExpiry`
- `convex/auth.ts:1035` → `internal.adAccounts.setTokenExpiry`
- `convex/tokenRecovery.ts:371` (inside `handleTokenExpired`) → `internal.adAccounts.setTokenExpiry`

The old export was removed from `tokenRecovery.ts` and replaced with a one-line note pointing at the new location.

After this change the strict spec check `awk '... getValidTokenForAccount ...' convex/auth.ts | grep "tokenRecovery\."` returns **zero hits**, satisfying the spec's hard rule literally.

### Polish 3 — Targeted regression test
Added `tests/unit/auth-tokenExpiresAt-zero-fallthrough.test.ts` (3 cases). It reads `convex/auth.ts` and asserts:

1. The liveness predicate inside `getValidTokenForAccount` does not include `=== 0` — guarantees `tokenExpiresAt = 0` falls through to refresh cascade rather than entering the dead-token throw branch.
2. The function body documents `tokenExpiresAt = 0` as the invalidated marker and references "fall through".
3. After comment-stripping, the function body contains no `tokenRecovery.tryRecoverToken` or `tokenRecovery.handleTokenExpired` calls — locking in the spec's MUST NOT rule for the future.

Sanity-checked the regex against the pre-fix predicate string — it correctly flags the regression.

### Verification after polish
- `npx tsc --noEmit -p convex/tsconfig.json` — clean.
- `npx vitest run tests/unit/auth-tokenExpiresAt-zero-fallthrough.test.ts` — 3/3 pass.
- Strict spec grep — no `tokenRecovery.*` references inside `getValidTokenForAccount` body.
