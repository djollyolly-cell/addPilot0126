// TEMP: A/B test — Lifestyle only: Haiku vs Sonnet (skin texture focus)
// Usage: node test_ab.mjs

import { ConvexClient } from "convex/browser";
import { writeFileSync } from "fs";

const client = new ConvexClient("https://convex.aipilot.by");
await new Promise(r => setTimeout(r, 2000));

async function callAction(path, args) {
  const { api } = await import("./convex/_generated/api.js");
  const [mod, fn] = path.split(":");
  return await client.action(api[mod][fn], args);
}

async function generateImage(prompt, label) {
  const taskId = await callAction("testPrompts:submitFluxTask", { prompt });
  console.log(`  ${label}: task submitted (${taskId})`);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const result = await callAction("testPrompts:pollFluxResult", { taskId });
    if (result.status === "ready") {
      console.log(`  ✓ ${label} image ready`);
      return result.url;
    }
    if (result.status === "failed") throw new Error(`${label} FLUX failed`);
    if (i % 5 === 4) console.log(`  ${label}: still generating... (${(i+1)*3}s)`);
  }
  throw new Error(`${label} FLUX timeout`);
}

console.log("Step 1: Getting lifestyle prompts (Haiku vs Sonnet)...");
const p = await callAction("testPrompts:comparePromptsV2", {});

const variants = [
  { key: "lifestyle_haiku", label: "Lifestyle + Haiku" },
  { key: "lifestyle_sonnet", label: "Lifestyle + Sonnet" },
];

for (const v of variants) {
  console.log(`\n=== ${v.label.toUpperCase()} ===`);
  console.log(p[v.key]);
}

console.log("\nStep 2: Generating 2 FLUX Ultra images...");
const urls = await Promise.all(
  variants.map(v => generateImage(p[v.key], v.label))
);

console.log("\n=== RESULTS ===");
variants.forEach((v, i) => console.log(`${v.label}: ${urls[i]}`));

const cards = variants.map((v, i) => `
  <div class="card">
    <h2>${v.label}</h2>
    <img src="${urls[i]}"/>
    <p>${p[v.key]}</p>
  </div>`).join("");

const html = `<!DOCTYPE html>
<html><head><title>Lifestyle: Haiku vs Sonnet (skin texture)</title>
<style>
body{font-family:sans-serif;background:#111;color:#fff;text-align:center;padding:20px}
h1{margin-bottom:4px}
.subtitle{color:#aaa;font-size:14px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:1300px;margin:0 auto}
.card{background:#222;border-radius:12px;padding:16px}
.card img{width:100%;aspect-ratio:1;border-radius:8px;object-fit:cover}
.card h2{margin:12px 0 8px;font-size:18px}
.card p{font-size:11px;color:#888;text-align:left;max-height:80px;overflow:auto;margin-top:8px}
</style></head>
<body>
<h1>Lifestyle: Haiku vs Sonnet — текстура кожи</h1>
<p class="subtitle">FLUX Ultra + raw | Суффикс: visible pores, no smoothing, camera grain | Тест: "${p.testInput}"</p>
<div class="grid">${cards}</div>
</body></html>`;

writeFileSync("/tmp/ab_test_v2.html", html);
console.log("\nComparison saved to: /tmp/ab_test_v2.html");
console.log("Opening...");

import { exec } from "child_process";
exec("open /tmp/ab_test_v2.html");

setTimeout(() => process.exit(0), 2000);
