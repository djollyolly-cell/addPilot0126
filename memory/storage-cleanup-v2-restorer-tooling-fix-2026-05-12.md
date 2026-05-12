---
name: storage-cleanup-v2-restorer-tooling-fix-2026-05-12
description: Restorer tooling fix for Storage Cleanup V2 maxRuns=24 wave gating after wave 4 SPOF
type: project
---

# Storage Cleanup V2 Restorer Tooling Fix — 2026-05-12

## Context

Wave 4 of the Tier 1 maxRuns=24 ledger completed cleanly, but the shell
restorer observed the terminal row and did not restore
`METRICS_REALTIME_CLEANUP_V2_ENABLED=0`. The operator restored the env
manually. Cleanup itself was clean; the issue was an operational tooling SPOF.

Wave 5 was explicitly blocked until the restorer tooling was fixed and
verified.

## What Changed

Added `scripts/storage-cleanup-restorer.cjs`, a target-runId-bound restorer
CLI with explicit parsed-field decisions:

- Requires `--target-run-id`.
- Reads recent `cleanupRunState` rows and targets only the matching runId.
- Restores env only when the target row is terminal:
  `state in ("completed", "failed")` or `isActive=false`.
- Does not restore env for active, unknown, or non-target rows.
- Emits heartbeat JSON on every poll.
- Uses a 30s timeout for Convex CLI calls by default to avoid an infinite
  restorer hang on network/CLI stalls.
- Retries transient Convex CLI failures with default backoff `1s / 3s / 10s`
  before surfacing an error.
- Supports a guarded failsafe window:
  - terminal target row -> restore env;
  - active/unknown target after failsafe -> halt + operator alert, no env
    mutation.
- Supports `--dry-run`, `--once`, and `--row-json-file` for rehearsal without
  live Convex or env mutation.

Added `tests/unit/storage-cleanup-restorer.test.ts` covering the critical
safety decisions:

- terminal target row restores env;
- active target row waits;
- non-target terminal row does not restore env;
- failsafe active/unknown paths halt-alert without env mutation;
- target row can be found among recent rows;
- command timeout and retry backoff args parse correctly.

## Verification

Local dependency-free verification was run in the clean worktree:

```text
node --check scripts/storage-cleanup-restorer.cjs
node <inline assertions requiring scripts/storage-cleanup-restorer.cjs>
node scripts/storage-cleanup-restorer.cjs --target-run-id target-1 \
  --row-json-file /tmp/restorer-terminal.json --dry-run --once
node scripts/storage-cleanup-restorer.cjs --target-run-id target-1 \
  --row-json-file /tmp/restorer-active.json --dry-run --once
node scripts/storage-cleanup-restorer.cjs --target-run-id target-1 \
  --row-json-file /tmp/restorer-unknown.json --dry-run --once \
  --expected-terminal-at-ms 1000 --failsafe-buffer-ms 1000
```

Results:

- syntax check passed;
- dependency-free assertions passed;
- terminal simulation produced `action="restore_env"` and dry-run env output;
- active simulation produced `action="wait"` and no env mutation.
- unknown-after-failsafe simulation produced `action="halt_alert"`, exit `2`,
  and no env mutation.

Follow-up hardening on 2026-05-12 added the Convex CLI command timeout and
retry/backoff controls after review identified those as pre-wave-5 reliability
requirements.

After the hardening patch, the focused Vitest test was run from the clean
worktree using a temporary symlink to the existing local `node_modules`:

```text
npm run test:unit -- tests/unit/storage-cleanup-restorer.test.ts
```

Result: `9` tests passed.

## Operational Notes

Live use must still follow the cleanup runbook:

1. Fresh mini-preflight.
2. Explicit operator go for the wave.
3. Env flip and single trigger.
4. Verify the matching `cleanupRunState` target runId.
5. Start the restorer bound to that exact target runId.

Example shape:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
node scripts/storage-cleanup-restorer.cjs \
  --target-run-id "$RUN_ID" \
  --read-limit 50 \
  --expected-terminal-at-ms "$EXPECTED_TERMINAL_MS" \
  --failsafe-buffer-ms 900000 \
  --command-timeout-ms 30000 \
  --retry-delays-ms 1000,3000,10000
```

Do not use the restorer as a generic "no active row" env-zero tool. It is
target-runId-bound by design.

When using `--once`, do not treat exit code `0` alone as a success signal.
The operator must inspect the heartbeat payload. A successful positive
rehearsal requires the expected `observedRunId`, terminal state, and
`action="restore_env"` / `reason="target_terminal"`.

## Wave 5 Readiness Rehearsal (Required)

Before wave 5, run a production-equivalent dry-run rehearsal against live
Convex admin reads. This is read-only with respect to runtime state because
`--dry-run` must be used; it must still be explicitly approved as a live admin
read.

Primary positive rehearsal:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
node scripts/storage-cleanup-restorer.cjs \
  --target-run-id 1778525039989-605b8ed53962 \
  --read-limit 50 \
  --dry-run \
  --once
```

Expected positive result:

```json
{
  "observedRunId": "1778525039989-605b8ed53962",
  "state": "completed",
  "isActive": false,
  "action": "restore_env",
  "reason": "target_terminal"
}
```

The command must also print:

```text
dry_run_restore env=METRICS_REALTIME_CLEANUP_V2_ENABLED value=0
env_verify=dry-run
```

If the target runId is not found with `--read-limit 50`, this is not a
successful rehearsal. First read recent `cleanupRunState` rows, choose a
completed target runId that is visible in the read window, and repeat the
positive rehearsal against that exact runId.

Optional negative rehearsal:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
node scripts/storage-cleanup-restorer.cjs \
  --target-run-id definitely-not-existing \
  --read-limit 50 \
  --dry-run \
  --once
```

Expected negative result: heartbeat action `wait`, no `dry_run_restore`
line, and no env mutation.

Negative rehearsal result on 2026-05-12:

```json
{
  "targetRunId": "definitely-not-existing",
  "observedRunId": null,
  "state": null,
  "isActive": null,
  "action": "wait",
  "reason": "target_not_visible"
}
```

Post-rehearsal env verification: `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`.

Use `--failsafe-buffer-ms 900000` for wave 5 unless there is a specific reason
to choose a larger buffer. The default retry worst case is about 134s per
Convex CLI operation (`4 * 30s` command timeout plus `1s + 3s + 10s` backoff),
so the buffer should include both expected duration jitter and retry overhead.

## Status

Restorer tooling fix is implemented and locally dry-run verified. Wave 5
remains blocked until the production-equivalent positive dry-run rehearsal
above is completed successfully. After that, use the script only in
target-runId-bound mode.
