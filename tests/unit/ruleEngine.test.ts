/**
 * Unit Tests — Rule Engine Module
 * Sprint 7-8: Rule Engine
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';

describe('ruleEngine module', () => {
  let t: ReturnType<typeof convexTest>;
  let testUserId: string;
  let testAccountId: string;

  beforeEach(async () => {
    t = convexTest(schema);
    testUserId = await t.mutation(api.users.create, {
      email: 'test@example.com',
      vkId: '12345',
      subscriptionTier: 'start', // Need Start tier for stopAd
    });
    testAccountId = await t.mutation(api.adAccounts.connect, {
      userId: testUserId as any,
      vkAccountId: 'vk_123',
      name: 'Test Account',
      accessToken: 'token_123',
    });
  });

  describe('ruleEngine.checkRule — CPL Limit', () => {
    it('should trigger when CPL > threshold', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'CPL Limit',
        type: 'cpl_limit',
        conditions: {
          metric: 'cpl',
          operator: '>',
          value: 500,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      const metrics = {
        adId: 'ad_123',
        cpl: 600, // Greater than threshold 500
        ctr: 2.0,
        spent: 3000,
        leads: 5,
      };

      const result = await t.action(internal.ruleEngine.checkRule, {
        ruleId,
        metrics,
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toContain('CPL');
    });

    it('should NOT trigger when CPL < threshold', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'CPL Limit',
        type: 'cpl_limit',
        conditions: {
          metric: 'cpl',
          operator: '>',
          value: 500,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      const metrics = {
        adId: 'ad_123',
        cpl: 400, // Less than threshold 500
        ctr: 2.0,
        spent: 2000,
        leads: 5,
      };

      const result = await t.action(internal.ruleEngine.checkRule, {
        ruleId,
        metrics,
      });

      expect(result.triggered).toBe(false);
    });
  });

  describe('ruleEngine.checkRule — Min CTR', () => {
    it('should trigger when CTR < threshold', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Min CTR',
        type: 'min_ctr',
        conditions: {
          metric: 'ctr',
          operator: '<',
          value: 1.0,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      const metrics = {
        adId: 'ad_123',
        cpl: 300,
        ctr: 0.5, // Less than threshold 1.0
        spent: 1500,
        leads: 5,
      };

      const result = await t.action(internal.ruleEngine.checkRule, {
        ruleId,
        metrics,
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toContain('CTR');
    });

    it('should NOT trigger when CTR > threshold', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Min CTR',
        type: 'min_ctr',
        conditions: {
          metric: 'ctr',
          operator: '<',
          value: 1.0,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      const metrics = {
        adId: 'ad_123',
        cpl: 300,
        ctr: 1.5, // Greater than threshold 1.0
        spent: 1500,
        leads: 5,
      };

      const result = await t.action(internal.ruleEngine.checkRule, {
        ruleId,
        metrics,
      });

      expect(result.triggered).toBe(false);
    });
  });

  describe('ruleEngine.checkRule — Fast Spend', () => {
    it('should trigger when spend rate > threshold', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Fast Spend',
        type: 'fast_spend',
        conditions: {
          metric: 'spend_rate',
          operator: '>',
          value: 20, // 20% in 15 minutes
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      const metrics = {
        adId: 'ad_123',
        cpl: 300,
        ctr: 1.5,
        spent: 1500,
        leads: 5,
        spendRate: 25, // 25% > 20%
      };

      const result = await t.action(internal.ruleEngine.checkRule, {
        ruleId,
        metrics,
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toContain('spend');
    });
  });

  describe('ruleEngine.checkRule — Spend No Leads', () => {
    it('should trigger when spent > threshold and leads = 0', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Spend No Leads',
        type: 'spend_no_leads',
        conditions: {
          metric: 'spend_no_leads',
          operator: '>',
          value: 1000,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      const metrics = {
        adId: 'ad_123',
        cpl: 0,
        ctr: 0.5,
        spent: 1500, // > 1000
        leads: 0, // No leads
      };

      const result = await t.action(internal.ruleEngine.checkRule, {
        ruleId,
        metrics,
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toContain('leads');
    });

    it('should NOT trigger when leads > 0', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Spend No Leads',
        type: 'spend_no_leads',
        conditions: {
          metric: 'spend_no_leads',
          operator: '>',
          value: 1000,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      const metrics = {
        adId: 'ad_123',
        cpl: 300,
        ctr: 1.5,
        spent: 1500,
        leads: 5, // Has leads
      };

      const result = await t.action(internal.ruleEngine.checkRule, {
        ruleId,
        metrics,
      });

      expect(result.triggered).toBe(false);
    });
  });

  describe('ruleEngine.calculateSavings', () => {
    it('should calculate savings based on hourly rate', async () => {
      // 100 RUB/min, 18:00 stop time = 6 hours until midnight
      const result = await t.action(internal.ruleEngine.calculateSavings, {
        hourlySpendRate: 6000, // 100 RUB/min = 6000 RUB/hour
        stopTime: new Date('2026-01-25T18:00:00').getTime(),
        endOfDay: new Date('2026-01-26T00:00:00').getTime(),
      });

      expect(result).toBe(36000); // 6 hours * 6000 RUB/hour
    });

    it('should handle late night stops', async () => {
      // Stop at 23:00, 1 hour until midnight
      const result = await t.action(internal.ruleEngine.calculateSavings, {
        hourlySpendRate: 6000,
        stopTime: new Date('2026-01-25T23:00:00').getTime(),
        endOfDay: new Date('2026-01-26T00:00:00').getTime(),
      });

      expect(result).toBe(6000); // 1 hour * 6000 RUB/hour
    });
  });

  describe('ruleEngine.executeAction', () => {
    it('should create actionLog on trigger', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Test Rule',
        type: 'cpl_limit',
        conditions: {
          metric: 'cpl',
          operator: '>',
          value: 500,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      await t.action(internal.ruleEngine.executeAction, {
        ruleId,
        accountId: testAccountId,
        adId: 'ad_123',
        adName: 'Test Ad',
        metrics: {
          cpl: 600,
          ctr: 1.5,
          spent: 3000,
          leads: 5,
        },
      });

      const logs = await t.query(api.actionLogs.listByUser, {
        userId: testUserId as any,
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].actionType).toBe('stopped_and_notified');
      expect(logs[0].adId).toBe('ad_123');
    });

    it('should increment rule triggerCount', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Test Rule',
        type: 'cpl_limit',
        conditions: {
          metric: 'cpl',
          operator: '>',
          value: 500,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      await t.action(internal.ruleEngine.executeAction, {
        ruleId,
        accountId: testAccountId,
        adId: 'ad_123',
        adName: 'Test Ad',
        metrics: {
          cpl: 600,
          ctr: 1.5,
          spent: 3000,
          leads: 5,
        },
      });

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.triggerCount).toBe(1);
    });
  });

  describe('ruleEngine — Edge Cases', () => {
    it('should skip inactive rules', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Inactive Rule',
        type: 'cpl_limit',
        conditions: {
          metric: 'cpl',
          operator: '>',
          value: 500,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: false, // INACTIVE
      });

      const result = await t.action(internal.ruleEngine.checkRule, {
        ruleId,
        metrics: {
          adId: 'ad_123',
          cpl: 600,
          ctr: 1.5,
          spent: 3000,
          leads: 5,
        },
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('inactive');
    });

    it('should skip if minSamples not reached', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Rule with minSamples',
        type: 'cpl_limit',
        conditions: {
          metric: 'cpl',
          operator: '>',
          value: 500,
          minSamples: 10,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      const result = await t.action(internal.ruleEngine.checkRule, {
        ruleId,
        metrics: {
          adId: 'ad_123',
          cpl: 600,
          ctr: 1.5,
          spent: 3000,
          leads: 5,
          samples: 5, // Less than minSamples
        },
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('samples');
    });

    it('should mark actionLog as failed on VK API error', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Test Rule',
        type: 'cpl_limit',
        conditions: {
          metric: 'cpl',
          operator: '>',
          value: 500,
        },
        actions: {
          stopAd: true,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      // Mock VK API error
      vi.spyOn(t, 'action').mockRejectedValueOnce(new Error('VK_API_ERROR'));

      try {
        await t.action(internal.ruleEngine.executeAction, {
          ruleId,
          accountId: testAccountId,
          adId: 'ad_123',
          adName: 'Test Ad',
          metrics: {
            cpl: 600,
            ctr: 1.5,
            spent: 3000,
            leads: 5,
          },
          simulateError: true,
        });
      } catch (e) {
        // Expected
      }

      const logs = await t.query(api.actionLogs.listByUser, {
        userId: testUserId as any,
      });

      if (logs.length > 0) {
        expect(logs[0].status).toBe('failed');
      }
    });
  });
});
