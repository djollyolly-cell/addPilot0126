import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

describe("users", () => {
  describe("create", () => {
    test("creates a new user with freemium tier", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
        name: "Test User",
      });

      expect(userId).toBeDefined();

      // Verify user was created
      const user = await t.query(api.users.get, { id: userId });
      expect(user).toBeDefined();
      expect(user?.email).toBe("test@example.com");
      expect(user?.vkId).toBe("12345");
      expect(user?.name).toBe("Test User");
      expect(user?.subscriptionTier).toBe("freemium");
      expect(user?.onboardingCompleted).toBe(false);
    });

    test("throws error for duplicate vkId", async () => {
      const t = convexTest(schema);

      // Create first user
      await t.mutation(api.users.create, {
        email: "test1@example.com",
        vkId: "12345",
      });

      // Try to create duplicate
      await expect(
        t.mutation(api.users.create, {
          email: "test2@example.com",
          vkId: "12345",
        })
      ).rejects.toThrow("User with this VK ID already exists");
    });
  });

  describe("getByVkId", () => {
    test("returns user by vkId", async () => {
      const t = convexTest(schema);

      // Create user
      await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
        name: "Test User",
      });

      // Get by vkId
      const user = await t.query(api.users.getByVkId, { vkId: "12345" });
      expect(user).toBeDefined();
      expect(user?.vkId).toBe("12345");
      expect(user?.name).toBe("Test User");
    });

    test("returns null for non-existent vkId", async () => {
      const t = convexTest(schema);

      const user = await t.query(api.users.getByVkId, { vkId: "nonexistent" });
      expect(user).toBeNull();
    });
  });

  describe("updateTier", () => {
    test("updates tier from freemium to start", async () => {
      const t = convexTest(schema);

      // Create user
      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      // Update tier
      const result = await t.mutation(api.users.updateTier, {
        userId,
        tier: "start",
      });

      expect(result.success).toBe(true);
      expect(result.previousTier).toBe("freemium");
      expect(result.newTier).toBe("start");

      // Verify update
      const user = await t.query(api.users.get, { id: userId });
      expect(user?.subscriptionTier).toBe("start");
    });

    test("updates tier from start to pro", async () => {
      const t = convexTest(schema);

      // Create user
      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      // Update to start first
      await t.mutation(api.users.updateTier, {
        userId,
        tier: "start",
      });

      // Update to pro
      const result = await t.mutation(api.users.updateTier, {
        userId,
        tier: "pro",
      });

      expect(result.success).toBe(true);
      expect(result.previousTier).toBe("start");
      expect(result.newTier).toBe("pro");

      const user = await t.query(api.users.get, { id: userId });
      expect(user?.subscriptionTier).toBe("pro");
    });

    test("throws error for non-existent user", async () => {
      const t = convexTest(schema);

      // Create a user to get a valid ID format, then delete it
      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      await t.mutation(api.users.deleteUser, { userId });

      await expect(
        t.mutation(api.users.updateTier, {
          userId,
          tier: "start",
        })
      ).rejects.toThrow("User not found");
    });

    test("downgrade from start to freemium deactivates excess rules", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "downgrade@example.com",
        vkId: "downgrade_test",
      });

      // Upgrade to start
      await t.mutation(api.users.updateTier, { userId, tier: "start" });

      // Connect an account to create rules for
      const accountId = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "DG001",
        name: "Downgrade Cabinet",
        accessToken: "token_dg",
      });

      // Create 4 active rules (start limit = 10, freemium limit = 2)
      const ruleIds = [];
      for (let i = 1; i <= 4; i++) {
        const ruleId = await t.run(async (ctx) => {
          return await ctx.db.insert("rules", {
            userId,
            name: `Rule ${i}`,
            type: "cpl_limit",
            conditions: { metric: "cpl", operator: ">", value: 500 },
            actions: { stopAd: true, notify: true },
            targetAccountIds: [accountId],
            isActive: true,
            triggerCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        });
        ruleIds.push(ruleId);
      }

      // Downgrade to freemium (limit = 2 rules)
      await t.mutation(api.users.updateTier, { userId, tier: "freemium" });

      // Check: first 2 rules should remain active, last 2 should be deactivated
      const rules = await t.run(async (ctx) => {
        return await ctx.db
          .query("rules")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect();
      });

      const activeRules = rules.filter((r) => r.isActive);
      const inactiveRules = rules.filter((r) => !r.isActive);

      expect(activeRules).toHaveLength(2);
      expect(inactiveRules).toHaveLength(2);
    });

    test("downgrade to freemium disables stopAd on all rules", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "stoptest@example.com",
        vkId: "stop_test",
      });

      await t.mutation(api.users.updateTier, { userId, tier: "start" });

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "STOP001",
        name: "Stop Test Cabinet",
        accessToken: "token_stop",
      });

      // Create a rule with stopAd: true
      await t.run(async (ctx) => {
        await ctx.db.insert("rules", {
          userId,
          name: "StopAd Rule",
          type: "cpl_limit",
          conditions: { metric: "cpl", operator: ">", value: 500 },
          actions: { stopAd: true, notify: true },
          targetAccountIds: [accountId],
          isActive: true,
          triggerCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });

      // Downgrade to freemium (autoStop = false)
      await t.mutation(api.users.updateTier, { userId, tier: "freemium" });

      const rules = await t.run(async (ctx) => {
        return await ctx.db
          .query("rules")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect();
      });

      // All rules should have stopAd disabled
      for (const rule of rules) {
        expect(rule.actions.stopAd).toBe(false);
      }
    });

    test("sets subscription expiration date", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
      await t.mutation(api.users.updateTier, {
        userId,
        tier: "start",
        expiresAt,
      });

      const user = await t.query(api.users.get, { id: userId });
      expect(user?.subscriptionExpiresAt).toBe(expiresAt);
    });
  });

  describe("getLimits", () => {
    test("returns freemium limits", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      const limits = await t.query(api.users.getLimits, { userId });

      expect(limits.tier).toBe("freemium");
      expect(limits.limits.accounts).toBe(1);
      expect(limits.limits.rules).toBe(2);
      expect(limits.limits.autoStop).toBe(false);
      expect(limits.usage.accounts).toBe(0);
      expect(limits.usage.rules).toBe(0);
      expect(limits.canAddAccount).toBe(true);
      expect(limits.canAddRule).toBe(true);
    });

    test("returns start limits", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      await t.mutation(api.users.updateTier, { userId, tier: "start" });

      const limits = await t.query(api.users.getLimits, { userId });

      expect(limits.tier).toBe("start");
      expect(limits.limits.accounts).toBe(3);
      expect(limits.limits.rules).toBe(10);
      expect(limits.limits.autoStop).toBe(true);
    });

    test("returns pro limits (unlimited)", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      await t.mutation(api.users.updateTier, { userId, tier: "pro" });

      const limits = await t.query(api.users.getLimits, { userId });

      expect(limits.tier).toBe("pro");
      expect(limits.limits.accounts).toBe(Infinity);
      expect(limits.limits.rules).toBe(Infinity);
      expect(limits.limits.autoStop).toBe(true);
    });
  });

  describe("updateProfile", () => {
    test("updates user name", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
        name: "Old Name",
      });

      await t.mutation(api.users.updateProfile, {
        userId,
        name: "New Name",
      });

      const user = await t.query(api.users.get, { id: userId });
      expect(user?.name).toBe("New Name");
    });

    test("updates user email", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "old@example.com",
        vkId: "12345",
      });

      await t.mutation(api.users.updateProfile, {
        userId,
        email: "new@example.com",
      });

      const user = await t.query(api.users.get, { id: userId });
      expect(user?.email).toBe("new@example.com");
    });
  });

  describe("completeOnboarding", () => {
    test("marks onboarding as completed", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      // Initially not completed
      let user = await t.query(api.users.get, { id: userId });
      expect(user?.onboardingCompleted).toBe(false);

      // Complete onboarding
      await t.mutation(api.users.completeOnboarding, { userId });

      user = await t.query(api.users.get, { id: userId });
      expect(user?.onboardingCompleted).toBe(true);
    });
  });

  describe("connectTelegram", () => {
    test("connects Telegram chat", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      await t.mutation(api.users.connectTelegram, {
        userId,
        chatId: "987654321",
      });

      const user = await t.query(api.users.get, { id: userId });
      expect(user?.telegramChatId).toBe("987654321");
    });
  });

  describe("disconnectTelegram", () => {
    test("disconnects Telegram chat", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      // Connect first
      await t.mutation(api.users.connectTelegram, {
        userId,
        chatId: "987654321",
      });

      // Disconnect
      await t.mutation(api.users.disconnectTelegram, { userId });

      const user = await t.query(api.users.get, { id: userId });
      expect(user?.telegramChatId).toBeUndefined();
    });
  });

  describe("deleteUser", () => {
    test("deletes user and related data", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "test@example.com",
        vkId: "12345",
      });

      // Delete user
      const result = await t.mutation(api.users.deleteUser, { userId });
      expect(result.success).toBe(true);

      // Verify user is deleted
      const user = await t.query(api.users.get, { id: userId });
      expect(user).toBeNull();
    });
  });

  describe("upsertFromVk (VK token storage)", () => {
    test("stores VK tokens on new user creation", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(internal.users.upsertFromVk, {
        vkId: "vk_999",
        email: "vk@example.com",
        name: "VK User",
        accessToken: "access_token_abc",
        refreshToken: "refresh_token_xyz",
        expiresIn: 3600,
      });

      const user = await t.query(api.users.get, { id: userId });
      expect(user).toBeDefined();
      expect(user?.vkAccessToken).toBe("access_token_abc");
      expect(user?.vkRefreshToken).toBe("refresh_token_xyz");
      expect(user?.vkTokenExpiresAt).toBeDefined();
      // expiresAt should be roughly now + 3600s
      expect(user!.vkTokenExpiresAt!).toBeGreaterThan(Date.now());
    });

    test("updates VK tokens on existing user", async () => {
      const t = convexTest(schema);

      // Create user first
      const userId = await t.mutation(internal.users.upsertFromVk, {
        vkId: "vk_888",
        email: "vk2@example.com",
        name: "VK User 2",
        accessToken: "old_token",
        expiresIn: 3600,
      });

      // Upsert again with new tokens
      const sameUserId = await t.mutation(internal.users.upsertFromVk, {
        vkId: "vk_888",
        email: "vk2@example.com",
        name: "VK User 2 Updated",
        accessToken: "new_token",
        refreshToken: "new_refresh",
        expiresIn: 7200,
      });

      expect(sameUserId).toEqual(userId);

      const user = await t.query(api.users.get, { id: userId });
      expect(user?.vkAccessToken).toBe("new_token");
      expect(user?.vkRefreshToken).toBe("new_refresh");
      expect(user?.name).toBe("VK User 2 Updated");
    });

    test("handles zero expiresIn gracefully", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(internal.users.upsertFromVk, {
        vkId: "vk_777",
        email: "vk3@example.com",
        name: "VK User 3",
        accessToken: "token_no_expiry",
        expiresIn: 0,
      });

      const user = await t.query(api.users.get, { id: userId });
      expect(user?.vkAccessToken).toBe("token_no_expiry");
      expect(user?.vkTokenExpiresAt).toBeUndefined();
    });
  });

  describe("updateVkTokens", () => {
    test("updates tokens on existing user", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "token@example.com",
        vkId: "vk_update_test",
      });

      await t.mutation(internal.users.updateVkTokens, {
        userId,
        accessToken: "refreshed_access",
        refreshToken: "refreshed_refresh",
        expiresIn: 86400,
      });

      const user = await t.query(api.users.get, { id: userId });
      expect(user?.vkAccessToken).toBe("refreshed_access");
      expect(user?.vkRefreshToken).toBe("refreshed_refresh");
      expect(user?.vkTokenExpiresAt).toBeDefined();
      expect(user!.vkTokenExpiresAt!).toBeGreaterThan(Date.now());
    });

    test("updates only accessToken when no refreshToken provided", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(internal.users.upsertFromVk, {
        vkId: "vk_partial",
        email: "partial@example.com",
        name: "Partial",
        accessToken: "old_access",
        refreshToken: "old_refresh",
        expiresIn: 3600,
      });

      await t.mutation(internal.users.updateVkTokens, {
        userId,
        accessToken: "new_access_only",
        expiresIn: 7200,
      });

      const user = await t.query(api.users.get, { id: userId });
      expect(user?.vkAccessToken).toBe("new_access_only");
      // refreshToken should remain unchanged
      expect(user?.vkRefreshToken).toBe("old_refresh");
    });
  });

  describe("getVkTokens", () => {
    test("returns tokens for existing user", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(internal.users.upsertFromVk, {
        vkId: "vk_get_tokens",
        email: "tokens@example.com",
        name: "Token User",
        accessToken: "my_access",
        refreshToken: "my_refresh",
        expiresIn: 3600,
      });

      const tokens = await t.query(internal.users.getVkTokens, { userId });
      expect(tokens).toBeDefined();
      expect(tokens?.accessToken).toBe("my_access");
      expect(tokens?.refreshToken).toBe("my_refresh");
      expect(tokens?.expiresAt).toBeDefined();
    });

    test("returns null for non-existent user", async () => {
      const t = convexTest(schema);

      // Create and delete user to get a valid but non-existent ID
      const userId = await t.mutation(api.users.create, {
        email: "del@example.com",
        vkId: "vk_del",
      });
      await t.mutation(api.users.deleteUser, { userId });

      const tokens = await t.query(internal.users.getVkTokens, { userId });
      expect(tokens).toBeNull();
    });

    test("returns undefined tokens when not set", async () => {
      const t = convexTest(schema);

      const userId = await t.mutation(api.users.create, {
        email: "no_tokens@example.com",
        vkId: "vk_no_tokens",
      });

      const tokens = await t.query(internal.users.getVkTokens, { userId });
      expect(tokens).toBeDefined();
      expect(tokens?.accessToken).toBeUndefined();
      expect(tokens?.refreshToken).toBeUndefined();
      expect(tokens?.expiresAt).toBeUndefined();
    });
  });
});
