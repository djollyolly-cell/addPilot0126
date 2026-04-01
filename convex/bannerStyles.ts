// Banner visual styles for FLUX image generation
// 6 styles with system prompts, suffixes, and niche-to-style mapping

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
