/**
 * Unit Tests — Rules Module
 * Sprint 4-6: Создание и редактирование правил
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api } from '../../convex/_generated/api';

describe('rules module', () => {
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

  describe('rules.create — Rule Types', () => {
    it('should create cpl_limit rule', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'CPL Limit Rule',
        type: 'cpl_limit',
        conditions: {
          metric: 'cpl',
          operator: '>',
          value: 500,
        },
        actions: {
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      expect(ruleId).toBeDefined();

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.type).toBe('cpl_limit');
      expect(rule?.conditions.value).toBe(500);
    });

    it('should create min_ctr rule', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Min CTR Rule',
        type: 'min_ctr',
        conditions: {
          metric: 'ctr',
          operator: '<',
          value: 1.5,
        },
        actions: {
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      expect(ruleId).toBeDefined();

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.type).toBe('min_ctr');
      expect(rule?.conditions.value).toBe(1.5);
    });

    it('should create fast_spend rule', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Fast Spend Rule',
        type: 'fast_spend',
        conditions: {
          metric: 'spend_rate',
          operator: '>',
          value: 20,
        },
        actions: {
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      expect(ruleId).toBeDefined();

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.type).toBe('fast_spend');
    });

    it('should create spend_no_leads rule', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Spend No Leads Rule',
        type: 'spend_no_leads',
        conditions: {
          metric: 'spend_no_leads',
          operator: '>',
          value: 1000,
        },
        actions: {
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      expect(ruleId).toBeDefined();

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.type).toBe('spend_no_leads');
    });
  });

  describe('rules.create — Validation', () => {
    it('should reject value = 0', async () => {
      await expect(
        t.mutation(api.rules.create, {
          userId: testUserId as any,
          name: 'Invalid Rule',
          type: 'cpl_limit',
          conditions: {
            metric: 'cpl',
            operator: '>',
            value: 0,
          },
          actions: {
            stopAd: false,
            notify: true,
          },
          targetAccountIds: [testAccountId as any],
          isActive: true,
        })
      ).rejects.toThrow('INVALID_VALUE');
    });

    it('should reject value < 0', async () => {
      await expect(
        t.mutation(api.rules.create, {
          userId: testUserId as any,
          name: 'Invalid Rule',
          type: 'cpl_limit',
          conditions: {
            metric: 'cpl',
            operator: '>',
            value: -100,
          },
          actions: {
            stopAd: false,
            notify: true,
          },
          targetAccountIds: [testAccountId as any],
          isActive: true,
        })
      ).rejects.toThrow('INVALID_VALUE');
    });

    it('should reject CTR > 100', async () => {
      await expect(
        t.mutation(api.rules.create, {
          userId: testUserId as any,
          name: 'Invalid CTR Rule',
          type: 'min_ctr',
          conditions: {
            metric: 'ctr',
            operator: '<',
            value: 150,
          },
          actions: {
            stopAd: false,
            notify: true,
          },
          targetAccountIds: [testAccountId as any],
          isActive: true,
        })
      ).rejects.toThrow('INVALID_VALUE');
    });

    it('should reject empty targets', async () => {
      await expect(
        t.mutation(api.rules.create, {
          userId: testUserId as any,
          name: 'No Targets Rule',
          type: 'cpl_limit',
          conditions: {
            metric: 'cpl',
            operator: '>',
            value: 500,
          },
          actions: {
            stopAd: false,
            notify: true,
          },
          targetAccountIds: [],
          isActive: true,
        })
      ).rejects.toThrow('EMPTY_TARGETS');
    });

    it('should reject empty name', async () => {
      await expect(
        t.mutation(api.rules.create, {
          userId: testUserId as any,
          name: '',
          type: 'cpl_limit',
          conditions: {
            metric: 'cpl',
            operator: '>',
            value: 500,
          },
          actions: {
            stopAd: false,
            notify: true,
          },
          targetAccountIds: [testAccountId as any],
          isActive: true,
        })
      ).rejects.toThrow('INVALID_NAME');
    });
  });

  describe('rules.toggleActive', () => {
    it('should toggle isActive from true to false', async () => {
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
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      await t.mutation(api.rules.toggleActive, { ruleId });

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.isActive).toBe(false);
    });

    it('should toggle isActive from false to true', async () => {
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
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: false,
      });

      await t.mutation(api.rules.toggleActive, { ruleId });

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.isActive).toBe(true);
    });
  });

  describe('rules — Tier Limits', () => {
    describe('Freemium tier', () => {
      it('should allow 2 rules for Freemium', async () => {
        for (let i = 1; i <= 2; i++) {
          const ruleId = await t.mutation(api.rules.create, {
            userId: testUserId as any,
            name: `Rule ${i}`,
            type: 'cpl_limit',
            conditions: {
              metric: 'cpl',
              operator: '>',
              value: 500,
            },
            actions: {
              stopAd: false,
              notify: true,
            },
            targetAccountIds: [testAccountId as any],
            isActive: true,
          });
          expect(ruleId).toBeDefined();
        }
      });

      it('should reject 3rd rule for Freemium', async () => {
        for (let i = 1; i <= 2; i++) {
          await t.mutation(api.rules.create, {
            userId: testUserId as any,
            name: `Rule ${i}`,
            type: 'cpl_limit',
            conditions: {
              metric: 'cpl',
              operator: '>',
              value: 500,
            },
            actions: {
              stopAd: false,
              notify: true,
            },
            targetAccountIds: [testAccountId as any],
            isActive: true,
          });
        }

        await expect(
          t.mutation(api.rules.create, {
            userId: testUserId as any,
            name: 'Rule 3',
            type: 'cpl_limit',
            conditions: {
              metric: 'cpl',
              operator: '>',
              value: 500,
            },
            actions: {
              stopAd: false,
              notify: true,
            },
            targetAccountIds: [testAccountId as any],
            isActive: true,
          })
        ).rejects.toThrow('RULE_LIMIT');
      });

      it('should reject stopAd=true for Freemium', async () => {
        await expect(
          t.mutation(api.rules.create, {
            userId: testUserId as any,
            name: 'Auto-stop Rule',
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
          })
        ).rejects.toThrow('FEATURE_UNAVAILABLE');
      });
    });

    describe('Start tier', () => {
      beforeEach(async () => {
        await t.mutation(api.users.updateTier, {
          userId: testUserId as any,
          tier: 'start',
        });
      });

      it('should allow 10 rules for Start', async () => {
        for (let i = 1; i <= 10; i++) {
          const ruleId = await t.mutation(api.rules.create, {
            userId: testUserId as any,
            name: `Rule ${i}`,
            type: 'cpl_limit',
            conditions: {
              metric: 'cpl',
              operator: '>',
              value: 500,
            },
            actions: {
              stopAd: false,
              notify: true,
            },
            targetAccountIds: [testAccountId as any],
            isActive: true,
          });
          expect(ruleId).toBeDefined();
        }
      });

      it('should reject 11th rule for Start', async () => {
        for (let i = 1; i <= 10; i++) {
          await t.mutation(api.rules.create, {
            userId: testUserId as any,
            name: `Rule ${i}`,
            type: 'cpl_limit',
            conditions: {
              metric: 'cpl',
              operator: '>',
              value: 500,
            },
            actions: {
              stopAd: false,
              notify: true,
            },
            targetAccountIds: [testAccountId as any],
            isActive: true,
          });
        }

        await expect(
          t.mutation(api.rules.create, {
            userId: testUserId as any,
            name: 'Rule 11',
            type: 'cpl_limit',
            conditions: {
              metric: 'cpl',
              operator: '>',
              value: 500,
            },
            actions: {
              stopAd: false,
              notify: true,
            },
            targetAccountIds: [testAccountId as any],
            isActive: true,
          })
        ).rejects.toThrow('RULE_LIMIT');
      });

      it('should allow stopAd=true for Start', async () => {
        const ruleId = await t.mutation(api.rules.create, {
          userId: testUserId as any,
          name: 'Auto-stop Rule',
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

        expect(ruleId).toBeDefined();
      });
    });

    describe('Pro tier', () => {
      beforeEach(async () => {
        await t.mutation(api.users.updateTier, {
          userId: testUserId as any,
          tier: 'pro',
        });
      });

      it('should allow unlimited rules for Pro', async () => {
        for (let i = 1; i <= 20; i++) {
          const ruleId = await t.mutation(api.rules.create, {
            userId: testUserId as any,
            name: `Rule ${i}`,
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
          expect(ruleId).toBeDefined();
        }
      });
    });
  });

  describe('rules.update', () => {
    it('should update rule name', async () => {
      const ruleId = await t.mutation(api.rules.create, {
        userId: testUserId as any,
        name: 'Original Name',
        type: 'cpl_limit',
        conditions: {
          metric: 'cpl',
          operator: '>',
          value: 500,
        },
        actions: {
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      await t.mutation(api.rules.update, {
        ruleId,
        name: 'Updated Name',
      });

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.name).toBe('Updated Name');
    });

    it('should update conditions value', async () => {
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
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      await t.mutation(api.rules.update, {
        ruleId,
        conditions: {
          metric: 'cpl',
          operator: '>',
          value: 750,
        },
      });

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.conditions.value).toBe(750);
    });
  });

  describe('rules.delete', () => {
    it('should delete rule', async () => {
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
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      await t.mutation(api.rules.delete, { ruleId });

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule).toBeNull();
    });
  });

  describe('rules.incrementTriggerCount', () => {
    it('should increment triggerCount', async () => {
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
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      await t.mutation(api.rules.incrementTriggerCount, { ruleId });

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.triggerCount).toBe(1);
    });

    it('should update lastTriggeredAt', async () => {
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
          stopAd: false,
          notify: true,
        },
        targetAccountIds: [testAccountId as any],
        isActive: true,
      });

      const before = Date.now();
      await t.mutation(api.rules.incrementTriggerCount, { ruleId });
      const after = Date.now();

      const rule = await t.query(api.rules.getById, { ruleId });
      expect(rule?.lastTriggeredAt).toBeGreaterThanOrEqual(before);
      expect(rule?.lastTriggeredAt).toBeLessThanOrEqual(after);
    });
  });
});
