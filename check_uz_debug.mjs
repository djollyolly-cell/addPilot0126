const KEY = process.env.ADMIN_KEY;
const BASE = "https://convex.aipilot.by/api";

async function action(fn, args = {}) {
  const resp = await fetch(BASE + "/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Convex " + KEY },
    body: JSON.stringify({ path: fn, args, format: "json" }),
  });
  const data = await resp.json();
  if (data.status !== "success") throw new Error(fn + ": " + JSON.stringify(data));
  return data.value;
}

async function query(fn, args = {}) {
  const resp = await fetch(BASE + "/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Convex " + KEY },
    body: JSON.stringify({ path: fn, args, format: "json" }),
  });
  const data = await resp.json();
  if (data.status !== "success") throw new Error(fn + ": " + JSON.stringify(data));
  return data.value;
}

// Check all Karina's accounts
const accounts = [
  { id: "j972fk1717c1kzd4yymm83p1mn844ztg", name: "Мария Иванова" },
  { id: "j9743mdam7dzy9e77akpmeyahx844x4z", name: "Тула лазер" },
  { id: "j9734nnqxaqfx1hrpkf6kskk1s846t25", name: "vkads (двери)" },
  { id: "j9792y8wj49bdvetre1f0121xs84688z", name: "Casa Latina" },
  { id: "j979gfx97ap9ztc8f8ayy56zh5847rzn", name: "Контрград" },
];

// Get rules to find targetCampaignIds
const userId = "kx705asxp5emswjx29n5x9acqs83732d";
const rules = await query("rules:list", { userId });

for (const acc of accounts) {
  const rule = rules.find(r => r.targetAccountIds.includes(acc.id));
  if (!rule) { console.log(`\n${acc.name}: NO RULE`); continue; }

  let token;
  try {
    token = await action("auth:getValidTokenForAccount", { accountId: acc.id });
  } catch(e) {
    console.log(`\n${acc.name}: TOKEN ERROR - ${e.message}`);
    continue;
  }

  const campaigns = await action("vkApi:getCampaignsForAccount", { accessToken: token });
  const targetIds = rule.targetCampaignIds || [];
  const targeted = campaigns.filter(c => targetIds.includes(String(c.id)));

  console.log(`\n=== ${acc.name} (rule: ${rule.name}, targets: ${targetIds.length}) ===`);
  
  for (const c of targeted) {
    // Get spent today from VK API
    let spent = 0;
    try {
      spent = await action("vkApi:getCampaignSpentToday", { accessToken: token, campaignId: String(c.id) });
    } catch(e) {
      spent = -1;
    }
    const pct = Number(c.budget_limit_day) > 0 ? ((spent / Number(c.budget_limit_day)) * 100).toFixed(0) : "?";
    console.log(`  ${c.name} | status=${c.status} | delivery=${c.delivery} | budget=${c.budget_limit_day} | spent=${spent.toFixed(2)} (${pct}%)`);
  }

  // Also show non-targeted non-deleted campaigns
  const nonTargeted = campaigns.filter(c => !targetIds.includes(String(c.id)) && c.status !== "deleted");
  if (nonTargeted.length > 0) {
    console.log(`  --- NOT IN RULE (${nonTargeted.length} campaigns) ---`);
    for (const c of nonTargeted.slice(0, 5)) {
      console.log(`  ${c.name} | status=${c.status} | delivery=${c.delivery} | budget=${c.budget_limit_day}`);
    }
    if (nonTargeted.length > 5) console.log(`  ... and ${nonTargeted.length - 5} more`);
  }
}
