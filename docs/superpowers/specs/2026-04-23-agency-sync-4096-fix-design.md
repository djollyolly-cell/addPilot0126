# Agency Sync 4096 Read Limit Fix — Design Spec

**Date:** 2026-04-23
**Status:** Approved
**Problem:** Agency accounts with 15,000+ campaigns/ads hit Convex "Too many reads (limit: 4096)" error during `syncNow`, because `clearAccountData` tries to delete all records in a single mutation before re-syncing.

---

## Solution Overview

Replace the "wipe + re-create" pattern with **upsert + paginated stale cleanup**:

1. `syncNow` upserts campaigns/ads from VK API (already does this)
2. After upserts, paginated queries scan all DB records for the account
3. Action compares DB records against VK API response to identify stale records
4. Stale records are deleted in small batches (200 IDs per mutation)

Key insight: the action (`syncNow`) has no read limit. Expensive scanning happens there. Mutations only receive explicit `_id` arrays for deletion — cheap and predictable.

---

## Architecture

```
syncNow (action, no read limit)
  │
  ├─ upsertCampaign × N  (existing, unchanged)
  ├─ upsertAd × N        (existing, unchanged)
  │
  ├─ listCampaignPage × ceil(total/500)  ← NEW internalQuery
  │   └─ action diffs against validCampaignIds → staleCampaignDocIds
  │
  ├─ listAdPage × ceil(total/500)        ← NEW internalQuery
  │   └─ action diffs against validAdIds → staleAdDocIds
  │
  ├─ deleteByIds × ceil(staleAds/200)       ← NEW internalMutation
  └─ deleteByIds × ceil(staleCampaigns/200) ← NEW internalMutation
```

Deletion order: ads first, then campaigns (prevents orphan ads).

---

## New Functions

### `listCampaignPage` — internalQuery

- Args: `accountId: Id<"adAccounts">`, `paginationOpts: PaginationOptions`
- Index: `by_accountId` on campaigns table
- Returns: `PaginationResult<Doc<"campaigns">>` (`{ page, isDone, continueCursor }`)
- Each page: 500 records (well under 4096 read limit)

### `listAdPage` — internalQuery

- Args: `accountId: Id<"adAccounts">`, `paginationOpts: PaginationOptions`
- Index: `by_accountId_vkAdId` on ads table
- Returns: `PaginationResult<Doc<"ads">>` (`{ page, isDone, continueCursor }`)
- Each page: 500 records

### `deleteByIds` — internalMutation

- Args: `ids: Id<"campaigns" | "ads">[]` (max 200 per call)
- Deletes each ID via `ctx.db.delete(id)`
- Returns: `{ deleted: number }`
- Cost: 200 reads + 200 writes = 400 ops per call (well under 4096)

---

## Changes to `syncNow`

### Remove

- `clearAccountData` call (line 1316, only for agency accounts)

### Add (after upsert loops)

```
// Pseudocode — action orchestration
const validCampaignSet = new Set(validCampaignIds);  // collected during upserts
const validAdSet = new Set(validAdIds);               // collected during upserts

// 1. Paginate all campaigns, identify stale
const staleCampaignDocIds = [];
let cursor = null, done = false;
while (!done) {
  const page = await ctx.runQuery(internal.adAccounts.listCampaignPage, {
    accountId, paginationOpts: { cursor, numItems: 500 },
  });
  for (const c of page.page) {
    if (!validCampaignSet.has(c.vkCampaignId)) staleCampaignDocIds.push(c._id);
  }
  done = page.isDone;
  cursor = page.continueCursor;
}

// 2. Same for ads via listAdPage

// 3. Delete stale ads first, then campaigns
for (batch of chunks(staleAdDocIds, 200))
  await ctx.runMutation(internal.adAccounts.deleteByIds, { ids: batch });
for (batch of chunks(staleCampaignDocIds, 200))
  await ctx.runMutation(internal.adAccounts.deleteByIds, { ids: batch });
```

---

## Bug Fix: `getCampaignByVkId`

Separate from the sync fix but discovered during analysis.

**Problem:** `getCampaignByVkId` accepts `accountId` but ignores it — uses `by_vkCampaignId` index. In multi-account setups, can return a campaign from the wrong account.

**Fix:** Switch to `by_accountId_vkCampaignId` composite index (already exists in schema).

---

## Deprecation: `clearAccountData`

After removing its only call site in `syncNow`, mark with `@deprecated` comment. Keep the function for API compatibility — remove in a future cleanup.

---

## Capacity Analysis (15,000 records)

| Operation | Count | Reads per call | Total reads |
|---|---|---|---|
| listCampaignPage (500/page) | 30 pages | 500 | 15,000 (in action, no limit) |
| listAdPage (500/page) | 30 pages | 500 | 15,000 (in action, no limit) |
| deleteByIds (200/batch) | depends on stale count | 200 | 200 × N batches |
| upsertCampaign | 15,000 | 2 (read + write) | via separate mutations |
| upsertAd | 15,000 | 2 (read + write) | via separate mutations |

No single mutation exceeds 4096 reads.

---

## Risk Assessment

| Risk | Mitigation |
|---|---|
| 15K records → many query pages | 500/page = 30 queries. Action has no read limit. ~30 round-trips acceptable. |
| deleteByIds: 200 deletes/mutation | 200 reads + 200 writes = 400 ops. Far below 4096. |
| Concurrent sync on same account | Upserts are idempotent. Worst case: stale record deleted then re-created on next cycle. |
| No stale records (common case) | 0 delete mutations. Only read pages. Minimal overhead. |
| Action timeout (10 min default) | 15K upserts + 30 pages + few deletes. Should complete in 2-3 min. |

---

## Scope

### In scope
- `listCampaignPage`, `listAdPage` internalQueries
- `deleteByIds` internalMutation
- `syncNow` refactor (remove clearAccountData, add stale cleanup)
- `getCampaignByVkId` bug fix
- `clearAccountData` deprecation
- Tests for all new/changed functions

### Out of scope
- Deleting `clearAccountData` entirely (needs deploy cycle)
- Optimizing upsert performance (separate concern)
- Metrics cleanup (separate table, separate concern)
