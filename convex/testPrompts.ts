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

const FLUX_SUFFIX = "Professional commercial photography or high-quality 3D render. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.";

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

// Step 2: Generate one FLUX image from a given prompt
export const generateTestImage = action({
  args: { prompt: v.string() },
  handler: async (_ctx, args): Promise<string> => {
    const bflApiKey = process.env.BFL_API_KEY;
    if (!bflApiKey) throw new Error("BFL_API_KEY not set");

    const resp = await fetch("https://api.bfl.ml/v1/flux-pro-1.1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-key": bflApiKey },
      body: JSON.stringify({ prompt: args.prompt, width: 600, height: 600 }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`FLUX submit error: ${resp.status} ${t}`);
    }
    const { id } = await resp.json();

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await fetch(`https://api.bfl.ml/v1/get_result?id=${id}`, {
        headers: { "x-key": bflApiKey },
      });
      const result = await poll.json();
      if (result.status === "Ready") {
        return result.result?.sample || "NO_URL";
      }
      if (result.status === "failed") {
        throw new Error(`FLUX failed: ${JSON.stringify(result)}`);
      }
    }
    throw new Error("FLUX timeout");
  },
});
