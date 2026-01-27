/**
 * Unit Tests — Ad Accounts Module
 * Sprint 2-3: Подключение рекламных кабинетов VK
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api } from '../../convex/_generated/api';

describe('adAccounts module', () => {
  let t: ReturnType<typeof convexTest>;
  let testUserId: string;

  beforeEach(async () => {
    t = convexTest(schema);
    // Create test user
    testUserId = await t.mutation(api.users.create, {
      email: 'test@example.com',
      vkId: '12345',
      subscriptionTier: 'freemium',
    });
  });

  describe('adAccounts.list', () => {
    it('should return empty array for new user', async () => {
      const accounts = await t.query(api.adAccounts.list, { userId: testUserId as any });
      expect(accounts).toEqual([]);
    });

    it('should return connected accounts', async () => {
      await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_123',
        name: 'Test Account',
        accessToken: 'token_123',
      });

      const accounts = await t.query(api.adAccounts.list, { userId: testUserId as any });
      expect(accounts).toHaveLength(1);
      expect(accounts[0].name).toBe('Test Account');
    });
  });

  describe('adAccounts.connect', () => {
    it('should connect a new account', async () => {
      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_123',
        name: 'Test Account',
        accessToken: 'token_123',
      });

      expect(accountId).toBeDefined();

      const account = await t.query(api.adAccounts.getById, { accountId });
      expect(account?.status).toBe('active');
    });

    it('should set lastSyncAt to undefined initially', async () => {
      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_123',
        name: 'Test Account',
        accessToken: 'token_123',
      });

      const account = await t.query(api.adAccounts.getById, { accountId });
      expect(account?.lastSyncAt).toBeUndefined();
    });

    it('should reject duplicate vkAccountId for same user', async () => {
      await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_123',
        name: 'Test Account 1',
        accessToken: 'token_123',
      });

      await expect(
        t.mutation(api.adAccounts.connect, {
          userId: testUserId as any,
          vkAccountId: 'vk_123',
          name: 'Test Account 2',
          accessToken: 'token_456',
        })
      ).rejects.toThrow('ACCOUNT_ALREADY_CONNECTED');
    });
  });

  describe('adAccounts.disconnect', () => {
    it('should disconnect an account', async () => {
      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_123',
        name: 'Test Account',
        accessToken: 'token_123',
      });

      await t.mutation(api.adAccounts.disconnect, { accountId });

      const account = await t.query(api.adAccounts.getById, { accountId });
      expect(account).toBeNull();
    });

    it('should handle non-existent account', async () => {
      await expect(
        t.mutation(api.adAccounts.disconnect, { accountId: 'nonexistent' as any })
      ).rejects.toThrow('ACCOUNT_NOT_FOUND');
    });
  });

  describe('adAccounts.syncNow', () => {
    it('should update lastSyncAt', async () => {
      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_123',
        name: 'Test Account',
        accessToken: 'token_123',
      });

      const before = Date.now();
      await t.mutation(api.adAccounts.syncNow, { accountId });
      const after = Date.now();

      const account = await t.query(api.adAccounts.getById, { accountId });
      expect(account?.lastSyncAt).toBeGreaterThanOrEqual(before);
      expect(account?.lastSyncAt).toBeLessThanOrEqual(after);
    });

    it('should clear lastError on successful sync', async () => {
      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_123',
        name: 'Test Account',
        accessToken: 'token_123',
      });

      // Simulate error
      await t.mutation(api.adAccounts.setError, {
        accountId,
        error: 'VK API Error',
      });

      // Sync should clear error
      await t.mutation(api.adAccounts.syncNow, { accountId });

      const account = await t.query(api.adAccounts.getById, { accountId });
      expect(account?.lastError).toBeUndefined();
      expect(account?.status).toBe('active');
    });
  });

  describe('adAccounts tier limits', () => {
    describe('Freemium tier', () => {
      it('should allow 1 account for Freemium', async () => {
        const accountId = await t.mutation(api.adAccounts.connect, {
          userId: testUserId as any,
          vkAccountId: 'vk_123',
          name: 'Test Account',
          accessToken: 'token_123',
        });

        expect(accountId).toBeDefined();
      });

      it('should reject 2nd account for Freemium', async () => {
        await t.mutation(api.adAccounts.connect, {
          userId: testUserId as any,
          vkAccountId: 'vk_123',
          name: 'Test Account 1',
          accessToken: 'token_123',
        });

        await expect(
          t.mutation(api.adAccounts.connect, {
            userId: testUserId as any,
            vkAccountId: 'vk_456',
            name: 'Test Account 2',
            accessToken: 'token_456',
          })
        ).rejects.toThrow('ACCOUNT_LIMIT_REACHED');
      });
    });

    describe('Start tier', () => {
      beforeEach(async () => {
        await t.mutation(api.users.updateTier, {
          userId: testUserId as any,
          tier: 'start',
        });
      });

      it('should allow up to 3 accounts for Start', async () => {
        for (let i = 1; i <= 3; i++) {
          const accountId = await t.mutation(api.adAccounts.connect, {
            userId: testUserId as any,
            vkAccountId: `vk_${i}`,
            name: `Test Account ${i}`,
            accessToken: `token_${i}`,
          });
          expect(accountId).toBeDefined();
        }
      });

      it('should reject 4th account for Start', async () => {
        for (let i = 1; i <= 3; i++) {
          await t.mutation(api.adAccounts.connect, {
            userId: testUserId as any,
            vkAccountId: `vk_${i}`,
            name: `Test Account ${i}`,
            accessToken: `token_${i}`,
          });
        }

        await expect(
          t.mutation(api.adAccounts.connect, {
            userId: testUserId as any,
            vkAccountId: 'vk_4',
            name: 'Test Account 4',
            accessToken: 'token_4',
          })
        ).rejects.toThrow('ACCOUNT_LIMIT_REACHED');
      });
    });

    describe('Pro tier', () => {
      beforeEach(async () => {
        await t.mutation(api.users.updateTier, {
          userId: testUserId as any,
          tier: 'pro',
        });
      });

      it('should allow unlimited accounts for Pro', async () => {
        for (let i = 1; i <= 10; i++) {
          const accountId = await t.mutation(api.adAccounts.connect, {
            userId: testUserId as any,
            vkAccountId: `vk_${i}`,
            name: `Test Account ${i}`,
            accessToken: `token_${i}`,
          });
          expect(accountId).toBeDefined();
        }
      });
    });
  });

  describe('adAccounts.updateStatus', () => {
    it('should update status to paused', async () => {
      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_123',
        name: 'Test Account',
        accessToken: 'token_123',
      });

      await t.mutation(api.adAccounts.updateStatus, {
        accountId,
        status: 'paused',
      });

      const account = await t.query(api.adAccounts.getById, { accountId });
      expect(account?.status).toBe('paused');
    });

    it('should update status to error', async () => {
      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_123',
        name: 'Test Account',
        accessToken: 'token_123',
      });

      await t.mutation(api.adAccounts.updateStatus, {
        accountId,
        status: 'error',
      });

      const account = await t.query(api.adAccounts.getById, { accountId });
      expect(account?.status).toBe('error');
    });
  });
});
