import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { isValidField } from "./reportFieldCatalog";

const TEMPLATE_LIMIT = 10;

const filtersValidator = v.object({
  accountIds: v.array(v.id("adAccounts")),
  campaignIds: v.optional(v.array(v.string())),
  groupIds: v.optional(v.array(v.number())),
  communityIds: v.optional(v.array(v.number())),
  campaignStatus: v.optional(v.string()),
});

const granularityValidator = v.union(
  v.literal("day"),
  v.literal("day_campaign"),
  v.literal("day_group"),
  v.literal("day_banner")
);

export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("reportTemplates")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
  },
});

export const create = mutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
    filters: filtersValidator,
    granularity: granularityValidator,
    fields: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.name.trim().length === 0) throw new Error("Введите имя шаблона");
    if (args.name.length > 60) throw new Error("Имя шаблона — максимум 60 символов");
    if (args.filters.accountIds.length === 0) {
      throw new Error("Выберите хотя бы один кабинет");
    }
    const invalid = args.fields.filter((f) => !isValidField(f));
    if (invalid.length > 0) {
      throw new Error(`Неизвестные поля: ${invalid.join(", ")}`);
    }

    const existing = await ctx.db
      .query("reportTemplates")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    if (existing.length >= TEMPLATE_LIMIT) {
      throw new Error(`Лимит шаблонов: ${TEMPLATE_LIMIT} на пользователя`);
    }
    if (existing.some((t) => t.name === args.name)) {
      throw new Error("Шаблон с таким именем уже существует");
    }

    const now = Date.now();
    return await ctx.db.insert("reportTemplates", {
      ...args,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("reportTemplates"),
    userId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
    filters: filtersValidator,
    granularity: granularityValidator,
    fields: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Шаблон не найден");
    if (existing.userId !== args.userId) throw new Error("Нет доступа");

    if (args.name.trim().length === 0) throw new Error("Введите имя шаблона");
    if (args.name.length > 60) throw new Error("Имя шаблона — максимум 60 символов");
    if (args.filters.accountIds.length === 0) {
      throw new Error("Выберите хотя бы один кабинет");
    }
    const invalid = args.fields.filter((f) => !isValidField(f));
    if (invalid.length > 0) {
      throw new Error(`Неизвестные поля: ${invalid.join(", ")}`);
    }

    // Уникальность имени (исключая текущий шаблон)
    const others = await ctx.db
      .query("reportTemplates")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    if (others.some((t) => t._id !== args.id && t.name === args.name)) {
      throw new Error("Шаблон с таким именем уже существует");
    }

    const patch: Record<string, unknown> = {
      name: args.name,
      filters: args.filters,
      granularity: args.granularity,
      fields: args.fields,
      updatedAt: Date.now(),
    };
    if (args.description !== undefined) {
      patch.description = args.description;
    }
    await ctx.db.patch(args.id, patch);
  },
});

export const remove = mutation({
  args: { id: v.id("reportTemplates"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Шаблон не найден");
    if (existing.userId !== args.userId) throw new Error("Нет доступа");
    await ctx.db.delete(args.id);
  },
});
