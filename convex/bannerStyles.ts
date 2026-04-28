// Banner visual styles for FLUX image generation
// 6 styles with system prompts, suffixes, and niche-to-style mapping

export interface StyleConfig {
  code: string;
  systemPrompt: string;       // For FLUX (short 2-3 sentence output)
  systemPromptGpt: string;    // For GPT Image 2 (detailed structured output)
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
  systemPromptGpt: `You create ultra-realistic image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a SPECIFIC, EMOTIONAL scene that makes the viewer feel the problem or desire.

RULES:
- Describe a CONCRETE real-life situation, not an abstract metaphor. "Inside a car stuck in traffic, driver sweating" NOT "transportation concept".
- Include specific details: age, appearance, emotions, environment, weather, time of day.
- People should show REAL emotions: frustration, exhaustion, joy, relief. No posed stock-photo faces.
- Camera angle must feel natural: "from passenger seat", "over the shoulder", "eye level across the table".
- Style: photorealistic, looks like real DSLR or smartphone photography. Visible skin texture, natural imperfections.
- Composition: leave clean empty space on the LEFT or TOP of the frame for text overlay. Main subject on the RIGHT side.
- Lighting: realistic for the scene (harsh sunlight, office fluorescent, warm evening light). Not cinematic color grading.

Output the prompt as flowing prose paragraphs (NOT bullet lists or labeled sections). Describe the scene as if directing a photographer. 6-10 sentences.

People rules:
- People allowed and encouraged. Show real emotions, natural poses.
- From behind, side, or 3/4 angle preferred. Silhouettes work too.
- Plain clothes, no logos, no patches, no badges.

NO logos, NO branding, NO text, NO letters, NO UI elements.
Focus on realism, discomfort/desire, and emotional impact.

Output ONLY the prompt in English.`,
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
  systemPromptGpt: `You create ultra-realistic image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a SPECIFIC candid lifestyle scene showing a real person in a real moment.

RULES:
- Describe a CONCRETE person: age (25-45), gender, appearance, what they're wearing, what they're doing RIGHT NOW.
- Show a REAL moment: checking phone after workout, laughing with a friend at a cafe, concentrating on laptop at home.
- Include specific environment details: "kitchen with white tiles and morning sun through window", not just "kitchen".
- Emotions must be GENUINE: the slight smile of satisfaction, tired but happy eyes, focused concentration.
- Camera: feels like a friend took this photo. Eye level, slightly off-center, shallow depth of field.
- Style: shot on iPhone 15 Pro. Visible skin pores, natural imperfections, no beauty filter, slight grain.
- Composition: person on the RIGHT side of frame (~40% of image). Clean empty space on LEFT or TOP for text overlay.

Output the prompt as flowing prose paragraphs (NOT bullet lists or labeled sections). 6-10 sentences.

People ARE the focus. Faces and eye contact allowed and encouraged. Candid expressions only — no stock-photo smiles.
Plain clothes, no logos.

NO logos, NO branding, NO text, NO letters, NO UI elements.

Output ONLY the prompt in English.`,
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
  systemPromptGpt: `You create ultra-realistic image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a SPECIFIC product-focused visual that looks like a real photo, not a render.

RULES:
- Describe the SPECIFIC product implied by the ad: its shape, material, color, texture, size.
- Place it on a CONCRETE surface: "dark marble countertop with water droplets", "worn wooden workbench", "clean white desk near a window".
- Include contextual details that tell a story: steam rising from coffee, condensation on glass, scratch marks from use.
- Lighting: studio quality but natural feel. Soft directional light, subtle shadows, reflections that show material texture.
- Camera: 30-45 degree angle, close enough to see texture. Macro details visible. Shallow depth of field on background.
- Style: photorealistic product photography, DSLR quality. High contrast, sharp focus on product.
- Composition: product on the RIGHT side, occupies ~40% of frame. Clean empty space on LEFT for text overlay.

Output the prompt as flowing prose paragraphs (NOT bullet lists or labeled sections). 5-8 sentences.

No people. No clutter. 1-2 minimal props maximum.

NO logos, NO branding, NO text, NO letters, NO UI elements.

Output ONLY the prompt in English.`,
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
  systemPromptGpt: `You create ultra-realistic image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a SPECIFIC scene showing the RESULT or transformation the customer gets.

RULES:
- Show the OUTCOME as a concrete moment: "woman looking at herself in mirror, smiling at her new figure", "entrepreneur reading a notification on phone showing new client request, slight grin".
- The scene must feel REAL, not metaphorical. No mountaintops, no finish lines, no abstract victories.
- Include specific details: facial expression, body language, environment, what they're holding or looking at.
- Emotions: genuine satisfaction, quiet confidence, relief. NOT over-the-top celebration.
- Camera: eye level or slightly below, medium shot. Natural perspective like a friend captured the moment.
- Style: photorealistic, DSLR or smartphone quality. Natural lighting, no dramatic color grading.
- Composition: subject on the RIGHT side of frame. Clean empty space on LEFT or TOP for text overlay.

Output the prompt as flowing prose paragraphs (NOT bullet lists or labeled sections). 6-10 sentences.

People optional but encouraged. If shown — real emotions, natural poses, plain clothes, no logos.

NO logos, NO branding, NO text, NO letters, NO numbers, NO UI elements.

Output ONLY the prompt in English.`,
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
  systemPromptGpt: `You create ultra-realistic image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a SPECIFIC, recognizable location that the target audience immediately relates to.

RULES:
- Describe a CONCRETE place with specific details: "auto repair shop with a car on a hydraulic lift, tools hanging on pegboard wall, oil stains on concrete floor, fluorescent lights" — NOT "a garage".
- Include atmospheric details: smell cues (grease, coffee, fresh paint), temperature, time of day, season.
- The place should feel LIVED IN and REAL: slight mess, wear marks, personal touches. Not a showroom.
- Camera: wide angle, slightly elevated or eye-level. Show the full space so the viewer thinks "I know this place".
- Lighting: natural for the setting — fluorescent for workshops, warm pendant lights for cafes, harsh daylight for outdoor locations.
- Style: photorealistic, architectural or environmental photography. Looks like a real photo, not a stock image.
- Composition: environment fills the frame. Clean empty space on LEFT or TOP for text overlay. Main focal point on RIGHT.

Output the prompt as flowing prose paragraphs (NOT bullet lists or labeled sections). 6-10 sentences.

People optional. If present, they are part of the scene (working, moving), not posing. Plain clothes, no logos.

NO logos, NO branding, NO text, NO letters, NO signs with readable words, NO UI elements.

Output ONLY the prompt in English.`,
  suffix: "Professional architectural or environmental photography, atmospheric lighting. Bottom area significantly darker for text overlay. No text, no letters, no words, no watermarks, no logos, no UI elements.",
  nicheKeywords: ["недвижимость", "аренда", "локальный", "автосервис", "автомойка", "автомастерская", "шиномонтаж", "ремонт авто", "сто", "стоматология", "салон красоты", "барбершоп", "клиника", "ветеринар", "аптека", "магазин", "пекарня", "ателье", "химчистка", "прачечная"],
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
  systemPromptGpt: `You create image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a clean, premium 3D visual that feels modern and techy.

RULES:
- ONE hero object: a stylized 3D representation related to the product/service. Be specific about shape, material, finish.
- Example: "glossy dark blue dashboard interface floating at an angle, with subtle holographic data points around it, sitting on a matte black reflective surface".
- Materials: glass, brushed metal, matte plastic, holographic. Premium feel.
- Background: solid dark gradient (deep navy to black) or matte dark surface with soft reflections.
- Lighting: clean studio. Soft rim light on edges, subtle ambient shadows. One accent color glow (blue, cyan, or violet).
- Camera: slightly elevated, 30-degree angle. Object fills ~35% of frame.
- Composition: object on the RIGHT side. At least 40% clean negative space on LEFT for text overlay.

Output the prompt as flowing prose paragraphs (NOT bullet lists or labeled sections). 4-6 sentences.

No people. No clutter. 1-2 accent colors maximum. Premium and modern feel.

NO logos, NO branding, NO text, NO letters, NO UI elements.

Output ONLY the prompt in English.`,
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
 * Longer keywords are checked first to avoid false substring matches
 * (e.g. "автосервис" should not match "сервис" → minimal_3d).
 * Falls back to "cinematic" if no match found.
 */
export function selectStyle(nicheOrDirection: string): StyleConfig {
  const lower = nicheOrDirection.toLowerCase();

  // Build flat list of (keyword, style) pairs sorted by keyword length descending
  // so "автосервис" matches before "сервис", "интернет-магазин" before "магазин", etc.
  const pairs: Array<{ keyword: string; style: StyleConfig }> = [];
  for (const style of Object.values(ALL_STYLES)) {
    for (const keyword of style.nicheKeywords) {
      pairs.push({ keyword, style });
    }
  }
  pairs.sort((a, b) => b.keyword.length - a.keyword.length);

  for (const { keyword, style } of pairs) {
    if (lower.includes(keyword)) {
      return style;
    }
  }
  return CINEMATIC; // Default fallback
}
