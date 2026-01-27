/**
 * Unit Tests — Telegram Module
 * Sprint 9-12: Telegram Bot
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';

describe('telegram module', () => {
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

  describe('telegram.handleWebhook — /start', () => {
    it('should save chatId on /start command', async () => {
      const webhookPayload = {
        message: {
          chat: { id: 987654321 },
          text: '/start',
          from: { id: 123456789 },
        },
      };

      // Assume user has linked VK ID to Telegram
      await t.action(internal.telegram.handleWebhook, {
        payload: webhookPayload,
        vkId: '12345',
      });

      const user = await t.query(api.users.getByVkId, { vkId: '12345' });
      expect(user?.telegramChatId).toBe('987654321');
    });

    it('should update chatId on repeat /start', async () => {
      // First /start
      await t.action(internal.telegram.handleWebhook, {
        payload: {
          message: {
            chat: { id: 111111111 },
            text: '/start',
            from: { id: 123456789 },
          },
        },
        vkId: '12345',
      });

      // Second /start with different chat
      await t.action(internal.telegram.handleWebhook, {
        payload: {
          message: {
            chat: { id: 222222222 },
            text: '/start',
            from: { id: 123456789 },
          },
        },
        vkId: '12345',
      });

      const user = await t.query(api.users.getByVkId, { vkId: '12345' });
      expect(user?.telegramChatId).toBe('222222222');
    });
  });

  describe('telegram.sendMessage', () => {
    it('should format message correctly', async () => {
      const message = await t.action(internal.telegram.formatRuleNotification, {
        ruleName: 'CPL Limit',
        adName: 'Test Ad',
        reason: 'CPL > 500',
        savedAmount: 10000,
      });

      expect(message).toContain('CPL Limit');
      expect(message).toContain('Test Ad');
      expect(message).toContain('CPL > 500');
      expect(message).toContain('10000');
    });

    it('should include emoji in critical notifications', async () => {
      const message = await t.action(internal.telegram.formatRuleNotification, {
        ruleName: 'CPL Limit',
        adName: 'Test Ad',
        reason: 'CPL > 500',
        savedAmount: 10000,
        priority: 'critical',
      });

      expect(message).toMatch(/[🚨🔴⚠️]/); // Contains warning emoji
    });
  });

  describe('telegram.sendRuleNotification', () => {
    beforeEach(async () => {
      await t.mutation(api.users.updateTelegramChatId, {
        userId: testUserId as any,
        chatId: '987654321',
      });
    });

    it('should send notification when chatId exists', async () => {
      const result = await t.action(internal.telegram.sendRuleNotification, {
        userId: testUserId,
        ruleName: 'CPL Limit',
        adName: 'Test Ad',
        reason: 'CPL > 500',
        savedAmount: 10000,
      });

      expect(result.sent).toBe(true);
    });

    it('should NOT send when chatId is missing', async () => {
      const newUserId = await t.mutation(api.users.create, {
        email: 'notelergam@example.com',
        vkId: '99999',
        subscriptionTier: 'freemium',
      });

      const result = await t.action(internal.telegram.sendRuleNotification, {
        userId: newUserId,
        ruleName: 'CPL Limit',
        adName: 'Test Ad',
        reason: 'CPL > 500',
        savedAmount: 10000,
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toContain('chatId');
    });
  });

  describe('telegram.groupNotifications', () => {
    it('should group multiple events into one message', async () => {
      const events = [
        { adName: 'Ad 1', reason: 'CPL > 500' },
        { adName: 'Ad 2', reason: 'CTR < 1%' },
        { adName: 'Ad 3', reason: 'Spend > 1000' },
      ];

      const message = await t.action(internal.telegram.groupNotifications, {
        events,
        ruleName: 'Multiple Rules',
      });

      expect(message).toContain('Ad 1');
      expect(message).toContain('Ad 2');
      expect(message).toContain('Ad 3');
      expect(message).toContain('3'); // Count
    });

    it('should send single event without grouping', async () => {
      const events = [{ adName: 'Ad 1', reason: 'CPL > 500' }];

      const message = await t.action(internal.telegram.groupNotifications, {
        events,
        ruleName: 'Single Rule',
      });

      expect(message).toContain('Ad 1');
      expect(message).not.toContain('и ещё');
    });
  });

  describe('telegram.inlineKeyboard', () => {
    it('should create inline keyboard with 2 buttons', async () => {
      const keyboard = await t.action(internal.telegram.createInlineKeyboard, {
        actionLogId: 'log_123',
      });

      expect(keyboard.inline_keyboard).toHaveLength(1);
      expect(keyboard.inline_keyboard[0]).toHaveLength(2);
      expect(keyboard.inline_keyboard[0][0].text).toContain('Отменить');
      expect(keyboard.inline_keyboard[0][1].text).toContain('OK');
    });

    it('should set correct callback_data', async () => {
      const keyboard = await t.action(internal.telegram.createInlineKeyboard, {
        actionLogId: 'log_123',
      });

      expect(keyboard.inline_keyboard[0][0].callback_data).toBe('revert:log_123');
      expect(keyboard.inline_keyboard[0][1].callback_data).toBe('confirm:log_123');
    });
  });

  describe('telegram.handleCallback — revert', () => {
    let testAccountId: string;
    let testRuleId: string;
    let testLogId: string;

    beforeEach(async () => {
      testAccountId = await t.mutation(api.adAccounts.connect, {
        userId: testUserId as any,
        vkAccountId: 'vk_123',
        name: 'Test Account',
        accessToken: 'token_123',
      });

      // Update to Start tier for stopAd
      await t.mutation(api.users.updateTier, {
        userId: testUserId as any,
        tier: 'start',
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

      testLogId = await t.mutation(api.actionLogs.create, {
        userId: testUserId as any,
        ruleId: testRuleId as any,
        accountId: testAccountId as any,
        adId: 'ad_123',
        adName: 'Test Ad',
        actionType: 'stopped',
        reason: 'CPL > 500',
        metricsSnapshot: { spent: 3000, leads: 5 },
        savedAmount: 10000,
        status: 'success',
      });
    });

    it('should revert action within 5 minutes', async () => {
      const result = await t.action(internal.telegram.handleCallback, {
        callbackData: `revert:${testLogId}`,
        chatId: '987654321',
      });

      expect(result.success).toBe(true);

      const log = await t.query(api.actionLogs.getById, { logId: testLogId });
      expect(log?.status).toBe('reverted');
      expect(log?.revertedAt).toBeDefined();
    });

    it('should reject revert after 5 minutes', async () => {
      // Update createdAt to 6 minutes ago
      await t.mutation(api.actionLogs.updateCreatedAt, {
        logId: testLogId,
        createdAt: Date.now() - 6 * 60 * 1000,
      });

      const result = await t.action(internal.telegram.handleCallback, {
        callbackData: `revert:${testLogId}`,
        chatId: '987654321',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('истекло');
    });

    it('should reject double revert', async () => {
      // First revert
      await t.action(internal.telegram.handleCallback, {
        callbackData: `revert:${testLogId}`,
        chatId: '987654321',
      });

      // Second revert
      const result = await t.action(internal.telegram.handleCallback, {
        callbackData: `revert:${testLogId}`,
        chatId: '987654321',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('уже');
    });
  });

  describe('telegram.sendDailyDigest', () => {
    beforeEach(async () => {
      await t.mutation(api.users.updateTelegramChatId, {
        userId: testUserId as any,
        chatId: '987654321',
      });
    });

    it('should format digest with statistics', async () => {
      const digest = await t.action(internal.telegram.formatDailyDigest, {
        userId: testUserId,
        stats: {
          triggers: 15,
          stops: 10,
          notifications: 5,
          savedTotal: 75000,
        },
      });

      expect(digest).toContain('15'); // triggers
      expect(digest).toContain('10'); // stops
      expect(digest).toContain('75000'); // saved
      expect(digest).toContain('Дайджест');
    });

    it('should NOT send digest when no events', async () => {
      const result = await t.action(internal.telegram.sendDailyDigest, {
        userId: testUserId,
        stats: {
          triggers: 0,
          stops: 0,
          notifications: 0,
          savedTotal: 0,
        },
      });

      expect(result.sent).toBe(false);
    });
  });

  describe('telegram.quietHours', () => {
    beforeEach(async () => {
      await t.mutation(api.users.updateTelegramChatId, {
        userId: testUserId as any,
        chatId: '987654321',
      });
    });

    it('should block notifications during quiet hours', async () => {
      await t.mutation(api.users.setQuietHours, {
        userId: testUserId as any,
        startHour: 23,
        endHour: 7,
      });

      const result = await t.action(internal.telegram.shouldSendNotification, {
        userId: testUserId,
        currentHour: 2, // 2 AM - within quiet hours
      });

      expect(result.shouldSend).toBe(false);
      expect(result.reason).toContain('quiet');
    });

    it('should allow notifications outside quiet hours', async () => {
      await t.mutation(api.users.setQuietHours, {
        userId: testUserId as any,
        startHour: 23,
        endHour: 7,
      });

      const result = await t.action(internal.telegram.shouldSendNotification, {
        userId: testUserId,
        currentHour: 14, // 2 PM - outside quiet hours
      });

      expect(result.shouldSend).toBe(true);
    });

    it('should handle 00:00-00:00 as disabled', async () => {
      await t.mutation(api.users.setQuietHours, {
        userId: testUserId as any,
        startHour: 0,
        endHour: 0,
      });

      const result = await t.action(internal.telegram.shouldSendNotification, {
        userId: testUserId,
        currentHour: 3,
      });

      expect(result.shouldSend).toBe(true); // Quiet hours disabled
    });
  });

  describe('telegram.rateLimit', () => {
    it('should handle 429 with Retry-After', async () => {
      const result = await t.action(internal.telegram.handleRateLimit, {
        retryAfter: 5,
      });

      expect(result.shouldRetry).toBe(true);
      expect(result.retryAfterMs).toBe(5000);
    });
  });
});
