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

// Get token for Тула лазер account
const accountId = "j9743mdam7dzy9e77akpmeyahx844x4z";
const token = await action("auth:getValidTokenForAccount", { accountId });

// Get campaigns with all fields including status and delivery
const campaigns = await action("vkApi:getCampaignsForAccount", { accessToken: token });

console.log("=== CAMPAIGNS (Тула лазер) ===");
console.log("Total:", campaigns.length);
for (const c of campaigns) {
  console.log(`  id=${c.id} | status="${c.status}" | delivery="${c.delivery}" | budget=${c.budget_limit_day} | name="${c.name}"`);
}
