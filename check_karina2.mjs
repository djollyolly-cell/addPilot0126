const KEY = process.env.ADMIN_KEY;
const BASE = "https://convex.aipilot.by/api";

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

const userId = "kx705asxp5emswjx29n5x9acqs83732d";

// Accounts: adAccounts:list
const accounts = await query("adAccounts:list", { userId });
console.log("=== ACCOUNTS (" + accounts.length + ") ===");
for (const acc of accounts) {
  console.log("  " + acc._id + " | " + acc.name + " | status: " + acc.status + " | vkId: " + acc.vkAccountId);
}

// Rules: rules:list
const rules = await query("rules:list", { userId });
console.log("\n=== RULES (" + rules.length + ") ===");
for (const r of rules) {
  // Match accounts by ID
  const accNames = (r.targetAccountIds || []).map(id => {
    const a = accounts.find(a => a._id === id);
    return a ? a.name : id;
  });
  console.log("\n--- " + r.name + " ---");
  console.log("  Type:", r.type);
  console.log("  Active:", r.isActive);
  console.log("  Conditions:", JSON.stringify(r.conditions));
  console.log("  Actions:", JSON.stringify(r.actions));
  console.log("  Target Accounts:", accNames.join(", "));
  console.log("  Target Campaigns:", r.targetCampaignIds ? r.targetCampaignIds.length + " campaigns" : "all");
  console.log("  Trigger Count:", r.triggerCount);
  console.log("  Last Triggered:", r.lastTriggeredAt ? new Date(r.lastTriggeredAt).toISOString() : "never");
  console.log("  Created:", new Date(r.createdAt).toISOString());
}

// Logs: ruleEngine:getLogs
const logs = await query("ruleEngine:getLogs", { userId });
console.log("\n=== ACTION LOGS (" + logs.length + " total, last 20) ===");
const recent = logs.slice(0, 20);
for (const l of recent) {
  const date = new Date(l.createdAt).toISOString().replace("T", " ").substring(0, 19);
  console.log("  " + date + " | " + l.actionType + " | " + (l.adName || "?") + " | saved: " + (l.savedAmount || 0) + "₽ | " + (l.reason || "").substring(0, 100));
}
