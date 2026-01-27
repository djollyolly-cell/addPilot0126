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
});
