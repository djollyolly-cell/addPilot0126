# Banner Pipeline V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current generic banner generation pipeline with style-based Haiku+Ultra generation and Canvas text compositing.

**Architecture:** Backend gets a new `bannerStyles.ts` with 6 visual styles and niche-to-style mapping. `aiGenerate.ts` and `creatives.ts` switch from Sonnet→FLUX Pro 1.1 (608×608) to Haiku→FLUX Ultra (1:1, raw). Frontend gets a `BannerCompositor` component that composites text (headline/subtitle/bullets) on the FLUX image via `<canvas>`, checks text coverage ≤18%, and auto-fits if exceeded.

**Tech Stack:** Convex (actions, mutations), Claude Haiku 4.5, FLUX Pro 1.1 Ultra, React Canvas API, Google Fonts (Inter)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `convex/bannerStyles.ts` | 6 style configs (systemPrompt + suffix), niche→style mapping, `selectStyle()` |
| Update | `convex/aiGenerate.ts` | `generateBannerImage` → Haiku + Ultra + styles; `generateBannerTexts` → new format |
| Update | `convex/creatives.ts` | `generateImage` → Haiku + Ultra + styles (reuse `bannerStyles.ts`) |
| Create | `src/components/BannerCompositor.tsx` | Canvas compositing: gradient overlay, plaques, headline/subtitle/bullets, coverage check, auto-fit, export |
| Update | `src/pages/AICabinetNewPage.tsx` | New BannerVariant interface, integrate BannerCompositor, handle new text format |
| Update | `src/pages/CreativesPage.tsx` | Integrate BannerCompositor for preview |
| Update | `index.html` | Add Google Fonts (Inter) preconnect + link |

---

### Task 1: Create `convex/bannerStyles.ts` — Style Configs & Niche Mapping

**Files:**
- Create: `convex/bannerStyles.ts`

- [ ] **Step 1: Create the file with all 6 style configs**

```typescript
// convex/bannerStyles.ts

export interface StyleConfig {
  code: string;
  systemPrompt: string;
  suffix: string;
  nicheKeywords: string[];
}

const CINEMATIC: StyleConfig = {
  code: "cinematic",
  systemPrompt: `You create image prompts for VK advertising banners.
Given Russian ad text, create a dramatic cinematic metaphor for the product benefit.

Examples of metaphors:
- Lead generation -> powerful magnet pulling golden coins from dark misty air, volumetric light
- Growth/scaling -> rocket launching from a launchpad, trail of fire, dramatic dusk sky
- Fitness -> athlete mid-jump seen from behind, gym atmosphere, chalk dust in dramatic side lighting
- Flower delivery -> luxurious bouquet of roses on black marble, water droplets, studio lighting
- Speed/efficiency -> sleek sports car in motion blur on empty highway at sunset
- Marketing -> giant bullseye target with arrow in center, sparks flying, epic lighting
- Education -> person from behind looking at a vast library, warm golden light flooding in

People rules:
- People allowed but secondary to the scene.
- From behind, side, silhouette, or far away. Always in action, never posed.
- Do NOT show faces or direct eye contact in cinematic style.

Visual rules:
- Bold saturated colors, very high contrast, dark or blurred backgrounds.
- Dramatic lighting: volumetric light, rim light, golden hour, or deep shadows.
- Cinematic photography or high-quality 3D render style.
- COMPOSITION: Medium or wide shot. Main subject occupies ~40% of frame.
- Lower third of image noticeably darker for text overlay area.
- NEVER include: text, letters, words, logos, screens, phones, UI, charts, icons.
- People must wear plain uniform, no logos, no patches, no badges.

Output ONLY the prompt in English (2-3 sentences).`,
  suffix: "Professional commercial photography or high-quality 3D render. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.",
  nicheKeywords: ["лидогенерация", "маркетинг", "реклама", "финансы", "кредит", "страхование"],
};

const LIFESTYLE_CANDID: StyleConfig = {
  code: "lifestyle_candid",
  systemPrompt: `You create image prompts for VK advertising banners.
Given Russian ad copy, create a natural, candid lifestyle scene.

People rules:
- People ARE the focus. Show them naturally in context of using the product or service.
- Faces looking at camera ARE allowed and work well in VK.
- Candid expressions, genuine emotions. No stiff poses.
- Show real situations: at a desk, in a gym, in a cafe, with a product in hand.
- Avoid stock photo cliches: no thumbs up, no forced smiles at nothing.
- Scene should feel like a candid moment captured on a phone, NOT a staged photoshoot.

Visual rules:
- Natural, warm, authentic lighting. Not overly dramatic.
- Background contextually relevant but not distracting (slightly blurred).
- Colors vibrant but realistic, not cinematic color grading.
- COMPOSITION: Medium or wide shot. Person occupies ~40% of frame. Air around the subject.
- Lower third of image noticeably darker for text overlay area.
- NEVER include: text, letters, logos, UI, screens, charts, icons.
- People must wear plain uniform, no logos, no patches, no badges.

Output ONLY the prompt in English (2-3 sentences).`,
  suffix: "Shot on iPhone 15 Pro, casual candid photo, visible skin pores and fine lines, natural skin imperfections, no beauty filter, no smoothing, no retouching, slight camera grain and noise, shallow depth of field, natural indoor lighting, warm tones. Bottom area darker for text overlay. No text, no letters, no words, no watermarks.",
  nicheKeywords: ["фитнес", "спорт", "красота", "косметика", "еда", "ресторан", "доставка", "кафе", "мероприятие", "ивент"],
};

const PRODUCT_FOCUS: StyleConfig = {
  code: "product_focus",
  systemPrompt: `You create image prompts for VK advertising banners.
Given Russian ad copy, create a clean product-focused visual.

Visual rules:
- The product is the hero: large, sharp, well-lit, centered or rule-of-thirds.
- Background: dark, neutral, or contextually relevant surface (marble, wood, concrete).
- Lighting: studio-quality. Clear reflections or shadows that add depth.
- No people. No clutter. Minimal props if any.
- Colors: product real colors should pop. High contrast with background.
- COMPOSITION: Product occupies ~40% of frame. Plenty of breathing room.
- Lower third of image noticeably darker for text overlay area.
- NEVER include: text, letters, logos, UI, screens, charts, icons.

Output ONLY the prompt in English (2-3 sentences).`,
  suffix: "Professional studio photography, high contrast, dark background. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.",
  nicheKeywords: ["товар", "интернет-магазин", "гаджет", "электроника", "одежда"],
};

const RESULT_VISUAL: StyleConfig = {
  code: "result_visual",
  systemPrompt: `You create image prompts for VK advertising banners.
Given Russian ad copy, create a visual that represents the end result or transformation.

Visual rules:
- Show the OUTCOME, not the process: achievement, success, transformation, a milestone reached.
- Can be metaphorical: a mountain summit, a finish line, a before/after expressed through light,
  a person expressing relief or confidence after completing something hard.
- People optional. If shown, they express satisfaction, relief, or confidence.
- Dramatic but clear. The feeling of "I got there" should be immediate.
- Colors: optimistic, energetic. Warm tones for personal achievement, cool/bold for business results.
- COMPOSITION: Medium or wide shot. Subject occupies ~40% of frame.
- Lower third of image noticeably darker for text overlay area.
- NEVER include: text, letters, numbers, logos, UI, screens, charts with labels, icons.
- People must wear plain uniform, no logos, no patches, no badges.

Output ONLY the prompt in English (2-3 sentences).`,
  suffix: "Professional commercial photography. Optimistic warm tones. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.",
  nicheKeywords: ["обучение", "курс", "коучинг", "похудение", "инвестиции"],
};

const LOCATION: StyleConfig = {
  code: "location",
  systemPrompt: `You create image prompts for VK advertising banners.
Given Russian ad copy, create a recognisable location or environment visual.

Visual rules:
- Show a place the target audience knows and relates to: a neighbourhood, interior, city, venue type.
- The location should immediately signal the niche: a gym interior, a cozy cafe, a business district,
  a residential area, a construction site, a school classroom.
- Atmosphere is key: time of day, weather, mood of the space.
- People optional. If present, they are part of the scene, not the focus.
- COMPOSITION: Wide shot preferred. Environment is the hero.
- Lower third of image noticeably darker for text overlay area.
- NEVER include: text, letters, logos, UI, screens, signs with readable words, icons.

Output ONLY the prompt in English (2-3 sentences).`,
  suffix: "Professional architectural or environmental photography, atmospheric lighting. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.",
  nicheKeywords: ["недвижимость", "аренда", "локальный"],
};

const MINIMAL_3D: StyleConfig = {
  code: "minimal_3d",
  systemPrompt: `You create image prompts for VK advertising banners.
Given Russian ad copy, create a clean minimalist 3D visual.

Visual rules:
- One hero object: abstract 3D form, geometric shape, or stylised product representation.
- Plenty of negative space around the object, at least 40% empty.
- Background: solid dark, gradient dark, or very softly lit neutral surface.
- Lighting: clean studio or subtle ambient. Soft shadows. No dramatic rays.
- Colors: 1-2 accent colors maximum. The object should feel premium and modern.
- No people. No clutter. Nothing competing with the main object.
- Lower third of image noticeably darker for text overlay area.
- NEVER include: text, letters, logos, UI, screens, charts, icons.

Output ONLY the prompt in English (2-3 sentences).`,
  suffix: "High-quality 3D render, clean minimal style, dark background, soft studio lighting. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.",
  nicheKeywords: ["saas", "приложение", "сервис", "b2b", "it", "разработка"],
};

export const ALL_STYLES: Record<string, StyleConfig> = {
  lifestyle_candid: LIFESTYLE_CANDID,
  cinematic: CINEMATIC,
  product_focus: PRODUCT_FOCUS,
  result_visual: RESULT_VISUAL,
  location: LOCATION,
  minimal_3d: MINIMAL_3D,
};

/**
 * Select visual style based on niche/businessDirection keyword matching.
 * Searches for keywords in the input string (lowercased).
 * Falls back to "cinematic" if no match found.
 */
export function selectStyle(nicheOrDirection: string): StyleConfig {
  const lower = nicheOrDirection.toLowerCase();
  for (const style of Object.values(ALL_STYLES)) {
    for (const keyword of style.nicheKeywords) {
      if (lower.includes(keyword)) {
        return style;
      }
    }
  }
  return CINEMATIC; // Default fallback
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors (new file has no external dependencies beyond types)

- [ ] **Step 3: Commit**

```bash
git add convex/bannerStyles.ts
git commit -m "feat: add bannerStyles.ts with 6 visual styles and niche mapping"
```

---

### Task 2: Update `convex/aiGenerate.ts` — generateBannerImage → Haiku + Ultra + Styles

**Files:**
- Modify: `convex/aiGenerate.ts:145-253`

- [ ] **Step 1: Update generateBannerImage to use Haiku + Ultra + styles**

Replace the entire `generateBannerImage` action (lines 145-253) with:

```typescript
// Generate image for a banner using Haiku (style prompt) + FLUX Ultra
export const generateBannerImage = action({
  args: {
    userId: v.id("users"),
    businessDirection: v.string(),
    title: v.string(),
    text: v.string(),
    niche: v.optional(v.string()),
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

    // Step 1: Select style based on niche/businessDirection
    const { selectStyle } = await import("./bannerStyles");
    const style = selectStyle(args.niche || args.businessDirection);

    // Step 2: Generate FLUX prompt via Claude Haiku with style system prompt
    const promptResp = await fetch(baseUrl + "/v1/messages", {
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
        messages: [{
          role: "user",
          content: args.businessDirection + ". " + args.title + ". " + args.text,
        }],
      }),
    });

    if (!promptResp.ok) throw new Error("Ошибка генерации промпта");
    const promptData = await promptResp.json();
    const visualKeywords = promptData.content?.[0]?.text || "Professional commercial photography scene";
    const imagePrompt = visualKeywords + " " + style.suffix;

    // Step 3: Submit to FLUX Ultra (square, raw)
    const fluxResp = await fetch("https://api.bfl.ai/v1/flux-pro-1.1-ultra", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-key": bflApiKey,
      },
      body: JSON.stringify({
        prompt: imagePrompt,
        aspect_ratio: "1:1",
        raw: true,
      }),
    });

    if (!fluxResp.ok) {
      const t = await fluxResp.text();
      throw new Error("FLUX Ultra API error: " + fluxResp.status + " " + t);
    }

    const fluxData = await fluxResp.json();
    const taskId = fluxData.id;
    if (!taskId) throw new Error("FLUX не вернул task ID");

    // Step 4: Poll for result (Ultra takes ~90 sec, max 60 iterations × 3 sec = 3 min)
    let imageUrl = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollResp = await fetch("https://api.bfl.ai/v1/get_result?id=" + taskId, {
        headers: { "x-key": bflApiKey },
      });
      if (pollResp.ok) {
        const pollData = await pollResp.json();
        if (pollData.status === "Ready" && pollData.result?.sample) {
          imageUrl = pollData.result.sample;
          break;
        }
        if (pollData.status === "Error" || pollData.status === "Failed") {
          throw new Error("FLUX генерация не удалась");
        }
      }
    }

    if (!imageUrl) throw new Error("Таймаут генерации изображения (3 мин)");

    // Step 5: Download and store in Convex
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) throw new Error("Не удалось скачать изображение");
    const blob = await imgResp.blob();
    const storageId = await ctx.storage.store(blob);

    // Record usage
    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "image",
    });

    return { storageId, imageUrl, style: style.code };
  },
});
```

- [ ] **Step 2: Add bannerStyles import at top of file**

Add to the top of `convex/aiGenerate.ts` (no static import needed — using dynamic import in action handler since Convex actions support it).

No change needed at top — the `await import("./bannerStyles")` is inside the handler.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add convex/aiGenerate.ts
git commit -m "feat: generateBannerImage uses Haiku + FLUX Ultra + style selection"
```

---

### Task 3: Update `convex/aiGenerate.ts` — generateBannerTexts New Format

**Files:**
- Modify: `convex/aiGenerate.ts:6-142`

- [ ] **Step 1: Update generateBannerTexts to produce new text format**

Replace the JSON format section in the system prompt and response parsing. The new format returns `headline`, `subtitle`, `bullets[]`, `adTitle`, `adText` instead of just `title`/`text`.

Replace the entire `generateBannerTexts` action (lines 6-142) with:

```typescript
// Generate banner text variants for an AI campaign
// Returns headline/subtitle/bullets (for banner image) + adTitle/adText (for VK Ads)
export const generateBannerTexts = action({
  args: {
    userId: v.id("users"),
    businessDirection: v.string(),
    objective: v.string(),
    targetUrl: v.string(),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
    context: v.optional(v.string()),
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
          pageContext = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 1000);
        }
      } catch {
        // Ignore fetch errors
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
Генерируй два типа текста:
1. Текст НА баннере (headline, subtitle, bullets) — крупный, читается за секунду
2. Текст ДЛЯ VK Ads (adTitle, adText) — текст объявления в ленте

ЖЁСТКИЕ ОГРАНИЧЕНИЯ:
- headline: до 35 символов (заголовок НА баннере, крупный шрифт)
- subtitle: до 60 символов (подзаголовок НА баннере, опционально)
- bullets: 2-4 штуки, каждый до 40 символов (буллеты НА баннере)
- adTitle: СТРОГО до 25 символов (заголовок для VK Ads)
- adText: СТРОГО до 90 символов (текст для VK Ads)

Считай символы! Если длиннее — обрежь и перефразируй.

Бизнес: ${args.businessDirection}
Цель: ${objectiveNames[args.objective] || args.objective}
URL: ${args.targetUrl}${args.targetAudience ? "\nЦелевая аудитория: " + args.targetAudience : ""}${args.usp ? "\nУТП: " + args.usp : ""}
${pageContext ? "\nКонтент страницы: " + pageContext : ""}

Принципы:
- Бей в боль или желание ЦА
- Используй цифры и факты
- Каждое слово работает — убирай воду
- Пиши на русском`;

    const response = await fetch(baseUrl + "/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: `Сгенерируй 3 варианта баннера для A/B тестирования.

Ответ строго в JSON формате (без markdown):
[
  {
    "headline": "...",
    "subtitle": "...",
    "bullets": ["...", "...", "..."],
    "adTitle": "...",
    "adText": "..."
  }
]`,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error("Claude API error: " + response.status + " " + text);
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || "[]";

    interface BannerTextVariant {
      headline: string;
      subtitle?: string;
      bullets: string[];
      adTitle: string;
      adText: string;
    }

    let banners: BannerTextVariant[];
    try {
      const cleaned = raw.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
      banners = JSON.parse(cleaned);
    } catch {
      throw new Error("AI вернул некорректный формат. Попробуйте ещё раз.");
    }

    // Enforce length limits
    banners = banners.map((b: BannerTextVariant) => ({
      headline: (b.headline || "").substring(0, 35),
      subtitle: b.subtitle ? b.subtitle.substring(0, 60) : undefined,
      bullets: (b.bullets || []).slice(0, 4).map((bl: string) => bl.substring(0, 40)),
      adTitle: (b.adTitle || b.headline || "").substring(0, 25),
      adText: (b.adText || "").substring(0, 90),
    }));

    // Record usage
    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    return banners;
  },
});
```

- [ ] **Step 2: Update improveTextField to support new fields**

Replace the `improveTextField` action (lines 256-333). Add support for `headline`, `subtitle`, `bullet` fields alongside existing `title`/`text`:

```typescript
// Improve a single text field via AI
export const improveTextField = action({
  args: {
    userId: v.id("users"),
    businessDirection: v.string(),
    objective: v.string(),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
    field: v.union(
      v.literal("title"), v.literal("text"),
      v.literal("headline"), v.literal("subtitle"), v.literal("bullet"),
      v.literal("adTitle"), v.literal("adText")
    ),
    currentValue: v.string(),
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

    const fieldMap: Record<string, { maxLen: number; name: string }> = {
      title: { maxLen: 25, name: "заголовок VK Ads (title)" },
      text: { maxLen: 90, name: "текст VK Ads (text)" },
      headline: { maxLen: 35, name: "заголовок на баннере" },
      subtitle: { maxLen: 60, name: "подзаголовок на баннере" },
      bullet: { maxLen: 40, name: "буллет на баннере" },
      adTitle: { maxLen: 25, name: "заголовок VK Ads" },
      adText: { maxLen: 90, name: "текст VK Ads" },
    };

    const config = fieldMap[args.field] || { maxLen: 90, name: args.field };

    const objectiveNames: Record<string, string> = {
      traffic: "Трафик на сайт",
      social: "Вступления в сообщество",
      messages: "Сообщения (лиды)",
      video_views: "Просмотры видео",
      engagement: "Продвижение поста",
    };

    const response = await fetch(baseUrl + "/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        system: "Ты — direct-response копирайтер для VK Ads. Улучши " + config.name + ".\nСТРОГО до " + config.maxLen + " символов. Считай символы!\nБизнес: " + args.businessDirection + "\nЦель: " + (objectiveNames[args.objective] || args.objective) + (args.targetAudience ? "\nЦА: " + args.targetAudience : "") + (args.usp ? "\nУТП: " + args.usp : "") + "\nОтвет — ТОЛЬКО улучшенный текст, без кавычек и пояснений.",
        messages: [{
          role: "user",
          content: 'Улучши: "' + args.currentValue + '"',
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
      .substring(0, config.maxLen);

    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    return improved;
  },
});
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add convex/aiGenerate.ts
git commit -m "feat: generateBannerTexts returns headline/subtitle/bullets/adTitle/adText format"
```

---

### Task 4: Update `convex/creatives.ts` — generateImage → Haiku + Ultra + Styles

**Files:**
- Modify: `convex/creatives.ts:224-356`

- [ ] **Step 1: Update generateImage to use bannerStyles + Ultra**

Replace the `generateImage` action (lines 224-356) with:

```typescript
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
      const { selectStyle } = await import("./bannerStyles");
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add convex/creatives.ts
git commit -m "feat: creatives.generateImage uses Haiku + FLUX Ultra + style selection"
```

---

### Task 5: Create `src/components/BannerCompositor.tsx` — Canvas Compositing

**Files:**
- Create: `src/components/BannerCompositor.tsx`
- Modify: `index.html` (add Inter font)

- [ ] **Step 1: Add Inter font to index.html**

Add to `<head>` section of `index.html`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
```

- [ ] **Step 2: Create BannerCompositor component**

```tsx
// src/components/BannerCompositor.tsx
import { useEffect, useRef, useState, useCallback } from "react";

interface BannerCompositorProps {
  imageUrl: string;
  headline: string;
  subtitle?: string;
  bullets: string[];
  /** Canvas size (FLUX Ultra generates 2048×2048, we render at 1080×1080) */
  size?: number;
  /** Called with the composited JPEG blob when ready */
  onComposite?: (blob: Blob) => void;
  className?: string;
}

const CANVAS_SIZE = 1080;
const PADDING = 60;
const TEXT_COVERAGE_LIMIT = 18;
const FONT_FAMILY = "'Inter', 'Roboto', system-ui, sans-serif";

interface TextBlock {
  x: number;
  y: number;
  w: number;
  h: number;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? current + " " + word : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function calculateCoverage(blocks: TextBlock[], w: number, h: number): number {
  const total = blocks.reduce((sum, b) => sum + b.w * b.h, 0);
  return (total / (w * h)) * 100;
}

export default function BannerCompositor({
  imageUrl,
  headline,
  subtitle,
  bullets,
  size = CANVAS_SIZE,
  onComposite,
  className,
}: BannerCompositorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [coverageInfo, setCoverageInfo] = useState<{ pct: number; passes: boolean } | null>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      canvas.width = size;
      canvas.height = size;

      // Draw FLUX background (resize to canvas)
      ctx.drawImage(img, 0, 0, size, size);

      // Auto-fit loop
      let fontScale = 1.0;
      let currentBullets = bullets.slice(0, 5);
      let currentSubtitle = subtitle;
      let currentHeadline = headline;

      for (let attempt = 0; attempt < 6; attempt++) {
        // Clear and redraw background
        ctx.drawImage(img, 0, 0, size, size);

        const result = drawTextLayers(
          ctx, size, currentHeadline, currentSubtitle, currentBullets, fontScale
        );

        const pct = calculateCoverage(result.blocks, size, size);
        if (pct <= TEXT_COVERAGE_LIMIT || attempt === 5) {
          setCoverageInfo({ pct: Math.round(pct * 10) / 10, passes: pct <= TEXT_COVERAGE_LIMIT });
          break;
        }

        // Auto-fit reductions
        if (attempt === 0) fontScale *= 0.9;
        else if (attempt === 1) fontScale *= 0.9;
        else if (attempt === 2 && currentBullets.length > 0) currentBullets = currentBullets.slice(0, -1);
        else if (attempt === 3 && currentSubtitle) currentSubtitle = undefined;
        else if (attempt === 4) {
          if (currentHeadline.length > 30) currentHeadline = currentHeadline.slice(0, 27) + "…";
          fontScale *= 0.85;
        } else {
          fontScale *= 0.8;
        }
      }

      // Export blob
      if (onComposite) {
        canvas.toBlob(
          (blob) => { if (blob) onComposite(blob); },
          "image/jpeg",
          0.92
        );
      }
    };
    img.src = imageUrl;
  }, [imageUrl, headline, subtitle, bullets, size, onComposite]);

  useEffect(() => {
    render();
  }, [render]);

  return (
    <div className={className}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", maxWidth: size, height: "auto", borderRadius: 8 }}
      />
      {coverageInfo && (
        <div className={"mt-1 text-xs " + (coverageInfo.passes ? "text-muted-foreground" : "text-destructive")}>
          Текст: {coverageInfo.pct}% / {TEXT_COVERAGE_LIMIT}% лимит
          {!coverageInfo.passes && " ⚠️ превышен"}
        </div>
      )}
    </div>
  );
}

function drawTextLayers(
  ctx: CanvasRenderingContext2D,
  size: number,
  headline: string,
  subtitle: string | undefined,
  bullets: string[],
  fontScale: number
): { blocks: TextBlock[] } {
  const blocks: TextBlock[] = [];
  const headlineSize = Math.round(48 * fontScale);
  const subtitleSize = Math.round(28 * fontScale);
  const bulletSize = Math.round(26 * fontScale);
  const lineSpacing = Math.round(10 * fontScale);
  const maxWidth = size - PADDING * 2;

  // --- Gradient overlay: bottom 38%, transparent→black(60%) ---
  const gradTop = Math.round(size * 0.62);
  const grad = ctx.createLinearGradient(0, gradTop, 0, size);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, gradTop, size, size - gradTop);

  // --- Calculate text layout to position plaque ---
  ctx.font = "bold " + headlineSize + "px " + FONT_FAMILY;
  const headlineLines = wrapText(ctx, headline, maxWidth);
  const headlineLineHeight = headlineSize * 1.2;
  const totalHeadlineH = headlineLines.length * headlineLineHeight;
  const maxHeadlineW = Math.max(...headlineLines.map((l) => ctx.measureText(l).width));

  // Start position: lower area
  const startY = Math.round(size * 0.62) + 20;
  let currentY = startY;

  // --- Headline plaque ---
  const plaquePadX = 12;
  const plaquePadY = 8;
  const plaqueX = PADDING - plaquePadX;
  const plaqueY = currentY - plaquePadY;
  const plaqueW = maxHeadlineW + plaquePadX * 2;
  const plaqueH = totalHeadlineH + plaquePadY * 2;

  ctx.fillStyle = "rgba(0,0,0,0.7)";
  roundRect(ctx, plaqueX, plaqueY, plaqueW, plaqueH, 6);
  ctx.fill();

  // Accent line (left edge, blue)
  ctx.fillStyle = "rgba(74,144,226,1)";
  ctx.fillRect(plaqueX, plaqueY + 4, 3, plaqueH - 8);

  // --- Headline text ---
  ctx.font = "bold " + headlineSize + "px " + FONT_FAMILY;
  ctx.fillStyle = "#FFFFFF";
  ctx.textBaseline = "top";
  for (const line of headlineLines) {
    ctx.fillText(line, PADDING, currentY);
    const m = ctx.measureText(line);
    blocks.push({ x: PADDING, y: currentY, w: m.width, h: headlineLineHeight });
    currentY += headlineLineHeight;
  }
  currentY += lineSpacing;

  // --- Subtitle ---
  if (subtitle) {
    ctx.font = subtitleSize + "px " + FONT_FAMILY;
    ctx.fillStyle = "#DCDCDC";
    const subLines = wrapText(ctx, subtitle, maxWidth);
    const subLineH = subtitleSize * 1.2;
    for (const line of subLines) {
      ctx.fillText(line, PADDING, currentY);
      const m = ctx.measureText(line);
      blocks.push({ x: PADDING, y: currentY, w: m.width, h: subLineH });
      currentY += subLineH;
    }
    currentY += lineSpacing;
  }

  // --- Bullets ---
  ctx.font = bulletSize + "px " + FONT_FAMILY;
  ctx.fillStyle = "#C8C8C8";
  const bulletLineH = bulletSize * 1.2;
  for (const bullet of bullets) {
    const bText = "•  " + bullet;
    const bLines = wrapText(ctx, bText, maxWidth);
    for (const line of bLines) {
      ctx.fillText(line, PADDING, currentY);
      const m = ctx.measureText(line);
      blocks.push({ x: PADDING, y: currentY, w: m.width, h: bulletLineH });
      currentY += bulletLineH;
    }
    currentY += Math.round(lineSpacing * 0.5);
  }

  return { blocks };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
```

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/components/BannerCompositor.tsx index.html
git commit -m "feat: add BannerCompositor with Canvas compositing, coverage check, auto-fit"
```

---

### Task 6: Update `src/pages/AICabinetNewPage.tsx` — Integrate BannerCompositor

**Files:**
- Modify: `src/pages/AICabinetNewPage.tsx`

- [ ] **Step 1: Update BannerVariant interface and imports**

At top of file, add import:
```typescript
import BannerCompositor from '@/components/BannerCompositor';
```

Replace the `BannerVariant` interface (line 37-44):
```typescript
interface BannerVariant {
  headline: string;
  subtitle?: string;
  bullets: string[];
  adTitle: string;
  adText: string;
  imageStorageId?: string;
  imageUrl?: string;
  isSelected: boolean;
  generatingImage: boolean;
}
```

- [ ] **Step 2: Update handleGenerateTexts to use new format**

Replace `handleGenerateTexts` (lines 135-159):
```typescript
  const handleGenerateTexts = async () => {
    if (!user?.userId) return;
    setGeneratingTexts(true);
    setError(null);
    try {
      const results = await generateTexts({
        userId: user.userId as Id<"users">,
        businessDirection,
        objective,
        targetUrl,
        targetAudience: targetAudience || undefined,
        usp: usp || undefined,
      });
      setBanners(results.map((r: { headline: string; subtitle?: string; bullets: string[]; adTitle: string; adText: string }) => ({
        headline: r.headline,
        subtitle: r.subtitle,
        bullets: r.bullets || [],
        adTitle: r.adTitle,
        adText: r.adText,
        isSelected: true,
        generatingImage: false,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации');
    } finally {
      setGeneratingTexts(false);
    }
  };
```

- [ ] **Step 3: Update handleGenerateImage to pass niche**

Replace `handleGenerateImage` (lines 161-179):
```typescript
  const handleGenerateImage = async (index: number) => {
    if (!user?.userId) return;
    const banner = banners[index];
    setBanners(prev => prev.map((b, i) => i === index ? { ...b, generatingImage: true } : b));
    try {
      const result = await generateImage({
        userId: user.userId as Id<"users">,
        businessDirection,
        title: banner.headline,
        text: banner.adText,
        niche: businessDirection,
      });
      setBanners(prev => prev.map((b, i) =>
        i === index ? { ...b, imageStorageId: result.storageId, generatingImage: false } : b
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации изображения');
      setBanners(prev => prev.map((b, i) => i === index ? { ...b, generatingImage: false } : b));
    }
  };
```

- [ ] **Step 4: Update handleImproveField for new fields**

Replace `handleImproveField` (lines 181-203):
```typescript
  const handleImproveField = async (index: number, field: 'headline' | 'subtitle' | 'adTitle' | 'adText') => {
    if (!user?.userId) return;
    const key = `${field}-${index}`;
    setImprovingField(key);
    try {
      const currentValue = field === 'subtitle'
        ? (banners[index].subtitle || '')
        : banners[index][field];
      const improved = await improveField({
        userId: user.userId as Id<"users">,
        businessDirection,
        objective,
        targetAudience: targetAudience || undefined,
        usp: usp || undefined,
        field,
        currentValue,
      });
      setBanners(prev => prev.map((b, i) =>
        i === index ? { ...b, [field]: improved } : b
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка улучшения');
    } finally {
      setImprovingField(null);
    }
  };
```

- [ ] **Step 5: Update handleLaunch to pass new fields**

In `handleLaunch`, update the `createBanner` call (around line 229) to pass new fields:
```typescript
      for (const banner of banners) {
        await createBanner({
          campaignId: campaignId as Id<"aiCampaigns">,
          title: banner.adTitle,
          text: banner.adText,
          imageStorageId: banner.imageStorageId as Id<"_storage"> | undefined,
          isSelected: banner.isSelected,
        });
      }
```

- [ ] **Step 6: Update banner card UI in Step 3**

Replace the banner editing section (around lines 600-755) to show new fields and BannerCompositor. The key changes:

1. Replace `banner.title` field with `banner.headline` + `banner.subtitle` + `banner.adTitle` + `banner.adText` editable fields
2. Replace the raw `<img>` display with `<BannerCompositor>` when image exists
3. Keep the "Из креативов" picker as-is

The headline field (replace the title input around line 607):
```tsx
{/* Headline (on banner) */}
<div>
  <Label className="text-xs">Заголовок на баннере ({banner.headline.length}/35)</Label>
  <div className="flex gap-1">
    <Input
      value={banner.headline}
      maxLength={35}
      onChange={(e) => {
        setBanners(prev => prev.map((b, i) =>
          i === index ? { ...b, headline: e.target.value } : b
        ));
      }}
      className="flex-1"
    />
    <Button
      variant="ghost" size="icon" className="h-10 w-10 shrink-0"
      onClick={() => handleImproveField(index, 'headline')}
      disabled={improvingField === `headline-${index}`}
      title="AI улучшение"
    >
      {improvingField === `headline-${index}` ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4 text-primary" />
      )}
    </Button>
  </div>
</div>

{/* Subtitle (on banner, optional) */}
<div>
  <Label className="text-xs">Подзаголовок ({(banner.subtitle || '').length}/60)</Label>
  <div className="flex gap-1">
    <Input
      value={banner.subtitle || ''}
      maxLength={60}
      placeholder="Опционально"
      onChange={(e) => {
        setBanners(prev => prev.map((b, i) =>
          i === index ? { ...b, subtitle: e.target.value || undefined } : b
        ));
      }}
      className="flex-1"
    />
    <Button
      variant="ghost" size="icon" className="h-10 w-10 shrink-0"
      onClick={() => handleImproveField(index, 'subtitle')}
      disabled={improvingField === `subtitle-${index}`}
      title="AI улучшение"
    >
      {improvingField === `subtitle-${index}` ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4 text-primary" />
      )}
    </Button>
  </div>
</div>

{/* Bullets (on banner) */}
<div>
  <Label className="text-xs">Буллеты на баннере</Label>
  {banner.bullets.map((bullet, bi) => (
    <div key={bi} className="flex gap-1 mt-1">
      <Input
        value={bullet}
        maxLength={40}
        placeholder={"Буллет " + (bi + 1)}
        onChange={(e) => {
          setBanners(prev => prev.map((b, i) => {
            if (i !== index) return b;
            const newBullets = [...b.bullets];
            newBullets[bi] = e.target.value;
            return { ...b, bullets: newBullets };
          }));
        }}
        className="flex-1 h-8 text-sm"
      />
    </div>
  ))}
</div>

{/* Separator */}
<div className="border-t border-border pt-2 mt-2">
  <p className="text-xs text-muted-foreground mb-2">Текст для VK Ads:</p>
</div>

{/* adTitle (for VK Ads) */}
<div>
  <Label className="text-xs">Title VK Ads ({banner.adTitle.length}/25)</Label>
  <div className="flex gap-1">
    <Input
      value={banner.adTitle}
      maxLength={25}
      onChange={(e) => {
        setBanners(prev => prev.map((b, i) =>
          i === index ? { ...b, adTitle: e.target.value } : b
        ));
      }}
      className="flex-1"
    />
    <Button
      variant="ghost" size="icon" className="h-10 w-10 shrink-0"
      onClick={() => handleImproveField(index, 'adTitle')}
      disabled={improvingField === `adTitle-${index}`}
      title="AI улучшение"
    >
      {improvingField === `adTitle-${index}` ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4 text-primary" />
      )}
    </Button>
  </div>
</div>

{/* adText (for VK Ads) */}
<div>
  <Label className="text-xs">Text VK Ads ({banner.adText.length}/90)</Label>
  <div className="flex gap-1">
    <textarea
      value={banner.adText}
      maxLength={90}
      rows={2}
      onChange={(e) => {
        setBanners(prev => prev.map((b, i) =>
          i === index ? { ...b, adText: e.target.value } : b
        ));
      }}
      className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-background resize-none"
    />
    <Button
      variant="ghost" size="icon" className="h-10 w-10 shrink-0 self-start mt-1"
      onClick={() => handleImproveField(index, 'adText')}
      disabled={improvingField === `adText-${index}`}
      title="AI улучшение"
    >
      {improvingField === `adText-${index}` ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4 text-primary" />
      )}
    </Button>
  </div>
</div>
```

Replace the image display section (around lines 670-754). When an image exists, show BannerCompositor instead of raw `<img>`:
```tsx
{/* Image with text compositing */}
<div>
  {(banner.imageStorageId || banner.imageUrl) ? (
    <div>
      <BannerCompositor
        imageUrl={banner.imageUrl || `${import.meta.env.VITE_CONVEX_SITE_URL || ''}/api/storage/${banner.imageStorageId}`}
        headline={banner.headline}
        subtitle={banner.subtitle}
        bullets={banner.bullets}
        size={1080}
        className="max-w-[300px]"
      />
      <div className="flex gap-1.5 mt-2">
        <Button variant="outline" size="sm" onClick={() => handleGenerateImage(index)} disabled={banner.generatingImage}>
          {banner.generatingImage ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Image className="h-4 w-4 mr-1" />}
          Новое фото
        </Button>
        {readyCreatives.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setShowCreativePicker(showCreativePicker === index ? null : index)}>
            <ImagePlus className="h-4 w-4 mr-1" />
            Из креативов
          </Button>
        )}
      </div>
    </div>
  ) : (
    <div className="flex gap-1.5">
      <Button variant="outline" size="sm" onClick={() => handleGenerateImage(index)} disabled={banner.generatingImage}>
        {banner.generatingImage ? (
          <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Генерация (~90 сек)...</>
        ) : (
          <><Image className="h-4 w-4 mr-1" />Сгенерировать фон</>
        )}
      </Button>
      {readyCreatives.length > 0 && (
        <Button variant="outline" size="sm" onClick={() => setShowCreativePicker(showCreativePicker === index ? null : index)}>
          <ImagePlus className="h-4 w-4 mr-1" />
          Из креативов
        </Button>
      )}
    </div>
  )}
  {/* Creative picker grid — keep as-is */}
  {showCreativePicker === index && readyCreatives.length > 0 && (
    <div className="mt-2 border border-border rounded-lg p-2">
      <p className="text-xs text-muted-foreground mb-2">Выберите креатив:</p>
      <div className="grid grid-cols-3 gap-2 max-h-48 overflow-y-auto">
        {readyCreatives.map((c) => (
          <button
            key={c._id}
            type="button"
            onClick={() => handlePickCreative(index, c.imageUrl!)}
            className="rounded-md border border-border hover:border-primary overflow-hidden transition-colors"
          >
            <img src={c.imageUrl!} alt={c.offer} className="w-full aspect-square object-cover" />
          </button>
        ))}
      </div>
    </div>
  )}
</div>
```

- [ ] **Step 7: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
git add src/pages/AICabinetNewPage.tsx
git commit -m "feat: AICabinetNewPage uses new text format and BannerCompositor"
```

---

### Task 7: Update `src/components/CreativeGallery.tsx` — Replace CSS Overlay with BannerCompositor

**Files:**
- Modify: `src/components/CreativeGallery.tsx`

The `CreativeGallery` component (separate file at `src/components/CreativeGallery.tsx`) currently uses CSS-based text overlay (gradient + absolute positioned text). Replace this with `BannerCompositor` for `ready` creatives with images.

- [ ] **Step 1: Add BannerCompositor import**

At top of `src/components/CreativeGallery.tsx`:
```typescript
import BannerCompositor from '@/components/BannerCompositor';
```

- [ ] **Step 2: Replace CSS overlay with BannerCompositor**

Replace the image display section (lines 59-102, the `creative.imageUrl` branch inside the aspect-square div) with:

```tsx
              ) : creative.imageUrl ? (
                <BannerCompositor
                  imageUrl={creative.imageUrl}
                  headline={creative.offer}
                  subtitle={creative.benefit}
                  bullets={creative.bullets ? creative.bullets.split(' • ') : []}
                  size={1080}
                  className="w-full h-full"
                />
```

This replaces the raw `<img>` + CSS gradient overlay + absolute-positioned text with proper Canvas compositing. The `offer` field maps to headline, `benefit` to subtitle, and `bullets` string (separated by " • ") is split into an array.

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/components/CreativeGallery.tsx
git commit -m "feat: CreativeGallery uses BannerCompositor instead of CSS text overlay"
```

---

### Task 8: Final Verification & Cleanup

**Files:**
- All modified files

- [ ] **Step 1: Full TypeScript check**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 2: Frontend build check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Lint check**

Run: `npm run lint`
Expected: Max 50 warnings, no errors

- [ ] **Step 4: Verify no broken imports**

Run: `npx tsc --noEmit`
Expected: No errors related to new/changed files

- [ ] **Step 5: Manual smoke test checklist**

Start dev server: `npm run dev`

Test in browser:
1. Go to AI Cabinet → Новая кампания
2. Fill business direction (e.g., "автосервис, кузовной ремонт")
3. Fill target URL, proceed to step 3
4. Verify 3 banner variants generated with: headline, subtitle, bullets, adTitle, adText
5. Click "Сгенерировать фон" on one banner
6. Wait ~90 sec for FLUX Ultra to generate
7. Verify BannerCompositor shows: gradient overlay + plaque + headline + subtitle + bullets
8. Verify text coverage shows under 18%
9. Edit headline text → verify canvas re-renders live
10. Go to Креативы page → create a creative → generate image → verify composited preview

- [ ] **Step 6: Commit final state**

```bash
git add -A
git commit -m "feat: Banner Pipeline V2 — Haiku + FLUX Ultra + styles + Canvas compositing"
```
