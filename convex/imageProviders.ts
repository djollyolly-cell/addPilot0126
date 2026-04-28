// Image generation provider API calls
// Supports: GPT Image 2 (OpenAI) and FLUX Ultra (BFL)

/**
 * Generate image via OpenAI GPT Image 2.
 * Synchronous — returns image blob directly, no polling needed.
 */
export async function generateWithGptImage2(
  prompt: string,
  openaiApiKey: string,
  size: "1024x1024" | "1536x1024" | "1024x1536" = "1024x1024",
): Promise<Blob> {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      size,
      quality: "high",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GPT Image 2 API error: ${response.status} ${text}`);
  }

  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("GPT Image 2: ответ не содержит изображения");
  }

  // Convert base64 to blob
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new Blob([bytes], { type: "image/png" });
}

/**
 * Generate image via FLUX Ultra (BFL API).
 * Asynchronous — submits job then polls for result (~90 seconds).
 */
export async function generateWithFlux(
  prompt: string,
  bflApiKey: string,
): Promise<Blob> {
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

  // Poll for result (Ultra ~90 sec, max 60 x 3 sec = 3 min)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollResp = await fetch("https://api.bfl.ai/v1/get_result?id=" + taskId, {
      headers: { "x-key": bflApiKey },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    if (pollData.status === "Ready") {
      const imageUrl = pollData.result?.sample;
      if (!imageUrl) throw new Error("FLUX: ответ Ready без URL изображения");
      const imgResp = await fetch(imageUrl);
      if (!imgResp.ok) throw new Error("Не удалось скачать изображение от FLUX");
      const imgBlob = await imgResp.blob();
      return new Blob([await imgBlob.arrayBuffer()], { type: imgBlob.type || "image/jpeg" });
    }
    if (pollData.status === "Error" || pollData.status === "Failed") {
      throw new Error("FLUX генерация не удалась: " + pollData.status);
    }
  }

  throw new Error("FLUX: таймаут генерации изображения (3 мин)");
}

/**
 * Build the TEXT OVERLAY block for GPT Image 2 native text rendering.
 */
export function buildTextOverlayBlock(
  headline: string,
  bullets: string,
  benefit: string,
  cta: string,
): string {
  const parts: string[] = [
    "",
    "TEXT OVERLAY (important):",
    "Add bold, clean, high-contrast Russian text in modern sans-serif font.",
    "",
  ];

  if (headline) {
    parts.push("Main headline (large, left or top):");
    parts.push(`"${headline}"`);
    parts.push("");
  }

  const subParts: string[] = [];
  if (bullets) subParts.push(bullets);
  if (benefit) subParts.push(benefit);
  if (subParts.length > 0) {
    parts.push("Subheadline (medium size, below):");
    parts.push(`"${subParts.join(". ")}"`);
    parts.push("");
  }

  if (cta) {
    parts.push("CTA line (small, bottom):");
    parts.push(`"${cta}"`);
    parts.push("");
  }

  parts.push("Text must be:");
  parts.push("- perfectly readable");
  parts.push("- no distortion");
  parts.push("- aligned cleanly");
  parts.push("- high contrast with background (white text on darker overlay or shadow)");

  return parts.join("\n");
}
