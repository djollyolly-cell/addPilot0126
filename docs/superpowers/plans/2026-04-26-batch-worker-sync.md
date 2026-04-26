# Batch Worker Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fan-out sync (264 individual workers saturating 32 V8 slots) with 6 batch workers processing accounts sequentially.

**Architecture:** `syncDispatch` gets accounts, splits into 6 chunks, dispatches via `dispatchSyncBatches` mutation which schedules 6 `syncBatchWorker` actions. Each worker processes ~44 accounts in a sequential loop. Same pattern for UZ budget.

**Tech Stack:** Convex (internalAction, internalMutation), TypeScript

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `convex/syncMetrics.ts` | Modify | Add `syncBatchWorker`, `dispatchSyncBatches`. Modify `syncDispatch`. Delete `syncOneAccount`, `dispatchSyncBatch`. |
| `convex/ruleEngine.ts` | Modify | Add `uzBudgetBatchWorker`, `dispatchUzBatches`. Modify `uzBudgetDispatch`. Delete `uzBudgetOneAccount`, `dispatchUzBatch`. |

No new files. No schema changes. No cron changes (same entry points).

---

### Task 1: Create `syncBatchWorker` + `dispatchSyncBatches` in syncMetrics.ts

**Files:**
- Modify: `convex/syncMetrics.ts`

The batch worker reuses the exact per-account logic from `syncOneAccount` (lines 813-1294), but wraps it in a sequential loop over an array of accountIds, with a worker-level timeout.

- [ ] **Step 1: Add batch worker constants**

At the top of `convex/syncMetrics.ts` (after line 11), add:

```typescript
const WORKER_COUNT = 6;
const WORKER_TIMEOUT_MS = 540_000; // 9 min total (Convex action limit = 10 min)
const BATCH_ACCOUNT_TIMEOUT_MS = 60_000; // 60s per account within batch worker
```

- [ ] **Step 2: Create `dispatchSyncBatches` mutation**

Replace the existing `dispatchSyncBatch` (lines 788-807) with:

```typescript
/** Split accounts into WORKER_COUNT chunks and schedule batch workers. */
export const dispatchSyncBatches = internalMutation({
  args: { accountIds: v.array(v.id("adAccounts")) },
  handler: async (ctx, args) => {
    const chunkSize = Math.ceil(args.accountIds.length / WORKER_COUNT);
    for (let i = 0; i < WORKER_COUNT; i++) {
      const chunk = args.accountIds.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunk.length === 0) break;
      await ctx.scheduler.runAfter(0, internal.syncMetrics.syncBatchWorker, {
        accountIds: chunk,
        workerIndex: i,
      });
    }
  },
});
```

- [ ] **Step 3: Create `syncBatchWorker` action**

Replace the existing `syncOneAccount` (lines 813-1294) with:

```typescript
/**
 * Batch worker: processes an array of accounts sequentially.
 * Each account has the same sync logic as the former syncOneAccount.
 * Worker-level timeout ensures we stay within Convex 10-min action limit.
 */
export const syncBatchWorker = internalAction({
  args: {
    accountIds: v.array(v.id("adAccounts")),
    workerIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const workerStart = Date.now();
    let synced = 0;
    let errors = 0;

    for (const accountId of args.accountIds) {
      // Worker-level timeout check: stop if approaching 9 min
      if (Date.now() - workerStart > WORKER_TIMEOUT_MS) {
        console.log(`[syncBatch#${args.workerIndex}] Worker timeout reached after ${synced} accounts, ${args.accountIds.length - synced} remaining`);
        break;
      }

      try {
        await syncSingleAccount(ctx, accountId);
        synced++;
      } catch (err) {
        errors++;
        console.error(`[syncBatch#${args.workerIndex}] Account ${accountId} failed: ${err instanceof Error ? err.message : err}`);
        // Continue to next account — don't let one failure stop the batch
      }
    }

    console.log(`[syncBatch#${args.workerIndex}] Done: ${synced} synced, ${errors} errors out of ${args.accountIds.length}`);
  },
});
```

- [ ] **Step 4: Extract per-account logic into `syncSingleAccount` helper**

Extract the entire body of `syncOneAccount.handler` (lines 815-1293) into a standalone async function above the `syncBatchWorker` definition. The function signature:

```typescript
async function syncSingleAccount(
  ctx: { runQuery: typeof ActionCtx.prototype.runQuery; runMutation: typeof ActionCtx.prototype.runMutation; runAction: typeof ActionCtx.prototype.runAction },
  accountId: Id<"adAccounts">
): Promise<void> {
```

The body is identical to the current `syncOneAccount` handler, with these changes:
1. Replace `args.accountId` → `accountId` everywhere
2. Replace the outer `withTimeout` timeout value: use `BATCH_ACCOUNT_TIMEOUT_MS` (60s) instead of `ACCOUNT_TIMEOUT_MS` (400s) / `ACCOUNT_TIMEOUT_RETRY_MS` (540s)
3. The `withTimeout` call becomes: `await withTimeout((async () => { ... })(), BATCH_ACCOUNT_TIMEOUT_MS, \`syncBatch account ${accountId}\`);`

The full function is the existing syncOneAccount handler body (lines 815-1293), just wrapped in a named function. No logic changes.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output, no errors.

- [ ] **Step 6: Run tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add convex/syncMetrics.ts
git commit -m "feat(sync): replace fan-out with batch workers (syncBatchWorker + dispatchSyncBatches)"
```

---

### Task 2: Update `syncDispatch` to use batch dispatching

**Files:**
- Modify: `convex/syncMetrics.ts:1300-1374`

- [ ] **Step 1: Change dispatch call in `syncDispatch`**

In `syncDispatch` (line 1344), replace:
```typescript
await ctx.runMutation(internal.syncMetrics.dispatchSyncBatch, { accountIds });
```

with:
```typescript
await ctx.runMutation(internal.syncMetrics.dispatchSyncBatches, { accountIds });
```

And update the log line (1345):
```typescript
console.log(`[syncDispatch] Dispatched ${Math.min(WORKER_COUNT, accountIds.length)} batch workers for ${accountIds.length} accounts`);
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add convex/syncMetrics.ts
git commit -m "feat(sync): wire syncDispatch to batch workers instead of fan-out"
```

---

### Task 3: Create `uzBudgetBatchWorker` + `dispatchUzBatches` in ruleEngine.ts

**Files:**
- Modify: `convex/ruleEngine.ts`

Same pattern as Task 1, but for UZ budget processing.

- [ ] **Step 1: Add batch constants at top of ruleEngine.ts**

After line 22 (`const ACCOUNT_TIMEOUT_MS = 90_000;`), add:

```typescript
const UZ_WORKER_COUNT = 6;
const UZ_WORKER_TIMEOUT_MS = 540_000; // 9 min
const UZ_BATCH_ACCOUNT_TIMEOUT_MS = 90_000; // 90s per account (same as current)
```

- [ ] **Step 2: Create `dispatchUzBatches` mutation**

Replace the existing `dispatchUzBatch` (lines 2867-2878) with:

```typescript
/** Split UZ accounts into chunks and schedule batch workers. */
export const dispatchUzBatches = internalMutation({
  args: { accountIds: v.array(v.id("adAccounts")) },
  handler: async (ctx, args) => {
    const chunkSize = Math.ceil(args.accountIds.length / UZ_WORKER_COUNT);
    for (let i = 0; i < UZ_WORKER_COUNT; i++) {
      const chunk = args.accountIds.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunk.length === 0) break;
      await ctx.scheduler.runAfter(0, internal.ruleEngine.uzBudgetBatchWorker, {
        accountIds: chunk,
        workerIndex: i,
      });
    }
  },
});
```

- [ ] **Step 3: Create `uzBudgetBatchWorker` action**

Replace the existing `uzBudgetOneAccount` (lines 2884-3161) with:

```typescript
/**
 * Batch worker for UZ budget rules. Processes accounts sequentially.
 */
export const uzBudgetBatchWorker = internalAction({
  args: {
    accountIds: v.array(v.id("adAccounts")),
    workerIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const workerStart = Date.now();
    let processed = 0;
    let errors = 0;

    for (const accountId of args.accountIds) {
      if (Date.now() - workerStart > UZ_WORKER_TIMEOUT_MS) {
        console.log(`[uzBatch#${args.workerIndex}] Worker timeout after ${processed} accounts`);
        break;
      }

      try {
        await processUzBudgetForAccount(ctx, accountId);
        processed++;
      } catch (err) {
        errors++;
        console.error(`[uzBatch#${args.workerIndex}] Account ${accountId} failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log(`[uzBatch#${args.workerIndex}] Done: ${processed} processed, ${errors} errors out of ${args.accountIds.length}`);
  },
});
```

- [ ] **Step 4: Extract per-account logic into `processUzBudgetForAccount` helper**

Extract the body of `uzBudgetOneAccount.handler` (lines 2886-3161) into:

```typescript
async function processUzBudgetForAccount(
  ctx: { runQuery: typeof ActionCtx.prototype.runQuery; runMutation: typeof ActionCtx.prototype.runMutation; runAction: typeof ActionCtx.prototype.runAction },
  accountId: Id<"adAccounts">
): Promise<void> {
```

The body is identical to `uzBudgetOneAccount` handler, with:
1. Replace `args.accountId` → `accountId` everywhere
2. Replace the `withTimeout` value: use `UZ_BATCH_ACCOUNT_TIMEOUT_MS` instead of `ACCOUNT_TIMEOUT_MS`

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 6: Run tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add convex/ruleEngine.ts
git commit -m "feat(uzBudget): replace fan-out with batch workers (uzBudgetBatchWorker + dispatchUzBatches)"
```

---

### Task 4: Update `uzBudgetDispatch` to use batch dispatching

**Files:**
- Modify: `convex/ruleEngine.ts:3167-3201`

- [ ] **Step 1: Change dispatch call in `uzBudgetDispatch`**

In `uzBudgetDispatch` (line 3187), replace:
```typescript
await ctx.runMutation(internal.ruleEngine.dispatchUzBatch, { accountIds });
```

with:
```typescript
await ctx.runMutation(internal.ruleEngine.dispatchUzBatches, { accountIds });
```

Update log (line 3188):
```typescript
console.log(`[uzBudgetDispatch] Dispatched ${Math.min(UZ_WORKER_COUNT, accountIds.length)} batch workers for ${accountIds.length} accounts (${uzRules.length} rules)`);
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add convex/ruleEngine.ts
git commit -m "feat(uzBudget): wire uzBudgetDispatch to batch workers"
```

---

### Task 5: Clean up old fan-out functions and unused constants

**Files:**
- Modify: `convex/syncMetrics.ts`
- Modify: `convex/ruleEngine.ts`

- [ ] **Step 1: Remove old fan-out functions from syncMetrics.ts**

Delete these functions (they've been replaced in Tasks 1-2):
- `dispatchSyncBatch` — replaced by `dispatchSyncBatches`
- `syncOneAccount` — replaced by `syncBatchWorker` + `syncSingleAccount`

Also remove the old `BATCH_SIZE` constant (line 635) — it was for the old sequential `syncAll` and is no longer used by any active code path.

Keep `listActiveAccounts` (used by old `syncAll` which we preserve for rollback) and `listSyncableAccounts` (used by `syncDispatch`).

- [ ] **Step 2: Remove old fan-out functions from ruleEngine.ts**

Delete:
- `dispatchUzBatch` — replaced by `dispatchUzBatches`
- `uzBudgetOneAccount` — replaced by `uzBudgetBatchWorker` + `processUzBudgetForAccount`

- [ ] **Step 3: Grep for any remaining references to deleted functions**

Run:
```bash
grep -rn "syncOneAccount\|dispatchSyncBatch[^e]\|uzBudgetOneAccount\|dispatchUzBatch[^e]" convex/ --include="*.ts"
```

Expected: No hits (or only in comments/old `syncAll` code that's preserved for rollback).

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output. If `_generated/api.ts` has stale references, run `npx convex codegen` first.

- [ ] **Step 5: Run tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add convex/syncMetrics.ts convex/ruleEngine.ts
git commit -m "chore: remove old fan-out functions (syncOneAccount, dispatchSyncBatch, etc.)"
```

---

### Task 6: Deploy and verify

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

This triggers GitHub Actions: Convex deploy + Docker image build.

- [ ] **Step 2: Verify deploy succeeded**

Check GitHub Actions for green status.

- [ ] **Step 3: Wait for next sync cycle (5 min) and check health**

Run the diagnostic script (`/tmp/check-sync.cjs`) or check Convex dashboard:
- Heartbeat `syncDispatch` should show `completed` status
- Stale accounts should drop to near 0 within 10 minutes
- CPU should drop from 80-90% back to ~30%

Expected metrics after deploy:
| Metric | Before (fan-out) | After (batch) |
|---|---|---|
| Scheduled actions/cycle | ~800 | ~12 |
| V8 slots peak | 32 (saturated) | ~12 |
| Scheduler lag | 18 min | ~0 |
| CPU | 80-90% | ~30% |

- [ ] **Step 4: Monitor for one hour**

Check:
1. No stale account alerts in Telegram
2. All accounts syncing within 10 min
3. CPU stable around 30%
4. No new errors in system logs

---

## Rollback

If batch workers have issues, revert `syncDispatch` to call `syncAll` directly:
1. In `crons.ts`, change `syncDispatch` to `syncAll`
2. Push to main

The old `syncAll` function is preserved in `syncMetrics.ts` for exactly this purpose.
