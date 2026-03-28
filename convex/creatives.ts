import { v } from "convex/values";
import { query, mutation, action, internalQuery, internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

// List creatives for an account
export const list = query({
  args: {
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    const creatives = await ctx.db
      .query("creatives")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    // Return newest first, only for this user
    return creatives
      .filter((c) => c.userId === args.userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

// Get single creative
export const get = query({
  args: { id: v.id("creatives") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Create a draft creative
export const create = mutation({
  args: {
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
    offer: v.string(),
    bullets: v.string(),
    benefit: v.string(),
    cta: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("creatives", {
      userId: args.userId,
      accountId: args.accountId,
      offer: args.offer.slice(0, 60),
      bullets: args.bullets.slice(0, 120),
      benefit: args.benefit.slice(0, 50),
      cta: args.cta.slice(0, 40),
      status: "draft",
      createdAt: now,
      expiresAt: now + TWO_DAYS_MS,
    });
  },
});

// Update creative text fields
export const update = mutation({
  args: {
    id: v.id("creatives"),
    offer: v.optional(v.string()),
    bullets: v.optional(v.string()),
    benefit: v.optional(v.string()),
    cta: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    const cleaned: Record<string, string> = {};
    if (updates.offer !== undefined) cleaned.offer = updates.offer.slice(0, 60);
    if (updates.bullets !== undefined) cleaned.bullets = updates.bullets.slice(0, 120);
    if (updates.benefit !== undefined) cleaned.benefit = updates.benefit.slice(0, 50);
    if (updates.cta !== undefined) cleaned.cta = updates.cta.slice(0, 40);
    await ctx.db.patch(id, cleaned);
  },
});

// Delete creative and its storage file
export const deleteCreative = mutation({
  args: { id: v.id("creatives") },
  handler: async (ctx, args) => {
    const creative = await ctx.db.get(args.id);
    if (!creative) return;
    if (creative.storageId) {
      await ctx.storage.delete(creative.storageId);
    }
    await ctx.db.delete(args.id);
  },
});

// Save generated image (called internally after DALL-E generation)
export const saveGeneratedImage = internalMutation({
  args: {
    id: v.id("creatives"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const url = await ctx.storage.getUrl(args.storageId);
    await ctx.db.patch(args.id, {
      storageId: args.storageId,
      imageUrl: url ?? undefined,
      status: "ready" as const,
    });
  },
});

// Mark creative as failed
export const markFailed = internalMutation({
  args: {
    id: v.id("creatives"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: "failed" as const,
      errorMessage: args.errorMessage,
    });
  },
});

// Generate text for a single field using Claude API
export const generateText = action({
  args: {
    userId: v.id("users"),
    field: v.union(
      v.literal("offer"),
      v.literal("bullets"),
      v.literal("benefit"),
      v.literal("cta")
    ),
    context: v.optional(v.string()), // Existing text from other fields for context
  },
  handler: async (ctx, args) => {
    // Check generation limits
    const usage = await ctx.runQuery(internal.aiLimits.getUsageInternal, {
      userId: args.userId,
      type: "text",
    });
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const tier = user?.subscriptionTier || "freemium";
    const limits: Record<string, number> = { freemium: 5, start: 50, pro: 200 };
    if (usage >= (limits[tier] || 5)) {
      throw new Error("Лимит генераций текста исчерпан. Обновите тариф.");
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY не настроен");

    const fieldConfig: Record<string, { maxLen: number; prompt: string }> = {
      offer: {
        maxLen: 60,
        prompt: "Сгенерируй короткий рекламный оффер (до 60 символов) на русском языке. Он должен быть цепляющим, конкретным и побуждающим к действию.",
      },
      bullets: {
        maxLen: 120,
        prompt: "Сгенерируй буллеты (ключевые преимущества, до 120 символов) для рекламного объявления на русском языке. Краткие, конкретные, через разделитель.",
      },
      benefit: {
        maxLen: 50,
        prompt: "Сгенерируй короткую выгоду для клиента (до 50 символов) на русском языке. Конкретная польза, которую получит клиент.",
      },
      cta: {
        maxLen: 40,
        prompt: "Сгенерируй призыв к действию (CTA, до 40 символов) на русском языке. Краткий, побуждающий к немедленному действию.",
      },
    };

    const config = fieldConfig[args.field];
    let systemPrompt = `Ты — копирайтер для рекламных объявлений VK Ads. Пиши только на русском языке. Отвечай ТОЛЬКО текстом, без кавычек, без пояснений. Максимум ${config.maxLen} символов.`;
    if (args.context) {
      systemPrompt += `\n\nКонтекст объявления: ${args.context}`;
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
        max_tokens: 150,
        system: systemPrompt,
        messages: [{ role: "user", content: config.prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const generatedText = data.content?.[0]?.text?.slice(0, config.maxLen) || "";

    // Record usage
    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    return generatedText;
  },
});

// Generate banner image using DALL-E
export const generateImage = action({
  args: {
    creativeId: v.id("creatives"),
    userId: v.id("users"),
    offer: v.string(),
    bullets: v.string(),
    benefit: v.string(),
    cta: v.string(),
    businessContext: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check limits
    const usage = await ctx.runQuery(internal.aiLimits.getUsageInternal, {
      userId: args.userId,
      type: "image",
    });
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const tier = user?.subscriptionTier || "freemium";
    const limits: Record<string, number> = { freemium: 2, start: 20, pro: 50 };
    if (usage >= (limits[tier] || 2)) {
      throw new Error("Лимит генераций изображений исчерпан. Обновите тариф.");
    }

    // Set status to generating
    await ctx.runMutation(internal.creatives.markGenerating, { id: args.creativeId });

    const apiKey = process.env.OPENAI_API_KEY;
    const openaiBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com";
    if (!apiKey) throw new Error("OPENAI_API_KEY не настроен");

    try {
      const bizCtx = args.businessContext ? `\nBrand context: ${args.businessContext}` : "";
      const prompt = `Create a professional advertising background image for a social media ad banner. DO NOT include any text, letters, words, or typography in the image — only visual elements.

Theme based on the ad concept:
- Product/service: ${args.offer}
- Benefits: ${args.bullets}
- Value: ${args.benefit}${bizCtx}

Style: Modern, clean, professional marketing visual. Bright vibrant colors, abstract geometric shapes or relevant lifestyle imagery. No text, no letters, no words anywhere in the image. Size 1080x1080.`;

      const openaiHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };
      if (process.env.OPENAI_BASE_URL) openaiHeaders["x-target-api"] = "openai";

      const response = await fetch(`${openaiBaseUrl}/v1/images/generations`, {
        method: "POST",
        headers: openaiHeaders,
        body: JSON.stringify({
          model: "dall-e-3",
          prompt,
          n: 1,
          size: "1024x1024",
          response_format: "url",
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`DALL-E API error: ${response.status} ${text}`);
      }

      const data = await response.json();
      const imageUrl = data.data?.[0]?.url;
      if (!imageUrl) throw new Error("Не удалось получить URL изображения");

      // Download image and store in Convex
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) throw new Error("Не удалось скачать изображение");

      const imageBlob = await imageResponse.blob();
      const storageId = await ctx.storage.store(imageBlob);

      // Save to creative
      await ctx.runMutation(internal.creatives.saveGeneratedImage, {
        id: args.creativeId,
        storageId,
      });

      // Record usage
      await ctx.runMutation(internal.aiLimits.recordGeneration, {
        userId: args.userId,
        type: "image",
      });

    } catch (error) {
      await ctx.runMutation(internal.creatives.markFailed, {
        id: args.creativeId,
        errorMessage: error instanceof Error ? error.message : "Ошибка генерации",
      });
      throw error;
    }
  },
});

// Internal: mark as generating
export const markGenerating = internalMutation({
  args: { id: v.id("creatives") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: "generating" as const });
  },
});

// Cron cleanup: delete expired creatives (older than 2 days)
export const cleanupExpired = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.runQuery(internal.creatives.getExpired, { now });
    let count = 0;
    for (const creative of expired) {
      await ctx.runMutation(internal.creatives.deleteExpiredOne, { id: creative._id });
      count++;
    }
    if (count > 0) {
      console.log(`[creatives cleanup] Deleted ${count} expired creatives`);
    }
  },
});

// Internal query for cleanup
export const getExpired = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("creatives")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", args.now))
      .collect();
  },
});

// Internal mutation for cleanup: delete one creative + storage
export const deleteExpiredOne = internalMutation({
  args: { id: v.id("creatives") },
  handler: async (ctx, args) => {
    const creative = await ctx.db.get(args.id);
    if (!creative) return;
    if (creative.storageId) {
      await ctx.storage.delete(creative.storageId);
    }
    await ctx.db.delete(args.id);
  },
});

