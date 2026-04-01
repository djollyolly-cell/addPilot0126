import { v } from "convex/values";
import { query, mutation, action, internalQuery, internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { selectStyle } from "./bannerStyles";

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
    adTitle: v.optional(v.string()),
    adText: v.optional(v.string()),
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
      adTitle: args.adTitle?.slice(0, 90),
      adText: args.adText?.slice(0, 220),
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
      v.literal("cta"),
      v.literal("adTitle"),
      v.literal("adText")
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
        prompt: "Сгенерируй рекламный оффер (до 60 символов). Используй конкретные цифры, результат или выгоду. Бей в боль или желание ЦА. Примеры сильных офферов: «Клиенты из ВК за 3 дня без бюджета на тесты», «Похудей на 5 кг за неделю без диет», «Заявки по 150₽ вместо 800₽ — без магии». НЕ пиши общие фразы типа «Лучшее решение» или «Высокое качество».",
      },
      bullets: {
        maxLen: 120,
        prompt: "Сгенерируй 3 буллета через « • » (до 120 символов суммарно). Каждый буллет — конкретная выгода с цифрой или фактом, а НЕ характеристика продукта. Формула: результат + срок/условие. Примеры: «ROI +300% за первый месяц • Настройка за 15 минут • Без абонентской платы». НЕ пиши абстрактно («индивидуальный подход», «высокое качество», «команда профессионалов»).",
      },
      benefit: {
        maxLen: 50,
        prompt: "Сгенерируй ключевую выгоду (до 50 символов). Покажи трансформацию: что изменится в жизни клиента. Формула: «из [боль] → в [результат]» или конкретный измеримый результат. Примеры: «С 0 до 50 заявок в день», «Экономия 3 часов ежедневно», «Окупаемость с первой недели». НЕ пиши общие фразы.",
      },
      cta: {
        maxLen: 40,
        prompt: "Сгенерируй CTA (до 40 символов). Используй глагол действия + дедлайн/ограничение/бонус. Примеры: «Забери стратегию бесплатно», «Получить расчёт за 2 минуты», «Попробуй 7 дней бесплатно», «Успей до конца недели». НЕ пиши «Узнать больше» или «Подробнее».",
      },
      adTitle: {
        maxLen: 90,
        prompt: "Сгенерируй заголовок рекламного объявления для VK Ads (до 90 символов). Заголовок — первое, что видит пользователь в ленте. Он должен: остановить скролл, вызвать любопытство или ударить в боль ЦА. Используй цифры, вопросы, провокации или конкретный результат. Примеры: «Почему 80% рекламных бюджетов сливается в пустую?», «3 ошибки таргетолога, которые съедают ваш бюджет», «Как мы привели 200 заявок за 5 дней по 97₽». НЕ пиши скучные заголовки.",
      },
      adText: {
        maxLen: 220,
        prompt: "Сгенерируй текст рекламного объявления для VK Ads (до 220 символов). Структура: 1) Боль/проблема ЦА (1 предложение) → 2) Решение через продукт (1 предложение) → 3) Доказательство/результат с цифрой → 4) Призыв к действию. Пиши живым разговорным языком, не канцеляритом. Используй эмодзи умеренно (1-2 штуки максимум). Примеры стиля: «Устали сливать бюджет на рекламу без заявок? Наш AI-таргетолог находит клиентов и отключает убыточные объявления за вас. 87% клиентов окупают подписку за 3 дня. Попробуйте бесплатно →»",
      },
    };

    const config = fieldConfig[args.field];
    let systemPrompt = `Ты — агрессивный direct-response копирайтер для VK Ads. Твоя задача — генерировать текст, который ПРОДАЁТ, а не описывает. Пиши на русском. Отвечай ТОЛЬКО текстом, без кавычек, без пояснений. Максимум ${config.maxLen} символов.\n\nПринципы:\n- Бей в боль или желание ЦА (страх потери, жадность, любопытство, срочность)\n- Используй конкретные цифры и факты, а не прилагательные\n- Каждое слово должно работать — убирай воду\n- Пиши как будто ЦА увидит это на 0.5 секунды в ленте`;
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

// Generate banner image using Haiku (style prompt) + FLUX Ultra
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

    const bflApiKey = process.env.BFL_API_KEY;
    if (!bflApiKey) throw new Error("BFL_API_KEY не настроен");

    try {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      const anthropicBase = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
      if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY не настроен");

      // Step 1: Select style based on business context
      const style = selectStyle(args.businessContext || args.offer);

      // Step 2: Generate FLUX prompt via Haiku with style system prompt
      const translateResp = await fetch(anthropicBase + "/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system: style.systemPrompt,
          messages: [{ role: "user", content: args.offer + ". " + args.bullets + ". " + args.benefit + ". " + (args.businessContext || "") }],
        }),
      });

      let visualKeywords = "Professional commercial photography scene";
      if (translateResp.ok) {
        const trData = await translateResp.json();
        visualKeywords = trData.content?.[0]?.text || visualKeywords;
      }

      const prompt = visualKeywords + " " + style.suffix;

      // Step 3: Submit to FLUX Ultra (square, raw)
      const submitResp = await fetch("https://api.bfl.ai/v1/flux-pro-1.1-ultra", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-key": bflApiKey,
        },
        body: JSON.stringify({
          prompt,
          aspect_ratio: "1:1",
          raw: true,
        }),
      });

      if (!submitResp.ok) {
        const text = await submitResp.text();
        throw new Error("FLUX Ultra API error: " + submitResp.status + " " + text);
      }

      const submitData = await submitResp.json();
      const taskId = submitData.id;

      // Step 4: Poll for result (Ultra ~90 sec, max 60 × 3 sec = 3 min)
      let imageUrl: string | null = null;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const pollResp = await fetch("https://api.bfl.ai/v1/get_result?id=" + taskId, {
          headers: { "x-key": bflApiKey },
        });
        if (!pollResp.ok) continue;
        const pollData = await pollResp.json();
        if (pollData.status === "Ready") {
          imageUrl = pollData.result?.sample;
          break;
        }
        if (pollData.status === "Error" || pollData.status === "Failed") {
          throw new Error("FLUX генерация не удалась: " + pollData.status);
        }
      }

      if (!imageUrl) {
        throw new Error("FLUX: таймаут генерации изображения (3 мин)");
      }

      // Step 5: Download and store
      const imgResp = await fetch(imageUrl);
      if (!imgResp.ok) throw new Error("Не удалось скачать изображение от FLUX");
      const imgBlob = await imgResp.blob();
      const mimeType = imgBlob.type || "image/jpeg";
      const imageBlob = new Blob([await imgBlob.arrayBuffer()], { type: mimeType });
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

