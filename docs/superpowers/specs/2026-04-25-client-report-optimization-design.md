# Client Report Optimization + campaignType

Date: 2026-04-25

## Problems

1. **`new_lead` rule fires on subscriptions.** `metricsDaily.leads = Math.max(5 sources)` without campaign type. Rule sees `leads > 0` and reports "Новый лид!" for subscription campaigns (vk.result = community joins).

2. **clientReport timeouts.** Current implementation makes 10-20 VK API calls per account (banners, campaigns, ad_plans, packages, statistics/banners/day.json batched, lead_ads). For 25-day periods with hundreds of banners — timeouts.

3. **Community dialog Flood control.** `messagesGetHistory` sends requests to each peer with 100ms delay. VK returns error 9 (Flood control) for 25+ dialogs, blocking all community data.

## Solution

### 1. New field: `campaignType` in metricsDaily

**Schema change:**
```ts
// metricsDaily — new optional field
campaignType: v.optional(v.string()) // "lead" | "message" | "subscription" | "awareness"
```

**syncMetrics changes:**
- Add 1 call to `packages.json` per account (lightweight, up to 50 packages in one request)
- Map `package_id` (already available in `vkCampaigns` from `getCampaignsForAccount`) to package name
- Use existing `classifyCampaignPackage(packageName)` to resolve type
- Pass `campaignType` to `saveDaily` / `saveDailyBatch`

**metrics.ts changes:**
- `saveDaily` and `saveDailyBatch` accept new optional `campaignType` arg
- Store in metricsDaily document

### 2. ruleEngine: new_lead respects campaign type

```ts
case "new_lead": {
  if (metrics.campaignType === "subscription" || metrics.campaignType === "awareness")
    return false;
  return metrics.leads > 0;
}
```

`getAccountTodayMetrics` already reads from metricsDaily — add `campaignType` to returned fields.

### 3. clientReport: metrics from metricsDaily

**Replace VK API calls with DB reads for basic metrics:**

Current flow (slow):
```
fetchAllBanners → fetchAdGroups → fetchAdPlans → packages.json
→ statistics/banners/day.json (batched) → fetchLeadCounts
```

New flow (fast):
```
internalQuery: metricsDaily by accountId + date range
+ campaigns/ads tables for names (already in Convex DB)
```

**Specific changes to `clientReport.ts`:**

- New `internalQuery _getMetricsForReport`: reads metricsDaily for account + date range, returns all rows with `campaignType`
- New `internalQuery _getCampaignNames`: reads from `campaigns` table (vkCampaignId → name, adPlanId) and `ads` table (vkAdId → name)
- `buildReport` action: replaces VK API stats calls with DB queries for section 1 (ad metrics)
- Route `vkResult` by `campaignType` from metricsDaily (same logic as current `resolveCategory` but using stored type)
- Sections 2-5 (dialogs, Lead Ads phones, Senler, phones_count) remain as VK API calls but moved to separate action

### 4. Split report into two calls

**Call 1: `buildReport`** (instant, from DB)
- Basic metrics: impressions, clicks, spent, CPC, CTR, CPL
- Results by category: subscribes, messages, lead_forms, other
- Totals with breakdown by campaign type

**Call 2: `buildCommunityReport`** (slow, VK Community API)
- message_starts, phones_count, phones_detail
- Senler subs
- Called separately from frontend, results merged into the same table

**Frontend changes:**
- Two calls: `buildReport` (shows table immediately) + `buildCommunityReport` (async)
- Community columns show spinner while loading
- On error: show warning icon + "Повторить" button (retries only community call)
- On success: merge data into existing rows by date

### 5. Flood control fix

**vkCommunityApi.ts:**
- Add retry on `error_code === 9` (Flood control) with longer backoff (1-2 seconds)
- Increase delay between dialog requests from 100ms to 500ms
- Reduce batch size from 3 to 2 concurrent requests

### 6. Single account per report

**Frontend:**
- Report generation limited to 1 account at a time
- If user selects multiple accounts, show notification: "Отчёт формируется по одному кабинету. Выберите один кабинет."
- Remove multi-account support from `buildReport` args (simplifies code)

### 7. Totals with breakdown by campaign type

**Current totals:** single row summing everything.

**New totals:** breakdown by campaign type, each with all columns:

| | Показы | Клики | Расход | CPC | CTR | Результаты | CPL |
|---|---|---|---|---|---|---|---|
| Подписки | 85 000 | 1 200 | 28 000 | 23.33 | 1.41 | 420 | 66.67 |
| Сообщения | 12 000 | 300 | 5 000 | 16.67 | 2.5 | 15 | 333 |
| Лиды | 3 000 | 50 | 2 000 | 40 | 1.67 | 3 | 667 |
| **Всего** | **100 000** | **1 550** | **35 000** | | | | |

**Implementation:**
- `computeTotals` returns `Record<CampaignType, Partial<ReportRow>>` + grand total
- Each row in metricsDaily already has `campaignType` — group and sum by type
- Frontend renders totals section with type rows + grand total row

### 8. Backfill migration

One-time `internalAction`:
1. For each active account: call `packages.json` (1 request) to build `package_id → type` mapping
2. Read all metricsDaily records without `campaignType` (up to 90 days)
3. Match `campaignId` (= ad_group_id) to `campaigns` table → get `package_id` from VK data → resolve type
4. Batch patch metricsDaily records with `campaignType`

## What does NOT change

- `reports.ts` (4-level hierarchical report) — untouched
- Lead Ads phone extraction — stays as VK API call (inside `buildCommunityReport`)
- Senler subs — stays as Senler API call (inside `buildCommunityReport`)
- `ReportResult` type — same structure, totals field changes from `Partial<ReportRow>` to object with type breakdown
- Digest — already works from metricsDaily, unaffected

## File changes summary

| File | Change |
|---|---|
| `convex/schema.ts` | Add `campaignType` to metricsDaily |
| `convex/metrics.ts` | `saveDaily`/`saveDailyBatch` accept `campaignType` |
| `convex/syncMetrics.ts` | Add `packages.json` call, pass `campaignType` to save |
| `convex/ruleEngine.ts` | `new_lead` checks `campaignType`, `getAccountTodayMetrics` returns it |
| `convex/clientReport.ts` | Rewrite: metrics from DB, split into two actions, single account, new totals |
| `convex/vkCommunityApi.ts` | Retry on error 9, increase delays |
| `src/pages/ReportsPage.tsx` | Two async calls, spinner for community columns, retry button, single account validation |
| One-time backfill action | Populate `campaignType` for existing records |
