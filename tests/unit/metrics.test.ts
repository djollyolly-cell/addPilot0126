/**
 * Unit Tests — Metrics Module
 * Sprint 7: Синхронизация метрик
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';

describe('metrics module', () => {
  let t: ReturnType<typeof convexTest>;
  let testUserId: string;
  let testAccountId: string;

  beforeEach(async () => {
    t = convexTest(schema);
    testUserId = await t.mutation(api.users.create, {
      email: 'test@example.com',
      vkId: '12345',
      subscriptionTier: 'freemium',
    });
    testAccountId = await t.mutation(api.adAccounts.connect, {
      userId: testUserId as any,
      vkAccountId: 'vk_123',
      name: 'Test Account',
      accessToken: 'token_123',
    });
  });

  describe('metrics.saveRealtime', () => {
    it('should save realtime metrics', async () => {
      await t.mutation(api.metrics.saveRealtime, {
        accountId: testAccountId as any,
        adId: 'ad_123',
        spent: 1500,
        leads: 5,
        impressions: 10000,
        clicks: 150,
      });

      const metrics = await t.query(api.metrics.getRealtimeByAdId, {
        adId: 'ad_123',
      });

      expect(metrics).toHaveLength(1);
      expect(metrics[0].spent).toBe(1500);
      expect(metrics[0].leads).toBe(5);
    });

    it('should set timestamp automatically', async () => {
      const before = Date.now();
      await t.mutation(api.metrics.saveRealtime, {
        accountId: testAccountId as any,
        adId: 'ad_123',
        spent: 1500,
        leads: 5,
        impressions: 10000,
        clicks: 150,
      });
      const after = Date.now();

      const metrics = await t.query(api.metrics.getRealtimeByAdId, {
        adId: 'ad_123',
      });

      expect(metrics[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(metrics[0].timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('metrics.saveDaily', () => {
    it('should save daily aggregated metrics', async () => {
      await t.mutation(api.metrics.saveDaily, {
        accountId: testAccountId as any,
        adId: 'ad_123',
        date: '2026-01-25',
        impressions: 50000,
        clicks: 750,
        spent: 7500,
        leads: 25,
      });

      const metrics = await t.query(api.metrics.getDailyByAdId, {
        adId: 'ad_123',
        date: '2026-01-25',
      });

      expect(metrics).toBeDefined();
      expect(metrics?.spent).toBe(7500);
      expect(metrics?.leads).toBe(25);
    });

    it('should calculate CPL', async () => {
      await t.mutation(api.metrics.saveDaily, {
        accountId: testAccountId as any,
        adId: 'ad_123',
        date: '2026-01-25',
        impressions: 50000,
        clicks: 750,
        spent: 7500,
        leads: 25,
      });

      const metrics = await t.query(api.metrics.getDailyByAdId, {
        adId: 'ad_123',
        date: '2026-01-25',
      });

      expect(metrics?.cpl).toBe(300); // 7500 / 25 = 300
    });

    it('should calculate CTR', async () => {
      await t.mutation(api.metrics.saveDaily, {
        accountId: testAccountId as any,
        adId: 'ad_123',
        date: '2026-01-25',
        impressions: 50000,
        clicks: 750,
        spent: 7500,
        leads: 25,
      });

      const metrics = await t.query(api.metrics.getDailyByAdId, {
        adId: 'ad_123',
        date: '2026-01-25',
      });

      expect(metrics?.ctr).toBe(1.5); // (750 / 50000) * 100 = 1.5
    });

    it('should handle zero leads (CPL undefined)', async () => {
      await t.mutation(api.metrics.saveDaily, {
        accountId: testAccountId as any,
        adId: 'ad_123',
        date: '2026-01-25',
        impressions: 50000,
        clicks: 750,
        spent: 7500,
        leads: 0,
      });

      const metrics = await t.query(api.metrics.getDailyByAdId, {
        adId: 'ad_123',
        date: '2026-01-25',
      });

      expect(metrics?.cpl).toBeUndefined();
    });

    it('should handle zero impressions (CTR undefined)', async () => {
      await t.mutation(api.metrics.saveDaily, {
        accountId: testAccountId as any,
        adId: 'ad_123',
        date: '2026-01-25',
        impressions: 0,
        clicks: 0,
        spent: 0,
        leads: 0,
      });

      const metrics = await t.query(api.metrics.getDailyByAdId, {
        adId: 'ad_123',
        date: '2026-01-25',
      });

      expect(metrics?.ctr).toBeUndefined();
    });
  });

  describe('metrics.getByAccountAndDateRange', () => {
    it('should return metrics for date range', async () => {
      // Save metrics for multiple days
      for (let i = 20; i <= 25; i++) {
        await t.mutation(api.metrics.saveDaily, {
          accountId: testAccountId as any,
          adId: 'ad_123',
          date: `2026-01-${i}`,
          impressions: 10000 * i,
          clicks: 150 * i,
          spent: 1500 * i,
          leads: 5 * i,
        });
      }

      const metrics = await t.query(api.metrics.getByAccountAndDateRange, {
        accountId: testAccountId as any,
        startDate: '2026-01-22',
        endDate: '2026-01-25',
      });

      expect(metrics).toHaveLength(4);
    });
  });

  describe('metrics.getSavedToday', () => {
    it('should sum savedAmount for today', async () => {
      // Create action logs with saved amounts
      await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: 'rule_123' as any,
        accountId: testAccountId as any,
        adId: 'ad_123',
        adName: 'Test Ad 1',
        actionType: 'stopped',
        reason: 'CPL > 500',
        metricsSnapshot: { cpl: 600, spent: 3000, leads: 5 },
        savedAmount: 10000,
        status: 'success',
      });

      await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: 'rule_123' as any,
        accountId: testAccountId as any,
        adId: 'ad_456',
        adName: 'Test Ad 2',
        actionType: 'stopped',
        reason: 'CPL > 500',
        metricsSnapshot: { cpl: 700, spent: 4000, leads: 5 },
        savedAmount: 15000,
        status: 'success',
      });

      const saved = await t.query(api.metrics.getSavedToday, {
        userId: testUserId as any,
      });

      expect(saved).toBe(25000);
    });

    it('should return 0 for new user', async () => {
      const saved = await t.query(api.metrics.getSavedToday, {
        userId: testUserId as any,
      });

      expect(saved).toBe(0);
    });
  });

  describe('metrics.getSavedHistory', () => {
    it('should return savings by day for last 7 days', async () => {
      // This would need test data setup for multiple days
      const history = await t.query(api.metrics.getSavedHistory, {
        userId: testUserId as any,
        days: 7,
      });

      expect(history).toHaveLength(7);
      expect(history[0]).toHaveProperty('date');
      expect(history[0]).toHaveProperty('amount');
    });
  });

  describe('metrics.cleanupOldRealtime', () => {
    it('should delete realtime metrics older than 24 hours', async () => {
      // Save old metric
      await t.mutation(api.metrics.saveRealtimeWithTimestamp, {
        accountId: testAccountId as any,
        adId: 'ad_old',
        spent: 1000,
        leads: 3,
        impressions: 5000,
        clicks: 100,
        timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      });

      // Save recent metric
      await t.mutation(api.metrics.saveRealtime, {
        accountId: testAccountId as any,
        adId: 'ad_new',
        spent: 500,
        leads: 2,
        impressions: 3000,
        clicks: 50,
      });

      await t.mutation(internal.metrics.cleanupOldRealtime);

      const oldMetrics = await t.query(api.metrics.getRealtimeByAdId, {
        adId: 'ad_old',
      });
      const newMetrics = await t.query(api.metrics.getRealtimeByAdId, {
        adId: 'ad_new',
      });

      expect(oldMetrics).toHaveLength(0);
      expect(newMetrics).toHaveLength(1);
    });
  });

  describe('metrics.getActivityStats', () => {
    it('should return activity counts', async () => {
      // Create some action logs
      for (let i = 0; i < 5; i++) {
        await t.mutation(api.actionLogs.create, {
          userId: testUserId as any,
          ruleId: 'rule_123' as any,
          accountId: testAccountId as any,
          adId: `ad_${i}`,
          adName: `Test Ad ${i}`,
          actionType: i % 2 === 0 ? 'stopped' : 'notified',
          reason: 'Test reason',
          metricsSnapshot: { spent: 1000, leads: 3 },
          savedAmount: 5000,
          status: 'success',
        });
      }

      const stats = await t.query(api.metrics.getActivityStats, {
        userId: testUserId as any,
      });

      expect(stats.triggers).toBe(5);
      expect(stats.stops).toBe(3); // 0, 2, 4
      expect(stats.notifications).toBe(2); // 1, 3
    });
  });
});
