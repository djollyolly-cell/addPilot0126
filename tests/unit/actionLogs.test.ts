/**
 * Unit Tests — Action Logs Module
 * Sprint 8-9: Логирование действий
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api } from '../../convex/_generated/api';

describe('actionLogs module', () => {
  let t: ReturnType<typeof convexTest>;
  let testUserId: string;
  let testAccountId: string;
  let testRuleId: string;

  beforeEach(async () => {
    t = convexTest(schema);
    testUserId = await t.mutation(api.users.create, {
      email: 'test@example.com',
      vkId: '12345',
      subscriptionTier: 'start',
    });
    testAccountId = await t.mutation(api.adAccounts.connect, {
      userId: testUserId as any,
      vkAccountId: 'vk_123',
      name: 'Test Account',
      accessToken: 'token_123',
    });
    testRuleId = await t.mutation(api.rules.create, {
      userId: testUserId as any,
      name: 'Test Rule',
      type: 'cpl_limit',
      conditions: { metric: 'cpl', operator: '>', value: 500 },
      actions: { stopAd: true, notify: true },
      targetAccountIds: [testAccountId as any],
      isActive: true,
    });
  });

  describe('actionLogs.create', () => {
    it('should create action log with all fields', async () => {
      const logId = await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_123',
        adName: 'Test Ad',
        actionType: 'stopped',
        reason: 'CPL > 500 (текущий: 600)',
        metricsSnapshot: {
          cpl: 600,
          ctr: 1.5,
          spent: 3000,
          leads: 5,
        },
        savedAmount: 10000,
        status: 'success',
      });

      expect(logId).toBeDefined();

      const log = await t.query(api.actionLogs.getById, { logId });
      expect(log?.adId).toBe('ad_123');
      expect(log?.actionType).toBe('stopped');
      expect(log?.savedAmount).toBe(10000);
      expect(log?.status).toBe('success');
    });

    it('should set createdAt automatically', async () => {
      const before = Date.now();
      const logId = await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_123',
        adName: 'Test Ad',
        actionType: 'notified',
        reason: 'Test reason',
        metricsSnapshot: { spent: 1000, leads: 2 },
        savedAmount: 0,
        status: 'success',
      });
      const after = Date.now();

      const log = await t.query(api.actionLogs.getById, { logId });
      expect(log?.createdAt).toBeGreaterThanOrEqual(before);
      expect(log?.createdAt).toBeLessThanOrEqual(after);
    });

    it('should support different action types', async () => {
      const types: Array<'stopped' | 'notified' | 'stopped_and_notified'> = [
        'stopped',
        'notified',
        'stopped_and_notified',
      ];

      for (const actionType of types) {
        const logId = await t.mutation(api.actionLogs.create, {
          userId: testUserId as any,
          ruleId: testRuleId as any,
          accountId: testAccountId as any,
          adId: `ad_${actionType}`,
          adName: `Test Ad ${actionType}`,
          actionType,
          reason: 'Test reason',
          metricsSnapshot: { spent: 1000, leads: 2 },
          savedAmount: 5000,
          status: 'success',
        });

        const log = await t.query(api.actionLogs.getById, { logId });
        expect(log?.actionType).toBe(actionType);
      }
    });
  });

  describe('actionLogs.listByUser', () => {
    it('should return logs for specific user', async () => {
      // Create logs for test user
      for (let i = 0; i < 3; i++) {
        await t.mutation(api.actionLogs.create, {
          userId: testUserId as any,
          ruleId: testRuleId as any,
          accountId: testAccountId as any,
          adId: `ad_${i}`,
          adName: `Test Ad ${i}`,
          actionType: 'stopped',
          reason: 'Test reason',
          metricsSnapshot: { spent: 1000, leads: 2 },
          savedAmount: 5000,
          status: 'success',
        });
      }

      // Create log for another user
      const otherUserId = await t.mutation(api.users.create, {
        email: 'other@example.com',
        vkId: '99999',
        subscriptionTier: 'freemium',
      });

      await t.mutation(api.actionLogs.create, {
        userId: otherUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_other',
        adName: 'Other Ad',
        actionType: 'notified',
        reason: 'Other reason',
        metricsSnapshot: { spent: 500, leads: 1 },
        savedAmount: 0,
        status: 'success',
      });

      const logs = await t.query(api.actionLogs.listByUser, {
        userId: testUserId as any,
      });

      expect(logs).toHaveLength(3);
    });

    it('should return logs in reverse chronological order', async () => {
      for (let i = 0; i < 5; i++) {
        await t.mutation(api.actionLogs.create, {
          userId: testUserId as any,
          ruleId: testRuleId as any,
          accountId: testAccountId as any,
          adId: `ad_${i}`,
          adName: `Test Ad ${i}`,
          actionType: 'stopped',
          reason: 'Test reason',
          metricsSnapshot: { spent: 1000, leads: 2 },
          savedAmount: 5000 * (i + 1),
          status: 'success',
        });
      }

      const logs = await t.query(api.actionLogs.listByUser, {
        userId: testUserId as any,
      });

      // Newest first
      for (let i = 0; i < logs.length - 1; i++) {
        expect(logs[i].createdAt).toBeGreaterThanOrEqual(logs[i + 1].createdAt);
      }
    });

    it('should support pagination', async () => {
      for (let i = 0; i < 25; i++) {
        await t.mutation(api.actionLogs.create, {
          userId: testUserId as any,
          ruleId: testRuleId as any,
          accountId: testAccountId as any,
          adId: `ad_${i}`,
          adName: `Test Ad ${i}`,
          actionType: 'stopped',
          reason: 'Test reason',
          metricsSnapshot: { spent: 1000, leads: 2 },
          savedAmount: 5000,
          status: 'success',
        });
      }

      const page1 = await t.query(api.actionLogs.listByUserPaginated, {
        userId: testUserId as any,
        limit: 10,
        cursor: null,
      });

      expect(page1.items).toHaveLength(10);
      expect(page1.cursor).toBeDefined();

      const page2 = await t.query(api.actionLogs.listByUserPaginated, {
        userId: testUserId as any,
        limit: 10,
        cursor: page1.cursor,
      });

      expect(page2.items).toHaveLength(10);
      expect(page2.items[0]._id).not.toBe(page1.items[0]._id);
    });
  });

  describe('actionLogs.listByRule', () => {
    it('should return logs for specific rule', async () => {
      // Create second rule
      const rule2Id = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Rule 2',
        type: 'min_ctr',
        conditions: { metric: 'ctr', operator: '<', value: 1.0 },
        actions: { stopAd: true, notify: true },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      // Create logs for first rule
      await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_1',
        adName: 'Ad 1',
        actionType: 'stopped',
        reason: 'CPL',
        metricsSnapshot: { spent: 1000, leads: 2 },
        savedAmount: 5000,
        status: 'success',
      });

      // Create logs for second rule
      await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: rule2Id as any,
        accountId: testAccountId as any,
        adId: 'ad_2',
        adName: 'Ad 2',
        actionType: 'stopped',
        reason: 'CTR',
        metricsSnapshot: { spent: 1000, leads: 2 },
        savedAmount: 3000,
        status: 'success',
      });

      const logsRule1 = await t.query(api.actionLogs.listByRule, {
        ruleId: testRuleId,
      });

      expect(logsRule1).toHaveLength(1);
      expect(logsRule1[0].reason).toContain('CPL');
    });
  });

  describe('actionLogs.updateStatus', () => {
    it('should update status to reverted', async () => {
      const logId = await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_123',
        adName: 'Test Ad',
        actionType: 'stopped',
        reason: 'Test reason',
        metricsSnapshot: { spent: 1000, leads: 2 },
        savedAmount: 5000,
        status: 'success',
      });

      await t.mutation(api.actionLogs.updateStatus, {
        logId,
        status: 'reverted',
      });

      const log = await t.query(api.actionLogs.getById, { logId });
      expect(log?.status).toBe('reverted');
      expect(log?.revertedAt).toBeDefined();
    });

    it('should update status to failed', async () => {
      const logId = await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_123',
        adName: 'Test Ad',
        actionType: 'stopped',
        reason: 'Test reason',
        metricsSnapshot: { spent: 1000, leads: 2 },
        savedAmount: 5000,
        status: 'success',
      });

      await t.mutation(api.actionLogs.updateStatus, {
        logId,
        status: 'failed',
      });

      const log = await t.query(api.actionLogs.getById, { logId });
      expect(log?.status).toBe('failed');
    });
  });

  describe('actionLogs.search', () => {
    beforeEach(async () => {
      // Create diverse logs for search testing
      await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_summer',
        adName: 'Summer Sale Campaign',
        actionType: 'stopped',
        reason: 'CPL > 500',
        metricsSnapshot: { spent: 3000, leads: 5 },
        savedAmount: 10000,
        status: 'success',
      });

      await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_winter',
        adName: 'Winter Promo',
        actionType: 'notified',
        reason: 'CTR < 1.0',
        metricsSnapshot: { spent: 2000, leads: 3 },
        savedAmount: 0,
        status: 'success',
      });
    });

    it('should search by ad name', async () => {
      const results = await t.query(api.actionLogs.search, {
        userId: testUserId as any,
        query: 'Summer',
      });

      expect(results).toHaveLength(1);
      expect(results[0].adName).toContain('Summer');
    });

    it('should search by reason', async () => {
      const results = await t.query(api.actionLogs.search, {
        userId: testUserId as any,
        query: 'CPL',
      });

      expect(results).toHaveLength(1);
      expect(results[0].reason).toContain('CPL');
    });

    it('should return empty for no matches', async () => {
      const results = await t.query(api.actionLogs.search, {
        userId: testUserId as any,
        query: 'nonexistent12345',
      });

      expect(results).toHaveLength(0);
    });
  });

  describe('actionLogs.filter', () => {
    beforeEach(async () => {
      await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_1',
        adName: 'Ad 1',
        actionType: 'stopped',
        reason: 'Test',
        metricsSnapshot: { spent: 1000, leads: 2 },
        savedAmount: 5000,
        status: 'success',
      });

      await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_2',
        adName: 'Ad 2',
        actionType: 'notified',
        reason: 'Test',
        metricsSnapshot: { spent: 1000, leads: 2 },
        savedAmount: 0,
        status: 'success',
      });

      await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_3',
        adName: 'Ad 3',
        actionType: 'stopped_and_notified',
        reason: 'Test',
        metricsSnapshot: { spent: 1000, leads: 2 },
        savedAmount: 3000,
        status: 'failed',
      });
    });

    it('should filter by actionType', async () => {
      const results = await t.query(api.actionLogs.filter, {
        userId: testUserId as any,
        actionType: 'stopped',
      });

      expect(results).toHaveLength(1);
      expect(results[0].actionType).toBe('stopped');
    });

    it('should filter by status', async () => {
      const results = await t.query(api.actionLogs.filter, {
        userId: testUserId as any,
        status: 'failed',
      });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
    });

    it('should filter by accountId', async () => {
      const results = await t.query(api.actionLogs.filter, {
        userId: testUserId as any,
        accountId: testAccountId,
      });

      expect(results).toHaveLength(3);
    });

    it('should combine multiple filters', async () => {
      const results = await t.query(api.actionLogs.filter, {
        userId: testUserId as any,
        actionType: 'stopped',
        status: 'success',
      });

      expect(results).toHaveLength(1);
    });
  });

  describe('actionLogs.getRecentEvents', () => {
    it('should return limited recent events', async () => {
      for (let i = 0; i < 20; i++) {
        await t.mutation(api.actionLogs.create, {
          userId: testUserId as any,
          ruleId: testRuleId as any,
          accountId: testAccountId as any,
          adId: `ad_${i}`,
          adName: `Ad ${i}`,
          actionType: 'stopped',
          reason: 'Test',
          metricsSnapshot: { spent: 1000, leads: 2 },
          savedAmount: 5000,
          status: 'success',
        });
      }

      const events = await t.query(api.actionLogs.getRecentEvents, {
        userId: testUserId as any,
        limit: 10,
      });

      expect(events).toHaveLength(10);
    });
  });
});
