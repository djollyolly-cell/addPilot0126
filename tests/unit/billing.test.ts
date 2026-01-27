/**
 * Unit Tests — Billing Module
 * Sprint 24-25: Биллинг
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';

describe('billing module', () => {
  let t: ReturnType<typeof convexTest>;
  let testUserId: string;

  beforeEach(async () => {
    t = convexTest(schema);
    testUserId = await t.mutation(api.users.create, {
      email: 'test@example.com',
      vkId: '12345',
      subscriptionTier: 'freemium',
    });
  });

  describe('billing.handlePaymentWebhook', () => {
    it('should upgrade to Start on successful payment', async () => {
      await t.action(internal.billing.handlePaymentWebhook, {
        userId: testUserId,
        tier: 'start',
        paymentId: 'pay_123',
        amount: 990,
        status: 'success',
      });

      const user = await t.query(api.users.getById, { userId: testUserId as any });
      expect(user?.subscriptionTier).toBe('start');
    });

    it('should upgrade to Pro on successful payment', async () => {
      await t.action(internal.billing.handlePaymentWebhook, {
        userId: testUserId,
        tier: 'pro',
        paymentId: 'pay_456',
        amount: 2990,
        status: 'success',
      });

      const user = await t.query(api.users.getById, { userId: testUserId as any });
      expect(user?.subscriptionTier).toBe('pro');
    });

    it('should NOT upgrade on failed payment', async () => {
      await t.action(internal.billing.handlePaymentWebhook, {
        userId: testUserId,
        tier: 'start',
        paymentId: 'pay_789',
        amount: 990,
        status: 'failed',
      });

      const user = await t.query(api.users.getById, { userId: testUserId as any });
      expect(user?.subscriptionTier).toBe('freemium');
    });

    it('should record payment in history', async () => {
      await t.action(internal.billing.handlePaymentWebhook, {
        userId: testUserId,
        tier: 'start',
        paymentId: 'pay_123',
        amount: 990,
        status: 'success',
      });

      const payments = await t.query(api.billing.getPaymentHistory, {
        userId: testUserId as any,
      });

      expect(payments).toHaveLength(1);
      expect(payments[0].amount).toBe(990);
      expect(payments[0].status).toBe('success');
    });
  });

  describe('billing.checkExpiry', () => {
    it('should send notification 7 days before expiry', async () => {
      // Set subscription to expire in 7 days
      await t.mutation(api.users.setSubscriptionExpiry, {
        userId: testUserId as any,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        tier: 'start',
      });

      const result = await t.action(internal.billing.checkExpiry, {
        userId: testUserId,
      });

      expect(result.shouldNotify).toBe(true);
      expect(result.daysRemaining).toBe(7);
    });

    it('should send notification 1 day before expiry', async () => {
      await t.mutation(api.users.setSubscriptionExpiry, {
        userId: testUserId as any,
        expiresAt: Date.now() + 1 * 24 * 60 * 60 * 1000,
        tier: 'start',
      });

      const result = await t.action(internal.billing.checkExpiry, {
        userId: testUserId,
      });

      expect(result.shouldNotify).toBe(true);
      expect(result.daysRemaining).toBe(1);
      expect(result.urgent).toBe(true);
    });

    it('should NOT notify for freemium users', async () => {
      const result = await t.action(internal.billing.checkExpiry, {
        userId: testUserId,
      });

      expect(result.shouldNotify).toBe(false);
    });
  });

  describe('billing.handleDowngrade', () => {
    it('should deactivate extra accounts on downgrade from Start to Freemium', async () => {
      // Setup: User with Start tier and 3 accounts
      await t.mutation(api.users.updateTier, {
        userId: testUserId as any,
        tier: 'start',
      });

      const accountIds = [];
      for (let i = 1; i <= 3; i++) {
        const id = await t.mutation(api.adAccounts.connect, {
          userId: testUserId as any,
          vkAccountId: `vk_${i}`,
          name: `Account ${i}`,
          accessToken: `token_${i}`,
        });
        accountIds.push(id);
      }

      // Downgrade to Freemium
      await t.action(internal.billing.handleDowngrade, {
        userId: testUserId,
        newTier: 'freemium',
      });

      const accounts = await t.query(api.adAccounts.list, {
        userId: testUserId as any,
      });

      const activeAccounts = accounts.filter((a: any) => a.status === 'active');
      expect(activeAccounts).toHaveLength(1);
    });

    it('should deactivate extra rules on downgrade', async () => {
      // Setup: User with Start tier and 5 rules
      await t.mutation(api.users.updateTier, {
        userId: testUserId as any,
        tier: 'start',
      });

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_1',
        name: 'Account 1',
        accessToken: 'token_1',
      });

      for (let i = 1; i <= 5; i++) {
        await t.mutation(api.rules.create, {
          userId: testUserId as any,
          name: `Rule ${i}`,
          type: 'cpl_limit',
          conditions: { metric: 'cpl', operator: '>', value: 500 },
          actions: { stopAd: false, notify: true },
          targetAccountIds: [accountId as any],
          isActive: true,
        });
      }

      // Downgrade to Freemium
      await t.action(internal.billing.handleDowngrade, {
        userId: testUserId,
        newTier: 'freemium',
      });

      const rules = await t.query(api.rules.listByUser, {
        userId: testUserId as any,
      });

      const activeRules = rules.filter((r: any) => r.isActive);
      expect(activeRules).toHaveLength(2); // Freemium limit
    });

    it('should disable stopAd on downgrade to Freemium', async () => {
      // Setup: User with Start tier and stopAd rule
      await t.mutation(api.users.updateTier, {
        userId: testUserId as any,
        tier: 'start',
      });

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_1',
        name: 'Account 1',
        accessToken: 'token_1',
      });

      await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Auto-stop Rule',
        type: 'cpl_limit',
        conditions: { metric: 'cpl', operator: '>', value: 500 },
        actions: { stopAd: true, notify: true },
        targetAccountIds: [accountId as any],
        isActive: true,
      });

      // Downgrade to Freemium
      await t.action(internal.billing.handleDowngrade, {
        userId: testUserId,
        newTier: 'freemium',
      });

      const rules = await t.query(api.rules.listByUser, {
        userId: testUserId as any,
      });

      const stopAdRules = rules.filter((r: any) => r.actions.stopAd);
      expect(stopAdRules).toHaveLength(0);
    });
  });

  describe('billing.getSubscriptionInfo', () => {
    it('should return subscription details', async () => {
      await t.mutation(api.users.updateTier, {
        userId: testUserId as any,
        tier: 'start',
      });

      await t.mutation(api.users.setSubscriptionExpiry, {
        userId: testUserId as any,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        tier: 'start',
      });

      const info = await t.query(api.billing.getSubscriptionInfo, {
        userId: testUserId as any,
      });

      expect(info.tier).toBe('start');
      expect(info.isActive).toBe(true);
      expect(info.daysRemaining).toBeGreaterThan(0);
    });

    it('should return freemium info for free users', async () => {
      const info = await t.query(api.billing.getSubscriptionInfo, {
        userId: testUserId as any,
      });

      expect(info.tier).toBe('freemium');
      expect(info.limits.accounts).toBe(1);
      expect(info.limits.rules).toBe(2);
      expect(info.limits.autoStop).toBe(false);
    });
  });

  describe('billing.createPaymentIntent', () => {
    it('should create payment intent for Start', async () => {
      const intent = await t.action(internal.billing.createPaymentIntent, {
        userId: testUserId,
        tier: 'start',
      });

      expect(intent.amount).toBe(990);
      expect(intent.currency).toBe('RUB');
      expect(intent.tier).toBe('start');
    });

    it('should create payment intent for Pro', async () => {
      const intent = await t.action(internal.billing.createPaymentIntent, {
        userId: testUserId,
        tier: 'pro',
      });

      expect(intent.amount).toBe(2990);
      expect(intent.currency).toBe('RUB');
      expect(intent.tier).toBe('pro');
    });

    it('should warn if already subscribed', async () => {
      await t.mutation(api.users.updateTier, {
        userId: testUserId as any,
        tier: 'start',
      });

      const intent = await t.action(internal.billing.createPaymentIntent, {
        userId: testUserId,
        tier: 'start',
      });

      expect(intent.warning).toContain('already');
    });
  });

  describe('billing.calculateROI', () => {
    it('should calculate ROI correctly', async () => {
      await t.mutation(api.users.updateTier, {
        userId: testUserId as any,
        tier: 'start',
      });

      // Add some savings
      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_1',
        name: 'Account 1',
        accessToken: 'token_1',
      });

      await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: 'rule_1' as any,
        accountId: accountId as any,
        adId: 'ad_1',
        adName: 'Test Ad',
        actionType: 'stopped',
        reason: 'CPL > 500',
        metricsSnapshot: { spent: 3000, leads: 5 },
        savedAmount: 50000, // Saved 50000 RUB
        status: 'success',
      });

      const roi = await t.query(api.billing.calculateROI, {
        userId: testUserId as any,
        period: 30, // days
      });

      // ROI = (savedAmount - subscriptionCost) / subscriptionCost * 100
      // ROI = (50000 - 990) / 990 * 100 = 4951%
      expect(roi.percentage).toBeGreaterThan(0);
      expect(roi.savedTotal).toBe(50000);
      expect(roi.subscriptionCost).toBe(990);
    });

    it('should return null ROI for Freemium', async () => {
      const roi = await t.query(api.billing.calculateROI, {
        userId: testUserId as any,
        period: 30,
      });

      expect(roi.percentage).toBeNull();
      expect(roi.message).toContain('Freemium');
    });
  });
});
