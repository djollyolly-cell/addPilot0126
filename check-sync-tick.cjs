// Verify a SYNC V2 canary run, with baseline mode.
//
// Usage:
//   node check-sync-tick.cjs baseline
//     — snapshot pre-trigger state to /tmp/sync-canary-baseline.json:
//       pg_wal size, V2 _scheduled_jobs counts, failed counters,
//       /version, lastSyncAt stale count.
//
//   node check-sync-tick.cjs <window-start-ISO> <window-end-ISO>
//     — post-tick verification + delta vs baseline (if file exists).
//       e.g. node check-sync-tick.cjs 2026-05-05T22:00:00Z 2026-05-05T22:30:00Z
//
// Sync canary specifics vs UZ:
//   - pg_wal pressure is a primary risk for sync (V1 5-min interval was
//     a contributor to the 2026-05-04/05 incident). Captured at multiple
//     points: T-0 (baseline), then at T+5/T+15/T+30 by re-running.
//   - listSyncableAccounts backlog: log selected/eligible to see whether
//     the canary keeps up with the queue.
//   - moderation poll runs only if SYNC_METRICS_V2_POLL_MODERATION=1.

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const { ConvexHttpClient } = require("convex/browser");

const SSH_ARGS = [
  "-i",
  `${process.env.HOME}/.ssh/id_ed25519_server`,
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "ConnectTimeout=10",
  "root@178.172.235.49",
];
const CONVEX_URL = "http://178.172.235.49:3220";
const BASELINE_PATH = "/tmp/sync-canary-baseline.json";

function ssh(remoteCmd) {
  const r = spawnSync("ssh", [...SSH_ARGS, remoteCmd], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`ssh exit=${r.status} stderr=${r.stderr}`);
  }
  return (r.stdout || "").trim();
}

function psql(sql) {
  const remote = `docker exec -i adpilot-postgres psql -U convex -d adpilot_prod -t -A -F'|'`;
  const r = spawnSync("ssh", [...SSH_ARGS, remote], {
    input: sql,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`psql exit=${r.status} stderr=${r.stderr}`);
  }
  return (r.stdout || "").trim();
}

function adminClient() {
  const adminKey = execSync("node gen-admin-key.cjs").toString().trim();
  const c = new ConvexHttpClient(CONVEX_URL);
  c.setAdminAuth(adminKey);
  return c;
}

async function getVersion() {
  const r = spawnSync(
    "curl",
    [
      "-sS",
      "-w",
      "\nHTTP %{http_code} time %{time_total}s",
      "--max-time",
      "10",
      "--resolve",
      "convex.aipilot.by:443:178.172.235.49",
      "https://convex.aipilot.by/version",
    ],
    { encoding: "utf8" }
  );
  return (r.stdout || "").trim();
}

async function pgWalSize() {
  return ssh(
    `docker exec adpilot-postgres du -sh /var/lib/postgresql/data/pg_wal`
  );
}

async function v2ScheduledJobsState() {
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
        'syncMetrics.js:syncBatchWorkerV2',
        'syncMetrics.js:dispatchSyncBatchesV2',
        'syncMetrics.js:syncDispatchV2'
      )
    GROUP BY 1,2
    ORDER BY 1,2;
  `;
  return psql(sql);
}

async function failedCounters() {
  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (id) id, ts, deleted, convert_from(json_value,'UTF8')::jsonb AS j
      FROM documents
      WHERE table_id = decode('7ee519d746cd4bc3221534e5d95c5010','hex')
      ORDER BY id, ts DESC
    )
    SELECT j ->> 'udfPath' AS udf_path, count(*) AS failed
    FROM latest
    WHERE NOT deleted AND j #>> '{state,type}' = 'failed'
    GROUP BY 1
    ORDER BY 2 DESC
    LIMIT 10;
  `;
  return psql(sql);
}

async function staleAccountsCount(client) {
  // Stale = lastSyncAt > 20 min OR null
  const all = await client.query("syncMetrics:listAllActiveAccountsBasic", {});
  const now = Date.now();
  const stale = (all || []).filter(
    (a) => !a.lastSyncAt || now - a.lastSyncAt > 20 * 60_000
  );
  return { total: (all || []).length, stale: stale.length };
}

async function captureSnapshot(client, label) {
  const snap = {
    label,
    capturedAtUtc: new Date().toISOString(),
    capturedAtMs: Date.now(),
  };
  try {
    snap.version = await getVersion();
  } catch (e) {
    snap.version = `ERR ${e.message}`;
  }
  try {
    snap.pgWal = await pgWalSize();
  } catch (e) {
    snap.pgWal = `ERR ${e.message}`;
  }
  try {
    snap.v2Jobs = await v2ScheduledJobsState();
  } catch (e) {
    snap.v2Jobs = `ERR ${e.message}`;
  }
  try {
    snap.failedCounters = await failedCounters();
  } catch (e) {
    snap.failedCounters = `ERR ${e.message}`;
  }
  try {
    const s = await staleAccountsCount(client);
    snap.lastSyncAtStale = `${s.stale}/${s.total}`;
  } catch (e) {
    snap.lastSyncAtStale = `ERR ${e.message}`;
  }
  return snap;
}

function printSnapshot(snap, indent = "    ") {
  console.log(`${indent}label: ${snap.label}`);
  console.log(`${indent}captured: ${snap.capturedAtUtc}`);
  console.log(`${indent}/version: ${snap.version.replace(/\n/g, " | ")}`);
  console.log(`${indent}pg_wal: ${snap.pgWal}`);
  console.log(`${indent}lastSyncAt stale (>20min): ${snap.lastSyncAtStale}`);
  console.log(`${indent}V2 _scheduled_jobs:`);
  if (!snap.v2Jobs) console.log(`${indent}  (empty)`);
  else
    for (const line of String(snap.v2Jobs).split("\n"))
      console.log(`${indent}  ${line}`);
  console.log(`${indent}top failed counters:`);
  if (!snap.failedCounters) console.log(`${indent}  (empty)`);
  else
    for (const line of String(snap.failedCounters).split("\n"))
      console.log(`${indent}  ${line}`);
}

async function postCheck(startIso, endIso, client) {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();

  console.log(`=== SYNC V2 canary post-check ===`);
  console.log(`Window: ${startIso} -> ${endIso}`);
  console.log();

  let baseline = null;
  if (fs.existsSync(BASELINE_PATH)) {
    try {
      baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
      console.log(`[baseline] loaded from ${BASELINE_PATH}`);
      console.log(`           captured: ${baseline.capturedAtUtc}`);
    } catch (e) {
      console.log(`[baseline] FAILED to parse ${BASELINE_PATH}: ${e.message}`);
      console.log(`           continuing with absolute values only.`);
    }
  } else {
    console.log(
      `[baseline] missing — ${BASELINE_PATH} not found. Showing absolute values.`
    );
  }
  console.log();

  // 1) Backend stdout — primary sync signal
  console.log(`[1] Backend stdout in window (errors / V2 logs):`);
  try {
    const errCount = ssh(
      `docker logs adpilot-convex-backend --since ${startIso} --until ${endIso} 2>&1 | grep -cE 'Too many concurrent|Transient error|TOKEN_EXPIRED' || true`
    );
    console.log(`    V8/transient error-line count: ${errCount}`);
    // syncBatchV2 catches per-account errors and continues — worker can
    // report success while individual accounts failed. Surface those.
    const accountFailCount = ssh(
      `docker logs adpilot-convex-backend --since ${startIso} --until ${endIso} 2>&1 | grep -cE 'syncBatchV2.*Account .* failed' || true`
    );
    console.log(`    syncBatchV2 per-account failures: ${accountFailCount}`);
    if (Number(accountFailCount) > 0) {
      const sample = ssh(
        `docker logs adpilot-convex-backend --since ${startIso} --until ${endIso} 2>&1 | grep -E 'syncBatchV2.*Account .* failed' | head -10 || true`
      );
      console.log(`    --- per-account failure samples ---`);
      for (const l of sample.split("\n")) console.log(`    ${l}`);
    }
    const v2Lines = ssh(
      `docker logs adpilot-convex-backend --since ${startIso} --until ${endIso} 2>&1 | grep -E 'syncBatchV2|syncDispatchV2|dispatchSyncBatchesV2' | head -30 || true`
    );
    if (v2Lines) {
      console.log(`    --- V2 log lines ---`);
      for (const l of v2Lines.split("\n")) console.log(`    ${l}`);
    } else {
      console.log(`    V2 log lines: (none in window)`);
    }
  } catch (e) {
    console.log(`    SSH error: ${e.message}`);
  }
  console.log();

  // 2) Heartbeat
  console.log(`[2] cronHeartbeats[name=syncDispatch]:`);
  try {
    const hb = await client.query("syncMetrics:getCronHeartbeat", {
      name: "syncDispatch",
    });
    if (!hb) {
      console.log(`    NO heartbeat record yet`);
    } else {
      const inWindow = hb.startedAt >= startMs && hb.startedAt <= endMs;
      console.log(
        `    status=${hb.status} error=${hb.error ?? "null"} startedAt=${new Date(hb.startedAt).toISOString()} finishedAt=${hb.finishedAt ? new Date(hb.finishedAt).toISOString() : "n/a"}`
      );
      console.log(`    in window: ${inWindow}`);
    }
  } catch (e) {
    console.log(`    query error: ${e.message}`);
  }
  console.log();

  // 3) Current snapshot
  console.log(`[3] Current snapshot:`);
  const current = await captureSnapshot(client, "post-check");
  printSnapshot(current);
  console.log();

  // 4) Delta vs baseline
  if (baseline) {
    console.log(`[4] Delta vs baseline:`);
    console.log(`    pg_wal: ${baseline.pgWal} -> ${current.pgWal}`);
    console.log(
      `    lastSyncAt stale: ${baseline.lastSyncAtStale} -> ${current.lastSyncAtStale}`
    );
    console.log(`    V2 _scheduled_jobs: see absolute above`);
    console.log(`    failed counters: see absolute above`);
    console.log(
      `    Watch for: pg_wal +>200 MB, stale stays high, new failed entries.`
    );
  } else {
    console.log(`[4] Delta: skipped (no baseline)`);
  }
  console.log();

  // 5) adminAlerts.notify in window (must be 0)
  console.log(`[5] adminAlerts.js:notify schedules created in window (must be 0):`);
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
    console.log(`    count: ${psql(sql)}`);
  } catch (e) {
    console.log(`    SQL error: ${e.message}`);
  }
  console.log();

  console.log(`=== END ===`);
  console.log(`Clean criteria for sync canary:`);
  console.log(`  [1a] backend stdout: 0 'Too many concurrent', 0 'Transient error'`);
  console.log(`  [1b] backend stdout: 0 'syncBatchV2 ... Account ... failed'`);
  console.log(`  [2]  heartbeat: status=completed, error=null, in window`);
  console.log(`       (heartbeat reflects DISPATCHER completion only,`);
  console.log(`        not worker completion — workers run async)`);
  console.log(`  [3]  V2 worker schedules: success increments, 0 new failed`);
  console.log(`  [4]  pg_wal delta: < 200 MB for canary tick`);
  console.log(`  [5]  adminAlerts.notify: 0 in window`);
}

async function baselineMode(client) {
  console.log(`=== SYNC V2 canary baseline ===`);
  const snap = await captureSnapshot(client, "baseline");
  printSnapshot(snap);
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(snap, null, 2));
  console.log();
  console.log(`Saved to ${BASELINE_PATH}`);
}

async function main() {
  const args = process.argv.slice(2);
  const client = adminClient();

  if (args[0] === "baseline") {
    await baselineMode(client);
  } else if (args.length >= 2) {
    await postCheck(args[0], args[1], client);
  } else {
    console.error(
      `Usage:\n  node check-sync-tick.cjs baseline\n  node check-sync-tick.cjs <start-ISO> <end-ISO>`
    );
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
