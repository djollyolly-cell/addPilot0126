/**
 * Unit Tests — Users Module
 * Sprint 1: Инфраструктура и Convex Setup
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api } from '../../convex/_generated/api';

describe('users module', () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema);
  });

  describe('users.create', () => {
    it('should create a new user with valid data', async () => {
      const userId = await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      expect(userId).toBeDefined();
      expect(typeof userId).toBe('string');
    });

    it('should set onboardingCompleted to false by default', async () => {
      const userId = await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      const user = await t.query(api.users.getById, { userId });
      expect(user?.onboardingCompleted).toBe(false);
    });

    it('should set createdAt timestamp', async () => {
      const before = Date.now();
      const userId = await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });
      const after = Date.now();

      const user = await t.query(api.users.getById, { userId });
      expect(user?.createdAt).toBeGreaterThanOrEqual(before);
      expect(user?.createdAt).toBeLessThanOrEqual(after);
    });

    it('should reject duplicate vkId', async () => {
      await t.mutation(api.users.create, {
        email: 'test1@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      await expect(
        t.mutation(api.users.create, {
          email: 'test2@example.com',
          vkId: '12345',
          subscriptionTier: 'freemium',
        })
      ).rejects.toThrow('VK_ID_EXISTS');
    });

    it('should reject invalid email format', async () => {
      await expect(
        t.mutation(api.users.create, {
          email: 'invalid-email',
          vkId: '12345',
          subscriptionTier: 'freemium',
        })
      ).rejects.toThrow('INVALID_EMAIL');
    });
  });

  describe('users.getByVkId', () => {
    it('should find user by vkId', async () => {
      await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      const user = await t.query(api.users.getByVkId, { vkId: '12345' });
      expect(user).toBeDefined();
      expect(user?.email).toBe('test@example.com');
    });

    it('should return null for non-existent vkId', async () => {
      const user = await t.query(api.users.getByVkId, { vkId: 'nonexistent' });
      expect(user).toBeNull();
    });
  });

  describe('users.updateTier', () => {
    it('should update subscription tier to start', async () => {
      const userId = await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      await t.mutation(api.users.updateTier, {
        userId,
        tier: 'start',
      });

      const user = await t.query(api.users.getById, { userId });
      expect(user?.subscriptionTier).toBe('start');
    });

    it('should update subscription tier to pro', async () => {
      const userId = await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      await t.mutation(api.users.updateTier, {
        userId,
        tier: 'pro',
      });

      const user = await t.query(api.users.getById, { userId });
      expect(user?.subscriptionTier).toBe('pro');
    });

    it('should reject invalid tier', async () => {
      const userId = await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      await expect(
        t.mutation(api.users.updateTier, {
          userId,
          tier: 'invalid' as any,
        })
      ).rejects.toThrow();
    });

    it('should reject non-existent userId', async () => {
      await expect(
        t.mutation(api.users.updateTier, {
          userId: 'nonexistent' as any,
          tier: 'start',
        })
      ).rejects.toThrow('USER_NOT_FOUND');
    });
  });

  describe('users.updateTelegramChatId', () => {
    it('should update telegramChatId', async () => {
      const userId = await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      await t.mutation(api.users.updateTelegramChatId, {
        userId,
        chatId: '987654321',
      });

      const user = await t.query(api.users.getById, { userId });
      expect(user?.telegramChatId).toBe('987654321');
    });

    it('should allow updating chatId multiple times', async () => {
      const userId = await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      await t.mutation(api.users.updateTelegramChatId, {
        userId,
        chatId: '111111',
      });

      await t.mutation(api.users.updateTelegramChatId, {
        userId,
        chatId: '222222',
      });

      const user = await t.query(api.users.getById, { userId });
      expect(user?.telegramChatId).toBe('222222');
    });
  });

  describe('users.completeOnboarding', () => {
    it('should set onboardingCompleted to true', async () => {
      const userId = await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      await t.mutation(api.users.completeOnboarding, { userId });

      const user = await t.query(api.users.getById, { userId });
      expect(user?.onboardingCompleted).toBe(true);
    });
  });

  describe('users.delete', () => {
    it('should delete user', async () => {
      const userId = await t.mutation(api.users.create, {
        email: 'test@example.com',
        vkId: '12345',
        subscriptionTier: 'freemium',
      });

      await t.mutation(api.users.delete, { userId });

      const user = await t.query(api.users.getById, { userId });
      expect(user).toBeNull();
    });
  });
});
