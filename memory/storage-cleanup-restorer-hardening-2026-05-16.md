# Storage Cleanup Restorer Hardening — 2026-05-16

Type: doc-only hardening receipt
Scope: `scripts/storage-cleanup-restorer.cjs`
Reason: Wave 6 first restorer exited on noisy Convex CLI output:
`Unexpected token 'W', "WebSocket "... is not valid JSON`

## Change

Hardened `parseRowsJson` so it extracts the first balanced JSON array from
Convex CLI output before parsing. This allows the restorer to tolerate
WebSocket/reconnect noise before or after the `cleanupRunState --format
jsonArray` payload.

Committed and pushed:

- branch: `origin/emergency/drain-scheduled-jobs`
- commit: `7cfa08cd218d2523188048853e1bcd5d0d48168e`
- subject: `tools(storage-cleanup): tolerate noisy restorer JSON`

Changed files:

- `scripts/storage-cleanup-restorer.cjs`
- `tests/unit/storage-cleanup-restorer.test.ts`
- `tests/fixtures/storage-cleanup-restorer-noisy-running.txt`
- `tests/fixtures/storage-cleanup-restorer-terminal.json`
- `tests/fixtures/storage-cleanup-restorer-invalid-target.json`

## Verification

Passed:

- `node --check scripts/storage-cleanup-restorer.cjs`
- `git diff --check`
- `npx vitest run --config vitest.config.ts tests/unit/storage-cleanup-restorer.test.ts`
  in isolated worktree `/private/tmp/adpilot-restorer-hardening-2026-05-16`:
  `1` file passed, `11` tests passed.
- direct Node parser regression:
  - noisy WebSocket-like lines before JSON array -> parsed rows, no crash;
  - noisy line after JSON array -> parsed rows, no crash.
- CLI fixture rehearsal with noisy running row:
  - target `1778525039989-605b8ed53962`
  - observed `state=running`, `batchesRun=11`
  - decision `action=wait`, `reason=target_not_terminal`
- CLI fixture positive dry-run:
  - terminal target row
  - decision `action=restore_env`, `reason=target_terminal`
  - `dry_run_restore ... value=0`
  - `env_verify=dry-run`
- CLI fixture negative dry-run:
  - invalid target `0000000000000-000000000000`
  - decision `action=wait`, `reason=target_not_visible`
- live positive dry-run against Wave 6 terminal runId
  `1778955542827-b02bca844e80`:
  - decision `action=restore_env`, `reason=target_terminal`
  - `env_verify=dry-run`
- live negative dry-run against invalid runId:
  - decision `action=wait`, `reason=target_not_visible`
- post-rehearsal env verification:
  - `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`

## Wave 7 Requirement

Before Wave 7, pin SOT to `7cfa08cd218d2523188048853e1bcd5d0d48168e` or a later
commit that deliberately includes this hardening. Do not use old SOT `2b62f99`
for Wave 7 unless the runbook explicitly accepts the old noisy-JSON SPOF and
operator re-arm/rescue dependency.

This receipt does not authorize Wave 7, env writes, trigger, profile changes,
automation, PG raw probes, or database maintenance.
