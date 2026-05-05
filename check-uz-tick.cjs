// Verify a UZ V2 canary run.
//
// Usage:
//   node check-uz-tick.cjs <window-start-ISO> <window-end-ISO>
//   e.g. node check-uz-tick.cjs 2026-05-05T17:30:00Z 2026-05-05T18:30:00Z
//
// Defaults to "last 30 minutes" if no args given.
//
// Checks (in order of priority for UZ):
//   1. Backend stdout (most informative for UZ — token errors, VK API errors,
//      "Too many concurrent requests"). Read via SSH from prod backend.
//   2. cronHeartbeats[name=uzBudgetDispatch]: status=completed, error=null.
//   3. _scheduled_jobs latest-state for ruleEngine.js:uzBudgetBatchWorkerV2:
//      counts of success / failed in window vs baseline.
//   4. _scheduled_jobs created in window for adminAlerts.js:notify
//      (must be 0 — alert fan-out gate must hold).
//   5. systemLogs error level since window start (secondary signal).

const { execSync } = require("child_process");
const { ConvexHttpClient } = require("convex/browser");

const SSH_ARGS = ["-i", `${process.env.HOME}/.ssh/id_ed25519_server`, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10", "root@178.172.235.49"];
const CONVEX_URL = "https://convex.aipilot.by";

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length >= 2) return { startIso: args[0], endIso: args[1] };
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function ssh(remoteCmd) {
  // Pass remote command as a single argv element so local shell does not parse it.
  const { spawnSync } = require("child_process");
  const r = spawnSync("ssh", [...SSH_ARGS, remoteCmd], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`ssh exit=${r.status} stderr=${r.stderr}`);
  }
  return (r.stdout || "").trim();
}

function psql(sql) {
  // Pipe SQL via stdin to psql to avoid quoting nightmares.
  const { spawnSync } = require("child_process");
  const remote = `docker exec -i adpilot-postgres psql -U convex -d adpilot_prod -t -A -F'|'`;
  const r = spawnSync("ssh", [...SSH_ARGS, remote], { input: sql, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`psql exit=${r.status} stderr=${r.stderr}`);
  }
  return (r.stdout || "").trim();
}

async function main() {
  const { startIso, endIso } = parseArgs();
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();

  console.log(`=== UZ V2 canary verification ===`);
  console.log(`Window: ${startIso} -> ${endIso}`);
  console.log(`        (${startMs} -> ${endMs} ms)`);
  console.log();

  // 1) Backend stdout — primary signal for UZ
  console.log("[1] Backend stdout (Too many concurrent / Transient error / token errors):");
  try {
    const errCount = ssh(
      `docker logs adpilot-convex-backend --since ${startIso} --until ${endIso} 2>&1 | grep -cE 'Too many concurrent|Transient error|TOKEN_EXPIRED' || true`
    );
    console.log(`    error-line count: ${errCount}`);
    if (Number(errCount) > 0) {
      const sample = ssh(
        `docker logs adpilot-convex-backend --since ${startIso} --until ${endIso} 2>&1 | grep -E 'Too many concurrent|Transient error|TOKEN_EXPIRED' | head -10 || true`
      );
      console.log("    --- sample ---");
      for (const line of sample.split("\n")) console.log(`    ${line}`);
    }
    const uzLines = ssh(
      `docker logs adpilot-convex-backend --since ${startIso} --until ${endIso} 2>&1 | grep -E 'uzBatchV2|uzBudgetDispatchV2' | head -20 || true`
    );
    if (uzLines) {
      console.log("    --- UZ V2 log lines ---");
      for (const line of uzLines.split("\n")) console.log(`    ${line}`);
    } else {
      console.log("    UZ V2 log lines: 0");
    }
  } catch (e) {
    console.log(`    SSH error: ${e.message}`);
  }
  console.log();

  // 2) Heartbeat
  const adminKey = execSync("node gen-admin-key.cjs").toString().trim();
  const client = new ConvexHttpClient(CONVEX_URL);
  client.setAdminAuth(adminKey);

  console.log("[2] cronHeartbeats[name=uzBudgetDispatch]:");
  try {
    const hb = await client.query("syncMetrics:getCronHeartbeat", { name: "uzBudgetDispatch" });
    if (!hb) {
      console.log("    NO heartbeat record yet");
    } else {
      console.log(`    status=${hb.status} error=${hb.error ?? "null"} startedAt=${new Date(hb.startedAt).toISOString()} finishedAt=${hb.finishedAt ? new Date(hb.finishedAt).toISOString() : "n/a"}`);
      const inWindow = hb.startedAt >= startMs && hb.startedAt <= endMs;
      console.log(`    in window: ${inWindow}`);
    }
  } catch (e) {
    console.log(`    query error: ${e.message}`);
  }
  console.log();

  // 3) _scheduled_jobs latest-state for V2 worker
  console.log("[3] _scheduled_jobs latest-state for ruleEngine.js:uzBudgetBatchWorkerV2 / dispatchUzBatchesV2 / uzBudgetDispatchV2:");
  try {
    const sql = `
      WITH latest AS (
        SELECT DISTINCT ON (id) id, ts, deleted, convert_from(json_value,'UTF8')::jsonb AS j
        FROM documents
        WHERE table_id = decode('7ee519d746cd4bc3221534e5d95c5010','hex')
        ORDER BY id, ts DESC
      )
      SELECT j ->> 'udfPath' AS udf_path,
             j #>> '{state,type}' AS state_type,
             count(*) AS rows
      FROM latest
      WHERE NOT deleted
        AND j ->> 'udfPath' IN (
          'ruleEngine.js:uzBudgetBatchWorkerV2',
          'ruleEngine.js:dispatchUzBatchesV2',
          'ruleEngine.js:uzBudgetDispatchV2'
        )
      GROUP BY 1,2
      ORDER BY 3 DESC;
    `;
    const out = psql(sql);
    if (!out) {
      console.log("    no V2 schedules found yet");
    } else {
      for (const line of out.split("\n")) console.log(`    ${line}`);
    }
  } catch (e) {
    console.log(`    SQL error: ${e.message}`);
  }
  console.log();

  // 4) adminAlerts.notify schedules created in window (must be 0)
  console.log("[4] adminAlerts.js:notify schedules created in window (must be 0):");
  try {
    const sql = `
      WITH latest AS (
        SELECT DISTINCT ON (id) id, ts, deleted, convert_from(json_value,'UTF8')::jsonb AS j
        FROM documents
        WHERE table_id = decode('7ee519d746cd4bc3221534e5d95c5010','hex')
        ORDER BY id, ts DESC
      )
      SELECT count(*)
      FROM latest
      WHERE NOT deleted
        AND j ->> 'udfPath' = 'adminAlerts.js:notify'
        AND (j ->> '_creationTime')::numeric BETWEEN ${startMs} AND ${endMs};
    `;
    const out = psql(sql);
    console.log(`    count: ${out}`);
  } catch (e) {
    console.log(`    SQL error: ${e.message}`);
  }
  console.log();

  // 5) systemLogs (secondary)
  console.log("[5] systemLogs error level since window start (secondary):");
  try {
    const errs = await client.query("systemLogger:getRecentByLevel", {
      level: "error",
      since: startMs,
      limit: 50,
    });
    const inWindow = (errs || []).filter((l) => (l.createdAt || l._creationTime) <= endMs);
    console.log(`    error logs in window: ${inWindow.length}`);
    for (const l of inWindow.slice(0, 5)) {
      console.log(`      ${new Date(l.createdAt || l._creationTime).toISOString()} src=${l.source} msg=${(l.message || "").slice(0, 150)}`);
    }
  } catch (e) {
    console.log(`    query error: ${e.message}`);
  }
  console.log();

  console.log("=== END ===");
  console.log("Clean criteria for canary tick (all must hold):");
  console.log("  [1] backend stdout: 0 'Too many concurrent', 0 'Transient error', 0 'TOKEN_EXPIRED' surprises");
  console.log("  [2] heartbeat: status=completed, error=null");
  console.log("  [3] V2 worker: 0 failed (vs baseline) + N success matching dispatched count");
  console.log("  [4] adminAlerts.notify: 0 schedules in window");
  console.log("  [5] systemLogs: 0 errors in window");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
