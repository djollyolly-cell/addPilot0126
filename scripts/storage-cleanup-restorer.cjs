#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");

const TERMINAL_STATES = new Set(["completed", "failed"]);
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_READ_LIMIT = 5;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    once: false,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    readLimit: DEFAULT_READ_LIMIT,
    now: () => Date.now(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[i];
    };

    switch (arg) {
      case "--target-run-id":
        options.targetRunId = next();
        break;
      case "--env-name":
        options.envName = next();
        break;
      case "--poll-interval-ms":
        options.pollIntervalMs = Number(next());
        break;
      case "--expected-terminal-at-ms":
        options.expectedTerminalAtMs = Number(next());
        break;
      case "--failsafe-buffer-ms":
        options.failsafeBufferMs = Number(next());
        break;
      case "--read-limit":
        options.readLimit = Number(next());
        break;
      case "--row-json-file":
        options.rowJsonFile = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--once":
        options.once = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.envName =
    options.envName || "METRICS_REALTIME_CLEANUP_V2_ENABLED";

  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 1000) {
    throw new Error("--poll-interval-ms must be a number >= 1000");
  }
  if (!Number.isInteger(options.readLimit) || options.readLimit < 1) {
    throw new Error("--read-limit must be a positive integer");
  }
  if (
    options.expectedTerminalAtMs !== undefined &&
    !Number.isFinite(options.expectedTerminalAtMs)
  ) {
    throw new Error("--expected-terminal-at-ms must be a number");
  }
  if (
    options.failsafeBufferMs !== undefined &&
    !Number.isFinite(options.failsafeBufferMs)
  ) {
    throw new Error("--failsafe-buffer-ms must be a number");
  }

  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/storage-cleanup-restorer.cjs --target-run-id <runId> [options]",
    "",
    "Required environment for live mode:",
    "  CONVEX_SELF_HOSTED_URL",
    "  CONVEX_SELF_HOSTED_ADMIN_KEY",
    "",
    "Options:",
    "  --env-name <name>                  Env var to restore to 0",
    "  --poll-interval-ms <ms>            Default: 30000",
    "  --read-limit <n>                   cleanupRunState rows to read; default: 5",
    "  --expected-terminal-at-ms <epoch>  Enables guarded failsafe window",
    "  --failsafe-buffer-ms <ms>          Buffer added to expected terminal time",
    "  --row-json-file <path>             Read rows from a local JSON file (test/dry-run)",
    "  --dry-run                          Log restore action without setting env",
    "  --once                             Run one poll then exit",
    "",
    "Safety:",
    "  - Restores env only when the target runId is terminal.",
    "  - Does not force env=0 for active or unknown target rows.",
    "  - Timeout/unknown paths halt with an operator alert instead of mutating env.",
  ].join("\n");
}

function parseRowsJson(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("cleanupRunState payload must be a JSON array");
  }
  return parsed;
}

function findTargetRow(rows, targetRunId) {
  return rows.find((row) => row && row.runId === targetRunId);
}

function isTerminalRow(row) {
  if (!row) return false;
  if (TERMINAL_STATES.has(row.state)) return true;
  return row.isActive === false;
}

function isActiveRow(row) {
  if (!row) return false;
  if (row.isActive === true) return true;
  return row.state === "running" || row.state === "claimed";
}

function getRestorerDecision({ row, targetRunId, nowMs, expectedTerminalAtMs, failsafeBufferMs }) {
  if (row && row.runId !== targetRunId) {
    return {
      action: "wait",
      reason: "non_target_row_visible",
      shouldRestoreEnv: false,
      shouldContinue: true,
    };
  }

  if (isTerminalRow(row)) {
    return {
      action: "restore_env",
      reason: "target_terminal",
      shouldRestoreEnv: true,
      shouldContinue: false,
    };
  }

  const hasFailsafe =
    Number.isFinite(expectedTerminalAtMs) && Number.isFinite(failsafeBufferMs);
  const failsafeAtMs = hasFailsafe ? expectedTerminalAtMs + failsafeBufferMs : undefined;
  const failsafeExpired = hasFailsafe && nowMs >= failsafeAtMs;

  if (failsafeExpired) {
    return {
      action: "halt_alert",
      reason: row && isActiveRow(row) ? "target_active_after_failsafe" : "target_unknown_after_failsafe",
      shouldRestoreEnv: false,
      shouldContinue: false,
    };
  }

  return {
    action: "wait",
    reason: row ? "target_not_terminal" : "target_not_visible",
    shouldRestoreEnv: false,
    shouldContinue: true,
  };
}

function runConvex(args, options = {}) {
  const env = {
    ...process.env,
  };
  if (!env.CONVEX_SELF_HOSTED_URL || !env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    throw new Error(
      "CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY are required in live mode",
    );
  }

  const result = spawnSync("npx", ["convex", ...args], {
    cwd: options.cwd || process.cwd(),
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const message = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(message || `convex exited with status ${result.status}`);
  }

  return result.stdout.trim();
}

function readRows(options) {
  if (options.rowJsonFile) {
    return parseRowsJson(fs.readFileSync(options.rowJsonFile, "utf8"));
  }

  const raw = runConvex(
    ["data", "cleanupRunState", "--limit", String(options.readLimit), "--format", "jsonArray"],
    options,
  );
  return parseRowsJson(raw);
}

function restoreEnvZero(options) {
  if (options.dryRun) {
    console.log(`dry_run_restore env=${options.envName} value=0`);
    return "dry-run";
  }

  runConvex(["env", "set", options.envName, "0"], options);
  const value = runConvex(["env", "get", options.envName], options);
  if (value !== "0") {
    throw new Error(`env verify failed: expected 0, got ${JSON.stringify(value)}`);
  }
  return value;
}

function logHeartbeat({ targetRunId, row, decision }) {
  const payload = {
    ts: new Date().toISOString(),
    targetRunId,
    observedRunId: row ? row.runId : null,
    state: row ? row.state : null,
    isActive: row ? row.isActive : null,
    batchesRun: row ? row.batchesRun : null,
    deletedCount: row ? row.deletedCount : null,
    durationMs: row ? row.durationMs : null,
    action: decision.action,
    reason: decision.reason,
  };
  console.log(JSON.stringify(payload));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(argv = process.argv.slice(2), runtime = {}) {
  const options = {
    ...parseArgs(argv),
    ...runtime,
  };

  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (!options.targetRunId) {
    throw new Error("--target-run-id is required");
  }

  while (true) {
    const rows = runtime.readRows ? await runtime.readRows(options) : readRows(options);
    const row = findTargetRow(rows, options.targetRunId);
    const decision = getRestorerDecision({
      row,
      targetRunId: options.targetRunId,
      nowMs: options.now(),
      expectedTerminalAtMs: options.expectedTerminalAtMs,
      failsafeBufferMs: options.failsafeBufferMs,
    });

    logHeartbeat({
      targetRunId: options.targetRunId,
      row,
      decision,
    });

    if (decision.shouldRestoreEnv) {
      const value = runtime.restoreEnvZero
        ? await runtime.restoreEnvZero(options)
        : restoreEnvZero(options);
      console.log(`env_verify=${value}`);
      return 0;
    }

    if (!decision.shouldContinue || options.once) {
      if (decision.action === "halt_alert") {
        console.error(`operator_alert=${decision.reason}`);
        return 2;
      }
      return 0;
    }

    await sleep(options.pollIntervalMs);
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}

module.exports = {
  TERMINAL_STATES,
  findTargetRow,
  getRestorerDecision,
  isActiveRow,
  isTerminalRow,
  parseArgs,
  parseRowsJson,
  usage,
};
