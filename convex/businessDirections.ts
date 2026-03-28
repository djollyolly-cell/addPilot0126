import { v } from "convex/values";
import { query, mutation, action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// List directions for an account
export const list = query({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("businessDirections")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
});

// Internal list (for AI prompts)
export const listInternal = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("businessDirections")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    return all.filter((d) => d.isActive);
  },
});

// Create a new direction
export const create = mutation({
  args: {
    accountId: v.id("adAccounts"),
    name: v.string(),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.name.trim()) throw new Error("Введите название направления");
    return await ctx.db.insert("businessDirections", {
      accountId: args.accountId,
      name: args.name.trim(),
      targetAudience: args.targetAudience,
      usp: args.usp,
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

// Update a direction
export const update = mutation({
  args: {
    id: v.id("businessDirections"),
    name: v.optional(v.string()),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    const filtered: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(updates)) {
      if (val !== undefined) filtered[k] = val;
    }
    await ctx.db.patch(id, filtered);
  },
});

// Delete a direction
export const remove = mutation({
  args: { id: v.id("businessDirections") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

// Get single direction
export const get = query({
  args: { id: v.id("businessDirections") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// AI suggest target audience variants
export const suggestTargetAudience = action({
  args: {
    userId: v.id("users"),
    companyName: v.string(),
    industry: v.string(),
    directionName: v.string(),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY не настроен");
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

    const usage = await ctx.runQuery(internal.aiLimits.getUsageInternal, {
      userId: args.userId,
      type: "text",
    });
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const tier = user?.subscriptionTier || "freemium";
    const limits: Record<string, number> = { freemium: 5, start: 50, pro: 200 };
    if (usage >= (limits[tier] || 5)) {
      throw new Error("Лимит генераций исчерпан. Обновите тариф.");
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: `Ты — маркетолог-стратег. На основе информации о бизнесе предложи 5 вариантов целевой аудитории. Каждый вариант — одна строка, максимум 80 символов. Формат: демография + география + интересы. Отвечай ТОЛЬКО JSON-массивом строк, без пояснений.`,
        messages: [{
          role: "user",
          content: `Компания: ${args.companyName}\nНиша: ${args.industry}\nНаправление: ${args.directionName}`,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "[]";

    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    try {
      return JSON.parse(text) as string[];
    } catch {
      return [text.trim()];
    }
  },
});

// AI suggest USP variants
export const suggestUsp = action({
  args: {
    userId: v.id("users"),
    companyName: v.string(),
    industry: v.string(),
    directionName: v.string(),
    targetAudience: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY не настроен");
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

    const usage = await ctx.runQuery(internal.aiLimits.getUsageInternal, {
      userId: args.userId,
      type: "text",
    });
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const tier = user?.subscriptionTier || "freemium";
    const limits: Record<string, number> = { freemium: 5, start: 50, pro: 200 };
    if (usage >= (limits[tier] || 5)) {
      throw new Error("Лимит генераций исчерпан. Обновите тариф.");
    }

    const audienceCtx = args.targetAudience ? `\nЦелевая аудитория: ${args.targetAudience}` : "";

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: `Ты — маркетолог-стратег. На основе информации о бизнесе предложи 5 вариантов УТП (уникального торгового предложения). Каждый вариант — одна строка, максимум 80 символов. УТП должно быть конкретным и измеримым. Отвечай ТОЛЬКО JSON-массивом строк, без пояснений.`,
        messages: [{
          role: "user",
          content: `Компания: ${args.companyName}\nНиша: ${args.industry}\nНаправление: ${args.directionName}${audienceCtx}`,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "[]";

    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    try {
      return JSON.parse(text) as string[];
    } catch {
      return [text.trim()];
    }
  },
});
