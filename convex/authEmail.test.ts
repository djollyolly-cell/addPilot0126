import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { validateEmail } from "./authEmail";

describe("authEmail", () => {
  describe("validateEmail", () => {
    test("accepts valid email", () => {
      expect(validateEmail("user@example.com")).toBe(true);
      expect(validateEmail("test.user@domain.ru")).toBe(true);
      expect(validateEmail("name+tag@mail.co")).toBe(true);
    });

    test("rejects invalid email", () => {
      expect(validateEmail("")).toBe(false);
      expect(validateEmail("notanemail")).toBe(false);
      expect(validateEmail("@domain.com")).toBe(false);
      expect(validateEmail("user@")).toBe(false);
      expect(validateEmail("user @domain.com")).toBe(false);
      expect(validateEmail("user@domain")).toBe(false);
    });
  });

  describe("checkRateLimit", () => {
    test("returns not blocked for new email", async () => {
      const t = convexTest(schema);

      const result = await t.query(api.authEmail.checkRateLimit, {
        email: "new@example.com",
      });

      expect(result.blocked).toBe(false);
      expect(result.attemptsLeft).toBe(5);
    });

    test("decrements attempts after failed login", async () => {
      const t = convexTest(schema);
      const email = "test@example.com";

      // Record one failed attempt
      await t.run(async (ctx) => {
        await ctx.db.insert("loginAttempts", {
          email,
          attempts: 1,
          lastAttemptAt: Date.now(),
        });
      });

      const result = await t.query(api.authEmail.checkRateLimit, { email });

      expect(result.blocked).toBe(false);
      expect(result.attemptsLeft).toBe(4);
    });

    test("blocks after max attempts", async () => {
      const t = convexTest(schema);
      const email = "blocked@example.com";

      // Simulate 5 failed attempts with block
      await t.run(async (ctx) => {
        await ctx.db.insert("loginAttempts", {
          email,
          attempts: 5,
          lastAttemptAt: Date.now(),
          blockedUntil: Date.now() + 15 * 60 * 1000,
        });
      });

      const result = await t.query(api.authEmail.checkRateLimit, { email });

      expect(result.blocked).toBe(true);
      expect(result.attemptsLeft).toBe(0);
      expect(result.remainingMinutes).toBeGreaterThan(0);
    });

    test("unblocks after block duration expires", async () => {
      const t = convexTest(schema);
      const email = "expired@example.com";

      // Simulate expired block
      await t.run(async (ctx) => {
        await ctx.db.insert("loginAttempts", {
          email,
          attempts: 5,
          lastAttemptAt: Date.now() - 20 * 60 * 1000,
          blockedUntil: Date.now() - 5 * 60 * 1000, // expired 5 min ago
        });
      });

      const result = await t.query(api.authEmail.checkRateLimit, { email });

      expect(result.blocked).toBe(false);
      expect(result.attemptsLeft).toBe(5);
    });
  });

  describe("recordFailedAttempt", () => {
    test("creates record on first failed attempt", async () => {
      const t = convexTest(schema);
      const email = "first@example.com";

      await t.mutation(internal.authEmail.recordFailedAttempt, { email });

      const result = await t.query(api.authEmail.checkRateLimit, { email });
      expect(result.attemptsLeft).toBe(4);
    });

    test("increments attempts on subsequent failures", async () => {
      const t = convexTest(schema);
      const email = "multi@example.com";

      await t.mutation(internal.authEmail.recordFailedAttempt, { email });
      await t.mutation(internal.authEmail.recordFailedAttempt, { email });
      await t.mutation(internal.authEmail.recordFailedAttempt, { email });

      const result = await t.query(api.authEmail.checkRateLimit, { email });
      expect(result.attemptsLeft).toBe(2);
    });

    test("blocks after 5 failed attempts", async () => {
      const t = convexTest(schema);
      const email = "toomany@example.com";

      for (let i = 0; i < 5; i++) {
        await t.mutation(internal.authEmail.recordFailedAttempt, { email });
      }

      const result = await t.query(api.authEmail.checkRateLimit, { email });
      expect(result.blocked).toBe(true);
      expect(result.attemptsLeft).toBe(0);
    });
  });

  describe("resetAttempts", () => {
    test("clears attempts record", async () => {
      const t = convexTest(schema);
      const email = "reset@example.com";

      // Record some failed attempts
      await t.mutation(internal.authEmail.recordFailedAttempt, { email });
      await t.mutation(internal.authEmail.recordFailedAttempt, { email });

      // Reset
      await t.mutation(internal.authEmail.resetAttempts, { email });

      const result = await t.query(api.authEmail.checkRateLimit, { email });
      expect(result.blocked).toBe(false);
      expect(result.attemptsLeft).toBe(5);
    });

    test("does nothing for non-existent email", async () => {
      const t = convexTest(schema);

      // Should not throw
      await t.mutation(internal.authEmail.resetAttempts, {
        email: "nonexistent@example.com",
      });

      const result = await t.query(api.authEmail.checkRateLimit, {
        email: "nonexistent@example.com",
      });
      expect(result.blocked).toBe(false);
    });
  });
});
