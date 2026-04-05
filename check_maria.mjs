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

// Мария Иванова account
const accountId = "j972fk1717c1kzd4yymm83p1mn844ztg";
const token = await action("auth:getValidTokenForAccount", { accountId });
const campaigns = await action("vkApi:getCampaignsForAccount", { accessToken: token });

// Filter non-deleted
const active = campaigns.filter(c => c.status !== "deleted");
console.log("=== NON-DELETED CAMPAIGNS (Мария Иванова) ===");
for (const c of active) {
  console.log(`  id=${c.id} | status="${c.status}" | delivery="${c.delivery}" | budget=${c.budget_limit_day} | name="${c.name}"`);
}
