# Digest Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Telegram digests (daily/weekly/monthly) to separate leads vs subscriptions, show per-account data, group rule events, and add period-over-period comparison.

**Architecture:** Single data collection pipeline `collectDigestData()` serves all 3 digest types. VK API `packages.json` + `ad_groups.json` determine lead vs subscription via `package_id`. Formatting functions produce per-account blocks with optional delta comparison. Rule events grouped by rule name (not per-ad).

**Tech Stack:** Convex (internalAction/internalQuery), VK myTarget API, Telegram Bot API

---

### Task 1: Add new interfaces and helper functions

**Files:**
- Modify: `convex/telegram.ts:117-139` (replace old interfaces)

- [ ] **Step 1: Write tests for `isSubscriptionPackage` and `formatDelta`**

Create file `tests/digest-helpers.test.ts`:

```typescript
import { describe, test, expect } from "vitest";

// We'll test pure functions extracted from telegram.ts
// For now, define them inline and move later

function isSubscriptionPackage(packageName: string): boolean {
  const lower = packageName.toLowerCase();
  return ["подписк", "subscribe", "community", "join"].some(kw => lower.includes(kw));
}

function formatDelta(current: number, previous: number): string {
  if (previous === 0) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "";
  return pct > 0 ? ` (↑${pct}%)` : ` (↓${Math.abs(pct)}%)`;
}

function formatNum(n: number): string {
  return n.toLocaleString("ru-RU");
}

describe("isSubscriptionPackage", () => {
  test("detects Russian subscription keyword", () => {
    expect(isSubscriptionPackage("Подписка на сообщество")).toBe(true);
    expect(isSubscriptionPackage("подписка")).toBe(true);
  });

  test("detects English keywords", () => {
    expect(isSubscriptionPackage("Subscribe to community")).toBe(true);
    expect(isSubscriptionPackage("Join community")).toBe(true);
    expect(isSubscriptionPackage("Community subscription")).toBe(true);
  });

  test("returns false for non-subscription packages", () => {
    expect(isSubscriptionPackage("Отправка сообщений")).toBe(false);
    expect(isSubscriptionPackage("Трафик")).toBe(false);
    expect(isSubscriptionPackage("Получение лидов")).toBe(false);
    expect(isSubscriptionPackage("Конверсии")).toBe(false);
  });
});

describe("formatDelta", () => {
  test("positive delta", () => {
    expect(formatDelta(112, 100)).toBe(" (↑12%)");
  });

  test("negative delta", () => {
    expect(formatDelta(88, 100)).toBe(" (↓12%)");
  });

  test("zero delta", () => {
    expect(formatDelta(100, 100)).toBe("");
  });

  test("zero previous", () => {
    expect(formatDelta(100, 0)).toBe("");
  });
});

describe("formatNum", () => {
  test("formats with spaces", () => {
    const result = formatNum(106989);
    // Node may use non-breaking space (U+00A0) for ru-RU
    expect(result.replace(/\s/g, " ")).toBe("106 989");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/digest-helpers.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 3: Add new interfaces and pure functions to telegram.ts**

Replace the old interfaces at lines 117-139 with:

```typescript
// ─── Digest interfaces ──────────────────────────────────────────────

export interface DigestActionLogSummary {
  adName: string;
  adId: string;
  accountId: string;
  actionType: string;
  reason: string;
  savedAmount: number;
  ruleName: string;
  metricsSnapshot: {
    spent: number;
    leads: number;
    cpl?: number;
    ctr?: number;
  };
}

export interface DigestMetrics {
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  subscriptions: number;
  cpl: number;
  costPerSub: number;
}

export interface DigestAccountData {
  name: string;
  metrics: DigestMetrics;
  prevMetrics?: DigestMetrics;
  ruleEvents: { ruleName: string; count: number }[];
  savedAmount: number;
}

export interface DigestData {
  accounts: DigestAccountData[];
  totals: DigestMetrics;
  prevTotals?: DigestMetrics;
}

// ─── Digest pure helpers ─────────────────────────────────────────────

export function isSubscriptionPackage(packageName: string): boolean {
  const lower = packageName.toLowerCase();
  return ["подписк", "subscribe", "community", "join"].some(kw => lower.includes(kw));
}

export function formatDelta(current: number, previous: number): string {
  if (previous === 0) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "";
  return pct > 0 ? ` (↑${pct}%)` : ` (↓${Math.abs(pct)}%)`;
}
```

- [ ] **Step 4: Update test imports to use actual exports**

Update `tests/digest-helpers.test.ts` to import from telegram.ts:

```typescript
import { describe, test, expect } from "vitest";
import { isSubscriptionPackage, formatDelta } from "../convex/telegram";
```

Remove the inline function definitions from the test file.

- [ ] **Step 5: Run tests again**

Run: `npx vitest run tests/digest-helpers.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add convex/telegram.ts tests/digest-helpers.test.ts
git commit -m "feat(digest): add new interfaces and helpers for leads/subscriptions split"
```

---

### Task 2: Add new data collection queries

**Files:**
- Modify: `convex/telegram.ts` (add new internalQueries after existing ones, ~line 1230)

- [ ] **Step 1: Add `getMetricsByAccount` query**

Add after the existing `getAdDailyMetrics` query (after line ~1229):

```typescript
/** Get metrics grouped by account for given dates, with campaignId for classification */
export const getMetricsByAccount = internalQuery({
  args: {
    userId: v.id("users"),
    dates: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const result: Array<{
      accountId: string;
      accountName: string;
      campaigns: Map<string, { impressions: number; clicks: number; spent: number; leads: number }>;
      impressions: number;
      clicks: number;
      spent: number;
      leads: number;
    }> = [];

    for (const account of accounts) {
      let totalImpressions = 0;
      let totalClicks = 0;
      let totalSpent = 0;
      let totalLeads = 0;
      const campaignMetrics = new Map<string, { impressions: number; clicks: number; spent: number; leads: number }>();

      for (const date of args.dates) {
        const metrics = await ctx.db
          .query("metricsDaily")
          .withIndex("by_accountId_date", (q) =>
            q.eq("accountId", account._id).eq("date", date)
          )
          .collect();

        for (const m of metrics) {
          totalImpressions += m.impressions || 0;
          totalClicks += m.clicks || 0;
          totalSpent += m.spent || 0;
          totalLeads += m.leads || 0;

          if (m.campaignId) {
            const existing = campaignMetrics.get(m.campaignId) || { impressions: 0, clicks: 0, spent: 0, leads: 0 };
            existing.impressions += m.impressions || 0;
            existing.clicks += m.clicks || 0;
            existing.spent += m.spent || 0;
            existing.leads += m.leads || 0;
            campaignMetrics.set(m.campaignId, existing);
          }
        }
      }

      // Convert Map to serializable array
      const campaignsArray: Array<{ campaignId: string; impressions: number; clicks: number; spent: number; leads: number }> = [];
      campaignMetrics.forEach((v, k) => campaignsArray.push({ campaignId: k, ...v }));

      result.push({
        accountId: account._id,
        accountName: account.name,
        campaigns: campaignsArray as unknown as Map<string, { impressions: number; clicks: number; spent: number; leads: number }>,
        impressions: totalImpressions,
        clicks: totalClicks,
        spent: Math.round(totalSpent * 100) / 100,
        leads: totalLeads,
      });
    }

    return result;
  },
});
```

**Note:** The `campaigns` field is actually serialized as an array — Convex cannot return Maps. Rename the type in the return to match:

```typescript
// The actual return type per account:
{
  accountId: string;
  accountName: string;
  campaigns: Array<{ campaignId: string; impressions: number; clicks: number; spent: number; leads: number }>;
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
}
```

- [ ] **Step 2: Add `getActionLogsByAccount` query**

Add after `getMetricsByAccount`:

```typescript
/** Get action logs grouped by account + rule for digest period */
export const getActionLogsByAccount = internalQuery({
  args: {
    userId: v.id("users"),
    since: v.number(),
    until: v.number(),
  },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", args.userId).gte("createdAt", args.since)
      )
      .collect();

    const filtered = logs.filter((l) => l.createdAt < args.until);

    // Group by accountId → ruleName → count
    const byAccount = new Map<string, { events: Map<string, number>; savedAmount: number }>();

    for (const log of filtered) {
      const accId = log.accountId as string;
      if (!byAccount.has(accId)) {
        byAccount.set(accId, { events: new Map(), savedAmount: 0 });
      }
      const acc = byAccount.get(accId)!;

      // Get rule name — use ruleId to fetch rule
      const rule = await ctx.db.get(log.ruleId);
      const ruleName = rule?.name || log.reason.split("—")[0].trim();

      acc.events.set(ruleName, (acc.events.get(ruleName) || 0) + 1);
      acc.savedAmount += log.savedAmount;
    }

    // Convert to serializable
    const result: Array<{
      accountId: string;
      ruleEvents: Array<{ ruleName: string; count: number }>;
      savedAmount: number;
    }> = [];

    byAccount.forEach((data, accountId) => {
      const ruleEvents: Array<{ ruleName: string; count: number }> = [];
      data.events.forEach((count, ruleName) => {
        ruleEvents.push({ ruleName, count });
      });
      // Sort by count descending
      ruleEvents.sort((a, b) => b.count - a.count);
      result.push({ accountId, ruleEvents, savedAmount: data.savedAmount });
    });

    return result;
  },
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add convex/telegram.ts
git commit -m "feat(digest): add per-account metrics and rule event queries"
```

---

### Task 3: Implement `collectDigestData` action

**Files:**
- Modify: `convex/telegram.ts` (add new internalAction after queries)

- [ ] **Step 1: Add `collectDigestData` action**

This is the main data pipeline that fetches VK API package data and classifies leads/subscriptions. Add as internalAction:

```typescript
/** Collect digest data for a user: metrics + rule events, per account, with lead/subscription split */
export const collectDigestData = internalAction({
  args: {
    userId: v.id("users"),
    dates: v.array(v.string()),
    prevDates: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<DigestData> => {
    const dayMs = 24 * 60 * 60 * 1000;

    // Time range for action logs
    const sinceDate = new Date(args.dates[0] + "T00:00:00Z");
    const untilDate = new Date(args.dates[args.dates.length - 1] + "T23:59:59Z");
    const since = sinceDate.getTime();
    const until = untilDate.getTime() + 1000;

    // Fetch metrics and rule events in parallel
    const [accountMetrics, accountRuleEvents] = await Promise.all([
      ctx.runQuery(internal.telegram.getMetricsByAccount, {
        userId: args.userId,
        dates: args.dates,
      }),
      ctx.runQuery(internal.telegram.getActionLogsByAccount, {
        userId: args.userId,
        since,
        until,
      }),
    ]);

    // Fetch previous period metrics if requested
    let prevAccountMetrics: typeof accountMetrics | null = null;
    if (args.prevDates && args.prevDates.length > 0) {
      prevAccountMetrics = await ctx.runQuery(internal.telegram.getMetricsByAccount, {
        userId: args.userId,
        dates: args.prevDates,
      });
    }

    // For each account, fetch package mapping from VK API to classify leads vs subscriptions
    const accounts: DigestAccountData[] = [];

    for (const accMetrics of accountMetrics) {
      // Try to get VK API token for package classification
      let campaignTypeMap = new Map<string, "lead" | "subscription">();

      try {
        const accessToken = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId: accMetrics.accountId as any }
        );

        // Fetch packages + ad_groups to build campaign type map
        const [adPlans, adGroups, packages] = await Promise.all([
          ctx.runAction(api.vkApi.getMtAdPlans, { accessToken }),
          ctx.runAction(api.vkApi.getMtCampaigns, { accessToken }),
          // We need packages.json — call via probe or add new action
        ]);

        // For now, use ad_groups (= campaigns.json) which have package_id
        // and fetch packages separately
        const probeResult = await ctx.runAction(api.vkApi.probeVkCampaignEndpoints, { accessToken });
        const probeData = probeResult as Record<string, { body?: { items?: Array<{ id: number; name: string }> } }>;
        const packagesItems = probeData?.packages?.body?.items || [];
        const packageNameMap = new Map<number, string>();
        for (const pkg of packagesItems) {
          packageNameMap.set(pkg.id, pkg.name);
        }

        // campaigns.json items have package_id — these are ad_groups in VK Ads terms
        const campaignsItems = probeData?.campaigns_extended?.body?.items as Array<{ id: number; package_id?: number }> | undefined;
        // ad_groups have ad_plan_id + package_id
        const adGroupsItems = probeData?.ad_groups?.body?.items as Array<{ id: number; ad_plan_id: number; package_id: number }> | undefined;

        if (adGroupsItems && packageNameMap.size > 0) {
          // Build ad_plan_id → package_id (from first group)
          const planPackageMap = new Map<number, number>();
          for (const group of adGroupsItems) {
            if (!planPackageMap.has(group.ad_plan_id)) {
              planPackageMap.set(group.ad_plan_id, group.package_id);
            }
          }

          // Now classify each ad_plan
          for (const [planId, packageId] of planPackageMap) {
            const packageName = packageNameMap.get(packageId) || "";
            const type = isSubscriptionPackage(packageName) ? "subscription" : "lead";
            campaignTypeMap.set(String(planId), type);
          }
        }
      } catch {
        // Token expired or no access — all campaigns default to "lead"
      }

      // Split metrics by campaign type
      const campaignsData = accMetrics.campaigns as unknown as Array<{
        campaignId: string; impressions: number; clicks: number; spent: number; leads: number;
      }>;

      let leadSpent = 0, leadLeads = 0;
      let subSpent = 0, subLeads = 0;
      let totalImpressions = 0, totalClicks = 0, totalSpent = 0;

      for (const c of campaignsData) {
        totalImpressions += c.impressions;
        totalClicks += c.clicks;
        totalSpent += c.spent;

        const type = campaignTypeMap.get(c.campaignId) || "lead";
        if (type === "subscription") {
          subSpent += c.spent;
          subLeads += c.leads;
        } else {
          leadSpent += c.spent;
          leadLeads += c.leads;
        }
      }

      // If no campaign-level data, use account totals (all as leads)
      if (campaignsData.length === 0) {
        totalImpressions = accMetrics.impressions;
        totalClicks = accMetrics.clicks;
        totalSpent = accMetrics.spent;
        leadLeads = accMetrics.leads;
        leadSpent = accMetrics.spent;
      }

      const metrics: DigestMetrics = {
        impressions: totalImpressions,
        clicks: totalClicks,
        spent: Math.round(totalSpent * 100) / 100,
        leads: leadLeads,
        subscriptions: subLeads,
        cpl: leadLeads > 0 ? Math.round(leadSpent / leadLeads) : 0,
        costPerSub: subLeads > 0 ? Math.round(subSpent / subLeads) : 0,
      };

      // Previous period metrics (simplified — no campaign type split for prev period)
      let prevMetrics: DigestMetrics | undefined;
      if (prevAccountMetrics) {
        const prevAcc = prevAccountMetrics.find((a) => a.accountId === accMetrics.accountId);
        if (prevAcc) {
          // For previous period, use same campaign type map
          const prevCampaigns = prevAcc.campaigns as unknown as Array<{
            campaignId: string; impressions: number; clicks: number; spent: number; leads: number;
          }>;

          let prevLeadSpent = 0, prevLeadLeads = 0;
          let prevSubSpent = 0, prevSubLeads = 0;
          let prevTotalImpressions = 0, prevTotalClicks = 0, prevTotalSpent = 0;

          for (const c of prevCampaigns) {
            prevTotalImpressions += c.impressions;
            prevTotalClicks += c.clicks;
            prevTotalSpent += c.spent;
            const type = campaignTypeMap.get(c.campaignId) || "lead";
            if (type === "subscription") {
              prevSubSpent += c.spent;
              prevSubLeads += c.leads;
            } else {
              prevLeadSpent += c.spent;
              prevLeadLeads += c.leads;
            }
          }

          if (prevCampaigns.length === 0) {
            prevTotalImpressions = prevAcc.impressions;
            prevTotalClicks = prevAcc.clicks;
            prevTotalSpent = prevAcc.spent;
            prevLeadLeads = prevAcc.leads;
            prevLeadSpent = prevAcc.spent;
          }

          prevMetrics = {
            impressions: prevTotalImpressions,
            clicks: prevTotalClicks,
            spent: Math.round(prevTotalSpent * 100) / 100,
            leads: prevLeadLeads,
            subscriptions: prevSubLeads,
            cpl: prevLeadLeads > 0 ? Math.round(prevLeadSpent / prevLeadLeads) : 0,
            costPerSub: prevSubLeads > 0 ? Math.round(prevSubSpent / prevSubLeads) : 0,
          };
        }
      }

      // Rule events for this account
      const accRules = accountRuleEvents.find((a) => a.accountId === accMetrics.accountId);

      accounts.push({
        name: accMetrics.accountName,
        metrics,
        prevMetrics,
        ruleEvents: accRules?.ruleEvents || [],
        savedAmount: accRules?.savedAmount || 0,
      });
    }

    // Calculate totals
    const totals: DigestMetrics = {
      impressions: accounts.reduce((s, a) => s + a.metrics.impressions, 0),
      clicks: accounts.reduce((s, a) => s + a.metrics.clicks, 0),
      spent: Math.round(accounts.reduce((s, a) => s + a.metrics.spent, 0) * 100) / 100,
      leads: accounts.reduce((s, a) => s + a.metrics.leads, 0),
      subscriptions: accounts.reduce((s, a) => s + a.metrics.subscriptions, 0),
      cpl: 0,
      costPerSub: 0,
    };
    const totalLeadSpent = accounts.reduce((s, a) => {
      const ratio = a.metrics.leads > 0 ? a.metrics.cpl * a.metrics.leads : 0;
      return s + ratio;
    }, 0);
    totals.cpl = totals.leads > 0 ? Math.round(totalLeadSpent / totals.leads) : 0;
    const totalSubSpent = accounts.reduce((s, a) => {
      const ratio = a.metrics.subscriptions > 0 ? a.metrics.costPerSub * a.metrics.subscriptions : 0;
      return s + ratio;
    }, 0);
    totals.costPerSub = totals.subscriptions > 0 ? Math.round(totalSubSpent / totals.subscriptions) : 0;

    // Previous totals
    let prevTotals: DigestMetrics | undefined;
    if (args.prevDates && args.prevDates.length > 0) {
      const accsWithPrev = accounts.filter((a) => a.prevMetrics);
      if (accsWithPrev.length > 0) {
        prevTotals = {
          impressions: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.impressions || 0), 0),
          clicks: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.clicks || 0), 0),
          spent: Math.round(accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.spent || 0), 0) * 100) / 100,
          leads: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.leads || 0), 0),
          subscriptions: accsWithPrev.reduce((s, a) => s + (a.prevMetrics?.subscriptions || 0), 0),
          cpl: 0,
          costPerSub: 0,
        };
        if (prevTotals.leads > 0) {
          const prevLeadSpent = accsWithPrev.reduce((s, a) => s + (a.prevMetrics ? a.prevMetrics.cpl * a.prevMetrics.leads : 0), 0);
          prevTotals.cpl = Math.round(prevLeadSpent / prevTotals.leads);
        }
        if (prevTotals.subscriptions > 0) {
          const prevSubSpent = accsWithPrev.reduce((s, a) => s + (a.prevMetrics ? a.prevMetrics.costPerSub * a.prevMetrics.subscriptions : 0), 0);
          prevTotals.costPerSub = Math.round(prevSubSpent / prevTotals.subscriptions);
        }
      }
    }

    return { accounts, totals, prevTotals };
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add convex/telegram.ts
git commit -m "feat(digest): add collectDigestData action with lead/subscription classification"
```

---

### Task 4: Rewrite formatting functions

**Files:**
- Modify: `convex/telegram.ts` (replace `formatDailyDigest`, `formatWeeklyDigest`, `formatMonthlyDigest`)

- [ ] **Step 1: Write tests for new formatting functions**

Add to `tests/digest-helpers.test.ts`:

```typescript
import { formatDigestMessage } from "../convex/telegram";
import type { DigestData } from "../convex/telegram";

describe("formatDigestMessage", () => {
  const sampleData: DigestData = {
    accounts: [{
      name: "Сервис Парк",
      metrics: {
        impressions: 106989,
        clicks: 278,
        spent: 6418,
        leads: 9,
        subscriptions: 571,
        cpl: 768,
        costPerSub: 52,
      },
      ruleEvents: [
        { ruleName: "Клики без лидов", count: 2 },
        { ruleName: "CPL лимит", count: 1 },
      ],
      savedAmount: 1200,
    }],
    totals: {
      impressions: 106989,
      clicks: 278,
      spent: 6418,
      leads: 9,
      subscriptions: 571,
      cpl: 768,
      costPerSub: 52,
    },
  };

  test("daily format includes account name", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("Сервис Парк");
    expect(msg).toContain("Дайджест за 01.04.2026");
  });

  test("daily format separates leads and subscriptions", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("Лиды: 9");
    expect(msg).toContain("Подписки: 571");
  });

  test("daily format groups rule events", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("Клики без лидов — 2");
    expect(msg).toContain("CPL лимит — 1");
    expect(msg).not.toContain("Ad 209963110");
  });

  test("hides leads line when leads = 0", () => {
    const noLeads: DigestData = {
      accounts: [{
        ...sampleData.accounts[0],
        metrics: { ...sampleData.accounts[0].metrics, leads: 0, cpl: 0 },
      }],
      totals: { ...sampleData.totals, leads: 0, cpl: 0 },
    };
    const msg = formatDigestMessage("daily", noLeads, "01.04.2026");
    expect(msg).not.toContain("Лиды:");
    expect(msg).toContain("Подписки: 571");
  });

  test("weekly format includes comparison header", () => {
    const dataWithPrev: DigestData = {
      ...sampleData,
      prevTotals: {
        impressions: 95000,
        clicks: 250,
        spent: 5900,
        leads: 8,
        subscriptions: 520,
        cpl: 800,
        costPerSub: 50,
      },
      accounts: [{
        ...sampleData.accounts[0],
        prevMetrics: {
          impressions: 95000,
          clicks: 250,
          spent: 5900,
          leads: 8,
          subscriptions: 520,
          cpl: 800,
          costPerSub: 50,
        },
      }],
    };
    const msg = formatDigestMessage("weekly", dataWithPrev, "24.03 — 30.03.2026", "17.03 — 23.03");
    expect(msg).toContain("Сравнение с прошлой неделей");
    expect(msg).toContain("↑");
  });

  test("totals line at the end", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("Итого:");
    expect(msg).toContain("расход 6 418₽");
  });
});
```

- [ ] **Step 2: Implement `formatDigestMessage`**

Replace the three old formatting functions with one unified function in `convex/telegram.ts`:

```typescript
export function formatDigestMessage(
  type: "daily" | "weekly" | "monthly",
  data: DigestData,
  periodStr: string,
  prevPeriodStr?: string,
): string {
  const lines: string[] = [];

  // Header
  if (type === "daily") {
    lines.push(`📊 <b>Дайджест за ${periodStr}</b>`);
  } else if (type === "weekly") {
    lines.push(`📊 <b>Сводка за неделю (${periodStr})</b>`);
  } else {
    lines.push(`📅 <b>Отчёт за ${periodStr}</b>`);
  }

  // Comparison header for weekly/monthly
  if (type !== "daily" && data.prevTotals && prevPeriodStr) {
    if (type === "weekly") {
      lines.push(`📉 Сравнение с прошлой неделей (${prevPeriodStr})`);
    } else {
      lines.push(`📉 Сравнение с ${prevPeriodStr}`);
    }
  }

  lines.push("");

  // Per-account blocks
  for (const account of data.accounts) {
    lines.push(`📋 <b>${account.name}:</b>`);

    const m = account.metrics;
    const p = account.prevMetrics;
    const showDelta = type !== "daily" && !!p;

    lines.push(`📈 Показы: ${m.impressions.toLocaleString("ru-RU")}${showDelta ? formatDelta(m.impressions, p!.impressions) : ""} | 👆 Клики: ${m.clicks.toLocaleString("ru-RU")}${showDelta ? formatDelta(m.clicks, p!.clicks) : ""}`);
    lines.push(`💰 Расход: ${m.spent.toLocaleString("ru-RU")}₽${showDelta ? formatDelta(m.spent, p!.spent) : ""}`);

    if (m.leads > 0) {
      lines.push(`🎯 Лиды: ${m.leads} | CPL: ${m.cpl}₽${showDelta && p!.cpl > 0 ? formatDelta(m.cpl, p!.cpl) : ""}`);
    }
    if (m.subscriptions > 0) {
      lines.push(`👥 Подписки: ${m.subscriptions} | Стоимость: ${m.costPerSub}₽${showDelta && p!.costPerSub > 0 ? formatDelta(m.costPerSub, p!.costPerSub) : ""}`);
    }

    lines.push("");

    // Rule events
    if (account.ruleEvents.length > 0) {
      const totalEvents = account.ruleEvents.reduce((s, e) => s + e.count, 0);
      lines.push(`⚙️ Правила: сработало ${totalEvents} ${pluralRu(totalEvents, "раз", "раза", "раз")}`);
      for (const event of account.ruleEvents) {
        lines.push(`• ${event.ruleName} — ${event.count} ${pluralRu(event.count, "раз", "раза", "раз")}`);
      }
      if (account.savedAmount > 0) {
        lines.push(`✅ Сэкономлено: ~${account.savedAmount.toLocaleString("ru-RU")}₽`);
      }
    } else {
      lines.push("✅ Правила не сработали");
    }

    lines.push("");
  }

  // Totals
  const t = data.totals;
  const pt = data.prevTotals;
  const showTotalDelta = type !== "daily" && !!pt;

  let totalsLine = `<b>Итого:</b> расход ${t.spent.toLocaleString("ru-RU")}₽${showTotalDelta ? formatDelta(t.spent, pt!.spent) : ""}`;
  if (t.leads > 0) totalsLine += `, лиды ${t.leads}`;
  if (t.subscriptions > 0) totalsLine += `, подписки ${t.subscriptions}`;

  lines.push(totalsLine);

  return lines.join("\n");
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/digest-helpers.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add convex/telegram.ts tests/digest-helpers.test.ts
git commit -m "feat(digest): unified formatDigestMessage with per-account blocks and lead/sub split"
```

---

### Task 5: Rewrite `sendDailyDigest`

**Files:**
- Modify: `convex/telegram.ts:1268-1355` (replace existing `sendDailyDigest`)

- [ ] **Step 1: Replace `sendDailyDigest`**

```typescript
export const sendDailyDigest = internalAction({
  args: {},
  handler: async (ctx) => {
    const recipients = await ctx.runQuery(
      internal.telegram.getDigestRecipients,
      {}
    );

    if (recipients.length === 0) return { sent: 0 };

    // Yesterday's date
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dateISO = yesterday.toISOString().slice(0, 10);
    const dateStr = `${String(yesterday.getDate()).padStart(2, "0")}.${String(yesterday.getMonth() + 1).padStart(2, "0")}.${yesterday.getFullYear()}`;

    let sentCount = 0;

    for (const recipient of recipients) {
      try {
        const data = await ctx.runAction(internal.telegram.collectDigestData, {
          userId: recipient.userId,
          dates: [dateISO],
        });

        // Skip if no accounts with data
        if (data.accounts.length === 0) continue;

        const message = formatDigestMessage("daily", data, dateStr);

        // Split message if > 4096 chars (Telegram limit)
        const messages = splitTelegramMessage(message);

        for (const msg of messages) {
          await ctx.runAction(internal.telegram.sendMessageWithRetry, {
            chatId: recipient.chatId,
            text: msg,
          });
        }
        sentCount++;
      } catch (err) {
        console.error(
          `[telegram] Failed to send daily digest to ${recipient.userId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return { sent: sentCount };
  },
});
```

- [ ] **Step 2: Add `splitTelegramMessage` helper**

```typescript
function splitTelegramMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const messages: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > maxLen && current.length > 0) {
      messages.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) messages.push(current);
  return messages;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add convex/telegram.ts
git commit -m "feat(digest): rewrite sendDailyDigest with new pipeline"
```

---

### Task 6: Rewrite `sendWeeklyDigest`

**Files:**
- Modify: `convex/telegram.ts:1477-1607` (replace existing)

- [ ] **Step 1: Replace `sendWeeklyDigest`**

```typescript
export const sendWeeklyDigest = internalAction({
  args: {},
  handler: async (ctx) => {
    const recipients = await ctx.runQuery(
      internal.telegram.getDigestRecipients,
      {}
    );

    if (recipients.length === 0) return { sent: 0 };

    const now = Date.now();
    const nowDate = new Date(now);
    let sentCount = 0;

    for (const recipient of recipients) {
      const settings: Doc<"userSettings"> | null = await ctx.runQuery(
        internal.userSettings.getInternal,
        { userId: recipient.userId }
      );
      const tz = settings?.timezone || "Europe/Moscow";

      // Check if Monday 08:30-08:59 in user's timezone
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const timeParts = formatter.formatToParts(nowDate);
      const dayOfWeek = timeParts.find((p) => p.type === "weekday")?.value;
      const hour = parseInt(timeParts.find((p) => p.type === "hour")?.value || "-1", 10);
      const minute = parseInt(timeParts.find((p) => p.type === "minute")?.value || "-1", 10);

      if (dayOfWeek !== "Mon" || hour !== 8 || minute < 30) continue;

      // Current week: 7 days ago through yesterday
      const dayMs = 24 * 60 * 60 * 1000;
      const dates: string[] = [];
      for (let i = 7; i >= 1; i--) {
        dates.push(new Date(now - i * dayMs).toISOString().slice(0, 10));
      }

      // Previous week: 14 days ago through 8 days ago
      const prevDates: string[] = [];
      for (let i = 14; i >= 8; i--) {
        prevDates.push(new Date(now - i * dayMs).toISOString().slice(0, 10));
      }

      // Period strings
      const startDate = new Date(now - 7 * dayMs);
      const endDate = new Date(now - 1 * dayMs);
      const periodStr = `${fmtDD(startDate)}.${fmtMM(startDate)} — ${fmtDD(endDate)}.${fmtMM(endDate)}.${endDate.getFullYear()}`;

      const prevStart = new Date(now - 14 * dayMs);
      const prevEnd = new Date(now - 8 * dayMs);
      const prevPeriodStr = `${fmtDD(prevStart)}.${fmtMM(prevStart)} — ${fmtDD(prevEnd)}.${fmtMM(prevEnd)}`;

      try {
        const data = await ctx.runAction(internal.telegram.collectDigestData, {
          userId: recipient.userId,
          dates,
          prevDates,
        });

        if (data.accounts.length === 0) continue;

        const message = formatDigestMessage("weekly", data, periodStr, prevPeriodStr);
        const messages = splitTelegramMessage(message);

        for (const msg of messages) {
          await ctx.runAction(internal.telegram.sendMessageWithRetry, {
            chatId: recipient.chatId,
            text: msg,
          });
        }
        sentCount++;
      } catch (err) {
        console.error(
          `[telegram] Failed to send weekly digest to ${recipient.userId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return { sent: sentCount };
  },
});

function fmtDD(d: Date): string { return String(d.getDate()).padStart(2, "0"); }
function fmtMM(d: Date): string { return String(d.getMonth() + 1).padStart(2, "0"); }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add convex/telegram.ts
git commit -m "feat(digest): rewrite sendWeeklyDigest with comparison and lead/sub split"
```

---

### Task 7: Rewrite `sendMonthlyDigest`

**Files:**
- Modify: `convex/telegram.ts:1734-1852` (replace existing)

- [ ] **Step 1: Replace `sendMonthlyDigest`**

```typescript
export const sendMonthlyDigest = internalAction({
  args: {},
  handler: async (ctx) => {
    const recipients = await ctx.runQuery(
      internal.telegram.getDigestRecipients,
      {}
    );

    if (recipients.length === 0) return { sent: 0 };

    const now = Date.now();
    const nowDate = new Date(now);
    let sentCount = 0;

    for (const recipient of recipients) {
      const settings: Doc<"userSettings"> | null = await ctx.runQuery(
        internal.userSettings.getInternal,
        { userId: recipient.userId }
      );
      const tz = settings?.timezone || "Europe/Moscow";

      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        day: "numeric",
        month: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const parts = formatter.formatToParts(nowDate);
      const day = parseInt(parts.find((p) => p.type === "day")?.value || "0", 10);
      const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "-1", 10);

      if (day !== 1 || hour !== 9) continue;

      const localMonth = parseInt(parts.find((p) => p.type === "month")?.value || "1", 10);
      const localYear = parseInt(parts.find((p) => p.type === "year")?.value || "2026", 10);

      // Previous month
      const prevMonth = localMonth === 1 ? 12 : localMonth - 1;
      const prevYear = localMonth === 1 ? localYear - 1 : localYear;
      const daysInPrevMonth = new Date(prevYear, prevMonth, 0).getDate();

      // Build date arrays
      const dates: string[] = [];
      for (let d = 1; d <= daysInPrevMonth; d++) {
        dates.push(`${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      }

      // Month before that (for comparison)
      const prevPrevMonth = prevMonth === 1 ? 12 : prevMonth - 1;
      const prevPrevYear = prevMonth === 1 ? prevYear - 1 : prevYear;
      const daysInPrevPrevMonth = new Date(prevPrevYear, prevPrevMonth, 0).getDate();

      const prevDates: string[] = [];
      for (let d = 1; d <= daysInPrevPrevMonth; d++) {
        prevDates.push(`${prevPrevYear}-${String(prevPrevMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      }

      const monthName = `${MONTH_NAMES_RU[prevMonth - 1]} ${prevYear}`;
      const prevMonthName = `${MONTH_NAMES_GENITIVE_RU[prevPrevMonth - 1]} ${prevPrevYear}`;

      try {
        const data = await ctx.runAction(internal.telegram.collectDigestData, {
          userId: recipient.userId,
          dates,
          prevDates,
        });

        if (data.accounts.length === 0) continue;

        const message = formatDigestMessage("monthly", data, monthName, prevMonthName);
        const messages = splitTelegramMessage(message);

        for (const msg of messages) {
          await ctx.runAction(internal.telegram.sendMessageWithRetry, {
            chatId: recipient.chatId,
            text: msg,
          });
        }
        sentCount++;
      } catch (err) {
        console.error(
          `[telegram] Failed to send monthly digest to ${recipient.userId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return { sent: sentCount };
  },
});
```

- [ ] **Step 2: Add genitive month names constant**

Add next to `MONTH_NAMES_RU`:

```typescript
const MONTH_NAMES_GENITIVE_RU = [
  "январём", "февралём", "мартом", "апрелем", "маем", "июнем",
  "июлем", "августом", "сентябрём", "октябрём", "ноябрём", "декабрём",
];
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add convex/telegram.ts
git commit -m "feat(digest): rewrite sendMonthlyDigest with comparison and lead/sub split"
```

---

### Task 8: Clean up old code and final verification

**Files:**
- Modify: `convex/telegram.ts` (remove dead code)

- [ ] **Step 1: Remove old formatting functions**

Delete:
- Old `formatDailyDigest` (lines ~145-206) — replaced by `formatDigestMessage`
- Old `formatWeeklyDigest` (lines ~1365-1427) — replaced
- Old `formatMonthlyDigest` (lines ~1622-1684) — replaced
- Old `getDigestMetricsSummary` — replaced by `getMetricsByAccount`
- Old `getWeeklyMetricsSummary` — replaced
- Old `getMonthlyMetricsSummary` — replaced
- Old `getAdDailyMetrics` — no longer needed (end-of-day metrics refresh removed in favor of grouped approach)

Keep:
- `getDigestActionLogs` — still used internally (by `getActionLogsByAccount`)
- `getDigestRecipients` — still used
- `sendMessageWithRetry` — still used
- `MONTH_NAMES_RU` — still used

- [ ] **Step 2: Run full typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No new errors

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Run lint**

Run: `npx eslint . --ext .ts,.tsx 2>&1 | tail -3`
Expected: ≤50 warnings

- [ ] **Step 5: Final commit**

```bash
git add convex/telegram.ts tests/digest-helpers.test.ts
git commit -m "refactor(digest): remove old digest functions, cleanup"
```
