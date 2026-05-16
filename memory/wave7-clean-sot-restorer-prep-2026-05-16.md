# Wave 7 Clean SOT Worktree + Restorer Prep — 2026-05-16

Type: project memory / operator prep receipt
Mode: read-only prep, no Wave 7 authorization

## Result

PASS. The restorer noisy-JSON hardening is now committed and pushed to
`origin/emergency/drain-scheduled-jobs`. A clean detached Wave 7 SOT worktree was
created and verified.

This receipt does not authorize:

- Wave 7 trigger;
- flipping `METRICS_REALTIME_CLEANUP_V2_ENABLED`;
- profile changes;
- automation;
- PG raw probes;
- database maintenance.

## Source Of Truth

Wave 7 SOT candidate:

- branch: `origin/emergency/drain-scheduled-jobs`
- commit: `7cfa08cd218d2523188048853e1bcd5d0d48168e`
- short commit: `7cfa08c tools(storage-cleanup): tolerate noisy restorer JSON`
- clean detached worktree: `/private/tmp/adpilot-wave7-sot-2026-05-16`

Verification:

```text
$ git rev-parse origin/emergency/drain-scheduled-jobs
7cfa08cd218d2523188048853e1bcd5d0d48168e

$ git -C /private/tmp/adpilot-wave7-sot-2026-05-16 rev-parse HEAD
7cfa08cd218d2523188048853e1bcd5d0d48168e

$ git -C /private/tmp/adpilot-wave7-sot-2026-05-16 status --short
<empty>
```

`gh run list --commit 7cfa08cd218d2523188048853e1bcd5d0d48168e --limit 10`
returned no visible runs in this session.

## Verification

Passed in isolated hardening worktree:

- `npm ci`
- `npx vitest run --config vitest.config.ts tests/unit/storage-cleanup-restorer.test.ts`
  - `1` file passed
  - `11` tests passed
- `node --check scripts/storage-cleanup-restorer.cjs`
- `git diff --check`
- direct Node parser regression for noisy output before/after JSON.

Passed from clean Wave 7 SOT worktree:

- `node /private/tmp/adpilot-wave7-sot-2026-05-16/scripts/storage-cleanup-restorer.cjs --help`
- `node --check /private/tmp/adpilot-wave7-sot-2026-05-16/scripts/storage-cleanup-restorer.cjs`
- fixture noisy-running dry-run:
  - target `1778525039989-605b8ed53962`
  - decision `action=wait`, `reason=target_not_terminal`
- live positive dry-run against Wave 6 terminal runId
  `1778955542827-b02bca844e80`:
  - decision `action=restore_env`, `reason=target_terminal`
  - `dry_run_restore env=METRICS_REALTIME_CLEANUP_V2_ENABLED value=0`
  - `env_verify=dry-run`
- live negative dry-run against invalid runId `0000000000000-000000000000`:
  - decision `action=wait`, `reason=target_not_visible`
- post-rehearsal env:
  - `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`

Helper hash in main checkout:

```text
5da266ec3132c4c8415d8b41e95edd71f91088a3ddb26c116547015f393c0179  gen-admin-key.cjs
```

## Wave 7 Runbook Requirements

Wave 7 runbook must:

- pin SOT to `7cfa08cd218d2523188048853e1bcd5d0d48168e`;
- verify origin HEAD equals that hash before any env write;
- use clean worktree `/private/tmp/adpilot-wave7-sot-2026-05-16` or recreate it
  from that commit if missing;
- include the noisy-output parser regression as a required restorer rehearsal
  item, alongside positive and negative dry-runs;
- update restorer failure-mode notes: Wave 6 noisy-JSON SPOF is fixed by
  `7cfa08c`, but dry-run proof remains mandatory.
