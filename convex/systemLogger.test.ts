import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { classifyMessage } from "./systemLogger";

async function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.DISABLE_ERROR_ALERT_FANOUT;
  try {
    if (value === undefined) {
      delete process.env.DISABLE_ERROR_ALERT_FANOUT;
    } else {
      process.env.DISABLE_ERROR_ALERT_FANOUT = value;
    }
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.DISABLE_ERROR_ALERT_FANOUT;
    } else {
      process.env.DISABLE_ERROR_ALERT_FANOUT = previous;
    }
  }
}

describe("classifyMessage", () => {
  it("matches Too many concurrent → too_many_concurrent", () => {
    expect(
      classifyMessage("auth", "Token refresh failed: Too many concurrent requests"),
    ).toBe("too_many_concurrent");
  });

  it("matches Transient error → transient_error", () => {
    expect(classifyMessage("syncMetrics", "Transient error from VK API")).toBe(
      "transient_error",
    );
  });

  it("matches TOKEN_EXPIRED → token_expired (English)", () => {
    expect(classifyMessage("auth", "Refresh returned TOKEN_EXPIRED")).toBe(
      "token_expired",
    );
  });

  it("matches Russian Токен ... истёк → token_expired", () => {
    expect(
      classifyMessage("syncMetrics", "Токен VK Ads истёк, refreshToken отсутствует"),
    ).toBe("token_expired");
  });

  it("matches Russian Токен ... отсутствует → token_expired", () => {
    expect(
      classifyMessage("auth", "Токен пользователя отсутствует"),
    ).toBe("token_expired");
  });

  it("does NOT match Russian Токен without истёк/отсутствует", () => {
    expect(classifyMessage("auth", "Токен пользователя обновлён")).not.toBe(
      "token_expired",
    );
  });

  it("matches tokenRecovery + failed → token_recovery_failed", () => {
    expect(classifyMessage("tokenRecovery", "Recovery attempt failed")).toBe(
      "token_recovery_failed",
    );
  });

  it("matches tokenRecovery + error → token_recovery_failed", () => {
    expect(classifyMessage("tokenRecovery", "Unexpected error during retry")).toBe(
      "token_recovery_failed",
    );
  });

  it("does NOT match tokenRecovery if neither failed nor error", () => {
    const cls = classifyMessage("tokenRecovery", "Recovery succeeded");
    expect(cls).not.toBe("token_recovery_failed");
    expect(cls.startsWith("_fb:")).toBe(true);
  });

  it("fallback: normalizes message (lowercase, non-alnum to _, trim _)", () => {
    const cls = classifyMessage("syncMetrics", "Some Unknown Error: foo-bar [42]");
    expect(cls).toBe("_fb:some_unknown_error_foo_bar_42");
  });

  it("fallback: truncates to first 120 chars before normalization", () => {
    const long = "a".repeat(150);
    const cls = classifyMessage("test", long);
    expect(cls).toBe("_fb:" + "a".repeat(120));
  });

  it("identical messages classify to identical keys (stability)", () => {
    const a = classifyMessage("auth", "Some new error pattern not in mapping");
    const b = classifyMessage("auth", "Some new error pattern not in mapping");
    expect(a).toBe(b);
  });

  it("fallback: cyrillic-only message produces non-empty key via hash (not _fb: empty)", () => {
    const a = classifyMessage("test", "Совершенно неизвестная ошибка системы");
    expect(a).not.toBe("_fb:");
    expect(a.startsWith("_fb:nl_")).toBe(true);
    // stability: same input → same key
    const b = classifyMessage("test", "Совершенно неизвестная ошибка системы");
    expect(a).toBe(b);
    // distinct: different cyrillic messages → different keys
    const c = classifyMessage("test", "Другой текст ошибки");
    expect(c).not.toBe(a);
    expect(c.startsWith("_fb:nl_")).toBe(true);
  });
});

describe("systemLogger.log", () => {
  it("writes systemLogs row regardless of level (info)", async () => {
    await withEnv("1", async () => {
      const t = convexTest(schema);
      await t.mutation(internal.systemLogger.log, {
        level: "info",
        source: "test",
        message: "hello",
      });
      const logs = await t.run(async (ctx) =>
        ctx.db.query("systemLogs").collect(),
      );
      expect(logs.length).toBe(1);
      expect(logs[0].message).toBe("hello");
      expect(logs[0].level).toBe("info");
    });
  });

  it("writes systemLogs row even when gate suppresses fan-out", async () => {
    await withEnv("1", async () => {
      const t = convexTest(schema);
      await t.mutation(internal.systemLogger.log, {
        level: "error",
        source: "auth",
        message: "Too many concurrent requests",
      });
      const logs = await t.run(async (ctx) =>
        ctx.db.query("systemLogs").collect(),
      );
      expect(logs.length).toBe(1);
    });
  });

  it("with DISABLE_ERROR_ALERT_FANOUT=1: 5-call burst writes 0 dedup rows and 0 schedules (gate suppresses)", async () => {
    await withEnv("1", async () => {
      const t = convexTest(schema);
      for (let i = 0; i < 5; i++) {
        await t.mutation(internal.systemLogger.log, {
          level: "error",
          source: "auth",
          message: `Too many concurrent variant ${i}`,
        });
      }
      const logs = await t.run(async (ctx) =>
        ctx.db.query("systemLogs").collect(),
      );
      expect(logs.length).toBe(5);
      const dedup = await t.run(async (ctx) =>
        ctx.db.query("adminAlertDedup").collect(),
      );
      expect(dedup.length).toBe(0);
      const scheduled = await t.run(async (ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(scheduled.length).toBe(0);
    });
  });

  it("with DISABLE_ERROR_ALERT_FANOUT=0: 5-call burst same class → 1 dedup row + 1 schedule (inline dedup)", async () => {
    await withEnv("0", async () => {
      const t = convexTest(schema);
      for (let i = 0; i < 5; i++) {
        await t.mutation(internal.systemLogger.log, {
          level: "error",
          source: "auth",
          message: `Too many concurrent for account ${i}`,
        });
      }
      const logs = await t.run(async (ctx) =>
        ctx.db.query("systemLogs").collect(),
      );
      expect(logs.length).toBe(5);
      const dedup = await t.run(async (ctx) =>
        ctx.db.query("adminAlertDedup").collect(),
      );
      expect(dedup.length).toBe(1);
      expect(dedup[0].key).toBe("error:auth:too_many_concurrent");
      const scheduled = await t.run(async (ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(scheduled.length).toBe(1);
    });
  });

  it("with DISABLE_ERROR_ALERT_FANOUT=0: scheduled notify args do NOT include dedupKey (avoid D1c double-dedup)", async () => {
    await withEnv("0", async () => {
      const t = convexTest(schema);
      await t.mutation(internal.systemLogger.log, {
        level: "error",
        source: "auth",
        message: "Too many concurrent for D1c double-dedup test",
      });
      const scheduled = await t.run(async (ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(scheduled.length).toBe(1);
      // args is an array of positional arguments for the scheduled function.
      // For internal.adminAlerts.notify the single arg is an object {category, dedupKey?, text}.
      const argsObj = (scheduled[0] as unknown as { args: unknown[] }).args[0];
      expect(argsObj).toBeDefined();
      expect((argsObj as { category: string }).category).toBe("criticalErrors");
      expect((argsObj as { dedupKey?: string }).dedupKey).toBeUndefined();
      expect((argsObj as { text: string }).text).toContain("too_many_concurrent");
    });
  });

  it("with DISABLE_ERROR_ALERT_FANOUT=0: Russian + English token-expired share one dedup key", async () => {
    await withEnv("0", async () => {
      const t = convexTest(schema);
      await t.mutation(internal.systemLogger.log, {
        level: "error",
        source: "syncMetrics",
        message: "Sync failed: Токен VK Ads истёк, refreshToken отсутствует",
      });
      await t.mutation(internal.systemLogger.log, {
        level: "error",
        source: "syncMetrics",
        message: "TOKEN_EXPIRED received from VK API",
      });
      const dedup = await t.run(async (ctx) =>
        ctx.db.query("adminAlertDedup").collect(),
      );
      expect(dedup.length).toBe(1);
      expect(dedup[0].key).toBe("error:syncMetrics:token_expired");
      const scheduled = await t.run(async (ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(scheduled.length).toBe(1);
    });
  });

  it("with DISABLE_ERROR_ALERT_FANOUT=0: different sources produce distinct dedup keys", async () => {
    await withEnv("0", async () => {
      const t = convexTest(schema);
      await t.mutation(internal.systemLogger.log, {
        level: "error",
        source: "auth",
        message: "Too many concurrent",
      });
      await t.mutation(internal.systemLogger.log, {
        level: "error",
        source: "syncMetrics",
        message: "Too many concurrent",
      });
      const dedup = await t.run(async (ctx) =>
        ctx.db.query("adminAlertDedup").collect(),
      );
      expect(dedup.length).toBe(2);
      const keys = dedup.map((d) => d.key).sort();
      expect(keys).toEqual([
        "error:auth:too_many_concurrent",
        "error:syncMetrics:too_many_concurrent",
      ]);
      const scheduled = await t.run(async (ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(scheduled.length).toBe(2);
    });
  });

  it("warn level never triggers dedup write regardless of gate", async () => {
    await withEnv("0", async () => {
      const t = convexTest(schema);
      await t.mutation(internal.systemLogger.log, {
        level: "warn",
        source: "test",
        message: "warning",
      });
      const dedup = await t.run(async (ctx) =>
        ctx.db.query("adminAlertDedup").collect(),
      );
      expect(dedup.length).toBe(0);
    });
  });

  it("info level never triggers dedup write regardless of gate", async () => {
    await withEnv("0", async () => {
      const t = convexTest(schema);
      await t.mutation(internal.systemLogger.log, {
        level: "info",
        source: "test",
        message: "informational",
      });
      const dedup = await t.run(async (ctx) =>
        ctx.db.query("adminAlertDedup").collect(),
      );
      expect(dedup.length).toBe(0);
    });
  });
});
