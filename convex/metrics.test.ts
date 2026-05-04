import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

// Helper: create user + account
async function createTestUserWithAccount(t: ReturnType<typeof convexTest>) {
  const userId = await t.mutation(api.users.create, {
    email: "metrics@example.com",
    vkId: "metrics_user",
    name: "Metrics Test User",
  });
  await t.mutation(api.users.updateTier, { userId, tier: "start" });

  const accountId = await t.mutation(api.adAccounts.connect, {
    userId,
    vkAccountId: "M001",
    name: "Metrics Cabinet",
    accessToken: "token_metrics",
  });

  return { userId, accountId };
}

describe("metrics", () => {
  // ── Sprint 7 DoD #1: saveRealtime ──

  test("S7-DoD#1: saveRealtime saves metrics snapshot", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    const metricId = await t.mutation(api.metrics.saveRealtimePublic, {
      accountId,
      adId: "ad_100",
      spent: 250.5,
      leads: 3,
      impressions: 10000,
      clicks: 150,
    });

    expect(metricId).toBeDefined();

    // Verify saved data
    const latest = await t.query(api.metrics.getRealtimeByAd, {
      adId: "ad_100",
    });

    expect(latest).toBeDefined();
    expect(latest?.accountId).toBe(accountId);
    expect(latest?.adId).toBe("ad_100");
    expect(latest?.spent).toBe(250.5);
    expect(latest?.leads).toBe(3);
    expect(latest?.impressions).toBe(10000);
    expect(latest?.clicks).toBe(150);
    expect(latest?.timestamp).toBeGreaterThan(0);
  });

  test("saveRealtime creates multiple snapshots for same ad", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    // First snapshot
    await t.mutation(api.metrics.saveRealtimePublic, {
      accountId,
      adId: "ad_200",
      spent: 100,
      leads: 1,
      impressions: 5000,
      clicks: 80,
    });

    // Second snapshot (updated metrics)
    await t.mutation(api.metrics.saveRealtimePublic, {
      accountId,
      adId: "ad_200",
      spent: 200,
      leads: 2,
      impressions: 8000,
      clicks: 120,
    });

    // getRealtimeByAd returns the latest
    const latest = await t.query(api.metrics.getRealtimeByAd, {
      adId: "ad_200",
    });

    expect(latest).toBeDefined();
    expect(latest?.spent).toBe(200);
    expect(latest?.leads).toBe(2);
  });

  // ── Sprint 7 DoD #2: saveDaily with aggregation ──

  test("S7-DoD#2: saveDaily saves and calculates derived metrics", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    const metricId = await t.mutation(api.metrics.saveDailyPublic, {
      accountId,
      adId: "ad_300",
      date: "2026-01-27",
      impressions: 10000,
      clicks: 200,
      spent: 500,
      leads: 5,
    });

    expect(metricId).toBeDefined();

    // Verify saved data with calculated fields
    const daily = await t.query(api.metrics.getDailyByAd, {
      adId: "ad_300",
    });

    expect(daily).toHaveLength(1);
    const record = daily[0];
    expect(record.accountId).toBe(accountId);
    expect(record.date).toBe("2026-01-27");
    expect(record.impressions).toBe(10000);
    expect(record.clicks).toBe(200);
    expect(record.spent).toBe(500);
    expect(record.leads).toBe(5);
    // Derived metrics
    expect(record.cpl).toBe(100); // 500 / 5
    expect(record.ctr).toBe(2);   // (200 / 10000) * 100
    expect(record.cpc).toBe(2.5); // 500 / 200
  });

  test("saveDaily upserts existing record for same ad+date", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    // First save
    await t.mutation(api.metrics.saveDailyPublic, {
      accountId,
      adId: "ad_400",
      date: "2026-01-27",
      impressions: 5000,
      clicks: 100,
      spent: 250,
      leads: 2,
    });

    // Second save — should update, not create duplicate
    await t.mutation(api.metrics.saveDailyPublic, {
      accountId,
      adId: "ad_400",
      date: "2026-01-27",
      impressions: 8000,
      clicks: 180,
      spent: 400,
      leads: 4,
    });

    const daily = await t.query(api.metrics.getDailyByAd, {
      adId: "ad_400",
    });

    // Should be only 1 record (upserted)
    expect(daily).toHaveLength(1);
    expect(daily[0].impressions).toBe(8000);
    expect(daily[0].clicks).toBe(180);
    expect(daily[0].spent).toBe(400);
    expect(daily[0].leads).toBe(4);
    expect(daily[0].cpl).toBe(100); // 400 / 4
  });

  test("saveDaily handles zero leads (no division by zero)", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    await t.mutation(api.metrics.saveDailyPublic, {
      accountId,
      adId: "ad_500",
      date: "2026-01-27",
      impressions: 3000,
      clicks: 60,
      spent: 150,
      leads: 0,
    });

    const daily = await t.query(api.metrics.getDailyByAd, {
      adId: "ad_500",
    });

    expect(daily).toHaveLength(1);
    expect(daily[0].cpl).toBeUndefined(); // No leads → no CPL
    expect(daily[0].ctr).toBe(2); // (60/3000)*100
    expect(daily[0].cpc).toBe(2.5); // 150/60
  });

  test("saveDaily handles zero impressions (no division by zero)", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    await t.mutation(api.metrics.saveDailyPublic, {
      accountId,
      adId: "ad_600",
      date: "2026-01-27",
      impressions: 0,
      clicks: 0,
      spent: 0,
      leads: 0,
    });

    const daily = await t.query(api.metrics.getDailyByAd, {
      adId: "ad_600",
    });

    expect(daily).toHaveLength(1);
    expect(daily[0].cpl).toBeUndefined();
    expect(daily[0].ctr).toBeUndefined();
    expect(daily[0].cpc).toBeUndefined();
  });

  // ── Sprint 7 DoD #8: Empty response handling ──

  test("S7-DoD#8: empty stats produce no metrics records", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    // Don't save any metrics — simulating empty VK API response
    const daily = await t.query(api.metrics.getDailyByAccount, {
      accountId,
      date: "2026-01-27",
    });

    expect(daily).toHaveLength(0);

    const realtime = await t.query(api.metrics.getRealtimeByAd, {
      adId: "nonexistent_ad",
    });
    expect(realtime).toBeNull();
  });

  // ── Query tests ──

  test("getDailyByAd filters by date range", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    // Save 3 days of metrics
    for (const date of ["2026-01-25", "2026-01-26", "2026-01-27"]) {
      await t.mutation(api.metrics.saveDailyPublic, {
        accountId,
        adId: "ad_700",
        date,
        impressions: 1000,
        clicks: 50,
        spent: 100,
        leads: 1,
      });
    }

    // Filter by date range
    const filtered = await t.query(api.metrics.getDailyByAd, {
      adId: "ad_700",
      dateFrom: "2026-01-26",
      dateTo: "2026-01-26",
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].date).toBe("2026-01-26");

    // No filter — all 3
    const all = await t.query(api.metrics.getDailyByAd, {
      adId: "ad_700",
    });
    expect(all).toHaveLength(3);
  });

  test("getDailyByAccount returns metrics for specific date", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    // Save metrics for 2 ads on same date
    await t.mutation(api.metrics.saveDailyPublic, {
      accountId,
      adId: "ad_800",
      date: "2026-01-27",
      impressions: 5000,
      clicks: 100,
      spent: 200,
      leads: 2,
    });

    await t.mutation(api.metrics.saveDailyPublic, {
      accountId,
      adId: "ad_801",
      date: "2026-01-27",
      impressions: 3000,
      clicks: 60,
      spent: 150,
      leads: 1,
    });

    const daily = await t.query(api.metrics.getDailyByAccount, {
      accountId,
      date: "2026-01-27",
    });

    expect(daily).toHaveLength(2);
  });

  // ── Cleanup: deleteRealtimeBatch ──

  test("deleteRealtimeBatch deletes records older than retention period (2 days)", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    const now = Date.now();
    const fiveDaysAgo = now - 5 * 86_400_000;
    const oneDayAgo = now - 1 * 86_400_000;

    // Insert old record (5 days ago) — should be deleted
    await t.run(async (ctx) => {
      await ctx.db.insert("metricsRealtime", {
        accountId,
        adId: "ad_old",
        timestamp: fiveDaysAgo,
        spent: 100,
        leads: 1,
        impressions: 500,
        clicks: 10,
      });
    });

    // Insert fresh record (1 day ago) — should survive
    await t.run(async (ctx) => {
      await ctx.db.insert("metricsRealtime", {
        accountId,
        adId: "ad_fresh",
        timestamp: oneDayAgo,
        spent: 200,
        leads: 2,
        impressions: 1000,
        clicks: 20,
      });
    });

    // Run cleanup batch
    const result = await t.mutation(internal.metrics.deleteRealtimeBatch, {
      batchSize: 500,
    });

    expect(result.deleted).toBe(1);
    expect(result.hasMore).toBe(false);

    // Verify old record gone, fresh record remains
    const oldRecord = await t.query(api.metrics.getRealtimeByAd, { adId: "ad_old" });
    expect(oldRecord).toBeNull();

    const freshRecord = await t.query(api.metrics.getRealtimeByAd, { adId: "ad_fresh" });
    expect(freshRecord).toBeDefined();
    expect(freshRecord?.adId).toBe("ad_fresh");
  });

  test("deleteRealtimeBatch returns hasMore=true when batch is full", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);

    const tenDaysAgo = Date.now() - 10 * 86_400_000;

    // Insert 3 old records
    for (let i = 0; i < 3; i++) {
      await t.run(async (ctx) => {
        await ctx.db.insert("metricsRealtime", {
          accountId,
          adId: `ad_batch_${i}`,
          timestamp: tenDaysAgo + i * 1000,
          spent: 100,
          leads: 0,
          impressions: 500,
          clicks: 10,
        });
      });
    }

    // Delete with batchSize=2 — should delete 2, hasMore=true
    const result = await t.mutation(internal.metrics.deleteRealtimeBatch, {
      batchSize: 2,
    });

    expect(result.deleted).toBe(2);
    expect(result.hasMore).toBe(true);

    // Second batch — should delete 1, hasMore=false
    const result2 = await t.mutation(internal.metrics.deleteRealtimeBatch, {
      batchSize: 2,
    });

    expect(result2.deleted).toBe(1);
    expect(result2.hasMore).toBe(false);
  });

  test("deleteRealtimeBatch returns 0 when nothing to delete", async () => {
    const t = convexTest(schema);

    const result = await t.mutation(internal.metrics.deleteRealtimeBatch, {
      batchSize: 500,
    });

    expect(result.deleted).toBe(0);
    expect(result.hasMore).toBe(false);
  });
});

describe("saveDailyBatch — dirty-check", () => {
  test("first call → inserted=1", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);
    const r = await t.mutation(internal.metrics.saveDailyBatch, {
      accountId,
      items: [{ adId: "ad1", date: "2026-05-04", impressions: 100, clicks: 5, spent: 50, leads: 1 }],
    });
    expect(r).toEqual({ inserted: 1, patched: 0, skipped: 0 });
  });

  test("same metrics → skipped=1", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);
    const item = { adId: "ad1", date: "2026-05-04", impressions: 100, clicks: 5, spent: 50, leads: 1 };
    await t.mutation(internal.metrics.saveDailyBatch, { accountId, items: [item] });

    const r = await t.mutation(internal.metrics.saveDailyBatch, { accountId, items: [item] });
    expect(r).toEqual({ inserted: 0, patched: 0, skipped: 1 });
  });

  test("changed spent → patched=1", async () => {
    const t = convexTest(schema);
    const { accountId } = await createTestUserWithAccount(t);
    await t.mutation(internal.metrics.saveDailyBatch, {
      accountId,
      items: [{ adId: "ad1", date: "2026-05-04", impressions: 100, clicks: 5, spent: 50, leads: 1 }],
    });

    const r = await t.mutation(internal.metrics.saveDailyBatch, {
      accountId,
      items: [{ adId: "ad1", date: "2026-05-04", impressions: 100, clicks: 5, spent: 75, leads: 1 }],
    });
    expect(r).toEqual({ inserted: 0, patched: 1, skipped: 0 });
  });
});
