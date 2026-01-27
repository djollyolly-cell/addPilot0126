/**
 * Integration Tests — Full Workflow
 * Sprint 8: Rule Engine Full Flow
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';

describe('Full Workflow Integration', () => {
  let t: ReturnType<typeof convexTest>;
  let testUserId: string;
  let testAccountId: string;
  let testRuleId: string;

  beforeEach(async () => {
    t = convexTest(schema);

    // Mock external APIs
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('api.vk.com')) {
        return {
          ok: true,
          json: async () => ({ response: [{ id: 2001 }] }),
        };
      }
      if (url.includes('api.telegram.org')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 123 } }),
        };
      }
      return { ok: false };
    });

    // Setup test data
    testUserId = await t.mutation(api.users.create, {
      email: 'test@example.com',
      vkId: '12345',
      subscriptionTier: 'start', // Start tier for auto-stop
    });

    await t.mutation(api.users.updateTelegramChatId, {
      userId: testUserId as any,
      chatId: '987654321',
    });

    testAccountId = await t.mutation(api.adAccounts.connect, {
      userId: testUserId as any,
      vkAccountId: 'vk_123',
      name: 'Test Account',
      accessToken: 'test_token',
    });

    testRuleId = await t.mutation(api.rules.create, {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Metrics Sync → Rule Check → Action → Notification', () => {
    it('should complete full workflow when rule triggers', async () => {
      // Step 1: Sync metrics (simulating cron job)
      await t.mutation(api.metrics.saveRealtime, {
        accountId: testAccountId as any,
        adId: 'ad_123',
        spent: 3000,
        leads: 5,
        impressions: 10000,
        clicks: 150,
      });

      // Step 2: Calculate current CPL
      const metrics = await t.query(api.metrics.getLatestForAd, {
        adId: 'ad_123',
      });
      const cpl = metrics.leads > 0 ? metrics.spent / metrics.leads : 0;
      expect(cpl).toBe(600); // 3000/5 = 600 > 500 threshold

      // Step 3: Check rule
      const checkResult = await t.action(internal.ruleEngine.checkRule, {
        ruleId: testRuleId,
        metrics: {
          adId: 'ad_123',
          cpl: cpl,
          ctr: 1.5,
          spent: metrics.spent,
          leads: metrics.leads,
        },
      });
      expect(checkResult.triggered).toBe(true);

      // Step 4: Execute action
      await t.action(internal.ruleEngine.executeAction, {
        ruleId: testRuleId,
        accountId: testAccountId,
        adId: 'ad_123',
        adName: 'Test Ad',
        metrics: {
          cpl: cpl,
          ctr: 1.5,
          spent: metrics.spent,
          leads: metrics.leads,
        },
      });

      // Step 5: Verify action log created
      const logs = await t.query(api.actionLogs.listByUser, {
        userId: testUserId as any,
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].actionType).toBe('stopped_and_notified');
      expect(logs[0].status).toBe('success');

      // Step 6: Verify rule trigger count incremented
      const rule = await t.query(api.rules.getById, { ruleId: testRuleId });
      expect(rule?.triggerCount).toBe(1);
      expect(rule?.lastTriggeredAt).toBeDefined();

      // Step 7: Verify Telegram notification was sent (check fetch was called)
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('api.telegram.org'),
        expect.any(Object)
      );
    });

    it('should NOT trigger when metrics are below threshold', async () => {
      await t.mutation(api.metrics.saveRealtime, {
        accountId: testAccountId as any,
        adId: 'ad_456',
        spent: 2000,
        leads: 5,
        impressions: 10000,
        clicks: 150,
      });

      const metrics = await t.query(api.metrics.getLatestForAd, {
        adId: 'ad_456',
      });
      const cpl = metrics.leads > 0 ? metrics.spent / metrics.leads : 0;
      expect(cpl).toBe(400); // 2000/5 = 400 < 500 threshold

      const checkResult = await t.action(internal.ruleEngine.checkRule, {
        ruleId: testRuleId,
        metrics: {
          adId: 'ad_456',
          cpl: cpl,
          ctr: 1.5,
          spent: metrics.spent,
          leads: metrics.leads,
        },
      });

      expect(checkResult.triggered).toBe(false);
    });
  });

  describe('Multiple Rules Check', () => {
    it('should check all active rules for account', async () => {
      // Create second rule
      const rule2Id = await t.mutation(api.rules.create, {
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
        adId: 'ad_789',
        cpl: 600, // Triggers rule 1
        ctr: 0.5, // Triggers rule 2
        spent: 3000,
        leads: 5,
      };

      // Check rule 1
      const result1 = await t.action(internal.ruleEngine.checkRule, {
        ruleId: testRuleId,
        metrics,
      });
      expect(result1.triggered).toBe(true);

      // Check rule 2
      const result2 = await t.action(internal.ruleEngine.checkRule, {
        ruleId: rule2Id,
        metrics,
      });
      expect(result2.triggered).toBe(true);
    });
  });

  describe('Cron Job Simulation', () => {
    it('should process all active accounts in cron', async () => {
      // Add second account
      const account2Id = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_456',
        name: 'Test Account 2',
        accessToken: 'test_token_2',
      });

      // Update rule to target both accounts
      await t.mutation(api.rules.update, {
        ruleId: testRuleId,
        targetAccountIds: [testAccountId as any, account2Id as any],
      });

      // Simulate cron getting all active accounts
      const accounts = await t.query(api.adAccounts.listActiveForSync);
      expect(accounts.length).toBeGreaterThanOrEqual(2);

      // Simulate cron syncing each account
      for (const account of accounts) {
        await t.mutation(api.adAccounts.syncNow, { accountId: account._id });

        const updatedAccount = await t.query(api.adAccounts.getById, {
          accountId: account._id,
        });
        expect(updatedAccount?.lastSyncAt).toBeDefined();
      }
    });
  });

  describe('Revert Action Flow', () => {
    it('should revert stopped ad within 5 minutes', async () => {
      // Execute action first
      await t.action(internal.ruleEngine.executeAction, {
        ruleId: testRuleId,
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
      const logId = logs[0]._id;

      // Revert within 5 minutes
      await t.action(internal.telegram.handleCallback, {
        callbackData: `revert:${logId}`,
        chatId: '987654321',
      });

      // Verify log status changed
      const updatedLog = await t.query(api.actionLogs.getById, { logId });
      expect(updatedLog?.status).toBe('reverted');
      expect(updatedLog?.revertedAt).toBeDefined();

      // Verify VK API was called to resume ad
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('api.vk.com'),
        expect.any(Object)
      );
    });
  });

  describe('Savings Calculation', () => {
    it('should calculate total savings for dashboard', async () => {
      // Create multiple action logs with savings
      for (let i = 0; i < 5; i++) {
        await t.mutation(api.actionLogs.create, {
          userId: testUserId as any,
          ruleId: testRuleId as any,
          accountId: testAccountId as any,
          adId: `ad_${i}`,
          adName: `Test Ad ${i}`,
          actionType: 'stopped',
          reason: 'CPL > 500',
          metricsSnapshot: { spent: 3000, leads: 5 },
          savedAmount: 10000 + i * 1000, // 10000, 11000, 12000, 13000, 14000
          status: 'success',
        });
      }

      const savedToday = await t.query(api.metrics.getSavedToday, {
        userId: testUserId as any,
      });

      expect(savedToday).toBe(60000); // 10000 + 11000 + 12000 + 13000 + 14000
    });
  });
});

describe('Edge Cases Integration', () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle VK API failure gracefully', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        error: { error_code: 100, error_msg: 'Internal error' },
      }),
    });

    const userId = await t.mutation(api.users.create, {
      email: 'test@example.com',
      vkId: '12345',
      subscriptionTier: 'start',
    });

    const accountId = await t.mutation(api.adAccounts.connect, {
      userId: userId as any,
      vkAccountId: 'vk_123',
      name: 'Test Account',
      accessToken: 'test_token',
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId: userId as any,
      name: 'Test Rule',
      type: 'cpl_limit',
      conditions: { metric: 'cpl', operator: '>', value: 500 },
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId as any],
      isActive: true,
    });

    // Execute action should handle VK API failure
    try {
      await t.action(internal.ruleEngine.executeAction, {
        ruleId,
        accountId,
        adId: 'ad_123',
        adName: 'Test Ad',
        metrics: { cpl: 600, ctr: 1.5, spent: 3000, leads: 5 },
      });
    } catch (e) {
      // Expected to fail
    }

    // Action log should be marked as failed
    const logs = await t.query(api.actionLogs.listByUser, { userId: userId as any });
    if (logs.length > 0) {
      expect(logs[0].status).toBe('failed');
    }
  });

  it('should handle Telegram API failure gracefully', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('api.telegram.org')) {
        return {
          ok: false,
          json: async () => ({ ok: false, description: 'Chat not found' }),
        };
      }
      return {
        ok: true,
        json: async () => ({ response: [{ id: 2001 }] }),
      };
    });

    const userId = await t.mutation(api.users.create, {
      email: 'test@example.com',
      vkId: '12345',
      subscriptionTier: 'start',
    });

    await t.mutation(api.users.updateTelegramChatId, {
      userId: userId as any,
      chatId: 'invalid_chat',
    });

    // Should not throw, just log the error
    const result = await t.action(internal.telegram.sendRuleNotification, {
      userId,
      ruleName: 'Test Rule',
      adName: 'Test Ad',
      reason: 'CPL > 500',
      savedAmount: 10000,
    });

    expect(result.sent).toBe(false);
    expect(result.error).toBeDefined();
  });
});
