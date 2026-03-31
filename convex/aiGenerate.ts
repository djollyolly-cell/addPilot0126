import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";

// Generate 3 banner variants (title + text) for an AI campaign
export const generateBannerTexts = action({
  args: {
    userId: v.id("users"),
    businessDirection: v.string(),
    objective: v.string(),
    targetUrl: v.string(),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
    context: v.optional(v.string()), // parsed page content
  },
  handler: async (ctx, args) => {
    // Check limits
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

    // Try to fetch page content for context
    let pageContext = args.context || "";
    if (!pageContext && args.targetUrl) {
      try {
        const resp = await fetch(args.targetUrl, {
          headers: { "User-Agent": "AdPilot/1.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const html = await resp.text();
          // Extract text content (strip HTML tags, take first 1000 chars)
          pageContext = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 1000);
        }
      } catch {
        // Ignore fetch errors, proceed without page context
      }
    }

    const objectiveNames: Record<string, string> = {
      traffic: "Трафик на сайт",
      social: "Вступления в сообщество",
      messages: "Сообщения (лиды)",
      video_views: "Просмотры видео",
      engagement: "Продвижение поста",
    };

    const systemPrompt = `Ты — агрессивный direct-response копирайтер для VK Ads.
Генерируй текст для рекламных баннеров мультиформата.

ЖЁСТКИЕ ОГРАНИЧЕНИЯ:
- title: СТРОГО до 25 символов (заголовок)
- text: СТРОГО до 90 символов (текст объявления)

Считай символы! Если длиннее — обрежь и перефразируй.

Бизнес: ${args.businessDirection}
Цель: ${objectiveNames[args.objective] || args.objective}
URL: ${args.targetUrl}${args.targetAudience ? `\nЦелевая аудитория: ${args.targetAudience}` : ""}${args.usp ? `\nУТП: ${args.usp}` : ""}
${pageContext ? `\nКонтент страницы: ${pageContext}` : ""}

Принципы:
- Бей в боль или желание ЦА
- Используй цифры и факты
- Каждое слово работает — убирай воду
- Пиши на русском`;

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
        system: systemPrompt,
        messages: [{
          role: "user",
          content: `Сгенерируй 3 варианта баннера для A/B тестирования.

Ответ строго в JSON формате (без markdown):
[
  {"title": "...", "text": "..."},
  {"title": "...", "text": "..."},
  {"title": "...", "text": "..."}
]`,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || "[]";

    // Parse JSON response
    let banners: { title: string; text: string }[];
    try {
      // Remove markdown code fences if present
      const cleaned = raw.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
      banners = JSON.parse(cleaned);
    } catch {
      throw new Error("AI вернул некорректный формат. Попробуйте ещё раз.");
    }

    // Enforce length limits
    banners = banners.map((b: { title: string; text: string }) => ({
      title: b.title.substring(0, 25),
      text: b.text.substring(0, 90),
    }));

    // Record usage
    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    return banners;
  },
});

// Generate image for a banner (wrapper around existing FLUX generation)
export const generateBannerImage = action({
  args: {
    userId: v.id("users"),
    businessDirection: v.string(),
    title: v.string(),
    text: v.string(),
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

    const bflApiKey = process.env.BFL_API_KEY;
    if (!bflApiKey) throw new Error("BFL_API_KEY не настроен");

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY не настроен");

    // Step 1: Generate visual prompt via Claude (translate Russian to English visual keywords)
    const promptResp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        system: "You generate FLUX image prompts. Return ONLY the prompt in English, no explanations. Style: clean, modern, professional ad creative. No text on image.",
        messages: [{
          role: "user",
          content: `Business: ${args.businessDirection}\nAd title: ${args.title}\nAd text: ${args.text}\n\nGenerate a visual prompt for a square ad image (600x600).`,
        }],
      }),
    });

    if (!promptResp.ok) throw new Error("Ошибка генерации промпта");
    const promptData = await promptResp.json();
    const imagePrompt = promptData.content?.[0]?.text || `Professional ad for ${args.businessDirection}`;

    // Step 2: Generate image via BFL FLUX API
    const fluxResp = await fetch("https://api.bfl.ml/v1/flux-pro-1.1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-key": bflApiKey,
      },
      body: JSON.stringify({
        prompt: imagePrompt,
        width: 600,
        height: 600,
      }),
    });

    if (!fluxResp.ok) {
      const t = await fluxResp.text();
      throw new Error(`FLUX API error: ${fluxResp.status} ${t}`);
    }

    const fluxData = await fluxResp.json();
    const taskId = fluxData.id;
    if (!taskId) throw new Error("FLUX не вернул task ID");

    // Step 3: Poll for result
    let imageUrl = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollResp = await fetch(`https://api.bfl.ml/v1/get_result?id=${taskId}`, {
        headers: { "x-key": bflApiKey },
      });
      if (pollResp.ok) {
        const pollData = await pollResp.json();
        if (pollData.status === "Ready" && pollData.result?.sample) {
          imageUrl = pollData.result.sample;
          break;
        }
        if (pollData.status === "Error") {
          throw new Error("FLUX генерация не удалась");
        }
      }
    }

    if (!imageUrl) throw new Error("Таймаут генерации изображения");

    // Step 4: Download and store in Convex
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) throw new Error("Не удалось скачать изображение");
    const blob = await imgResp.blob();
    const storageId = await ctx.storage.store(blob);

    // Record usage
    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "image",
    });

    return { storageId, imageUrl };
  },
});

// Improve a single text field (title or text) via AI
export const improveTextField = action({
  args: {
    userId: v.id("users"),
    businessDirection: v.string(),
    objective: v.string(),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
    field: v.union(v.literal("title"), v.literal("text")),
    currentValue: v.string(),
  },
  handler: async (ctx, args) => {
    // Check limits (counts as text generation)
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

    const maxLen = args.field === "title" ? 25 : 90;
    const fieldName = args.field === "title" ? "заголовок (title)" : "текст объявления (text)";

    const objectiveNames: Record<string, string> = {
      traffic: "Трафик на сайт",
      social: "Вступления в сообщество",
      messages: "Сообщения (лиды)",
      video_views: "Просмотры видео",
      engagement: "Продвижение поста",
    };

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        system: `Ты — direct-response копирайтер для VK Ads. Улучши ${fieldName} рекламного баннера.
СТРОГО до ${maxLen} символов. Считай символы!
Бизнес: ${args.businessDirection}
Цель: ${objectiveNames[args.objective] || args.objective}${args.targetAudience ? `\nЦА: ${args.targetAudience}` : ""}${args.usp ? `\nУТП: ${args.usp}` : ""}
Ответ — ТОЛЬКО улучшенный текст, без кавычек и пояснений.`,
        messages: [{
          role: "user",
          content: `Улучши: "${args.currentValue}"`,
        }],
      }),
    });

    if (!response.ok) {
      throw new Error("Ошибка AI улучшения текста");
    }

    const data = await response.json();
    const improved = (data.content?.[0]?.text || args.currentValue)
      .replace(/^["«]|["»]$/g, "")
      .trim()
      .substring(0, maxLen);

    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    return improved;
  },
});
