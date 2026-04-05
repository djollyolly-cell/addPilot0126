import { v } from "convex/values";
import { action } from "./_generated/server";

// TEMP: A/B test — compare Haiku vs Sonnet for FLUX prompt generation
// Delete after testing

const SYSTEM_PROMPT = `You create image prompts for VK advertising banners.
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
- Bottom 38% of image significantly darker for text overlay.
- NEVER include: text, letters, words, logos, screens, phones, UI, charts, icons.

Output ONLY the prompt (2-3 sentences).`;

const LIFESTYLE_PROMPT = `You create image prompts for VK advertising banners.
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
- COMPOSITION: Main subject (person) positioned RIGHT side of frame. Top-left 40% area must be simpler/darker — this is where text will be placed.
- NEVER include: text, letters, logos, UI, screens, charts, icons.

Output ONLY the prompt in English (2-3 sentences).`;

const CINEMATIC_SUFFIX = "Professional commercial photography or high-quality 3D render. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.";
const LIFESTYLE_SUFFIX = "Shot on iPhone 15 Pro, casual candid photo, visible skin pores and fine lines, natural skin imperfections, no beauty filter, no smoothing, no retouching, slight camera grain and noise, shallow depth of field, natural indoor lighting, warm tones. Subject on the right side of frame, top-left area darker and simpler for text overlay. No text, no letters, no words, no watermarks.";

const PRODUCT_FOCUS_PROMPT = `You create image prompts for VK advertising banners.
Given Russian ad copy, create a clean product-focused visual.

Visual rules:
- The product is the hero: large, sharp, well-lit, centered or rule-of-thirds.
- Background: dark, neutral, or contextually relevant surface (marble, wood, concrete).
- Lighting: studio-quality. Clear reflections or shadows that add depth.
- No people. No clutter. Minimal props if any.
- Colors: product real colors should pop. High contrast with background.
- Bottom 38% of image noticeably darker for text overlay.
- NEVER include: text, letters, logos, UI, screens, charts, icons.

Output ONLY the prompt in English (2-3 sentences).`;

const RESULT_VISUAL_PROMPT = `You create image prompts for VK advertising banners.
Given Russian ad copy, create a visual that represents the end result or transformation.

Visual rules:
- Show the OUTCOME, not the process: achievement, success, transformation, a milestone reached.
- Can be metaphorical: a mountain summit, a finish line, a before/after expressed through light,
  a person expressing relief or confidence after completing something hard.
- People optional. If shown, they express satisfaction, relief, or confidence.
- Dramatic but clear. The feeling of "I got there" should be immediate.
- Colors: optimistic, energetic. Warm tones for personal achievement, cool/bold for business results.
- Bottom 38% of image noticeably darker for text overlay.
- NEVER include: text, letters, numbers, logos, UI, screens, charts with labels, icons.

Output ONLY the prompt in English (2-3 sentences).`;

const LOCATION_PROMPT = `You create image prompts for VK advertising banners.
Given Russian ad copy, create a recognisable location or environment visual.

Visual rules:
- Show a place the target audience knows and relates to: a neighbourhood, interior, city, venue type.
- The location should immediately signal the niche: a gym interior, a cozy cafe, a business district,
  a residential area, a construction site, a school classroom.
- Atmosphere is key: time of day, weather, mood of the space.
- People optional. If present, they are part of the scene, not the focus.
- Bottom 38% of image noticeably darker for text overlay.
- NEVER include: text, letters, logos, UI, screens, signs with readable words, icons.

Output ONLY the prompt in English (2-3 sentences).`;

const MINIMAL_3D_PROMPT = `You create image prompts for VK advertising banners.
Given Russian ad copy, create a clean minimalist 3D visual.

Visual rules:
- One hero object: abstract 3D form, geometric shape, or stylised product representation.
- Plenty of negative space around the object, at least 40% empty.
- Background: solid dark, gradient dark, or very softly lit neutral surface.
- Lighting: clean studio or subtle ambient. Soft shadows. No dramatic rays.
- Colors: 1-2 accent colors maximum. The object should feel premium and modern.
- No people. No clutter. Nothing competing with the main object.
- Bottom 38% of image noticeably darker for text overlay.
- NEVER include: text, letters, logos, UI, screens, charts, icons.

Output ONLY the prompt in English (2-3 sentences).`;

const PRODUCT_SUFFIX = "Professional studio photography, high contrast, dark background. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.";
const RESULT_SUFFIX = "Professional commercial photography. Optimistic warm tones. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.";
const LOCATION_SUFFIX = "Professional architectural or environmental photography, atmospheric lighting. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.";
const MINIMAL_3D_SUFFIX = "High-quality 3D render, clean minimal style, dark background, soft studio lighting. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.";

const ALL_STYLES: Record<string, { prompt: string; suffix: string }> = {
  lifestyle_candid: { prompt: LIFESTYLE_PROMPT, suffix: LIFESTYLE_SUFFIX },
  cinematic: { prompt: SYSTEM_PROMPT, suffix: CINEMATIC_SUFFIX },
  product_focus: { prompt: PRODUCT_FOCUS_PROMPT, suffix: PRODUCT_SUFFIX },
  result_visual: { prompt: RESULT_VISUAL_PROMPT, suffix: RESULT_SUFFIX },
  location: { prompt: LOCATION_PROMPT, suffix: LOCATION_SUFFIX },
  minimal_3d: { prompt: MINIMAL_3D_PROMPT, suffix: MINIMAL_3D_SUFFIX },
};

const FLUX_SUFFIX = CINEMATIC_SUFFIX; // backward compat for round 1

const TEST_INPUT = "Стоматология. Болит зуб? Вылечим! Современная стоматология без боли и очередей. Запись онлайн 24/7.";

// Step 1: Fast — just compare prompts from both models
export const comparePrompts = action({
  args: {},
  handler: async (_ctx): Promise<{ haiku: string; sonnet: string; testInput: string }> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    const [haikuResp, sonnetResp] = await Promise.all([
      fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: TEST_INPUT }],
        }),
      }),
      fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 300,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: TEST_INPUT }],
        }),
      }),
    ]);

    const haikuData = await haikuResp.json();
    const sonnetData = await sonnetResp.json();

    return {
      haiku: (haikuData.content?.[0]?.text?.trim() || "ERROR") + " " + FLUX_SUFFIX,
      sonnet: (sonnetData.content?.[0]?.text?.trim() || "ERROR") + " " + FLUX_SUFFIX,
      testInput: TEST_INPUT,
    };
  },
});

// Step 2a: Submit FLUX task, return task ID (fast, <5s)
export const submitFluxTask = action({
  args: { prompt: v.string() },
  handler: async (_ctx, args): Promise<string> => {
    const bflApiKey = process.env.BFL_API_KEY;
    if (!bflApiKey) throw new Error("BFL_API_KEY not set");

    const resp = await fetch("https://api.bfl.ai/v1/flux-pro-1.1-ultra", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-key": bflApiKey },
      body: JSON.stringify({ prompt: args.prompt, width: 608, height: 608, raw: true }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`FLUX submit error: ${resp.status} ${t}`);
    }
    const { id } = await resp.json();
    return id;
  },
});

// Step 2b: Poll FLUX result by task ID (fast, single check)
export const pollFluxResult = action({
  args: { taskId: v.string() },
  handler: async (_ctx, args): Promise<{ status: string; url?: string }> => {
    const bflApiKey = process.env.BFL_API_KEY;
    if (!bflApiKey) throw new Error("BFL_API_KEY not set");

    const poll = await fetch(`https://api.bfl.ai/v1/get_result?id=${args.taskId}`, {
      headers: { "x-key": bflApiKey },
    });
    const result = await poll.json();
    if (result.status === "Ready") {
      return { status: "ready", url: result.result?.sample || "NO_URL" };
    }
    if (result.status === "Error" || result.status === "failed") {
      return { status: "failed" };
    }
    return { status: "pending" };
  },
});

// Round 3: Custom input → Haiku prompt → Pro 1.1 vs Ultra side-by-side
export const compareFluxModels = action({
  args: {
    input: v.optional(v.string()),
    style: v.optional(v.string()), // "cinematic" | "lifestyle"
  },
  handler: async (_ctx, args): Promise<{
    prompt: string;
    proTaskId: string;
    ultraTaskId: string;
  }> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const bflApiKey = process.env.BFL_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    if (!bflApiKey) throw new Error("BFL_API_KEY not set");

    const userInput = args.input || TEST_INPUT;
    const systemPrompt = args.style === "lifestyle" ? LIFESTYLE_PROMPT : SYSTEM_PROMPT;
    const suffix = args.style === "lifestyle" ? LIFESTYLE_SUFFIX : CINEMATIC_SUFFIX;

    // Step 1: Get prompt from Haiku
    const haikuResp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: userInput }],
      }),
    });
    const haikuData = await haikuResp.json();
    const prompt = (haikuData.content?.[0]?.text?.trim() || "ERROR") + " " + suffix;

    // Step 2: Submit same prompt to both FLUX models
    const [proResp, ultraResp] = await Promise.all([
      fetch("https://api.bfl.ai/v1/flux-pro-1.1", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-key": bflApiKey },
        body: JSON.stringify({ prompt, width: 608, height: 608 }),
      }),
      fetch("https://api.bfl.ai/v1/flux-pro-1.1-ultra", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-key": bflApiKey },
        body: JSON.stringify({ prompt, width: 608, height: 608, raw: true }),
      }),
    ]);

    if (!proResp.ok) throw new Error(`Pro submit: ${await proResp.text()}`);
    if (!ultraResp.ok) throw new Error(`Ultra submit: ${await ultraResp.text()}`);

    const proId = (await proResp.json()).id;
    const ultraId = (await ultraResp.json()).id;

    return { prompt, proTaskId: proId, ultraTaskId: ultraId };
  },
});

const SQUARE_LIFESTYLE_PROMPT = `You create image prompts for SQUARE (1:1) VK advertising banners.
Given Russian ad copy, create a natural, candid lifestyle scene.

People rules:
- People ARE the focus. Show them naturally in context of using the product or service.
- Faces looking at camera ARE allowed and work well in VK.
- Candid expressions, genuine emotions. No stiff poses.
- Show real situations: at a desk, in a gym, in a cafe, with a product in hand.
- Scene should feel like a candid moment captured on a phone, NOT a staged photoshoot.

CRITICAL COMPOSITION (square 1:1 format):
- MEDIUM or WIDE shot. Person takes up about 40% of the frame. Lots of breathing room.
- Person in upper half of frame, with generous EMPTY/DARK space in the bottom third.
- Bottom 33% MUST be significantly darker, blurred, or empty — this is reserved for text overlay.
- Background should be simple, slightly blurred, not cluttered.
- Do NOT frame person between objects. Do NOT shoot through gaps. Keep the scene OPEN.
- NEVER include: text, letters, logos, UI, screens, charts, icons.

Output ONLY the prompt in English (2-3 sentences).`;

// Round 6: Test aspect_ratio param instead of width/height
export const testSquareCrop = action({
  args: {},
  handler: async (_ctx): Promise<{
    prompt: string;
    taskId: string;
  }> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const bflApiKey = process.env.BFL_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    if (!bflApiKey) throw new Error("BFL_API_KEY not set");

    const input = "Автосервис. Кузовной ремонт любой сложности. Покраска, рихтовка, полировка. Мастера с опытом 15+ лет.";

    const haikuResp = await fetch(baseUrl + "/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: SQUARE_LIFESTYLE_PROMPT,
        messages: [{ role: "user", content: input }],
      }),
    });
    const data = await haikuResp.json();
    const SQUARE_SUFFIX = "Shot on iPhone 15 Pro, casual candid photo, natural skin imperfections, no beauty filter, no retouching, slight camera grain, shallow depth of field, natural indoor lighting, warm tones. Medium shot with breathing room. Bottom third darker and simpler for text. No text, no letters, no words, no watermarks.";

    const prompt = (data.content?.[0]?.text?.trim() || "ERROR") + " " + SQUARE_SUFFIX;

    const resp = await fetch("https://api.bfl.ai/v1/flux-pro-1.1-ultra", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-key": bflApiKey },
      body: JSON.stringify({ prompt, aspect_ratio: "1:1", raw: true }),
    });

    if (!resp.ok) throw new Error("FLUX submit: " + (await resp.text()));

    return {
      prompt,
      taskId: (await resp.json()).id,
    };
  },
});

// Round 5: Test Ultra with/without raw flag at 1080x1080
export const testUltraSize = action({
  args: {},
  handler: async (_ctx): Promise<{
    prompt: string;
    withRawTaskId: string;
    noRawTaskId: string;
  }> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const bflApiKey = process.env.BFL_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    if (!bflApiKey) throw new Error("BFL_API_KEY not set");

    const input = "Автосервис. Кузовной ремонт любой сложности. Покраска, рихтовка, полировка.";

    const haikuResp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: LIFESTYLE_PROMPT,
        messages: [{ role: "user", content: input }],
      }),
    });
    const data = await haikuResp.json();
    const prompt = (data.content?.[0]?.text?.trim() || "ERROR") + " " + LIFESTYLE_SUFFIX;

    // Same prompt, same size, with vs without raw
    const [withRaw, noRaw] = await Promise.all([
      fetch("https://api.bfl.ai/v1/flux-pro-1.1-ultra", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-key": bflApiKey },
        body: JSON.stringify({ prompt, width: 1080, height: 1080, raw: true }),
      }),
      fetch("https://api.bfl.ai/v1/flux-pro-1.1-ultra", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-key": bflApiKey },
        body: JSON.stringify({ prompt, width: 1080, height: 1080 }),
      }),
    ]);

    if (!withRaw.ok) throw new Error(`raw submit: ${await withRaw.text()}`);
    if (!noRaw.ok) throw new Error(`noraw submit: ${await noRaw.text()}`);

    return {
      prompt,
      withRawTaskId: (await withRaw.json()).id,
      noRawTaskId: (await noRaw.json()).id,
    };
  },
});

// Round 4: All 6 styles for same input → Ultra
export const compareAllStyles = action({
  args: { input: v.string() },
  handler: async (_ctx, args): Promise<Record<string, { prompt: string; taskId: string }>> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const bflApiKey = process.env.BFL_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    if (!bflApiKey) throw new Error("BFL_API_KEY not set");

    const styles = Object.entries(ALL_STYLES);

    // Step 1: Generate all 6 prompts via Haiku in parallel
    const haikuResults = await Promise.all(
      styles.map(async ([name, cfg]) => {
        const resp = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey!,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 300,
            system: cfg.prompt,
            messages: [{ role: "user", content: args.input }],
          }),
        });
        const data = await resp.json();
        const text = data.content?.[0]?.text?.trim() || "ERROR";
        return { name, prompt: text + " " + cfg.suffix };
      })
    );

    // Step 2: Submit all 6 to FLUX Ultra in parallel
    const results: Record<string, { prompt: string; taskId: string }> = {};
    await Promise.all(
      haikuResults.map(async ({ name, prompt }) => {
        const resp = await fetch("https://api.bfl.ai/v1/flux-pro-1.1-ultra", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-key": bflApiKey! },
          body: JSON.stringify({ prompt, width: 608, height: 608, raw: true }),
        });
        if (!resp.ok) throw new Error(`FLUX submit ${name}: ${await resp.text()}`);
        const { id } = await resp.json();
        results[name] = { prompt, taskId: id };
      })
    );

    return results;
  },
});

// Round 2: 4 variants — 2 styles × 2 models
export const comparePromptsV2 = action({
  args: {},
  handler: async (_ctx): Promise<{
    cinematic_haiku: string;
    cinematic_sonnet: string;
    lifestyle_haiku: string;
    lifestyle_sonnet: string;
    testInput: string;
  }> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    const callClaude = (model: string, system: string) =>
      fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          system,
          messages: [{ role: "user", content: TEST_INPUT }],
        }),
      });

    const [cH, cS, lH, lS] = await Promise.all([
      callClaude("claude-haiku-4-5-20251001", SYSTEM_PROMPT),
      callClaude("claude-sonnet-4-20250514", SYSTEM_PROMPT),
      callClaude("claude-haiku-4-5-20251001", LIFESTYLE_PROMPT),
      callClaude("claude-sonnet-4-20250514", LIFESTYLE_PROMPT),
    ]);

    const [cHd, cSd, lHd, lSd] = await Promise.all([
      cH.json(), cS.json(), lH.json(), lS.json(),
    ]);

    const extract = (d: any) => d.content?.[0]?.text?.trim() || "ERROR";

    return {
      cinematic_haiku: extract(cHd) + " " + CINEMATIC_SUFFIX,
      cinematic_sonnet: extract(cSd) + " " + CINEMATIC_SUFFIX,
      lifestyle_haiku: extract(lHd) + " " + LIFESTYLE_SUFFIX,
      lifestyle_sonnet: extract(lSd) + " " + LIFESTYLE_SUFFIX,
      testInput: TEST_INPUT,
    };
  },
});
