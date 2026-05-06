# Design: `vkApiLimits.recordRateLimit` bounded restore (D2)

Date: 2026-05-06
Branch context: `emergency/drain-scheduled-jobs` (Phase 8 closed clean; B1 deployed/being watched separately)
Related: `docs/2026-05-05-convex-scheduled-jobs-incident-report.md`; `docs/2026-05-05-convex-drain-reenable-plan.md`; `docs/2026-05-06-merge-cleanup-scope.md`
Status: **design proposal only -- no code, no schema change, no env change, no deploy as part of this document**

## Scope of this proposal

This document is strictly a design proposal for restoring VK API rate-limit observability without recreating the scheduled-jobs amplification path that contributed to the 2026-05-04/05 incident.

It does not authorize:

1. Re-enabling the four `vkApi.ts` producers guarded by `if (false && hasData)`.
2. Restoring the old `recordRateLimit` body.
3. Re-enabling the `vk-throttling-probe` cron.
4. Adding schema, cron, env, or deploy changes.
5. Running any production probe or manual trigger.

The goal is to define a bounded D2 path so the next implementation session can make a small, reversible change instead of "just uncommenting" the old telemetry.

## Problem statement

`vkApiLimits.recordRateLimit` was built to record VK Ads `X-RateLimit-*` response headers and `429` responses into the `vkApiLimits` table. That observability is useful before scaling account sync load, but the original producer shape was unsafe:

```ts
void ctx.scheduler.runAfter(0, internal.vkApiLimits.recordRateLimit, {
  accountId: args.accountId,
  endpoint: info.endpoint,
  statusCode: info.statusCode,
  ...info.rateLimits,
});
```

During the incident, `_scheduled_jobs` history showed `248,692` `vkApiLimits.js:recordRateLimit` pending-version rows in the initial backlog snapshot (`docs/2026-05-05-convex-scheduled-jobs-incident-report.md`, section "Основная pending-очередь по этому первичному подсчету"). Even after the later latest-state correction showed those large counts were historical document versions rather than current live pending jobs, the RCA conclusion did not change: `recordRateLimit` was the largest scheduled-job producer and must not be restored in the old form.

Current drain-mode state:

- `convex/vkApiLimits.ts`: `recordRateLimit` is an `internalMutation` with the original args, but the handler is a no-op and returns `null`.
- `convex/vkApi.ts`: four producers are guarded by `if (false && hasData)`.
- `convex/crons.ts`: `vk-throttling-probe` cron is commented out.
- `convex/vkApiLimits.ts`: `probeThrottling` action body already uses direct `ctx.runMutation(internal.vkApiLimits.recordRateLimit, ...)`. With D2a's `429`-only mutation predicate, a manual/accidental probe call would return `null` for normal 200 responses instead of writing rows. The action body is compatible with D2a and does not need to be changed in D2a, but the cron must remain disabled.
- `convex/schema.ts`: existing `vkApiLimits` table has indexes by `accountId/capturedAt`, `endpoint/capturedAt`, and `capturedAt`.
- `convex/vkApiLimits.test.ts`: tests still describe the intended old insert behavior and currently fail while the handler remains no-op.

The production system is stable without this observability, but VK rate-limit visibility is in slip-mode: operators can infer rate pressure only from downstream symptoms (`429`, timeouts, token failures, sync gaps), not from first-class quota telemetry.

## Root cause

The issue is not the `vkApiLimits` table itself. The unsafe part is the combination of:

1. **Producer cardinality**: hot VK API paths can produce one telemetry event per VK response.
2. **Scheduler as transport**: every telemetry event became a Convex scheduled job via `runAfter(0)`.
3. **No write-rate bound**: successful 200 responses with headers could enqueue as aggressively as real user work.
4. **Probe amplification risk**: `vk-throttling-probe` added its own periodic source of writes for up to 30 accounts/run.

This made observability compete with production work for the same scheduler/action capacity. Under load, telemetry became load.

## Current producer inventory

Four `vkApi.ts` call sites currently have disabled producers:

| Function | Purpose | Risk profile |
|---|---|---|
| `getMtStatistics` | banner/day statistics | hot sync path, high response count |
| `getCampaignsSpentTodayBatch` | campaign spend for UZ/rules | hot rule/UZ path |
| `getMtLeadCounts` | lead counts | less common, but can fan out by account |
| `getMtBanners` | ads listing | sync/account report path |

One cron source is currently disabled:

| Cron | Current state | Risk profile |
|---|---|---|
| `vk-throttling-probe` | commented out | 30 account probes per 15 min, independent scheduled workload |

The D2 restore must treat these as separate sub-steps. Do not re-enable producers and the probe together.

## Two tiers -- keep them separate

### Tier 1 -- Bounded restore without scheduler transport

Scope:

- Restore `recordRateLimit` as a bounded mutation.
- Replace `runAfter(0)` producer transport with direct `ctx.runMutation(...)` from the calling action.
- Record only high-value events at first: `429` responses.
- Keep `vk-throttling-probe` disabled.
- No schema change, no new cron, no new table, no env flag.

Goal:

- Restore visibility into actual VK API throttling events.
- Guarantee that telemetry cannot create scheduled-job backlog.
- Keep additional write volume naturally bounded by actual `429` rate.

This is the recommended D2a path.

### Tier 2 -- Sampled quota observability

Scope:

- Expand from `429`-only to sampled `X-RateLimit-*` header snapshots.
- Add one-per-account-endpoint-minute sampling, either with existing indexes or a small schema addition if needed.
- Consider restoring `vk-throttling-probe` only after D2a is observed clean.

Goal:

- See quota depletion before `429` happens, while preserving hard write-rate bounds.

This is D2b/D2c, not the first restore step.

### Tier 3 -- Long-term telemetry architecture

Scope:

- Dedicated aggregated quota state or queue/drain architecture.
- UI/admin views for quota pressure.
- Retention/rollup jobs.
- Cross-endpoint quota policy.

This is outside incident aftermath.

The intentional rule: if a change adds a new table, new cron, new env flag, or enables `vk-throttling-probe`, it has left D2a and needs its own go.

## Design options

### Option A -- Direct bounded insert for `429` only (D2a, recommended)

Restore `recordRateLimit` to insert only when `statusCode === 429`. This intentionally narrows the old producer predicate (`hasData = headers present OR statusCode === 429`) to `429` only. Header sampling for 200 responses stays disabled by design and is deferred to D2b.

The four producers stop scheduling jobs and instead call `ctx.runMutation(internal.vkApiLimits.recordRateLimit, ...)` directly from their action context when a logical VK API call observes a `429`.

Expected shape:

```ts
const shouldRecordRateLimit = (info: CallMtApiResponseInfo) =>
  info.statusCode === 429;

const rlOptions = {
  onResponse: async (info: CallMtApiResponseInfo) => {
    if (!shouldRecordRateLimit(info)) return;
    try {
      await ctx.runMutation(internal.vkApiLimits.recordRateLimit, {
        accountId: args.accountId,
        endpoint: info.endpoint,
        statusCode: info.statusCode,
        ...info.rateLimits,
      });
    } catch {
      console.warn(`[vkApiLimits] failed to record 429 for ${info.endpoint}`);
    }
  },
};
```

To support this safely, `callMtApi` must change its exported callback contract from:

```ts
onResponse?: (info: CallMtApiResponseInfo) => void
```

to:

```ts
onResponse?: (info: CallMtApiResponseInfo) => void | Promise<void>
```

and await it inside the existing non-critical `try/catch` around the current callback invocation. This is a real exported-contract change and requires focused tests.

`callMtApi` currently invokes `onResponse` on every retry attempt. D2a must avoid writing up to three duplicate rows for a single throttled logical VK call. The desired D2a behavior is:

- at most one `recordRateLimit` mutation per logical `callMtApi(...)` invocation;
- record the first observed `429` for that logical call, even if a later retry succeeds with 200;
- normal 200 responses do not call `recordRateLimit`;
- callback failures are swallowed after a `console.warn`, never escalated through `systemLogger.log({ level: "error" })`.

The implementer should put the "any 429 observed" predicate and one-row-per-logical-call guard in `callMtApi` (or in a renamed throttle hook such as `onThrottle`), not only inside the `recordRateLimit` mutation. If the guard lives only in the mutation, the system still pays for N mutation calls during retry storms and only skips N inserts. The mutation-side `statusCode === 429` predicate remains defense-in-depth, not the primary bound.

The cleanest shape is:

1. Inside `callMtApi`, keep local state such as `let saw429 = false` and `let last429RateLimits: RateLimitHeaders | undefined`.
2. During the retry loop, set that state whenever `response.status === 429`; keep the latest 429 headers.
3. After the logical call resolves or throws, invoke the awaited throttle hook at most once with `{ statusCode: 429, rateLimits: last429RateLimits, endpoint }`.

This covers the important cases:

- `429 -> 200`: one 429 row, even though retry rescued the user-facing call.
- `429 -> 429 -> 429`: one 429 row, not three.
- `200`: zero rows.
- `503 -> 429 -> 200`: one 429 row.

Use the headers from the latest observed 429 because they are the freshest quota state if D2b later adds sampled quota analysis.

`recordRateLimit` mutation body:

```ts
if (args.statusCode !== 429) return null;
return await ctx.db.insert("vkApiLimits", {
  ...args,
  capturedAt: Date.now(),
});
```

**Pros**

- Removes scheduled jobs from the telemetry path entirely.
- Write volume is bounded by actual throttling events, not all VK responses.
- No schema change.
- No cron.
- Reuses existing `vkApiLimits` table and tests.
- Reversible by reverting the small code change; producer guards stay easy to re-disable.

**Cons / risks**

- No early warning from quota headers before `429`.
- If a systemic VK outage returns many `429`s, writes can still rise. This is acceptable for D2a because writes are direct mutations, not scheduled jobs, and 429 volume is exactly the incident signal operators need.
- Adding async `onResponse` changes the exported `callMtApi` contract and adds one awaited mutation round-trip for each recorded logical `429` call. This is acceptable for the rare 429 path, but D2b header sampling must revisit the latency cost before adding writes on 200 responses.
- The `recordRateLimit` catch path must use `console.warn`, not `systemLogger.log({ level: "error" })`. D2a must not introduce any new error-level systemLogger path before D1 is complete; otherwise a telemetry failure could feed the admin-alert amplification path that D1 is designed to close.

**Verdict**: recommended first implementation.

### Option B -- Direct insert for `429` plus per-minute sampling for low remaining quota (D2b)

Record `429` always. Additionally, record one sampled row per `(accountId, endpoint, minute)` when one of these is true:

- `rpsRemaining <= 1`
- `hourlyRemaining <= 100`
- `dailyRemaining <= 1000`

Sampling can be implemented using the existing `by_accountId_capturedAt` index:

1. Compute `since = Date.now() - 60_000`.
2. Query recent rows for `accountId` using `by_accountId_capturedAt`.
3. Filter in memory by `endpoint` and `capturedAt >= since`.
4. Skip insert if a row already exists.

This avoids a schema change, but the query is less precise than a purpose-built `(accountId, endpoint, minuteBucket)` index.

**Pros**

- Gives early warning before hard throttling.
- Still bounded to at most one sampled row per account/endpoint/minute.
- No scheduler transport.
- No new table.

**Cons / risks**

- More code and more reads inside the mutation.
- Thresholds are heuristic until real VK quota behavior is observed.
- Slightly more write volume than Option A.

**Verdict**: good second step after Option A has at least 24h clean observation.

### Option C -- Aggregated quota state row (D2c)

Add or repurpose state so each `(accountId, endpoint)` has one current row with last observed quota and counters. Instead of append-only inserts, producers upsert current state and increment counters.

**Pros**

- Strongest storage bound.
- Best operator model for "current quota pressure".
- Natural source for UI/admin dashboard.

**Cons / risks**

- Schema change or table semantics change.
- Upsert contention possible on hot endpoints.
- Existing tests and any historical queries must be rewritten.

**Verdict**: Tier 2/3. Useful, but not an incident-aftermath quick restore.

### Option D -- Restore `vk-throttling-probe` cron

Re-enable `vk-throttling-probe` every 15 minutes for batches of 30 accounts.

**Pros**

- Directly queries VK's throttling endpoint.
- Does not depend on hot user traffic to observe quotas.

**Cons / risks**

- Adds another scheduled job while recovery is still recent.
- Adds external VK calls even when users are idle.
- If combined with producer restore, it increases overlap pressure.

**Verdict**: not part of D2a. Consider only after Option A and then Option B are clean, and only with a separate runbook.

## Recommended path

Adopt **Option A** as D2a:

1. Restore `recordRateLimit` only for `statusCode === 429`.
2. Replace `runAfter(0)` producer transport with direct best-effort `ctx.runMutation`.
3. Keep header telemetry disabled for 200 responses.
4. Keep `vk-throttling-probe` disabled.
5. Keep the change small enough to revert cleanly.

This returns the most important signal (`429`) while eliminating the specific scheduled-job backlog mechanism that made the old design unsafe.

## D2a implementation boundaries

D2a may touch:

- `convex/vkApiLimits.ts`
- `convex/vkApi.ts`
- `convex/vkApiLimits.test.ts`
- one required focused `vkApi`/`callMtApi` test for async `onResponse` behavior

D2a must not touch:

- `convex/crons.ts`
- schema
- sync worker/batch envs
- UZ gates
- token refresh gates
- `adminAlerts.notify`
- `recordRateLimit` producers outside the four already-disabled `vkApi.ts` sites

If implementation needs any of the forbidden areas, stop and open a new design/update.

Required D2a deliverables:

1. Change `callMtApi` exported `onResponse` type to `void | Promise<void>`.
2. Await the callback inside the existing non-critical callback `try/catch`.
3. Add a one-row-per-logical-call guard for repeated `429` retry attempts.
4. Restore `recordRateLimit` with a `statusCode === 429` insert predicate.
5. Replace scheduler producers with direct bounded mutation calls.
6. Keep `probeThrottling` body unchanged and `vk-throttling-probe` cron disabled.
7. Update `convex/vkApiLimits.test.ts` to the new D2a predicate: 200-with-headers returns `null`; 429 inserts.
8. Add a focused `callMtApi` test proving async callback is awaited and callback failure does not fail the VK API call.

## Pre-implementation prerequisite gate

Before editing code in a future D2a implementation session, collect a read-only baseline:

1. Latest `_scheduled_jobs` state for `vkApiLimits.js:recordRateLimit`: capture `pending` and `inProgress` baseline. Preferred baseline is `0/0`, but a small static legacy count is not automatically blocking if it is already draining through the no-op handler. The blocking condition is growth after D2a deploy, not historical residue before deploy.
2. Current `vkApiLimits` row count and last `capturedAt`.
3. Confirm the four `vkApi.ts` producers are still disabled by `if (false && hasData)`.
4. Confirm `vk-throttling-probe` remains commented out.
5. Check backend stdout/systemLogs for VK API `429` count in the last 24h if logs are available.
6. Capture `pg_wal` exact byte baseline.
7. Confirm current env/gates are still the post-Phase-8 conservative profile.

If `429` volume is already high before D2a, do not implement write logging blindly. Investigate the throttling source first.

## Rollout plan

### D2a deploy canary

1. Implement Option A.
2. Run focused tests:
   - `convex/vkApiLimits.test.ts`, rewritten for the D2a predicate (`200` with headers skips; `429` inserts)
   - a required focused `callMtApi`/`onResponse` test for async callback behavior and callback-failure swallowing
   - `npx tsc --noEmit -p convex/tsconfig.json`
3. Commit and push only the D2a files.
4. Deploy only after explicit go.
5. Do not run manual sync or manual VK probes.
6. Observe the next organic sync/UZ windows.

### Acceptance criteria

D2a is clean if, over the first 3 hours after deploy:

- `/version` HTTP 200.
- `vkApiLimits.js:recordRateLimit` latest-state has `0 pending`, `0 inProgress`, and no failed growth.
- `_scheduled_jobs` does not show a new `recordRateLimit` schedule burst.
- `vkApiLimits` row growth is `<= number of observed VK 429 responses`.
- Normal 200 VK responses do not create `vkApiLimits` rows.
- Backend stdout has `0 Too many concurrent` and `0 Transient error`.
- Existing scheduled job failed counters remain flat.
- `pg_wal` delta stays under `50 MB`.

D2a closure requires:

- one clean token refresh tick,
- two clean sync ticks,
- one clean UZ tick,
- no `recordRateLimit` scheduled-job recurrence,
- no rollback trigger during the observation window.

Use a 3h closure window by default. The surrounding crons have different cadence (`tokenRefreshDispatch` every 2h; sync and UZ every 45 min). A 2h window can miss a clean token-refresh retry if the deploy lands just after one token tick or if the first eligible token tick is inconclusive. Three hours gives enough room for one token tick plus sync/UZ confirmation without forcing a premature close.

### Rollback

Rollback trigger:

- any `vkApiLimits.js:recordRateLimit` pending/inProgress burst,
- any `Too many concurrent` recurrence correlated with D2a,
- `pg_wal` delta `>= 50 MB` in the canary window,
- failed counters grow for `vkApiLimits`, sync V2, UZ V2, or token refresh V2,
- normal 200 responses are found to write rows unexpectedly.

Rollback action:

1. Revert the D2a commit.
2. Push the revert.
3. Deploy the revert after explicit go.
4. Verify the four producer guards are effectively disabled again and `recordRateLimit` returns `null`.

Do not attempt a partial production hot-edit of only one producer.

## Verification after D2a

Use both storage and runtime signals:

- `_scheduled_jobs` latest-state, not raw historical `documents` counts.
- `vkApiLimits` row-count delta after deploy.
- Backend stdout grep for `Too many concurrent`, `Transient error`, and VK 429 bursts.
- Existing `check-sync-tick.cjs`, `check-uz-tick.cjs`, and `check-token-refresh-tick.cjs` for surrounding cron health.
- `pg_wal` exact byte baseline/delta.

Success does not require seeing a new `429`. If no VK throttling occurs during the canary, the correct D2a behavior is zero new `vkApiLimits` rows and no scheduled jobs.

## Out of scope

D2a explicitly does not:

- restore `vk-throttling-probe`;
- record every response header;
- add a new table or index;
- build an admin UI for quota pressure;
- change sync worker count or batch size;
- change retry/backoff behavior for VK API calls;
- change token refresh behavior;
- restore `adminAlerts.notify`;
- remove the V1 no-op handler history for old `recordRateLimit` scheduled jobs;
- clean historical `_scheduled_jobs` rows from Postgres.

## Open decisions for the implementer

Before D2a code starts, decide:

1. Should all four disabled producers be re-enabled in one D2a commit, or should `getCampaignsSpentTodayBatch` and `getMtStatistics` be canaried first?
2. Should `recordRateLimit` return inserted id for `429` and `null` for skipped rows, preserving the existing test style?

Recommended answers:

1. Re-enable all four only if the predicate is strictly `statusCode === 429`; otherwise canary the two hottest paths separately.
2. Preserve `id | null` return semantics so existing tests stay meaningful.

Already decided by this design:

- `callMtApi` should await async `onResponse` inside the existing try/catch.
- the "any 429 observed" predicate and one-row-per-logical-call guard live in `callMtApi`/the throttle hook layer; the mutation predicate is only defense-in-depth.
- repeated retry-attempt `429`s should produce at most one telemetry row per logical VK API call.
- callback failure should produce `console.warn`, not `systemLogger.log({ level: "error" })`.

## Estimated effort

D2a implementation:

- Code: 45-60 minutes.
- Tests/typecheck: 20-30 minutes.
- Deploy and 3h observation: one operator window.

D2b sampled headers:

- Separate session after D2a, 1.5-2.5 hours design+implementation, depending on whether schema remains unchanged.

`vk-throttling-probe` restore:

- Separate runbook after D2a/D2b, with its own cron overlap math and acceptance criteria.

## Decision request

Approve this design as the D2 design deliverable, then schedule a separate D2a implementation session:

- Implement Option A only.
- Keep `vk-throttling-probe` disabled.
- Keep D2b/D2c deferred until D2a has clean observation.
