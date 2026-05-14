import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// Tests cover the conditional dedup path in adminAlerts.notify.
// Critical D1a safety property: systemLogger path schedules notify WITHOUT
// dedupKey (its inline dedup already gated); explicit callers pass their own
// dedupKey and get the historical checkDedup behavior.
//
// Telegram fan-out itself is not tested here — it requires admin fixtures
// (adminAlertSettings + users with telegramChatId) and ends up calling
// internal.telegram.sendMessage which goes through real fetch. With no admin
// fixtures, getEnabledAdmins returns empty and the loop never iterates,
// keeping these tests deterministic and free of network mocking.

describe("adminAlerts.notify — D1a safety: conditional dedup", () => {
  it("WITH dedupKey: first call writes adminAlertDedup row", async () => {
    const t = convexTest(schema);
    await t.action(internal.adminAlerts.notify, {
      category: "criticalErrors",
      dedupKey: "error:test-src:some_class",
      text: "test message",
    });
    const dedup = await t.run(async (ctx) =>
      ctx.db.query("adminAlertDedup").collect(),
    );
    expect(dedup.length).toBe(1);
    expect(dedup[0].key).toBe("error:test-src:some_class");
  });

  it("WITH same dedupKey within window: second call is dedup-hit, no new write", async () => {
    const t = convexTest(schema);
    await t.action(internal.adminAlerts.notify, {
      category: "criticalErrors",
      dedupKey: "error:test-src:same_class",
      text: "first",
    });
    await t.action(internal.adminAlerts.notify, {
      category: "criticalErrors",
      dedupKey: "error:test-src:same_class",
      text: "second",
    });
    const dedup = await t.run(async (ctx) =>
      ctx.db.query("adminAlertDedup").collect(),
    );
    expect(dedup.length).toBe(1);
    expect(dedup[0].key).toBe("error:test-src:same_class");
  });

  it("WITHOUT dedupKey: no adminAlertDedup write (D1a safety — systemLogger path)", async () => {
    const t = convexTest(schema);
    await t.action(internal.adminAlerts.notify, {
      category: "criticalErrors",
      text: "no dedup key, should bypass checkDedup entirely",
    });
    const dedup = await t.run(async (ctx) =>
      ctx.db.query("adminAlertDedup").collect(),
    );
    expect(dedup.length).toBe(0);
  });

  it("WITHOUT dedupKey: 5 consecutive calls still write 0 adminAlertDedup rows", async () => {
    const t = convexTest(schema);
    for (let i = 0; i < 5; i++) {
      await t.action(internal.adminAlerts.notify, {
        category: "criticalErrors",
        text: `systemLogger-style call ${i}`,
      });
    }
    const dedup = await t.run(async (ctx) =>
      ctx.db.query("adminAlertDedup").collect(),
    );
    expect(dedup.length).toBe(0);
  });

  it("different dedupKeys: each writes its own row", async () => {
    const t = convexTest(schema);
    await t.action(internal.adminAlerts.notify, {
      category: "criticalErrors",
      dedupKey: "error:src-a:cls1",
      text: "a",
    });
    await t.action(internal.adminAlerts.notify, {
      category: "criticalErrors",
      dedupKey: "error:src-b:cls2",
      text: "b",
    });
    const dedup = await t.run(async (ctx) =>
      ctx.db.query("adminAlertDedup").collect(),
    );
    expect(dedup.length).toBe(2);
    const keys = dedup.map((d) => d.key).sort();
    expect(keys).toEqual(["error:src-a:cls1", "error:src-b:cls2"]);
  });

  it("category with no enabled admins: still completes without throwing (no fan-out loop)", async () => {
    const t = convexTest(schema);
    // No adminAlertSettings rows — getEnabledAdmins returns []
    // Convex actions serialize void as null at the boundary, so .resolves.toBeNull().
    await expect(
      t.action(internal.adminAlerts.notify, {
        category: "criticalErrors",
        text: "should not throw",
      }),
    ).resolves.toBeNull();
  });
});
