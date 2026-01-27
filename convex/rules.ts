import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Default metric/operator per rule type
const RULE_TYPE_DEFAULTS: Record<
  string,
  { metric: string; operator: string }
> = {
  cpl_limit: { metric: "cpl", operator: ">" },
  min_ctr: { metric: "ctr", operator: "<" },
  fast_spend: { metric: "spent_speed", operator: ">" },
  spend_no_leads: { metric: "spent_no_leads", operator: ">" },
};

// Validation
function validateRuleValue(
  type: string,
  value: number
): string | null {
  if (value <= 0) {
    return "Значение должно быть больше 0";
  }
  if (type === "min_ctr" && value > 100) {
    return "CTR не может быть больше 100%";
  }
  return null;
}

// List rules for a user
export const list = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

// Get a single rule
export const get = query({
  args: {
    ruleId: v.id("rules"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.ruleId);
  },
});

// Create a new rule
export const create = mutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    type: v.union(
      v.literal("cpl_limit"),
      v.literal("min_ctr"),
      v.literal("fast_spend"),
      v.literal("spend_no_leads")
    ),
    value: v.number(),
    operator: v.optional(v.string()),
    minSamples: v.optional(v.number()),
    actions: v.object({
      stopAd: v.boolean(),
      notify: v.boolean(),
      notifyChannel: v.optional(v.string()),
      customMessage: v.optional(v.string()),
    }),
    targetAccountIds: v.array(v.id("adAccounts")),
    targetCampaignIds: v.optional(v.array(v.string())),
    targetAdIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    // Validate name
    if (!args.name.trim()) {
      throw new Error("Название правила не может быть пустым");
    }

    // Validate value
    const valueError = validateRuleValue(args.type, args.value);
    if (valueError) {
      throw new Error(valueError);
    }

    // Check tier limits
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("Пользователь не найден");
    }

    const tierRuleLimits: Record<string, number> = {
      freemium: 2,
      start: 10,
      pro: Infinity,
    };

    const existingRules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const activeRules = existingRules.filter((r) => r.isActive);
    const ruleLimit = tierRuleLimits[user.subscriptionTier] ?? 2;

    if (activeRules.length >= ruleLimit) {
      throw new Error(
        `Лимит правил для тарифа "${user.subscriptionTier}" исчерпан (${ruleLimit})`
      );
    }

    // Check duplicate name (warning, not blocking)
    const duplicate = existingRules.find(
      (r) => r.name.toLowerCase() === args.name.trim().toLowerCase()
    );
    if (duplicate) {
      throw new Error(
        `Правило с названием "${args.name.trim()}" уже существует`
      );
    }

    // Check autoStop permission
    const canAutoStop = user.subscriptionTier !== "freemium";
    const stopAd = canAutoStop ? args.actions.stopAd : false;

    const defaults = RULE_TYPE_DEFAULTS[args.type] || {
      metric: args.type,
      operator: ">",
    };

    const now = Date.now();
    const ruleId = await ctx.db.insert("rules", {
      userId: args.userId,
      name: args.name.trim(),
      type: args.type,
      conditions: {
        metric: defaults.metric,
        operator: args.operator || defaults.operator,
        value: args.value,
        minSamples: args.minSamples,
      },
      actions: {
        ...args.actions,
        stopAd,
      },
      targetAccountIds: args.targetAccountIds,
      targetCampaignIds: args.targetCampaignIds,
      targetAdIds: args.targetAdIds,
      isActive: true,
      triggerCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    return ruleId;
  },
});

// Update an existing rule
export const update = mutation({
  args: {
    ruleId: v.id("rules"),
    userId: v.id("users"),
    name: v.optional(v.string()),
    value: v.optional(v.number()),
    operator: v.optional(v.string()),
    minSamples: v.optional(v.number()),
    actions: v.optional(
      v.object({
        stopAd: v.boolean(),
        notify: v.boolean(),
        notifyChannel: v.optional(v.string()),
        customMessage: v.optional(v.string()),
      })
    ),
    targetAccountIds: v.optional(v.array(v.id("adAccounts"))),
    targetCampaignIds: v.optional(v.array(v.string())),
    targetAdIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) {
      throw new Error("Правило не найдено");
    }
    if (rule.userId !== args.userId) {
      throw new Error("Нет доступа к этому правилу");
    }

    const patch: Record<string, unknown> = {
      updatedAt: Date.now(),
    };

    if (args.name !== undefined) {
      if (!args.name.trim()) {
        throw new Error("Название правила не может быть пустым");
      }

      // Check duplicate name
      const existingRules = await ctx.db
        .query("rules")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .collect();

      const duplicate = existingRules.find(
        (r) =>
          r._id !== args.ruleId &&
          r.name.toLowerCase() === args.name!.trim().toLowerCase()
      );
      if (duplicate) {
        throw new Error(
          `Правило с названием "${args.name.trim()}" уже существует`
        );
      }

      patch.name = args.name.trim();
    }

    if (args.value !== undefined) {
      const valueError = validateRuleValue(rule.type, args.value);
      if (valueError) {
        throw new Error(valueError);
      }
      patch.conditions = {
        ...rule.conditions,
        value: args.value,
        operator: args.operator || rule.conditions.operator,
        minSamples:
          args.minSamples !== undefined
            ? args.minSamples
            : rule.conditions.minSamples,
      };
    }

    if (args.actions !== undefined) {
      patch.actions = args.actions;
    }

    if (args.targetAccountIds !== undefined) {
      patch.targetAccountIds = args.targetAccountIds;
    }
    if (args.targetCampaignIds !== undefined) {
      patch.targetCampaignIds = args.targetCampaignIds;
    }
    if (args.targetAdIds !== undefined) {
      patch.targetAdIds = args.targetAdIds;
    }

    await ctx.db.patch(args.ruleId, patch);
    return { success: true };
  },
});

// Toggle rule active/inactive
export const toggleActive = mutation({
  args: {
    ruleId: v.id("rules"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) {
      throw new Error("Правило не найдено");
    }
    if (rule.userId !== args.userId) {
      throw new Error("Нет доступа к этому правилу");
    }

    const newActive = !rule.isActive;

    // If activating, check tier limit
    if (newActive) {
      const user = await ctx.db.get(args.userId);
      if (!user) throw new Error("Пользователь не найден");

      const tierRuleLimits: Record<string, number> = {
        freemium: 2,
        start: 10,
        pro: Infinity,
      };

      const activeRules = await ctx.db
        .query("rules")
        .withIndex("by_userId_active", (q) =>
          q.eq("userId", args.userId).eq("isActive", true)
        )
        .collect();

      const ruleLimit = tierRuleLimits[user.subscriptionTier] ?? 2;
      if (activeRules.length >= ruleLimit) {
        throw new Error(
          `Лимит активных правил для тарифа "${user.subscriptionTier}" исчерпан`
        );
      }
    }

    await ctx.db.patch(args.ruleId, {
      isActive: newActive,
      updatedAt: Date.now(),
    });

    return { isActive: newActive };
  },
});

// Delete a rule
export const remove = mutation({
  args: {
    ruleId: v.id("rules"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) {
      throw new Error("Правило не найдено");
    }
    if (rule.userId !== args.userId) {
      throw new Error("Нет доступа к этому правилу");
    }

    await ctx.db.delete(args.ruleId);
    return { success: true };
  },
});
