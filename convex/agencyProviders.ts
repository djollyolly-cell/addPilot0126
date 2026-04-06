import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// ---- Queries ----

/** List all agency providers (for UI dropdown) */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("agencyProviders").collect();
  },
});

/** Get provider by name (internal) */
export const getByName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agencyProviders")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
  },
});

/** Get credentials for a user + provider */
export const getCredentials = query({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId_provider", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();
  },
});

/** Get all credentials for a user */
export const getUserCredentials = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

// ---- Internal queries ----

export const getCredentialsInternal = internalQuery({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId_provider", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();
  },
});

// ---- Mutations ----

/** Save or update credentials for a user + provider */
export const saveCredentials = mutation({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    apiKey: v.optional(v.string()),
    oauthClientId: v.optional(v.string()),
    oauthClientSecret: v.optional(v.string()),
    oauthAccessToken: v.optional(v.string()),
    oauthRefreshToken: v.optional(v.string()),
    oauthTokenExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId_provider", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...(args.apiKey !== undefined && { apiKey: args.apiKey }),
        ...(args.oauthClientId !== undefined && { oauthClientId: args.oauthClientId }),
        ...(args.oauthClientSecret !== undefined && { oauthClientSecret: args.oauthClientSecret }),
        ...(args.oauthAccessToken !== undefined && { oauthAccessToken: args.oauthAccessToken }),
        ...(args.oauthRefreshToken !== undefined && { oauthRefreshToken: args.oauthRefreshToken }),
        ...(args.oauthTokenExpiresAt !== undefined && { oauthTokenExpiresAt: args.oauthTokenExpiresAt }),
        lastUsedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("agencyCredentials", {
      userId: args.userId,
      providerId: args.providerId,
      apiKey: args.apiKey,
      oauthClientId: args.oauthClientId,
      oauthClientSecret: args.oauthClientSecret,
      oauthAccessToken: args.oauthAccessToken,
      oauthRefreshToken: args.oauthRefreshToken,
      oauthTokenExpiresAt: args.oauthTokenExpiresAt,
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

/** Internal: save credentials (callable from actions) */
export const saveCredentialsInternal = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.id("agencyProviders"),
    apiKey: v.optional(v.string()),
    oauthClientId: v.optional(v.string()),
    oauthClientSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("agencyCredentials")
      .withIndex("by_userId_provider", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...(args.apiKey !== undefined && { apiKey: args.apiKey }),
        ...(args.oauthClientId !== undefined && { oauthClientId: args.oauthClientId }),
        ...(args.oauthClientSecret !== undefined && { oauthClientSecret: args.oauthClientSecret }),
        lastUsedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("agencyCredentials", {
      userId: args.userId,
      providerId: args.providerId,
      apiKey: args.apiKey,
      oauthClientId: args.oauthClientId,
      oauthClientSecret: args.oauthClientSecret,
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

// ---- Seed providers ----

/** Seed all 4 agency providers. Safe to run multiple times — skips existing. */
export const seedProviders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const PROVIDERS = [
      {
        name: "vitamin",
        displayName: "Витамин",
        hasApi: true,
        authMethod: "api_key",
        requiredFields: [
          { key: "apiKey", label: "API-ключ Витамин", placeholder: "Ключ из поддержки Витамин", type: "password" },
          { key: "cabinetId", label: "ID кабинета в Витамин", placeholder: "Например: 26530229", type: "text" },
        ],
        notes: "API-ключ получить в поддержке Витамин. ID кабинета — из раздела Реклама → Рекламные аккаунты",
      },
      {
        name: "getuniq",
        displayName: "GetUNIQ",
        hasApi: true,
        authMethod: "oauth2",
        requiredFields: [
          { key: "clientId", label: "Client ID", placeholder: "70_...", type: "text" },
          { key: "clientSecret", label: "Client Secret", placeholder: "Секретный ключ приложения", type: "password" },
          { key: "cabinetId", label: "ID кабинета в GetUNIQ", placeholder: "Внутренний ID из GetUNIQ", type: "text" },
        ],
        notes: "OAuth2 приложение из ЛК GetUNIQ. Токен живёт 1 час, обновляется автоматически.",
        docsUrl: "https://dev.getuniq.me/",
      },
      {
        name: "targethunter",
        displayName: "TargetHunter",
        hasApi: false,
        requiredFields: [
          { key: "accessToken", label: "Токен доступа", placeholder: "Бессрочный токен из lead.targethunter.ru", type: "textarea" },
          { key: "accountName", label: "Название кабинета", placeholder: "Например: Клиент Иванов", type: "text" },
        ],
        notes: "Токены бессрочные. Получить в настройках кабинета LeadHunter.",
      },
      {
        name: "cerebro",
        displayName: "Церебро",
        hasApi: false,
        requiredFields: [
          { key: "accessToken", label: "Токен доступа", placeholder: "Токен из agency.cerebroapps.ru", type: "textarea" },
          { key: "accountName", label: "Название кабинета", placeholder: "Например: Клиент Петров", type: "text" },
        ],
        notes: "API нет. Токен получается вручную через agency.cerebroapps.ru",
      },
    ];

    const seeded: string[] = [];
    for (const p of PROVIDERS) {
      const existing = await ctx.db
        .query("agencyProviders")
        .withIndex("by_name", (q) => q.eq("name", p.name))
        .first();
      if (!existing) {
        await ctx.db.insert("agencyProviders", {
          ...p,
          createdAt: Date.now(),
        });
        seeded.push(p.name);
      }
    }
    return { seeded, skipped: PROVIDERS.length - seeded.length };
  },
});
