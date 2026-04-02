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
  budget_limit: { metric: "spent", operator: ">" },
  low_impressions: { metric: "impressions", operator: "<" },
  clicks_no_leads: { metric: "clicks_no_leads", operator: ">=" },
  new_lead: { metric: "leads", operator: ">" },
  uz_budget_manage: { metric: "budget_manage", operator: ">" },
};

// Validation
function validateRuleValue(
  type: string,
  value: number
): string | null {
  // new_lead and uz_budget_manage don't use the generic threshold value
  if (type === "new_lead" || type === "uz_budget_manage") return null;
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
      v.literal("spend_no_leads"),
      v.literal("budget_limit"),
      v.literal("low_impressions"),
      v.literal("clicks_no_leads"),
      v.literal("new_lead"),
      v.literal("uz_budget_manage")
    ),
    value: v.number(),
    operator: v.optional(v.string()),
    minSamples: v.optional(v.number()),
    timeWindow: v.optional(
      v.union(v.literal("daily"), v.literal("since_launch"), v.literal("24h"))
    ),
    actions: v.object({
      stopAd: v.boolean(),
      notify: v.boolean(),
      notifyChannel: v.optional(v.string()),
      customMessage: v.optional(v.string()),
      notifyOnEveryIncrease: v.optional(v.boolean()),
      notifyOnKeyEvents: v.optional(v.boolean()),
    }),
    targetAccountIds: v.array(v.id("adAccounts")),
    targetCampaignIds: v.optional(v.array(v.string())),
    targetAdIds: v.optional(v.array(v.string())),
    // uz_budget_manage specific fields
    initialBudget: v.optional(v.number()),
    budgetStep: v.optional(v.number()),
    maxDailyBudget: v.optional(v.number()),
    resetDaily: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Validate name
    if (!args.name.trim()) {
      throw new Error("Название правила не может быть пустым");
    }

    // Validate targets
    if (args.targetAccountIds.length === 0) {
      throw new Error("Выберите хотя бы один кабинет (EMPTY_TARGETS)");
    }

    // Validate value
    const valueError = validateRuleValue(args.type, args.value);
    if (valueError) {
      throw new Error(valueError);
    }

    // Validate uz_budget_manage specific fields
    if (args.type === "uz_budget_manage") {
      if (!args.initialBudget || args.initialBudget <= 0) {
        throw new Error("Начальный бюджет должен быть больше 0");
      }
      if (!args.budgetStep || args.budgetStep <= 0) {
        throw new Error("Шаг увеличения бюджета должен быть больше 0");
      }
      if (args.maxDailyBudget !== undefined && args.maxDailyBudget !== null && args.maxDailyBudget > 0) {
        if (args.maxDailyBudget <= args.initialBudget) {
          throw new Error("Максимальный бюджет должен быть больше начального");
        }
      }
      if (!args.targetCampaignIds || args.targetCampaignIds.length === 0) {
        throw new Error("Выберите хотя бы одну группу с форматом УЗ");
      }
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
    const ruleLimit = tierRuleLimits[user.subscriptionTier ?? "freemium"] ?? 2;

    if (activeRules.length >= ruleLimit) {
      throw new Error(
        `Лимит правил для тарифа "${user.subscriptionTier ?? "freemium"}" исчерпан (${ruleLimit})`
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
    if (!canAutoStop && args.actions.stopAd) {
      throw new Error(
        "Авто-стоп недоступен на тарифе Freemium (FEATURE_UNAVAILABLE)"
      );
    }
    const stopAd = args.actions.stopAd;

    const defaults = RULE_TYPE_DEFAULTS[args.type] || {
      metric: args.type,
      operator: ">",
    };

    const now = Date.now();

    // Build conditions based on rule type
    const conditions = {
      metric: defaults.metric,
      operator: args.operator || defaults.operator,
      value: args.value,
      minSamples: args.minSamples,
      timeWindow: args.timeWindow,
      // uz_budget_manage specific
      ...(args.type === "uz_budget_manage" ? {
        initialBudget: args.initialBudget,
        budgetStep: args.budgetStep,
        maxDailyBudget: args.maxDailyBudget,
        resetDaily: args.resetDaily ?? true,
      } : {}),
    };

    const ruleId = await ctx.db.insert("rules", {
      userId: args.userId,
      name: args.name.trim(),
      type: args.type,
      conditions,
      actions: {
        ...args.actions,
        stopAd,
        notifyOnEveryIncrease: args.actions.notifyOnEveryIncrease,
        notifyOnKeyEvents: args.actions.notifyOnKeyEvents,
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
    timeWindow: v.optional(
      v.union(v.literal("daily"), v.literal("since_launch"), v.literal("24h"))
    ),
    actions: v.optional(
      v.object({
        stopAd: v.boolean(),
        notify: v.boolean(),
        notifyChannel: v.optional(v.string()),
        customMessage: v.optional(v.string()),
        notifyOnEveryIncrease: v.optional(v.boolean()),
        notifyOnKeyEvents: v.optional(v.boolean()),
      })
    ),
    targetAccountIds: v.optional(v.array(v.id("adAccounts"))),
    targetCampaignIds: v.optional(v.array(v.string())),
    targetAdIds: v.optional(v.array(v.string())),
    // uz_budget_manage specific fields
    initialBudget: v.optional(v.number()),
    budgetStep: v.optional(v.number()),
    maxDailyBudget: v.optional(v.number()),
    resetDaily: v.optional(v.boolean()),
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
        timeWindow:
          args.timeWindow !== undefined
            ? args.timeWindow
            : rule.conditions.timeWindow,
      };
    }

    // Update budget fields for uz_budget_manage
    if (rule.type === "uz_budget_manage") {
      const currentConditions = (patch.conditions as Record<string, unknown>) || { ...rule.conditions };
      if (args.initialBudget !== undefined) {
        if (args.initialBudget <= 0) throw new Error("Начальный бюджет должен быть больше 0");
        currentConditions.initialBudget = args.initialBudget;
      }
      if (args.budgetStep !== undefined) {
        if (args.budgetStep <= 0) throw new Error("Шаг увеличения бюджета должен быть больше 0");
        currentConditions.budgetStep = args.budgetStep;
      }
      if (args.maxDailyBudget !== undefined) {
        currentConditions.maxDailyBudget = args.maxDailyBudget;
      }
      if (args.resetDaily !== undefined) {
        currentConditions.resetDaily = args.resetDaily;
      }
      patch.conditions = currentConditions;
    }

    if (args.actions !== undefined) {
      patch.actions = args.actions;
    }

    if (args.targetAccountIds !== undefined) {
      if (args.targetAccountIds.length === 0) {
        throw new Error("Выберите хотя бы один кабинет (EMPTY_TARGETS)");
      }
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

      const ruleLimit = tierRuleLimits[user.subscriptionTier ?? "freemium"] ?? 2;
      if (activeRules.length >= ruleLimit) {
        throw new Error(
          `Лимит активных правил для тарифа "${user.subscriptionTier ?? "freemium"}" исчерпан`
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
