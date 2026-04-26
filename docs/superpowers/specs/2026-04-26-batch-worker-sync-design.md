# Batch Worker Sync — Design Spec

**Date:** 2026-04-26
**Problem:** Fan-out sync (264 individual workers) saturates Convex scheduler (18 min lag, 80% CPU)
**Solution:** Replace 264 individual workers with 6 batch workers, each processing ~44 accounts sequentially

## Context

Today we converted sequential `syncAll` (1 action, 40 accounts/cycle) to fan-out (264 `syncOneAccount` workers). Each worker spawns 7 sub-actions (API calls), producing ~2500 concurrent actions for 32 V8 slots. Scheduler can't keep up, lag grows every cycle.

Server: 40 GB RAM (1.6 GB free), CPU jumped from 20% to 80-90% after fan-out deploy.

## Design

### Architecture

```
cron (5 min) → syncDispatch (action)
  → listSyncableAccounts() → N accounts (sorted by staleness)
  → split into WORKER_COUNT chunks
  → dispatchSyncBatches (mutation)
      → scheduler.runAfter(0, syncBatchWorker, {accountIds: chunk1})
      → scheduler.runAfter(0, syncBatchWorker, {accountIds: chunk2})
      → ... × WORKER_COUNT
```

Each `syncBatchWorker` = one action with sequential loop (same logic as old `syncAll` inner loop).

Same pattern for `uzBudgetDispatch` → `uzBudgetBatchWorker`.

### Constants

```typescript
const WORKER_COUNT = 6;
const ACCOUNT_TIMEOUT_MS = 60_000;   // per account within worker
const WORKER_TIMEOUT_MS = 540_000;   // 9 min total (Convex action limit = 10 min)
```

### Load Comparison

| Metric | Fan-out (current) | Batch (new) |
|---|---|---|
| Scheduled actions/cycle | ~800 | ~12 |
| V8 slots peak | 32 (saturated) | ~12 |
| Scheduler lag | 18 min, growing | ~0 |
| CPU | 80-90% | ~30% |
| Time for 264 accounts | fails to complete | ~7 min |

### What Changes

1. **New:** `syncBatchWorker` — action, processes array of accountIds sequentially
2. **New:** `dispatchSyncBatches` — mutation, splits into WORKER_COUNT chunks, schedules workers
3. **Modified:** `syncDispatch` — calls `dispatchSyncBatches` instead of `dispatchSyncBatch`
4. **New:** `uzBudgetBatchWorker` — action, processes UZ budget rules for a batch
5. **Modified:** `uzBudgetDispatch` — dispatches batch workers instead of individual
6. **Delete:** `syncOneAccount` (replaced by batch worker)
7. **Delete:** `dispatchSyncBatch` (replaced by batch dispatcher)
8. **Delete:** `uzBudgetOneAccount` (replaced by batch worker)
9. **Delete:** `dispatchUzBatch` (replaced by batch dispatcher)

### What Doesn't Change

- Cron intervals (5 min sync, 5 min uzBudget)
- `listSyncableAccounts` / `listSyncableUzAccounts` queries
- Per-account sync logic (API calls, upsert, metrics, rules)
- `tokenRefreshDispatch` (runs every 2h, low volume, fan-out OK)
- `recordRateLimit` (6 workers = ~6 mutations/sec, manageable)
- Health check, alerts, escalation logic
- Heartbeat tracking

### Error Handling

- Per-account errors caught inside loop (same as old syncAll)
- If one account fails, loop continues to next
- Worker-level timeout (WORKER_TIMEOUT_MS) kills entire batch if stuck
- Remaining un-synced accounts picked up next cycle (sorted by staleness)

### Scaling to 1000+

At 1000 accounts with 10s average per account:
- 6 workers × 167 accounts = 1670s per worker → exceeds 10 min timeout
- Solution when we get there: increase WORKER_COUNT to 12-16, or tier accounts by activity
- No architectural change needed, just constants

### Rollback

Old `syncAll` function preserved in code. Revert cron entry to use `syncAll` if batch workers have issues.
