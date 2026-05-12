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
- target row can be found among recent rows.

## Verification

Local dependency-free verification was run in the clean worktree:

```text
node --check scripts/storage-cleanup-restorer.cjs
node <inline assertions requiring scripts/storage-cleanup-restorer.cjs>
node scripts/storage-cleanup-restorer.cjs --target-run-id target-1 \
  --row-json-file /tmp/restorer-terminal.json --dry-run --once
node scripts/storage-cleanup-restorer.cjs --target-run-id target-1 \
  --row-json-file /tmp/restorer-active.json --dry-run --once
```

Results:

- syntax check passed;
- dependency-free assertions passed;
- terminal simulation produced `action="restore_env"` and dry-run env output;
- active simulation produced `action="wait"` and no env mutation.

`npm run test:unit -- tests/unit/storage-cleanup-restorer.test.ts` was
attempted from the temporary worktree, but the temp worktree has no
`node_modules`, so Vitest was not locally runnable there. The Vitest test file
is included for normal dependency-present CI/dev environments.

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
  --expected-terminal-at-ms "$EXPECTED_TERMINAL_MS" \
  --failsafe-buffer-ms 600000
```

Do not use the restorer as a generic "no active row" env-zero tool. It is
target-runId-bound by design.

## Status

Restorer tooling fix is implemented and locally dry-run verified. Before wave
5, the operator should still review the script invocation and use it in a
target-runId-bound mode only.
