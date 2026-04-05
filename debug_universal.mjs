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

// Find the "сервис парк" account (vkAccountId = 5538997)
const userId = "kx7djrrpr67bry6zxehzx0e65x8141ct"; // your userId
const accounts = await query("adAccounts:list", { userId });
const servPark = accounts.find(a => a.name?.includes("сервис") || a.name?.includes("Сервис") || String(a.vkAccountId) === "5538997");

if (!servPark) {
  console.log("Account not found. Available accounts:");
  accounts.forEach(a => console.log(`  ${a._id} - ${a.name} (vkAccountId: ${a.vkAccountId})`));
  process.exit(1);
}

console.log(`\n=== Account: ${servPark.name} (${servPark._id}) ===\n`);

// Get token
const token = await action("auth:getValidTokenForAccount", { accountId: servPark._id });

// 1. Get campaigns to find "универсальная"
const campaigns = await action("vkApi:getMtCampaigns", { accessToken: token });
console.log("\n=== ALL CAMPAIGNS ===");
for (const c of campaigns) {
  console.log(`  ${c.id} | ${c.name} | objective: ${c.objective} | status: ${c.status}`);
}

const univCamp = campaigns.find(c => c.name?.toLowerCase().includes("универсальн"));
if (univCamp) {
  console.log(`\n=== UNIVERSAL CAMPAIGN: ${univCamp.name} (id=${univCamp.id}, objective=${univCamp.objective}) ===`);
}

// 2. Get banners for this campaign
const banners = await action("vkApi:getMtBanners", { accessToken: token, campaignId: univCamp ? String(univCamp.id) : undefined });
const univBanners = univCamp ? banners.filter(b => b.campaign_id === univCamp.id) : [];
console.log(`\n=== BANNERS for universal campaign: ${univBanners.length} ===`);
for (const b of univBanners) {
  console.log(`  banner ${b.id} | campaign_id: ${b.campaign_id} | status: ${b.status}`);
}

// 3. Run diagnosLeads for ALL banners of this account for 2026-04-04
const allBannerIds = banners.map(b => String(b.id)).join(",");
console.log(`\n=== RAW STATS for ALL banners (${banners.length}) on 2026-04-04 ===`);

const diag = await action("vkApi:diagnosLeads", {
  accessToken: token,
  bannerIds: univBanners.length > 0 ? univBanners.map(b => String(b.id)).join(",") : allBannerIds,
  dateFrom: "2026-04-04",
  dateTo: "2026-04-04",
});

console.log("\n=== RAW STATS ===");
console.log(JSON.stringify(diag.rawStats, null, 2));

console.log("\n=== LEAD ADS ===");
console.log(JSON.stringify(diag.leadAdsLeads || diag.leadAdsSubsError || diag.leadAdsLeadsError, null, 2));
