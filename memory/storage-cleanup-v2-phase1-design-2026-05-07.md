# Storage Cleanup V2 — Phase 1 Implementation Design — 2026-05-07

Status: design draft, read-only audit complete. No code edits, no env changes, no deploy.

Related:
- Plan: `docs/superpowers/plans/2026-05-07-storage-cleanup-v2.md` (commit `9f6786b`, hardened runbook)
- Preflight baseline: `memory/storage-cleanup-v2-preflight-2026-05-07.md` (commit `ae2506b`)

Branch HEAD at audit time: `ae2506b` (matches origin).

## Scope of read-only audit

Sources of truth read directly (NOT `_generated/api.ts` — that file is generated and may be stale):

- `convex/metrics.ts` — full file
- `convex/schema.ts` — full file
- `convex/syncMetrics.ts` — heartbeat helpers (`getCronHeartbeat`, `upsertCronHeartbeat`) + env-gate idiom (`SYNC_ESCALATION_ALERTS_ENABLED`)
- `convex/crons.ts` — top section + `cleanup-old-realtime-metrics` block
- `convex/logCleanup.ts` — full file
- `convex/metrics.test.ts` — full file (test pattern)

Codegen (`convex codegen`) was NOT run; will be run only if generated types become stale or required by tests.

## Findings from audit

### Existing infrastructure that V2 will reuse

- **`deleteRealtimeBatch`** (`convex/metrics.ts:378-391`) — `internalMutation`, batch-deletes `metricsRealtime` by `by_timestamp` index, retention `RETENTION_DAYS = 2` already matches plan's `cutoff = now - 172_800_000`. Returns `{ deleted, hasMore }`. **Ready-to-use building block — V2 calls this, does not duplicate it.**
- **`cronHeartbeats` table** (`convex/schema.ts:815-822`) — `{ name, startedAt, finishedAt, status (running|completed|failed), error, lastAlertSentAt }`, indexed by name.
- **`getCronHeartbeat` / `upsertCronHeartbeat`** (`convex/syncMetrics.ts:767-881`) — query/mutation helpers.
- **Env-gate idiom** (`convex/syncMetrics.ts:803-805`):
  ```ts
  function isSyncEscalationAlertsEnabled(): boolean {
    return process.env.SYNC_ESCALATION_ALERTS_ENABLED === "1";
  }
  ```
  Read inside handler (not module-level const) so `convex env set` updates take effect without redeploy. V2 will mirror this exactly.
- **`schemaValidation: false`** (`convex/schema.ts:1112`) — adding new optional fields or new tables does not break existing rows.
- **Test pattern** (`convex/metrics.test.ts`) — `convexTest(schema)`, `t.mutation(internal.metrics.deleteRealtimeBatch, {...})`, `t.run(async (ctx) => ctx.db.insert(...))` for fixture data. Already covers `deleteRealtimeBatch` cutoff + `hasMore` + empty case.

### V1 state that V2 must preserve / avoid

- **`manualMassCleanup`** (`convex/metrics.ts:411-419`) is `internalAction`, body is `return;` (no-op). The drain-mode comment instructs to leave it no-op until V1 backlog is drained. V2 MUST NOT touch this body.
- **`scheduleMassCleanup`** (`convex/metrics.ts:452-457`) is `internalMutation` that schedules V1 no-op. Untouched in Phase 1.
- **`cleanupOldRealtimeMetrics`** (`convex/metrics.ts:424-449`) reads heartbeat name `"cleanup-realtime-metrics"` and delegates to V1 chain. **Cron is commented out, so this code path is dead.** V2 will NOT modify this function in Phase 1; switching it to V2 is Phase 6 (cron restore).
- **`triggerMassCleanup`** (`convex/metrics.ts:403-409`) is public `mutation` (frontend-callable). V2 entrypoint must NOT inherit that visibility — see Decision B.
- **Stale heartbeat row** `cleanup-realtime-metrics: running since 2026-05-04T18:00:00.793Z` (from preflight) — V2 must not write under this name; see Decision C.

## Decision A — Persistent run state: separate `cleanupRunState` table (NOT extending `cronHeartbeats`)

### Rationale

- `cronHeartbeats` is semantically per-cron-tick status. A cleanup run chain spans multiple invocations (canary trigger → action chain across `restMs` waits) — that is a job-state singleton, not a cron tick.
- `cronHeartbeats.status` union is `{running, completed, failed}`. The plan requires `{claimed, running, completed, failed}` for the non-terminal-blocks-new-claim guard. Extending the existing union would affect all current consumers (sync, UZ, token refresh).
- Cleanup-specific observability fields (`deletedCount`, `batchesRun`, `cutoffUsed`, `oldestRemainingTimestamp`, `durationMs`, `maxRuns`, `isActive`) belong in the run record, not on a multi-consumer cron-status table.
- New-table cost is acceptable: at canary cadence we expect O(1)-O(10) rows/day; eventual retention can be addressed in a future phase.

### Schema diff (added at end of `defineSchema` in `convex/schema.ts`)

```ts
// Persistent run state for storage cleanup V2 chains.
// One row per cleanup run; terminal rows kept for audit until a future
// retention phase. Source of truth for canary/run idempotency.
cleanupRunState: defineTable({
  cleanupName: v.string(),                              // e.g. "metrics-realtime-v2"
  runId: v.string(),                                    // unique per claim, see Decision F
  state: v.union(
    v.literal("claimed"),
    v.literal("running"),
    v.literal("completed"),
    v.literal("failed"),
  ),
  // Atomic claim guard. true while state in {claimed, running};
  // patched to false in the SAME mutation that transitions state to
  // {completed, failed}. Indexed for O(1) non-terminal lookup —
  // avoids first()-on-by_cleanupName matching a stale terminal row.
  isActive: v.boolean(),
  startedAt: v.number(),
  lastBatchAt: v.optional(v.number()),
  // batchesRun is the SOLE counter against maxRuns. runNumber is removed
  // to avoid two-counter drift and contradiction with test expectations.
  batchesRun: v.number(),                               // 0 on claim; +=1 per committed chunk
  maxRuns: v.number(),
  // Observability (V2 Conventions / Observability fields).
  // cutoffUsed is set at claim and IMMUTABLE for the run — passed to
  // deleteRealtimeBatch via its new optional cutoffMs arg, never
  // recomputed inside the chain.
  cutoffUsed: v.number(),                               // start; immutable for the run
  deletedCount: v.number(),                             // 0 on claim; summed across batches
  oldestRemainingTimestamp: v.optional(v.number()),     // post; sampled AFTER last batch commit
  durationMs: v.optional(v.number()),                   // post
  error: v.optional(v.string()),                        // post; "disabled_mid_chain" on env-toggle, exception message on caught throw, undefined on clean completion
  // Canary parameters carried on row (immutable after claim).
  batchSize: v.number(),
  timeBudgetMs: v.number(),                             // stored for future Phase 5 tuning; NOT enforced in Phase 1
  restMs: v.number(),
})
  .index("by_cleanupName_isActive", ["cleanupName", "isActive"])
  .index("by_runId", ["runId"]),
```

Indexes:
- `by_cleanupName_isActive` — for non-terminal claim guard. Single O(1) lookup: `.eq("cleanupName", X).eq("isActive", true).first()` returns the active row (claimed/running) if any, else null. Avoids `first()`-on-`by_cleanupName` matching a stale terminal row and giving a false block.
- `by_runId` — chain handlers (`manualMassCleanupV2`, all helpers) look up state by runId.

## Decision B — Function signatures (added to `convex/metrics.ts`)

All V2 names suffixed with `V2`. V1 names left untouched.

```ts
// Operator/admin trigger. internalMutation = no frontend / dashboard run-form;
// invoke via `npx convex run` with admin key (per memory/convex-deploy.md).
export const triggerMassCleanupV2 = internalMutation({
  args: {
    batchSize: v.number(),
    timeBudgetMs: v.number(),
    restMs: v.number(),
    maxRuns: v.number(),
  },
  handler: async (ctx, args) => {
    // 1. Env gate. If !METRICS_REALTIME_CLEANUP_V2_ENABLED → return
    //    { status: "disabled" }.
    // 2. Refuse if existing cleanupRunState row for "metrics-realtime-v2"
    //    has isActive === true (single O(1) lookup via by_cleanupName_isActive).
    //    On hit → return { status: "already-running", runId: hit.runId }.
    // 3. Insert row {
    //      cleanupName: "metrics-realtime-v2",
    //      runId, state: "claimed", isActive: true,
    //      startedAt: now,
    //      batchesRun: 0, maxRuns: args.maxRuns,
    //      cutoffUsed: now - 172_800_000,            // immutable for this run
    //      deletedCount: 0,
    //      batchSize: args.batchSize,
    //      timeBudgetMs: args.timeBudgetMs,          // stored, not enforced in Phase 1
    //      restMs: args.restMs,
    //    }.
    // 4. ctx.scheduler.runAfter(0, internal.metrics.manualMassCleanupV2, { runId }).
    // 5. Return { runId, status: "scheduled" }.
  },
});

// Worker action — does ONE chunk per invocation, never sleeps for restMs.
export const manualMassCleanupV2 = internalAction({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    // 1. Env gate (re-read inside handler, in case toggled mid-chain).
    //    If disabled: ctx.runMutation(internal.metrics.markFailedV2,
    //      { runId, error: "disabled_mid_chain" }) and return.
    //    The chain terminates cleanly — row goes to {state: "failed",
    //    isActive: false}. Future canary can claim immediately.
    // 2. const state = await ctx.runQuery(internal.metrics.getCleanupRunStateV2,
    //      { runId }).  Early return if missing or state in {"completed","failed"}.
    // 3. ctx.runMutation(internal.metrics.markRunningV2, { runId, lastBatchAt: now }).
    // 4. const result = await ctx.runMutation(internal.metrics.deleteRealtimeBatch,
    //      { batchSize: state.batchSize, cutoffMs: state.cutoffUsed }).
    //    cutoffMs is the run-immutable cutoff captured at claim time —
    //    NOT recomputed per chunk.
    // 5. const updated = await ctx.runMutation(
    //      internal.metrics.recordBatchProgressV2,
    //      { runId, deleted: result.deleted, hasMore: result.hasMore }).
    //    recordBatchProgressV2 RETURNS post-increment counters
    //    ({ batchesRun, deletedCount, lastBatchAt, hasMore }) so the
    //    schedule/complete decision below uses fresh values, NOT stale
    //    pre-increment state.batchesRun. Without this, a race would
    //    accidentally schedule one extra chunk past maxRuns.
    // 6. If updated.batchesRun < state.maxRuns AND result.hasMore:
    //      ctx.runMutation(internal.metrics.scheduleNextChunkV2, { runId }).
    //    Else:
    //      ctx.runMutation(internal.metrics.markCompletedV2, { runId }).
    // 7. Return — V8 slot released. The next chunk runs after restMs via scheduler.
    //
    // Top-level try/catch: any thrown error → markFailedV2({ runId,
    // error: e.message }). Phase 1 commit picks swallow-vs-rethrow
    // explicitly during code review.
    //
    // console.log per invocation:
    //   start: [cleanup-v2] runId=... batchesRun_pre=... cutoffUsed=... batchSize=...
    //   end:   [cleanup-v2] runId=... deleted=... durationMs=... hasMore=... decision=schedule|complete|failed
  },
});

// State helper queries/mutations (all internal, all small, all auditable):

export const getCleanupRunStateV2 = internalQuery({
  args: { runId: v.string() },
  // Lookup by by_runId index. Returns the row or null.
});

export const markRunningV2 = internalMutation({
  args: { runId: v.string(), lastBatchAt: v.number() },
  // Patches state: "running", lastBatchAt. isActive remains true.
});

export const recordBatchProgressV2 = internalMutation({
  args: { runId: v.string(), deleted: v.number(), hasMore: v.boolean() },
  // Patches: batchesRun += 1, deletedCount += deleted, lastBatchAt = now.
  // RETURNS: { batchesRun, deletedCount, lastBatchAt, hasMore } —
  // post-increment values. Caller (manualMassCleanupV2) uses these for
  // the schedule/complete decision so the guard sees fresh counters,
  // not pre-mutation state.
});

export const scheduleNextChunkV2 = internalMutation({
  args: { runId: v.string() },
  // Reads restMs from row, calls
  //   ctx.scheduler.runAfter(restMs, internal.metrics.manualMassCleanupV2, { runId }).
});

export const markCompletedV2 = internalMutation({
  args: { runId: v.string() },
  // Atomically patches:
  //   state: "completed", isActive: false,
  //   durationMs: now - startedAt,
  //   oldestRemainingTimestamp: sampled NOW via by_timestamp index
  //     (smallest timestamp present in metricsRealtime, or undefined if
  //     the table is empty). Sampled here — AFTER last batch commit —
  //     to satisfy the post-commit measurement-point invariant.
});

export const markFailedV2 = internalMutation({
  args: { runId: v.string(), error: v.string() },
  // Atomically patches:
  //   state: "failed", isActive: false,
  //   error: args.error, durationMs: now - startedAt.
  // Called from: manualMassCleanupV2 top-level try/catch (caught exceptions),
  // and from manualMassCleanupV2 env-gate path with error="disabled_mid_chain".
  // "failed" state is operator-distinguishable via the error field; it is
  // not necessarily a code-bug failure (env-toggle is a graceful exit).
});

// Defensive guards for state-mutating helpers above. Two classes,
// different semantics:
//
// Class A — chain workers (markRunningV2, recordBatchProgressV2,
// scheduleNextChunkV2):
//   MUST early-return no-op (no patch, no scheduler call) if the row is
//   missing OR has isActive === false. They operate ONLY on active rows.
//   Running them on a terminal or missing row would silently corrupt
//   observability counters, reactivate a closed run, or schedule a chunk
//   for a run that should not exist.
//
// Class B — terminal transitions (markCompletedV2, markFailedV2):
//   The very purpose of these helpers is to flip isActive from true → false
//   atomically with the state transition. Behavior:
//     - row missing             → no-op (defensive against caller bug; do not crash).
//     - row exists, isActive=true  → perform the transition (main path).
//     - row exists, isActive=false → no-op (idempotency — terminal state
//                                    already set; second call is harmless).
//
// All five helpers are chain-internal; only manualMassCleanupV2 (or
// triggerMassCleanupV2 for the initial insert) are expected callers.
```

Notes:
- `triggerMassCleanupV2` is `internalMutation`, NOT `mutation`. Frontend cannot invoke. Operator uses `npx convex run internal.metrics.triggerMassCleanupV2 '{...}'` with admin key per Phase 4 of plan.
- `manualMassCleanupV2` does NOT sleep for `restMs`. It calls `scheduleNextChunkV2` which does `ctx.scheduler.runAfter(restMs, internal.metrics.manualMassCleanupV2, { runId })` and returns. V8 slot is released between chunks.
- `markCompletedV2` samples `oldestRemainingTimestamp` after the final delete commits, satisfying observability semantics in plan.
- Try/catch in `manualMassCleanupV2` calls `markFailedV2` and does NOT re-schedule — chain stops on failure.

## Decision C — Heartbeat naming and V1 isolation

- V2 source of truth is `cleanupRunState` row, NOT `cronHeartbeats`.
- Phase 1 does NOT write to `cronHeartbeats` at all from V2 path. The V1 stale row `cleanup-realtime-metrics` from `2026-05-04T18:00:00.793Z` is left untouched (it does not block V2 because V2 never reads it).
- If admin dashboards or health checks need a V2 heartbeat surface in `cronHeartbeats` later, they can be added when `cleanup-old-realtime-metrics` cron is restored (Phase 6) under the V2-specific name `cleanup-realtime-metrics-v2`. Phase 1 does not need this.

This is a slight simplification vs the runbook's "heartbeat row OR dedicated table" deferred decision: Phase 1 picks "dedicated table only", and `cronHeartbeats` participation is deferred to Phase 6.

## Decision D — Env gate

```ts
function isMetricsRealtimeCleanupV2Enabled(): boolean {
  return process.env.METRICS_REALTIME_CLEANUP_V2_ENABLED === "1";
}
```

- Default unset (treated as off).
- Read inside every V2 handler (`triggerMassCleanupV2`, `manualMassCleanupV2`), NOT module-level const.
- If unset / not `"1"`: handler logs `[cleanup-v2] skip reason=disabled` and returns no-op.
- If toggled mid-chain to `0`: next `manualMassCleanupV2` invocation reads env, calls `markFailedV2({ runId, error: "disabled_mid_chain" })`, and exits without scheduling. Row transitions atomically to `state: "failed"`, `isActive: false`. No manual cleanup needed; future canary can claim immediately. The "failed" state is operator-distinguishable via the `error` field — env-toggle is a graceful exit, not a code-bug failure.

Per-table flag, no global flag (matches plan Phase 7/8 future flags `METRICS_DAILY_CLEANUP_V2_ENABLED`, `VK_API_LIMITS_CLEANUP_V2_ENABLED`).

## Decision E — Chunking and V8 slot discipline

Per V2 Conventions (plan):

```text
One invocation:
  1. claim/update persistent run state
  2. delete up to batchSize eligible rows
  3. record observability fields
  4. if batchesRun < maxRuns and hasMore, schedule next invocation after restMs
  5. return; do not hold a V8 slot during restMs
```

Concrete mapping:

- **Step 1** → `markRunningV2` mutation (1 doc patch on cleanupRunState row).
- **Step 2** → `deleteRealtimeBatch` mutation, called with
  `{ batchSize: state.batchSize, cutoffMs: state.cutoffUsed }`.
  Existing function reused; `cutoffMs` is a backward-compatible optional
  arg added in this Phase (see Files modified table).
  Run-immutable cutoff invariant: every chunk uses the SAME `cutoffMs`
  taken from the row, never recomputed `Date.now() - 2d` per chunk.
- **Step 3** → `recordBatchProgressV2` mutation. Patches:
  `batchesRun += 1`, `deletedCount += result.deleted`, `lastBatchAt = now`.
  RETURNS the post-patch counters — `{ batchesRun, deletedCount,
  lastBatchAt, hasMore }` — so step 4 evaluates against fresh values.
- **Step 4** → guard uses **returned** `updated.batchesRun` from step 3,
  NOT pre-mutation `state.batchesRun`. Logic:
  `if (updated.batchesRun < state.maxRuns && result.hasMore) →
   scheduleNextChunkV2; else → markCompletedV2`. This prevents an
  accidental extra chunk from a stale-read race between step 3's
  increment and step 4's decision.
- **Step 5** → action returns; V8 slot is freed for the duration of `restMs`.

V8 slot math under current env:
```text
token refresh 6 + UZ 6 + sync 2 + cleanup 1 = 15/16 (1 slot headroom)
```

`timeBudgetMs` is **stored on the row but NOT enforced** in Phase 1
implementation — single batch per invocation, `batchSize` is the only
effective limit. It is carried forward so future Phase 5 controlled-mode
tuning can reuse the same row schema without migration. Operators MUST NOT
treat `timeBudgetMs` as an actionable limit during Phase 4 canary; it is a
memo field only.

## Decision F — `runId` format

Choice: `${Date.now()}-${randomHex(6)}`.

Rationale:
- ULID would require a small dependency or hand-rolled implementation; not worth the surface.
- Using Convex `_id` of the inserted `cleanupRunState` row would work, but `runId` needs to exist BEFORE insert (it's a field on the row). Generating it on the application side is simpler.
- `Date.now()` + 6 hex bytes of randomness collides only on simultaneous insert in the same ms with same random — for our cadence (≤1 active run at a time), collision probability is negligible.

Fallback: if a future need arises (e.g. cross-table run grouping), switch to ULID — not Phase 1 scope.

## Tests (Phase 2)

Location: `convex/metrics.test.ts` (extend existing file, do NOT create a new file). Pattern: `convexTest(schema)`, `t.mutation(internal.metrics.…)`, `t.run(async (ctx) => ctx.db.insert(...))` for fixtures.

Invariant tests:

1. **V1 is no-op.** `internal.metrics.manualMassCleanup({ runNumber: 1 })` does not call scheduler; pre-existing fixture rows in `metricsRealtime` (older than cutoff) remain. (Smoke regression for the drain-mode no-op.)
2. **V2 schedules V2, not V1.** After `triggerMassCleanupV2`, scheduled functions must reference only `manualMassCleanupV2`; zero hits for `internal.metrics.manualMassCleanup`. Equivalent to plan's Phase 2 grep guard, at the test level.
3. **Cutoff retention via `cutoffMs`.** Insert one fixture row at `now - 5d` and one at `now - 1h`. After one V2 run with `batchSize: 500, maxRuns: 1`, the 5d row is deleted, the 1h row survives. Asserts `deleteRealtimeBatch(cutoffMs)` honors the run-immutable cutoff passed by V2.
4. **`deleteRealtimeBatch` backward-compatibility.** Direct call without `cutoffMs` deletes the same rows as before this Phase (built-in `Date.now() - 2d` cutoff). Asserts the V1 callers in existing tests stay green.
5. **Env gate off at trigger.** `process.env.METRICS_REALTIME_CLEANUP_V2_ENABLED` unset (or `"0"`): `triggerMassCleanupV2` returns `{ status: "disabled" }`, no `cleanupRunState` row inserted, no scheduler call.
6. **Non-terminal claim refusal via `isActive`.** Manually insert a `cleanupRunState` row with `cleanupName: "metrics-realtime-v2"`, `state: "running"`, `isActive: true`. Calling `triggerMassCleanupV2` returns `{ status: "already-running" }`. No new row inserted. Then patch the inserted row to `isActive: false` and confirm a fresh trigger succeeds — proves the guard tracks `isActive`, not just any row presence.
7. **`maxRuns` enforcement via `batchesRun`.** Fixture: 2000 old rows; `batchSize: 500, maxRuns: 1`. After chain settles: exactly one batch ran (500 deleted), final row has `state: "completed"`, `isActive: false`, `batchesRun === 1`, 1500 old rows remain.
8. **State transitions on success.** Trace: `claimed` → `running` → `completed`. Final row has `cutoffUsed` set (immutable), `deletedCount > 0`, `batchesRun ≥ 1`, `oldestRemainingTimestamp` set (or undefined if table empty), `durationMs > 0`, `error` undefined, `isActive === false`.
9. **Env-toggle mid-chain closes the row.** No prod-code seam — uses test-environment `process.env` mutation only, with save/restore hygiene:

   ```ts
   const prev = process.env.METRICS_REALTIME_CLEANUP_V2_ENABLED;
   try {
     // Manually insert cleanupRunState row {
     //   runId, cleanupName: "metrics-realtime-v2",
     //   state: "running", isActive: true,
     //   batchesRun: 0, maxRuns: 5,
     //   cutoffUsed: now - 172_800_000, deletedCount: 0,
     //   batchSize: 500, timeBudgetMs: 10_000, restMs: 60_000,
     //   startedAt: now - 1_000,
     // }.
     process.env.METRICS_REALTIME_CLEANUP_V2_ENABLED = "0";
     await t.action(internal.metrics.manualMassCleanupV2, { runId });
     // Assert row patched to:
     //   state: "failed", isActive: false, error: "disabled_mid_chain",
     //   durationMs > 0.
     // Assert: no further scheduled manualMassCleanupV2 for this runId.
   } finally {
     process.env.METRICS_REALTIME_CLEANUP_V2_ENABLED = prev;
   }
   ```

   Test hygiene: every test that mutates `process.env.METRICS_REALTIME_CLEANUP_V2_ENABLED` MUST save the previous value and restore it in `finally` (or `afterEach`). Otherwise leakage poisons the next test in the file. This is test-scope mutation only — NOT a prod-code env-injection seam.

Skip for Phase 1 (defer to Phase 5 if useful):
- Multi-batch chain (`maxRuns > 1`) end-to-end.
- restMs-induced ordering with concurrent fixture inserts.
- Generic exception path inside `manualMassCleanupV2` — covered operationally by Phase 4 canary; would require a prod-code injection seam to unit-test cleanly, which is rejected by design (env-toggle path IS covered by test #9 above without any prod-code seam).

## Risk register (carried from preflight)

| Risk | Source | Mitigation in Phase 1 |
|---|---|---|
| V1 stale heartbeat row blocks name reuse | preflight, line 154 | V2 uses `cleanupRunState` only; never reads/writes `cronHeartbeats` for cleanup. |
| pg_wal background rate uncalibrated | preflight, lines 87-88 | Out of code scope. Phase 4 canary requires fresh tight-window `pg_wal` measurement before trigger. |
| `indexes` table bloat 19:1 | preflight, line 101 | Out of code scope. Raises Phase 9 priority for `VACUUM (ANALYZE) indexes`. Does not block canary. |
| Worked-example floor (~300 KB) too small | preflight, line 196 | Documented: expect ~1 MB WAL on 500-row canary; canary observation thresholds use fresh recapture, not floor. |
| `triggerMassCleanup` is public `mutation`, V2 must not inherit | metrics.ts:403 audit | `triggerMassCleanupV2` is `internalMutation`. Operator command in Phase 4 of plan. |
| Self-scheduling chain has no kill switch | plan #3 | `METRICS_REALTIME_CLEANUP_V2_ENABLED=0` halts next chunk. Each `manualMassCleanupV2` invocation re-reads env. |

## Deploy-safety contract for the Phase 1 implementation commit

- `METRICS_REALTIME_CLEANUP_V2_ENABLED` not set in any env config; default-off enforced in code.
- `cleanup-old-realtime-metrics` cron remains commented in `convex/crons.ts` (NOT modified by Phase 1).
- `manualMassCleanup` V1 body remains `return;` (no-op).
- `scheduleMassCleanup` V1 body unchanged.
- `cleanupOldRealtimeMetrics` body unchanged (still delegates to V1 chain).
- `triggerMassCleanup` public mutation unchanged (still public, still schedules V1 no-op).
- No `npx convex run` smoke (even on dev) within the Phase 1 commit window.
- No `npx convex deploy` triggered by the Phase 1 commit; deploy is a separate Phase 3 go.
- After commit and BEFORE deploy: `npx tsc --noEmit -p convex/tsconfig.json` clean; Phase 2 grep guards pass.

## Files modified by Phase 1 commit

| File | Change |
|---|---|
| `convex/schema.ts` | Add `cleanupRunState` table (Decision A). |
| `convex/metrics.ts` | Add 8 new exports per Decision B. V1 *bodies* of `manualMassCleanup` / `scheduleMassCleanup` / `triggerMassCleanup` / `cleanupOldRealtimeMetrics` unchanged. **One V1-adjacent signature widening** — see below. |
| `convex/metrics.test.ts` | Add tests per Tests section. Existing tests unchanged. |

### V1-adjacent signature widening — `deleteRealtimeBatch`

`deleteRealtimeBatch` is a shared building block. V2 must pass the
run-immutable `cutoffUsed` rather than letting the function recompute
`Date.now() - 2d` per call (run-immutable cutoff invariant, Decision E
step 2). The change:

```ts
// Before (current — convex/metrics.ts:378-391):
export const deleteRealtimeBatch = internalMutation({
  args: { batchSize: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    // ... rest of body
  },
});

// After (Phase 1):
export const deleteRealtimeBatch = internalMutation({
  args: {
    batchSize: v.number(),
    cutoffMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cutoff = args.cutoffMs ?? Date.now() - RETENTION_DAYS * 86_400_000;
    // ... rest of body unchanged
  },
});
```

**Backward-compatibility** — existing callers (e.g. existing tests in
`convex/metrics.test.ts:307-405` which call `deleteRealtimeBatch({
batchSize: 500 })` and `{ batchSize: 2 }` without `cutoffMs`) get
identical behavior to today (computed `Date.now() - 2d`). V2 explicitly
passes `cutoffMs: state.cutoffUsed` to satisfy the run-immutable cutoff
invariant.

Phase 1 deploy-safety contract is amended accordingly:

- V1 function *bodies* — unchanged.
- V1 *signatures* — touched only in this one backward-compatible widening.
- All other V1 surfaces — unchanged.

Files NOT touched by Phase 1: `convex/crons.ts`, `convex/logCleanup.ts`, `convex/syncMetrics.ts`, env configs, anything outside `convex/`.

`_generated/api.ts` will refresh during normal Convex codegen on next `convex dev` / `convex deploy`. Not modified manually as part of this commit.

## Resolved review decisions

1. **`runId` format.** ACCEPTED — `${Date.now()}-${randomHex(6)}` (Decision F).
2. **Failure-path test seam.** REJECTED — no `_TEST_FAIL_INJECT_*` env-injection in prod code. Generic exception path inside `manualMassCleanupV2` is covered operationally by Phase 4 canary, NOT by Phase 2 unit tests. Env-toggle path IS covered by test #9 via test-scope `process.env` mutation with `finally`-restore — that is a test-environment write, not a prod-code seam.
3. **Carrying parameters on row.** ACCEPTED — `batchSize`, `timeBudgetMs`, `restMs` live on the `cleanupRunState` row (immutable after claim). Chain handlers read from row, do not re-pass via args.
4. **Per-chunk console.log.** ACCEPTED — 1 line at chunk start (`runId`, `batchesRun_pre`, `cutoffUsed`, `batchSize`), 1 line at chunk end (`runId`, `deleted`, `durationMs`, `hasMore`, `decision=schedule|complete|failed`). See Decision B handler note.
5. **State row retention.** OUT OF PHASE 1 SCOPE — at canary cadence ~1-10 rows/day no immediate concern; revisit after V2 has run for a month, or roll into a future cleanup phase. NO action in Phase 1 commit.

## Next steps

1. Review this design memo (no commit yet).
2. Commit this design memo doc-only after review go.
3. Separate go on Phase 1 code edits per Files-modified table above.
4. Phase 2 local verification (`npx tsc`, tests, grep guards) BEFORE commit of code.
5. Phase 3 deploy is its own go.
