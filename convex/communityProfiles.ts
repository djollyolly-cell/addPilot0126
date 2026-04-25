import { v } from "convex/values";
import { mutation, query, action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { groupsGetById } from "./vkCommunityApi";
import { validateSenlerKey as senlerValidate } from "./senlerApi";

// ─── Queries ──────────────────────────────────────────────

export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("communityProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
    // Strip sensitive tokens — never send them to the client
    return profiles.map((p) => ({
      _id: p._id,
      _creationTime: p._creationTime,
      userId: p.userId,
      vkGroupId: p.vkGroupId,
      vkGroupName: p.vkGroupName,
      vkGroupAvatarUrl: p.vkGroupAvatarUrl,
      hasVkToken: !!p.vkCommunityToken,
      hasSenlerKey: !!p.senlerApiKey,
      lastValidatedAt: p.lastValidatedAt,
      lastError: p.lastError,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  },
});

// ─── Validate actions ─────────────────────────────────────

/**
 * Валидирует VK community token и возвращает инфу о сообществе.
 * Не сохраняет в БД — это делает `create` / `update` mutation после того,
 * как UI получил подтверждение.
 */
export const validateCommunityToken = action({
  args: { token: v.string() },
  handler: async (_ctx, args) => {
    const trimmed = args.token.trim();
    if (trimmed.length === 0) {
      throw new Error("Введите токен");
    }
    try {
      const info = await groupsGetById(trimmed);
      return {
        vkGroupId: info.id,
        vkGroupName: info.name,
        vkGroupAvatarUrl: info.photo_100,
        screenName: info.screen_name,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("error 5")) {
        throw new Error("Токен не подходит — проверьте, что это access_token сообщества");
      }
      if (msg.includes("error 15")) {
        throw new Error("У токена нет прав для этого сообщества");
      }
      throw new Error(`Ошибка VK API: ${msg}`);
    }
  },
});

export const validateSenlerKey = action({
  args: { apiKey: v.string() },
  handler: async (_ctx, args) => {
    const trimmed = args.apiKey.trim();
    if (trimmed.length === 0) throw new Error("Введите API-ключ");
    try {
      await senlerValidate(trimmed);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Ключ Senler не подходит: ${msg}`);
    }
  },
});

// ─── Mutations ────────────────────────────────────────────

const PROFILE_LIMIT = 50;

export const create = mutation({
  args: {
    userId: v.id("users"),
    vkGroupId: v.number(),
    vkGroupName: v.string(),
    vkGroupAvatarUrl: v.optional(v.string()),
    vkCommunityToken: v.string(),
    senlerApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Лимит
    const existing = await ctx.db
      .query("communityProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    if (existing.length >= PROFILE_LIMIT) {
      throw new Error(`Лимит профилей: ${PROFILE_LIMIT} на пользователя`);
    }
    // Дедуп
    const dup = existing.find((p) => p.vkGroupId === args.vkGroupId);
    if (dup) {
      throw new Error("Это сообщество уже добавлено");
    }
    const now = Date.now();
    return await ctx.db.insert("communityProfiles", {
      ...args,
      lastValidatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("communityProfiles"),
    userId: v.id("users"),
    vkCommunityToken: v.optional(v.string()),
    senlerApiKey: v.optional(v.string()),
    vkGroupName: v.optional(v.string()),
    vkGroupAvatarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Профиль не найден");
    if (existing.userId !== args.userId) throw new Error("Нет доступа");

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.vkCommunityToken !== undefined) {
      patch.vkCommunityToken = args.vkCommunityToken;
      patch.lastValidatedAt = Date.now();
      patch.lastError = undefined;
    }
    if (args.senlerApiKey !== undefined) patch.senlerApiKey = args.senlerApiKey;
    if (args.vkGroupName !== undefined) patch.vkGroupName = args.vkGroupName;
    if (args.vkGroupAvatarUrl !== undefined) patch.vkGroupAvatarUrl = args.vkGroupAvatarUrl;

    await ctx.db.patch(args.id, patch);
  },
});

export const remove = mutation({
  args: { id: v.id("communityProfiles"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Профиль не найден");
    if (existing.userId !== args.userId) throw new Error("Нет доступа");
    await ctx.db.delete(args.id);
  },
});

// ─── Internal: cron daily validation ──────────────────────

export const _listAllForValidation = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("communityProfiles").collect();
  },
});

export const _markValidated = internalMutation({
  args: {
    id: v.id("communityProfiles"),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      lastValidatedAt: Date.now(),
      lastError: args.error,
    });
  },
});

export const dailyValidateAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.runQuery(internal.communityProfiles._listAllForValidation);
    for (const p of profiles) {
      const errorParts: string[] = [];
      try {
        await groupsGetById(p.vkCommunityToken);
      } catch (err) {
        errorParts.push(`VK: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (p.senlerApiKey) {
        try {
          await senlerValidate(p.senlerApiKey);
        } catch (err) {
          errorParts.push(`Senler: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await ctx.runMutation(internal.communityProfiles._markValidated, {
        id: p._id,
        error: errorParts.length ? errorParts.join(" | ") : undefined,
      });
      // Мягкий rate-limit: 300ms между профилями
      await new Promise((r) => setTimeout(r, 300));
    }
  },
});
