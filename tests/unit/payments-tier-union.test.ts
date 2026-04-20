import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("payments.tier union", () => {
  it("accepts existing tiers: start, pro", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "test@example.com",
        createdAt: Date.now(),
      })
    );
    for (const tier of ["start", "pro"] as const) {
      const id = await t.run(async (ctx) =>
        ctx.db.insert("payments", {
          userId,
          tier,
          orderId: `order_${tier}`,
          token: `tok_${tier}`,
          amount: 100,
          currency: "RUB",
          status: "pending",
          createdAt: Date.now(),
        })
      );
      expect(id).toBeTruthy();
    }
  });

  it("accepts new agency tiers: agency_s, agency_m, agency_l, agency_xl", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "agency@example.com",
        createdAt: Date.now(),
      })
    );
    for (const tier of ["agency_s", "agency_m", "agency_l", "agency_xl"] as const) {
      const id = await t.run(async (ctx) =>
        ctx.db.insert("payments", {
          userId,
          tier,
          orderId: `order_${tier}`,
          token: `tok_${tier}`,
          amount: 14900,
          currency: "RUB",
          status: "pending",
          createdAt: Date.now(),
        })
      );
      expect(id).toBeTruthy();
    }
  });
});
