# Storage Cleanup V2 — Phase 4 Canary Runbook — 2026-05-07

Status: pre-canary runbook. Written against design contract from commit `b3e4bd4`; re-verified against actual Phase 1 code in commit `2410f14` (read-only, no drift on the 6 main contracts: 8 V2 exports, args, schema, cutoffMs widening, env var name, log prefix). Re-run the "Re-verification before first use" checklist below before invoking trigger if HEAD has moved.

Related:
- Plan (hardened runbook): `docs/superpowers/plans/2026-05-07-storage-cleanup-v2.md` (commit `9f6786b`)
- Preflight baseline: `memory/storage-cleanup-v2-preflight-2026-05-07.md` (commit `ae2506b`)
- Phase 1 design: `memory/storage-cleanup-v2-phase1-design-2026-05-07.md` (commit `b3e4bd4`)
- Phase 1 code (source of facts): `convex/{schema,metrics,metrics.test}.ts` at commit `2410f14`

## What this runbook covers

ONE manual canary invocation of `triggerMassCleanupV2` against production with the smallest bounded parameters (`maxRuns=1, batchSize=500`). It does NOT cover Phase 5 (controlled runs), Phase 6 (cron restore), or Phase 7/8 (other tables). Each of those has its own go.

## Prerequisites (must hold before any Phase 4 step)

- [ ] Phase 1 code committed (8 V2 exports in `convex/metrics.ts`, `cleanupRunState` table in `convex/schema.ts`, `deleteRealtimeBatch` widened with optional `cutoffMs`).
- [ ] Phase 2 local verification clean: `npx tsc --noEmit -p convex/tsconfig.json`, `npm run test`, grep guards (broad inventory + zero-hits on V1 udfPath in scheduling positions).
- [ ] Phase 3 deploy clean: `npx convex deploy --yes` returned 0, `/version` HTTP 200 post-deploy.
- [ ] `METRICS_REALTIME_CLEANUP_V2_ENABLED` is NOT set in any deploy env at this point — must remain default-off until step 1 of pre-trigger sequence below.
- [ ] `cleanup-old-realtime-metrics` cron remains commented in `convex/crons.ts`. (Phase 4 is manual-only; cron restoration is Phase 6.)
- [ ] `_scheduled_functions` shows zero `manualMassCleanupV2` entries (no smoke run was performed during Phase 1/2/3).
- [ ] Operator has shell access to a machine with the repo checked out and `node gen-admin-key.cjs` runnable.

If any prerequisite fails → STOP. Do not attempt canary trigger until resolved.

## Step 1 — Set narrow env flag for canary window only

Set the per-table V2 enable flag to `1`. Do NOT set any other cleanup-V2 flag (Phase 7/8 flags must remain absent or `0`).

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1
```

Verification:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env list | grep METRICS_REALTIME_CLEANUP_V2_ENABLED
```

Expected: `METRICS_REALTIME_CLEANUP_V2_ENABLED=1`. No other `*_CLEANUP_V2_ENABLED` flags should appear.

NOTE: env update takes effect without redeploy because `isMetricsRealtimeCleanupV2Enabled()` reads `process.env` inside handler (per design memo Decision D, mirrors `SYNC_ESCALATION_ALERTS_ENABLED` pattern).

## Step 2 — Recapture anchors immediately before trigger

The Phase 0 / preflight numbers (commit `ae2506b`) are NOT acceptable as Phase 4 baseline — too much time has passed. Recapture all anchors NOW:

### 2a — `/version`

```bash
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" https://convex.aipilot.by/version
```
Expected: `200 <time>`. If non-200 → STOP.

### 2b — Disk headroom

```bash
ssh root@178.172.235.49 "df -h /"
```
Expected: free space ≥ preflight value (138G) minus reasonable drift. If free space dropped >20G since preflight without explanation → STOP.

### 2c — `pg_wal` baseline (fresh — anchor for delta)

```bash
ssh root@178.172.235.49 "docker exec convex-postgres-1 du -sb /var/lib/postgresql/data/pg_wal | awk '{print \$1}'"
```
Record `pg_wal_pre_canary` value.

### 2d — `metricsRealtime` count anchors

Re-run the counts (read-only — same method as preflight):
- `metricsRealtime` total count
- `metricsRealtime WHERE timestamp < (now - 172_800_000)` (eligible)
- `oldestRemainingTimestamp = min(timestamp)` across all `metricsRealtime` rows

Acceptable methods (any one):
- Convex dashboard SQL inspector
- `npx convex run` against a temporary read-only internal query (ONLY if such a query already exists in the codebase, do NOT add one for this purpose)
- Server-local pagination through `/api/list_snapshot` (same as preflight, but takes ~50min on 9.5M rows — only if other methods unavailable)

Record:
- `metricsRealtime_total_pre`
- `metricsRealtime_eligible_pre`
- `oldestRemainingTimestamp_pre`

### 2e — Core heartbeats clean

Read `cronHeartbeats` table:
- `syncDispatch` — must be `completed`, `error: undefined`, latest startedAt within last 15 min.
- `uzBudgetDispatch` — must be `completed`, `error: undefined`, latest startedAt within last 45 min.
- `tokenRefreshDispatch` — must be `completed`, `error: undefined`, latest startedAt within last 2h.

If any non-`completed` or has `error` set → STOP. Sync/UZ/token regression overrides cleanup work (per Decision priority in plan Phase 4 Hard stop section).

### 2f — `_scheduled_functions` failed counters baseline

Capture failed counts for these UDFs at this moment (will check delta after canary):
- `auth.js:tokenRefreshOneV2`
- `ruleEngine.js:uzBudgetBatchWorkerV2`
- `syncMetrics.js:syncBatchWorkerV2`
- `metrics.js:manualMassCleanup` (V1, residue)
- `metrics.js:manualMassCleanupV2` (V2 — must be 0 absolute, not just delta)
- `adminAlerts.js:notify`

Record `failed_counters_pre = { ... }`.

### 2g — Backend stdout rollback patterns (since Phase 3 deploy)

```bash
ssh root@178.172.235.49 "docker logs --since '<phase3_deploy_iso>' convex-backend-1 2>&1 | grep -E 'Too many concurrent|Transient error|TOKEN_EXPIRED|syncBatchV2.*Account .* failed' | wc -l"
```
Expected: 0. If >0 → STOP, investigate.

### 2h — WAL warn / hard-stop thresholds for canary

Compute thresholds from recaptured anchors (do NOT copy from worked example in plan):

```text
expected_wal_per_canary ≈ batchSize * avg_row_size * WAL_amplification(2-3x)
                       ≈ 500 * ~600 B * 3 ≈ ~900 KB ~ 1 MB

warn_threshold     = max(5 MB, 5x expected) = 5 MB
hard_stop_threshold = max(50 MB, 50x expected) = 50 MB
```

Where `avg_row_size ≈ 600 B` is taken from preflight (`documents` heap 24.4 GB / 44M rows ≈ 554 B; `metricsRealtime` is one of the largest collections, expect close to average).

If baseline WAL noise (from a separate T=0 / T=+30min spot-check before canary) is already comparable to or larger than the expected canary signal — re-derive thresholds from baseline rate, NOT from this floor. See preflight memo line 87.

## Step 3 — Wait for an organic `syncBatchWorkerV2` success

Do NOT trigger off the wall clock. The trigger gate is an observed `syncBatchWorkerV2 kind: "success"` row in `_scheduled_functions`.

```text
1. Watch _scheduled_functions for next syncBatchWorkerV2 with kind: "success".
2. Note its completion timestamp T_success.
3. Trigger canary within ~13 minutes of T_success (next 15-min sync tick is at T_success + ~15min;
   stay before it to maximize cleanup-only V8 slot availability).
```

If T_success is `failed` instead → STOP. Investigate sync regression first.

## Step 4 — Operator trigger command

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex run internal.metrics.triggerMassCleanupV2 \
  '{"batchSize": 500, "timeBudgetMs": 10000, "restMs": 60000, "maxRuns": 1}'
```

Expected return:
```json
{ "runId": "<epoch-ms>-<12hex>", "status": "scheduled" }
```

Possible non-success returns:
- `{ "status": "disabled" }` → step 1 was not done or env not propagated. Re-check Step 1.
- `{ "status": "already-running", "runId": "<existing>" }` → a previous run is still active (isActive=true). Investigate `cleanupRunState` row before retrying.

Save the returned `runId` for observation.

Admin key generation per `memory/convex-deploy.md` (AES-128-GCM-SIV from `CONVEX_INSTANCE_NAME` + `CONVEX_INSTANCE_SECRET`). Key is ephemeral — generated per command, not committed, not pasted into shared logs.

## Step 5 — Observation checklist (run during ~5 min after trigger)

### 5a — Backend stdout

```bash
ssh root@178.172.235.49 "docker logs --since 5m convex-backend-1 2>&1 | grep -E 'cleanup-v2|Too many concurrent|Transient error|TOKEN_EXPIRED|syncBatchV2.*Account .* failed'"
```

Expected:
- 1 `[cleanup-v2]` start log line (runId, batchesRun_pre=0, cutoffUsed, batchSize=500)
- 1 `[cleanup-v2]` end log line (runId, deleted=<≤500>, durationMs, hasMore, decision=complete)
- 0 occurrences of `Too many concurrent` / `Transient error` / `TOKEN_EXPIRED` / `syncBatchV2.*failed`

Hard stop on ANY of the above-listed error patterns.

Env-toggle caveat: if Step 8a disables the env gate while a chain is mid-flight, stdout may show
`[cleanup-v2] runId=<id> skip reason=disabled_mid_chain` instead of an end/decision line. In that
path `_scheduled_functions.kind` can still be `"success"` because the action returns normally; the
source of truth is `cleanupRunState.state === "failed"` and `error === "disabled_mid_chain"`.

### 5b — `pg_wal` delta

```bash
ssh root@178.172.235.49 "docker exec convex-postgres-1 du -sb /var/lib/postgresql/data/pg_wal | awk '{print \$1}'"
```

Compute delta from `pg_wal_pre_canary` (Step 2c). Compare to thresholds from Step 2h.
- Delta ≤ warn → ✅ proceed.
- warn < delta ≤ hard_stop → ⚠️ flag for closure memo, but canary not aborted.
- Delta > hard_stop → 🛑 HARD STOP, investigate.

### 5c — `_scheduled_functions` for `manualMassCleanupV2`

Look up scheduled functions for `metrics.js:manualMassCleanupV2`:
- Expected: exactly 1 entry, `kind: "success"`.
- 0 entries → trigger did not fire (env gate? CLI error?). Investigate.
- ≥2 entries → chain self-scheduled despite `maxRuns=1`. HARD STOP, this is a code bug (Decision E guard violation).
- Any `kind: "failed"` → HARD STOP, investigate.

Failure semantics caveat: env-toggle rollback (`disabled_mid_chain`) is a semantic cleanup failure
recorded in `cleanupRunState`, not necessarily `_scheduled_functions.kind: "failed"`.

### 5d — V1 backlog must NOT grow

Look up `_scheduled_functions` failed count for `metrics.js:manualMassCleanup` (V1).
- Expected: identical to `failed_counters_pre['metrics.js:manualMassCleanup']` from Step 2f. NOT advanced.
- If advanced → investigate caller attribution. V2 code should not schedule the V1 udfPath, but the
  public V1 `triggerMassCleanup` still exists; an accidental/manual V1 caller during the window is
  not automatically a V2 regression. Treat as dirty for this canary window until attributed.

### 5e — `cleanupRunState` row trace

Read row by `runId` (returned in Step 4):

Expected sequence (across observation window):
- Initial: `state: "claimed"`, `isActive: true`, `batchesRun: 0`, `deletedCount: 0`, `cutoffUsed: <pre - 172_800_000>`.
- After step 3 (markRunningV2): `state: "running"`, `lastBatchAt: <set>`.
- After steps 4-5 (deleteRealtimeBatch + recordBatchProgressV2): `batchesRun: 1`, `deletedCount: > 0`.
- After step 6 (markCompletedV2): `state: "completed"`, `isActive: false`, `durationMs: > 0`, `oldestRemainingTimestamp: <set>` (or undefined if table emptied).

Final expected row:
```text
state: "completed"
isActive: false
batchesRun: 1
maxRuns: 1
deletedCount: > 0 (≤ 500)
cutoffUsed: <trigger time (Step 4) - 172_800_000>     # set inside triggerMassCleanupV2 handler at insert
oldestRemainingTimestamp: >= oldestRemainingTimestamp_pre (or undefined only if table emptied)
durationMs: > 0 (likely 100ms — 30s)
error: undefined
```

If row stuck in `claimed` or `running` past observation window → HARD STOP. Possible env-toggle race or chain failure mid-flight. Manually inspect `_scheduled_functions` for an in-flight `manualMassCleanupV2` retry.

Secondary advance gate for `oldestRemainingTimestamp`:
- `post > pre` → normal progress.
- `post == pre` → acceptable if Step 5f is green; likely a dense same-millisecond timestamp cluster.
- `post < pre` → HARD STOP. This suggests a newly inserted historical row or a measurement mismatch;
  active writes should use `now()` timestamps, not historical timestamps.

Do NOT require `oldestRemainingTimestamp_post > cutoffUsed` for this canary. With `maxRuns=1` and a
large backlog, the oldest remaining row is expected to stay older than `cutoffUsed`. `post > cutoffUsed`
is a full-backlog-drained signal, not a clean-canary signal.

### 5f — `metricsRealtime` eligible count delta

After completion, re-count `metricsRealtime WHERE timestamp < cutoffUsed`. Expected:
```text
metricsRealtime_eligible_post == metricsRealtime_eligible_pre - deletedCount
```

If delta != deletedCount → cleanup operated on wrong cutoff or had a race. Investigate.

### 5g — Core heartbeats still clean

Re-check Step 2e — sync / UZ / token heartbeats remain `completed`, no new errors. If any went `error` or stuck `running` during canary window → HARD STOP, suspected V8 slot competition.

### 5h — `adminAlerts.notify` not advanced

Failed counter for `adminAlerts.js:notify` must be unchanged from `failed_counters_pre`. Cleanup-V2 is not supposed to fire any operator alerts on success path.

## Step 6 — Decision (clean / dirty)

### Clean canary criteria (all must hold):
- ✅ `_scheduled_functions`: 1 `manualMassCleanupV2 success`, 0 unattributed V1 backlog growth, 0 V2 failed.
- ✅ `cleanupRunState` row: `state: "completed"`, `isActive: false`, `batchesRun === 1`, `deletedCount > 0`, `durationMs > 0`, `error === undefined`.
- ✅ `metricsRealtime` eligible count decreased by exactly `deletedCount`.
- ✅ Secondary advance gate: `oldestRemainingTimestamp_post >= oldestRemainingTimestamp_pre`
  (`==` acceptable when eligible-delta gate is green; `<` is HARD STOP).
- ✅ `pg_wal` delta within warn threshold from Step 2h.
- ✅ Backend stdout: 0 rollback patterns; 2 `[cleanup-v2]` log lines (start+end).
- ✅ Core heartbeats unchanged (sync/UZ/token).
- ✅ `adminAlerts.notify` failed counter unchanged.

If all hold → **clean**. Proceed to Step 7.

### Dirty / abort
If any of the above fails or any HARD STOP fires → **dirty**. Skip to Step 8 (rollback).

## Step 7 — Post-canary cleanup (clean path)

### 7a — Disable env flag immediately

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0
```

Verify with `npx convex env list | grep METRICS_REALTIME_CLEANUP_V2_ENABLED` → `0`.

Reasoning: kill switch returns to deploy-safe state until controlled-runs phase (Phase 5) is approved.

### 7b — Write closure memo

Create `memory/storage-cleanup-v2-canary-closure-2026-05-07.md` (see template section at end of this file). Required content:
- Trigger time, runId
- Pre/post anchor values for all six anchors (pg_wal, metricsRealtime total, eligible, oldestRemainingTimestamp, /version, disk)
- Final `cleanupRunState` row contents
- pg_wal delta + threshold comparison
- Failed counters delta (must be all zero)
- Decision: clean
- Note: env flag returned to 0
- Open follow-ups for Phase 5 (if any)

### 7c — Update plan tracker

Append entry to `MEMORY.md` index (auto-memory at `~/.claude/projects/.../memory/MEMORY.md`):
- `[storage-cleanup-v2-canary-closure-2026-05-07.md] — Phase 4 canary closed clean, env back to 0`

## Step 8 — Rollback (dirty path)

### 8a — Disable env flag immediately

Same command as Step 7a — `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`. Stops any further chain self-schedule on next invocation (env-toggle path closes chain via markFailedV2 with `error: "disabled_mid_chain"` per Decision D).

### 8b — If chain is mid-flight

If `cleanupRunState` row is in `running` state after Step 8a:
- The next scheduled `manualMassCleanupV2` invocation will read env=0 and call `markFailedV2({ error: "disabled_mid_chain" })`. Wait up to `restMs` (60s) for this to happen.
- Verify row transitions to `state: "failed", isActive: false, error: "disabled_mid_chain"`.

If row remains in `claimed`/`running` past `restMs + 30s` → manual intervention required. DO NOT manually patch the row from a script — escalate, this indicates the chain handler did not run as expected.

### 8c — Investigate

Per the specific failure mode:
- `pg_wal` runaway → check Postgres activity (`pg_stat_activity`, `pg_stat_progress_vacuum`), correlate with cleanup window.
- V8 concurrency error → check timing relative to sync/UZ/token ticks; possibly bump `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` is NOT the answer (1 slot headroom is the design).
- V1 backlog growth → first attribute the caller. Grep the V2 implementation for
  `internal.metrics.manualMassCleanup\b` (must be zero hits in the V2 block); any V2-block hit is a
  naming-collision bug. If growth came from the public V1 `triggerMassCleanup`, treat this canary as
  dirty/noisy but do not attribute it to V2 without evidence.
- Sync/UZ/token regression in same window → unrelated incident or competition; do NOT assume causation.

### 8d — Document

Write `memory/storage-cleanup-v2-canary-rollback-2026-05-07.md` with:
- All anchors from Step 2
- Specific failure mode observed
- Stdout excerpts
- `cleanupRunState` row final state
- Investigation conclusions
- Action items before next canary attempt

## Step 9 — After clean canary

Phase 5 (controlled cleanup runs with `maxRuns > 1`) is the next track but requires its own go. Do NOT proceed to Phase 5 in the same operator session as Phase 4 — leave a buffer to:
- Verify Phase 4 closure didn't introduce delayed effects (next 1-2 sync ticks clean, no delayed alerts).
- Decide Phase 5 sizing based on observed Phase 4 numbers.

## Hard stop priority order

If multiple alarms fire simultaneously:

1. **Sync/UZ/token regression** in same window → highest priority. Pause cleanup (Step 8a), investigate core crons first. Cleanup-only signals (own pg_wal delta, own self-schedule overshoot) are second priority.
2. V8 concurrency errors.
3. V1 backlog growth (data-poison risk).
4. `cleanupRunState` row stuck in non-terminal past expected window.
5. `pg_wal` delta beyond hard_stop threshold.

## Closure memo template (for Step 7b / 8d)

```markdown
# Storage Cleanup V2 — Canary Closure — <date>

Status: <clean | dirty-rollback>
Trigger time: <ISO>
runId: <returned by triggerMassCleanupV2>

## Anchors (recaptured immediately before trigger — Step 2)

| Anchor | Pre | Post | Delta | Threshold | Verdict |
|---|---|---|---|---|---|
| /version | 200 | <code> | — | 200 | <✅/🛑> |
| disk free | <pre>G | <post>G | <delta>G | none drop ≥20G | <✅/🛑> |
| pg_wal | <pre> bytes | <post> bytes | <delta> bytes | warn=<warn>, hard=<hard> | <✅/⚠️/🛑> |
| metricsRealtime total | <pre> | <post> | <delta> | == eligible_pre - deletedCount | <✅/🛑> |
| metricsRealtime eligible | <pre> | <post> | <delta> | == -deletedCount | <✅/🛑> |
| oldestRemainingTimestamp | <pre ISO> | <post ISO> | <advance> | post >= pre; `< pre` hard-stop | <✅/🛑> |

## Core heartbeats (Step 2e and re-check post-canary)

| Heartbeat | Pre | Post | Verdict |
|---|---|---|---|
| syncDispatch | <ISO completed err=-> | <ISO completed err=-> | <✅/🛑> |
| uzBudgetDispatch | <ISO> | <ISO> | <✅/🛑> |
| tokenRefreshDispatch | <ISO> | <ISO> | <✅/🛑> |

## `_scheduled_functions` failed counters (Step 2f / 5d)

| UDF | Pre | Post | Delta | Verdict |
|---|---|---|---|---|
| auth.js:tokenRefreshOneV2 | <n> | <n> | 0 | <✅/🛑> |
| ruleEngine.js:uzBudgetBatchWorkerV2 | <n> | <n> | 0 | <✅/🛑> |
| syncMetrics.js:syncBatchWorkerV2 | <n> | <n> | 0 | <✅/🛑> |
| metrics.js:manualMassCleanup | <n> | <n> | 0 | <✅/🛑> |
| metrics.js:manualMassCleanupV2 | 0 | 0 | 0 | <✅/🛑> |
| adminAlerts.js:notify | <n> | <n> | 0 | <✅/🛑> |

## `cleanupRunState` final row

```text
runId: <runId>
state: <claimed|running|completed|failed>
isActive: <true|false>
batchesRun: <n>
maxRuns: 1
deletedCount: <n>
cutoffUsed: <epoch_ms> (<ISO>)
oldestRemainingTimestamp: <epoch_ms or undefined>
durationMs: <n>
error: <undefined or string>
```

## Backend stdout summary

- `[cleanup-v2]` log lines: start=<count>, end=<count> (expected 1+1 for clean)
- Rollback patterns: 0 expected (Too many concurrent, Transient error, TOKEN_EXPIRED, syncBatchV2 failed)

## Decision

<clean | dirty>

## Post-canary state

- METRICS_REALTIME_CLEANUP_V2_ENABLED: 0 (returned to deploy-safe)
- `cleanup-old-realtime-metrics` cron: still commented (Phase 6 not started)
- Phase 5 readiness: <ready / blocked: reason>

## Open follow-ups

- ...
```

## NOT in this runbook (separate runbooks)

- Phase 5 controlled runs (`maxRuns > 1`) — separate runbook before that go.
- Phase 6 cron restoration — separate runbook before that go.
- Phase 7 metricsDaily cleanup — different table, different runbook.
- Phase 8 vkApiLimits cleanup — different table, different runbook.
- Phase 9 PostgreSQL maintenance (`VACUUM ANALYZE`) — own runbook with maintenance window definition.

## Re-verification before first use

This runbook was written against the **design contract**, not against actually-deployed code. Before first canary, re-verify:

- [ ] Function `internal.metrics.triggerMassCleanupV2` exists in deployed code with args `{ batchSize, timeBudgetMs, restMs, maxRuns }`.
- [ ] Function returns `{ runId, status }` (or `{ status }` for refusals).
- [ ] Schema table `cleanupRunState` exists with fields and indexes per Decision A.
- [ ] Env var name is exactly `METRICS_REALTIME_CLEANUP_V2_ENABLED` (typo-resistance).
- [ ] Heartbeat / log prefix is exactly `[cleanup-v2]` (used in stdout grep).
- [ ] `gen-admin-key.cjs` exists at repo root and is runnable via `node gen-admin-key.cjs` (executable bit not required — script is invoked via node loader, not directly).

If any of the above mismatches deployed code → update this runbook BEFORE invoking trigger.
