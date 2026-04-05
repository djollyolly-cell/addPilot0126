const KEY = process.env.ADMIN_KEY;
const BASE = "https://convex.aipilot.by/api";

async function query(fn, args = {}) {
  const resp = await fetch(BASE + "/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Convex " + KEY },
    body: JSON.stringify({ path: fn, args, format: "json" }),
  });
  const data = await resp.json();
  if (data.status !== "success") throw new Error(JSON.stringify(data));
  return data.value;
}

// Find user by email via admin.listUsers (needs sessionToken, can't use directly)
// Use internal approach: query all users table directly
// Actually let's use the Convex admin query endpoint
async function queryTable(table, filter) {
  // Use a different approach - call the function that exists
  const resp = await fetch(BASE + "/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Convex " + KEY },
    body: JSON.stringify({ path: "users:getByEmail", args: { email: "karisha1306@bk.ru" }, format: "json" }),
  });
  const data = await resp.json();
  return data;
}

const userResp = await queryTable();
console.log("User lookup:", JSON.stringify(userResp, null, 2));
