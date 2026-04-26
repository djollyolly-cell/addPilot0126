import { v } from "convex/values";
import { mutation, query, action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { checkOrgWritable } from "./loadUnits";

/**
 * Single source of truth for tier-based rule limits.
 * Must match billing.ts TIERS[tier].rulesLimit.
 * Exported for testing. Used in create + toggleActive.
 *
 * Cross-plan note: Plan 3 (Billing Agency) will extend with
 * agency_s/m/l/xl: Infinity when agency tiers are added.
 */
export const TIER_RULE_LIMITS: Record<string, number> = {
  freemium: 3,
  start: 10,
  pro: Infinity,
  agency_s: Infinity,
  agency_m: Infinity,
  agency_l: Infinity,
  agency_xl: Infinity,
};

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
  cpc_limit: { metric: "cpc", operator: ">" },
  new_lead: { metric: "leads", operator: ">" },
  uz_budget_manage: { metric: "budget_manage", operator: ">" },
};

// Validation
function validateRuleValue(
  type: string,
  value: number
): string | null {
  // new_lead and uz_budget_manage don't use the generic threshold value
  if (type === "new_lead" || type === "uz_budget_manage" || type === "video_rotation") return null;
  if (value <= 0) {
    return "Значение должно быть больше 0";
  }
  if (type === "min_ctr" && value > 100) {
    return "CTR не может быть больше 100%";
  }
  return null;
}

// ---- Video rotation conflict checks ----

/** Check if any campaigns overlap with an active video_rotation rule */
async function validateRotationConflicts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { db: any },
  userId: Id<"users">,
  targetCampaignIds: string[] | undefined,
  _targetAccountIds: Id<"adAccounts">[],
  excludeRuleId?: Id<"rules">
): Promise<string | null> {
  const allRules = await ctx.db
    .query("rules")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .collect();

  const activeRules = allRules.filter(
    (r: any) => r.isActive && (!excludeRuleId || r._id !== excludeRuleId)
  );

  for (const r of activeRules) {
    if (r.type === "video_rotation") {
      if (targetCampaignIds) {
        const otherCampaigns = new Set(r.targetCampaignIds ?? []);
        for (const cId of targetCampaignIds) {
          if (otherCampaigns.has(cId)) {
            return `Кампания ${cId} уже участвует в ротации "${r.name}"`;
          }
        }
      }
    }
  }

  return null;
}

/** Check that rotation campaigns are not covered by any other rule on same accounts */
async function validateNoConflictingRules(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { db: any },
  userId: Id<"users">,
  targetAccountIds: Id<"adAccounts">[],
  targetCampaignIds: string[],
  excludeRuleId?: Id<"rules">
): Promise<string | null> {
  const allRules = await ctx.db
    .query("rules")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .collect();

  const activeRules = allRules.filter(
    (r: any) => r.isActive && r.type !== "video_rotation" && (!excludeRuleId || r._id !== excludeRuleId)
  );

  const accountSet = new Set(targetAccountIds.map(String));
  const campaignSet = new Set(targetCampaignIds);

  for (const r of activeRules) {
    const rAccountIds = (r.targetAccountIds ?? []).map(String);
    const hasOverlappingAccount = rAccountIds.some((aId: string) => accountSet.has(aId));

    if (hasOverlappingAccount && (!r.targetCampaignIds || r.targetCampaignIds.length === 0)) {
      return `На аккаунте есть правило "${r.name}" без фильтра кампаний — ротация невозможна`;
    }

    if (r.targetCampaignIds) {
      for (const cId of r.targetCampaignIds) {
        if (campaignSet.has(cId)) {
          return `Кампания ${cId} используется в правиле "${r.name}" — ротация невозможна`;
        }
      }
    }
  }

  return null;
}

/** Reverse check: when creating a non-rotation rule, check if campaigns are in rotation */
async function validateNotInRotation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { db: any },
  userId: Id<"users">,
  targetAccountIds: Id<"adAccounts">[],
  targetCampaignIds: string[] | undefined,
  excludeRuleId?: Id<"rules">
): Promise<string | null> {
  const allRules = await ctx.db
    .query("rules")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .collect();

  const activeRotations = allRules.filter(
    (r: any) => r.isActive && r.type === "video_rotation" && (!excludeRuleId || r._id !== excludeRuleId)
  );

  if (activeRotations.length === 0) return null;

  const accountSet = new Set(targetAccountIds.map(String));

  for (const rot of activeRotations) {
    const rotAccountIds = (rot.targetAccountIds ?? []).map(String);
    const hasOverlappingAccount = rotAccountIds.some((aId: string) => accountSet.has(aId));

    if (!hasOverlappingAccount) continue;

    if (!targetCampaignIds || targetCampaignIds.length === 0) {
      return `На аккаунте есть активная ротация "${rot.name}" — правило без фильтра кампаний невозможно`;
    }

    const rotCampaigns = new Set(rot.targetCampaignIds ?? []);
    for (const cId of targetCampaignIds) {
      if (rotCampaigns.has(cId)) {
        return `Кампания ${cId} участвует в ротации "${rot.name}" — назначение правил запрещено`;
      }
    }
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
    type: v.string(), // validated at runtime: L1 types + "custom" + "custom_l3"
    // L1: flat fields
    value: v.optional(v.number()),
    operator: v.optional(v.string()),
    minSamples: v.optional(v.number()),
    timeWindow: v.optional(
      v.union(v.literal("daily"), v.literal("since_launch"), v.literal("24h"), v.literal("1h"), v.literal("6h"))
    ),
    // L2: array of conditions (type="custom" only)
    conditionsArray: v.optional(v.array(v.object({
      metric: v.string(),
      operator: v.string(),
      value: v.number(),
      minSamples: v.optional(v.number()),
      timeWindow: v.optional(v.union(
        v.literal("daily"), v.literal("since_launch"),
        v.literal("24h"), v.literal("1h"), v.literal("6h")
      )),
    }))),
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
    targetAdPlanIds: v.optional(v.array(v.string())),
    targetAdIds: v.optional(v.array(v.string())),
    // L3: handler code (required when type="custom_l3")
    customRuleTypeCode: v.optional(v.string()),
    // uz_budget_manage specific fields
    initialBudget: v.optional(v.number()),
    budgetStep: v.optional(v.number()),
    maxDailyBudget: v.optional(v.number()),
    resetDaily: v.optional(v.boolean()),
    // cpc_limit specific: minimum spent before CPC check kicks in
    minSpent: v.optional(v.number()),
    // video_rotation specific fields
    slotDurationHours: v.optional(v.number()),
    rotationDailyBudget: v.optional(v.number()),
    campaignOrder: v.optional(v.array(v.string())),
    rotationQuietHoursEnabled: v.optional(v.boolean()),
    rotationQuietHoursStart: v.optional(v.string()),
    rotationQuietHoursEnd: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check write access (org in read_only/frozen blocks all writes)
    const writable = await checkOrgWritable(ctx, args.userId);
    if (!writable.writable) {
      throw new Error(writable.reason ?? "Кабинет недоступен для изменений");
    }

    // Validate name
    if (!args.name.trim()) {
      throw new Error("Название правила не может быть пустым");
    }

    // Validate targets
    if (args.targetAccountIds.length === 0) {
      throw new Error("Выберите хотя бы один кабинет (EMPTY_TARGETS)");
    }

    // Validate type
    const L1_TYPES = ["cpl_limit", "min_ctr", "fast_spend", "spend_no_leads",
                       "budget_limit", "low_impressions", "clicks_no_leads",
                       "cpc_limit", "new_lead", "uz_budget_manage"];
    const isL1 = L1_TYPES.includes(args.type);
    const isL2 = args.type === "custom";
    const isL3 = args.type === "custom_l3";

    const isRotation = args.type === "video_rotation";
    if (!isL1 && !isL2 && !isL3 && !isRotation) {
      throw new Error(`Неизвестный тип правила: ${args.type}`);
    }

    // L2 requires conditionsArray
    if (isL2) {
      if (!args.conditionsArray || args.conditionsArray.length === 0) {
        throw new Error("Конструктор требует минимум одно условие");
      }
      const KNOWN_METRICS = ["spent", "leads", "clicks", "impressions", "cpl", "ctr", "cpc", "reach"];
      for (const c of args.conditionsArray) {
        if (!KNOWN_METRICS.includes(c.metric)) {
          throw new Error(`Неизвестная метрика: ${c.metric}`);
        }
        if (![">", "<", ">=", "<=", "=="].includes(c.operator)) {
          throw new Error(`Неизвестный оператор: ${c.operator}`);
        }
      }
    }

    // L3 requires customRuleTypeCode + validate handler exists
    if (isL3) {
      if (!args.customRuleTypeCode) {
        throw new Error("L3 правило требует customRuleTypeCode");
      }
      const { CUSTOM_RULE_HANDLERS } = await import("./customRules");
      if (!CUSTOM_RULE_HANDLERS[args.customRuleTypeCode]) {
        throw new Error(`Неизвестный handler: ${args.customRuleTypeCode}`);
      }
    }

    // L1 requires value (except new_lead and uz_budget_manage)
    if (isL1 && args.type !== "new_lead" && args.type !== "uz_budget_manage") {
      const valueError = validateRuleValue(args.type, args.value ?? 0);
      if (valueError) {
        throw new Error(valueError);
      }
      if (args.value === undefined || args.value <= 0) {
        throw new Error("Значение должно быть больше 0");
      }
    }

    // Validate cpc_limit specific fields
    if (args.type === "cpc_limit") {
      if (args.minSpent === undefined || args.minSpent <= 0) {
        throw new Error("Минимальный расход должен быть больше 0");
      }
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

    // Validate video_rotation specific fields
    if (isRotation) {
      const userCheck = await ctx.db.get(args.userId);
      if (!userCheck) throw new Error("Пользователь не найден");
      if (!userCheck.isAdmin && !userCheck.videoRotationEnabled) {
        throw new Error("Модуль ротации не активирован");
      }
      if (!args.slotDurationHours || args.slotDurationHours < 1 || args.slotDurationHours > 24 || !Number.isInteger(args.slotDurationHours)) {
        throw new Error("Время слота: от 1 до 24 часов (целое число)");
      }
      if (!args.rotationDailyBudget || args.rotationDailyBudget <= 0) {
        throw new Error("Бюджет на сутки должен быть больше 0");
      }
      if (!args.targetCampaignIds || args.targetCampaignIds.length < 2) {
        throw new Error("Минимум 2 кампании для ротации");
      }
      if (args.targetCampaignIds.length > 50) {
        throw new Error("Максимум 50 кампаний в ротации");
      }
      const rotConflict = await validateRotationConflicts(ctx, args.userId, args.targetCampaignIds, args.targetAccountIds);
      if (rotConflict) throw new Error(rotConflict);
      const ruleConflict = await validateNoConflictingRules(ctx, args.userId, args.targetAccountIds, args.targetCampaignIds);
      if (ruleConflict) throw new Error(ruleConflict);
    }

    // Check tier limits
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("Пользователь не найден");
    }

    const existingRules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const activeRules = existingRules.filter((r) => r.isActive);
    const ruleLimit = TIER_RULE_LIMITS[user.subscriptionTier ?? "freemium"] ?? 3;

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

    // Check if campaigns are in an active rotation (reverse validation)
    if (!isRotation) {
      const rotCheck = await validateNotInRotation(ctx, args.userId, args.targetAccountIds, args.targetCampaignIds);
      if (rotCheck) throw new Error(rotCheck);
    }

    // Check autoStop permission
    const canAutoStop = user.subscriptionTier !== "freemium";
    if (!canAutoStop && args.actions.stopAd) {
      throw new Error(
        "Авто-стоп недоступен на тарифе Freemium (FEATURE_UNAVAILABLE)"
      );
    }
    const stopAd = args.actions.stopAd;

    // B5: Validate targetAdPlanIds belong to accessible accounts
    if (args.targetAdPlanIds && args.targetAdPlanIds.length > 0) {
      const validation = await ctx.runQuery(internal.accessControl.validateAdPlanIds, {
        userId: args.userId,
        adPlanIds: args.targetAdPlanIds,
      });
      if (!validation.ok) {
        throw new Error(
          `Нет доступа к рекламным планам: ${validation.invalidIds.join(", ")}`
        );
      }
    }

    const now = Date.now();

    // Build conditions based on level
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let conditions: any;
    if (isRotation) {
      conditions = {
        metric: "rotation",
        operator: ">",
        value: 0,
        slotDurationHours: args.slotDurationHours,
        dailyBudget: args.rotationDailyBudget,
        quietHoursEnabled: args.rotationQuietHoursEnabled ?? false,
        quietHoursStart: args.rotationQuietHoursStart,
        quietHoursEnd: args.rotationQuietHoursEnd,
        campaignOrder: args.campaignOrder ?? args.targetCampaignIds,
      };
    } else if (isL2) {
      conditions = args.conditionsArray; // array — validated non-empty above
    } else {
      // L1 / L3: single object
      const defaults = RULE_TYPE_DEFAULTS[args.type] || {
        metric: args.type,
        operator: ">",
      };
      conditions = {
        metric: defaults.metric,
        operator: args.operator || defaults.operator,
        value: args.value ?? 0,
        minSamples: args.minSamples,
        timeWindow: args.timeWindow,
        // uz_budget_manage specific
        ...(args.type === "uz_budget_manage" ? {
          initialBudget: args.initialBudget,
          budgetStep: args.budgetStep,
          maxDailyBudget: args.maxDailyBudget,
          resetDaily: args.resetDaily ?? true,
        } : {}),
        // cpc_limit specific
        ...(args.type === "cpc_limit" ? {
          minSpent: args.minSpent,
        } : {}),
      };
    }

    const ruleId = await ctx.db.insert("rules", {
      userId: args.userId,
      orgId: user?.organizationId,
      name: args.name.trim(),
      type: args.type as "cpl_limit" | "min_ctr" | "fast_spend" | "spend_no_leads" | "budget_limit" | "low_impressions" | "clicks_no_leads" | "new_lead" | "uz_budget_manage" | "custom" | "custom_l3" | "video_rotation",
      customRuleTypeCode: isL3 ? args.customRuleTypeCode : undefined,
      conditions,
      actions: {
        ...args.actions,
        stopAd,
        notifyOnEveryIncrease: args.actions.notifyOnEveryIncrease,
        notifyOnKeyEvents: args.actions.notifyOnKeyEvents,
      },
      targetAccountIds: args.targetAccountIds,
      targetCampaignIds: args.targetCampaignIds,
      targetAdPlanIds: args.targetAdPlanIds,
      targetAdIds: args.targetAdIds,
      isActive: true,
      triggerCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Activate rotation immediately after creation
    if (args.type === "video_rotation") {
      await ctx.scheduler.runAfter(0, internal.videoRotation.activate, { ruleId });
    }

    // Audit log
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: args.userId,
      category: "rule",
      action: "rule_created",
      status: "success",
      details: { ruleName: args.name.trim(), ruleType: args.type },
    }); } catch { /* non-critical */ }

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
      v.union(v.literal("daily"), v.literal("since_launch"), v.literal("24h"), v.literal("1h"), v.literal("6h"))
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
    targetAdPlanIds: v.optional(v.array(v.string())),
    targetAdIds: v.optional(v.array(v.string())),
    // L2: array of conditions (type="custom" only)
    conditionsArray: v.optional(v.array(v.object({
      metric: v.string(),
      operator: v.string(),
      value: v.number(),
      minSamples: v.optional(v.number()),
      timeWindow: v.optional(v.union(
        v.literal("daily"), v.literal("since_launch"),
        v.literal("24h"), v.literal("1h"), v.literal("6h")
      )),
    }))),
    // uz_budget_manage specific fields
    initialBudget: v.optional(v.number()),
    budgetStep: v.optional(v.number()),
    maxDailyBudget: v.optional(v.number()),
    resetDaily: v.optional(v.boolean()),
    // cpc_limit specific
    minSpent: v.optional(v.number()),
    // video_rotation specific
    slotDurationHours: v.optional(v.number()),
    rotationDailyBudget: v.optional(v.number()),
    rotationQuietHoursEnabled: v.optional(v.boolean()),
    rotationQuietHoursStart: v.optional(v.string()),
    rotationQuietHoursEnd: v.optional(v.string()),
    campaignOrder: v.optional(v.array(v.string())),
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

    // L2: update conditions via conditionsArray
    if (rule.type === "custom" && args.conditionsArray && args.conditionsArray.length > 0) {
      const KNOWN_METRICS = ["spent", "leads", "clicks", "impressions", "cpl", "ctr", "cpc", "reach"];
      for (const c of args.conditionsArray) {
        if (!KNOWN_METRICS.includes(c.metric)) {
          throw new Error(`Неизвестная метрика: ${c.metric}`);
        }
        if (![">", "<", ">=", "<=", "=="].includes(c.operator)) {
          throw new Error(`Неизвестный оператор: ${c.operator}`);
        }
      }
      patch.conditions = args.conditionsArray;
    }

    // L1: update conditions via value/operator/etc
    if (args.value !== undefined && !Array.isArray(rule.conditions)) {
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

    // Update minSpent for cpc_limit
    if (rule.type === "cpc_limit" && args.minSpent !== undefined) {
      if (args.minSpent <= 0) {
        throw new Error("Минимальный расход должен быть больше 0");
      }
      const currentConditions = (patch.conditions as Record<string, unknown>) || { ...rule.conditions };
      currentConditions.minSpent = args.minSpent;
      patch.conditions = currentConditions;
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

    // Update video_rotation fields
    if (rule.type === "video_rotation") {
      const currentConditions = (patch.conditions as Record<string, unknown>) || { ...rule.conditions };
      if (args.slotDurationHours !== undefined) {
        if (args.slotDurationHours < 1 || args.slotDurationHours > 24 || !Number.isInteger(args.slotDurationHours)) {
          throw new Error("Время слота должно быть целым числом от 1 до 24 часов");
        }
        currentConditions.slotDurationHours = args.slotDurationHours;
      }
      if (args.rotationDailyBudget !== undefined) {
        if (args.rotationDailyBudget <= 0) {
          throw new Error("Бюджет на сутки должен быть больше 0");
        }
        currentConditions.dailyBudget = args.rotationDailyBudget;
      }
      if (args.rotationQuietHoursEnabled !== undefined) {
        currentConditions.quietHoursEnabled = args.rotationQuietHoursEnabled;
      }
      if (args.rotationQuietHoursStart !== undefined) {
        currentConditions.quietHoursStart = args.rotationQuietHoursStart;
      }
      if (args.rotationQuietHoursEnd !== undefined) {
        currentConditions.quietHoursEnd = args.rotationQuietHoursEnd;
      }
      if (args.campaignOrder !== undefined) {
        currentConditions.campaignOrder = args.campaignOrder;
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
    if (args.targetAdPlanIds !== undefined) {
      // B5: Validate targetAdPlanIds belong to accessible accounts
      if (args.targetAdPlanIds.length > 0) {
        const validation = await ctx.runQuery(internal.accessControl.validateAdPlanIds, {
          userId: args.userId,
          adPlanIds: args.targetAdPlanIds,
        });
        if (!validation.ok) {
          throw new Error(
            `Нет доступа к рекламным планам: ${validation.invalidIds.join(", ")}`
          );
        }
      }
      patch.targetAdPlanIds = args.targetAdPlanIds;
    }
    if (args.targetAdIds !== undefined) {
      patch.targetAdIds = args.targetAdIds;
    }

    await ctx.db.patch(args.ruleId, patch);

    // Audit log
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: args.userId,
      category: "rule",
      action: "rule_updated",
      status: "success",
      details: { ruleName: (patch.name as string) ?? rule.name },
    }); } catch { /* non-critical */ }

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

      const activeRules = await ctx.db
        .query("rules")
        .withIndex("by_userId_active", (q) =>
          q.eq("userId", args.userId).eq("isActive", true)
        )
        .collect();

      const ruleLimit = TIER_RULE_LIMITS[user.subscriptionTier ?? "freemium"] ?? 3;
      if (activeRules.length >= ruleLimit) {
        throw new Error(
          `Лимит активных правил для тарифа "${user.subscriptionTier ?? "freemium"}" исчерпан`
        );
      }
    }

    // Handle video_rotation activation/deactivation
    if (rule.type === "video_rotation") {
      if (newActive) {
        const rotConflict = await validateRotationConflicts(ctx, args.userId, rule.targetCampaignIds, rule.targetAccountIds, args.ruleId);
        if (rotConflict) throw new Error(rotConflict);
        const ruleConflict = await validateNoConflictingRules(ctx, args.userId, rule.targetAccountIds, rule.targetCampaignIds ?? [], args.ruleId);
        if (ruleConflict) throw new Error(ruleConflict);
      }
    }

    await ctx.db.patch(args.ruleId, {
      isActive: newActive,
      updatedAt: Date.now(),
    });

    // Schedule rotation activate/deactivate (must run outside mutation)
    if (rule.type === "video_rotation") {
      if (newActive) {
        await ctx.scheduler.runAfter(0, internal.videoRotation.activate, { ruleId: args.ruleId });
      } else {
        await ctx.scheduler.runAfter(0, internal.videoRotation.deactivate, { ruleId: args.ruleId });
      }
    }

    // Audit log
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: args.userId,
      category: "rule",
      action: "rule_toggled",
      status: "success",
      details: { ruleName: rule.name, isActive: newActive },
    }); } catch { /* non-critical */ }

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

    // Audit log
    try { await ctx.runMutation(internal.auditLog.log, {
      userId: args.userId,
      category: "rule",
      action: "rule_deleted",
      status: "success",
      details: { ruleName: rule.name },
    }); } catch { /* non-critical */ }

    // Deactivate rotation if active
    if (rule.type === "video_rotation" && rule.isActive) {
      await ctx.scheduler.runAfter(0, internal.videoRotation.deactivate, { ruleId: args.ruleId });
    }

    // Clean up rotationState
    const rotState = await ctx.db
      .query("rotationState")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .first();
    if (rotState) {
      await ctx.db.delete(rotState._id);
    }

    await ctx.db.delete(args.ruleId);
    return { success: true };
  },
});

// Internal query to get rule by ID (used by initializeUzBudgets action)
export const getRule = internalQuery({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.ruleId);
  },
});

/**
 * Initialize budgets for a uz_budget_manage rule immediately after creation.
 * Sets budget_limit_day to initialBudget for all target campaigns.
 */
export const initializeUzBudgets = action({
  args: {
    ruleId: v.id("rules"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const rule: Awaited<ReturnType<typeof ctx.runQuery>> = await ctx.runQuery(internal.rules.getRule, { ruleId: args.ruleId });
    if (!rule || rule.type !== "uz_budget_manage") {
      throw new Error("Правило не найдено или имеет неверный тип");
    }
    if (!rule.isActive) {
      throw new Error("Правило неактивно — бюджеты не установлены");
    }
    if (rule.userId !== args.userId) {
      throw new Error("Нет доступа к этому правилу");
    }

    const { initialBudget } = rule.conditions as { initialBudget?: number };
    if (!initialBudget) {
      throw new Error("Начальный бюджет не задан в правиле");
    }

    const targetIds = rule.targetCampaignIds || [];
    if (targetIds.length === 0) {
      throw new Error("Нет целевых кампаний в правиле");
    }

    let initialized = 0;
    const errors: string[] = [];
    for (const accountId of rule.targetAccountIds) {
      let accessToken: string;
      try {
        accessToken = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId }
        );
      } catch {
        errors.push(`Не удалось получить токен для аккаунта ${accountId}`);
        continue;
      }

      // Get campaigns from VK API and resolve ad_plan_id matches
      const campaigns = await ctx.runAction(
        internal.vkApi.getCampaignsForAccount,
        { accessToken }
      ) as Array<{ id: number; name: string; status: string; budget_limit_day: string; ad_plan_id?: number; delivery?: string }>;

      const { filterCampaignsForRule } = await import("./uzBudgetHelpers");
      const matched = filterCampaignsForRule(campaigns, rule as { targetCampaignIds?: string[] });

      for (const campaign of matched) {
        try {
          await ctx.runAction(internal.vkApi.setCampaignBudget, {
            accessToken,
            campaignId: campaign.id,
            newLimitRubles: initialBudget,
          });
          initialized++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Кампания ${campaign.id} (${campaign.name}): ${msg}`);
        }
      }
    }

    console.log(`[initializeUzBudgets] Rule ${args.ruleId}: initialized ${initialized}/${targetIds.length} campaigns to ${initialBudget}₽`);

    if (initialized === 0) {
      throw new Error(`Не удалось установить бюджет ни для одной кампании. ${errors[0] || ""}`);
    }

    return { initialized, total: targetIds.length, initialBudget };
  },
});
