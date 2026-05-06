# Design: `adminAlerts.notify` amplification fix (D1)

Date: 2026-05-06
Branch context: `emergency/drain-scheduled-jobs` (Phase 8 closed clean `2026-05-06T17:47Z`; this fix is the next non-emergency track)
Related: `docs/2026-05-05-convex-scheduled-jobs-incident-report.md` (Phase 2 V2 verification chronology, tick `09:09 UTC`); `docs/2026-05-06-post-phase-8-checklist.md` (Trigger D1); `memory/phase-6-sync-canary-status.md` (substance prep)
Status: **design proposal only — no code, no deploy as part of this document**

## Scope of this proposal

This document is **strictly a design proposal**. It does not authorize any code change, schema change, env change, or deploy. Its purpose is to:

1. Fix the framing while context is fresh from RCA, before the incident aftermath team forgets the precise amplification chain.
2. Explicitly separate a **quick bounded fix** (one function in `systemLogger.ts`, no schema change, no new cron, no new table) from broader architectural questions (queue-based alert delivery, periodic scanning, severity tiers, migration of all `notify` call-sites).
3. Reduce the risk that incident aftermath turns into a large refactor: by writing down the bounded fix now, future implementers have a clear "stop the bleeding" path that does not expand scope.

This is an incident aftermath doc, not a regular product spec. It is parented by the 2026-05-04/05 scheduled jobs incident, not by a product roadmap item. Implementation, code, tests, and deploy are **out of scope here** and require a separate dedicated session with its own go.

## Problem statement

`systemLogger.log` (`convex/systemLogger.ts:47`) auto-schedules `internal.adminAlerts.notify` on every `level: "error"` write:

```ts
if (args.level === "error" && !DISABLE_ERROR_ALERT_FANOUT) {
  try { await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
    category: "criticalErrors",
    dedupKey: `${args.source}:${args.accountId ?? "global"}:${args.message.slice(0, 50)}`,
    text: [...].filter(Boolean).join('\n'),
  }); } catch { /* non-critical */ }
}
```

This was the amplification component of the 2026-05-04/05 scheduled jobs incident.

### The amplification chain

1. Token refresh worker fails with `Too many concurrent requests` (V8 slot saturation).
2. The catch path calls `systemLogger.log({ level: "error", source: "auth", message: "Too many concurrent...", accountId })`.
3. `systemLogger.log` writes to `systemLogs` AND schedules `adminAlerts.notify` via `runAfter(0)`.
4. Each scheduled `notify` worker takes a V8 action slot when picked up.
5. Notify workers compete with subsequent token refresh workers for slots → more `Too many concurrent` failures from those workers.
6. Each new failure produces another `systemLogger.log({ level: "error" })` → another `runAfter(0)` schedule.
7. Loop self-feeds.

### Observed signature (from incident report)

Tick `09:09 UTC` cross-correlation, captured in `docs/2026-05-05-convex-scheduled-jobs-incident-report.md` Phase 2 V2 verification chronology:

| Time | Event | Source |
|---|---|---|
| `09:11:20.014–043 UTC` | 4 `Too many concurrent` errors | `docker logs adpilot-convex-backend` |
| `09:11:20.015–045 UTC` | 4 `adminAlerts.js:notify` schedules | `_scheduled_jobs` latest-state |

The `±50ms` time correlation between error timestamps and schedule timestamps is the smoking gun: every error inside the loop produces a schedule in the same millisecond range, which becomes a worker that produces another error.

### Current mitigation (drain-mode)

Two coupled gates currently suppress the loop:

- `convex/adminAlerts.ts:139-149`: `notify` handler is no-op (`return;`).
- `convex/systemLogger.ts:10`: `DISABLE_ERROR_ALERT_FANOUT=1` env gate skips the `runAfter(0)` block entirely.

This is correct for incident drain but wrong for production long-term: error logs no longer reach Telegram admins at all. Operator visibility into prod errors is currently zero outside of manual `systemLogs` queries.

## Root cause

Two compounding design choices, not one:

### Cause 1 — schedule-per-error is structurally fragile

`runAfter(0)` per error log creates work proportional to error rate. Under saturation, error rate spikes, schedule rate spikes, which creates more workers competing for the same scarce slots that are already saturated. Any feedback signal (i.e. notify worker itself can fail and be logged) closes the loop.

### Cause 2 — current `dedupKey` is too granular to break the loop

The current key is `${source}:${accountId ?? "global"}:${message.slice(0, 50)}`.

When a systemic problem (V8 slot saturation, VK API outage, token endpoint down) hits N accounts at once, each account produces an error with:

- same `source` (e.g. `"auth"`)
- different `accountId`
- nearly-same `message` (system-level wording, e.g. `"Too many concurrent requests"`)

Result: N distinct dedup keys, N schedules. Per-account granularity is correct for **per-account incidents** but wrong for **systemic incidents**, which are exactly the ones that produce amplification.

The 30-minute `adminAlertDedup` window already exists (`convex/adminAlerts.ts:114-135`, `DEDUP_WINDOW_MS = 30 * 60 * 1000`). The infrastructure is there; the key shape neutralizes it for systemic events.

## Two tiers — keep them separate

This problem can be addressed at two very different scopes. Conflating them is exactly how incident aftermath turns into a large refactor. They are explicitly separated below.

### Tier 1 — Quick bounded fix

- Scope: change one block in one function (`systemLogger.ts:47` — the `runAfter(0)` block).
- No schema change. No new table. No new cron. No new state row. No call-site changes outside `systemLogger.ts`.
- Goal: break the systemLogger → adminAlerts.notify amplification loop. Restore admin alert delivery for non-systemic errors. Allow `DISABLE_ERROR_ALERT_FANOUT` to be lifted after canary.
- This is what should happen first, in a dedicated short session, after Phase 8 housekeeping is committed.
- Tier-1 candidate is **Option A** below.

### Tier 2 — Broader architectural work (deferred)

- Scope: alert delivery architecture, possibly schema, possibly migration of all `notify` call-sites.
- Examples: periodic scanner over `systemLogs` with batched summaries (Option B); unified `adminAlertQueue` table with cron drain, rate-limit guard, and migration of all 7 explicit `notify` callers (Option C).
- Goal: structurally remove scheduling from the error path, give operators batched summaries with full context, prepare for higher alert volumes.
- This is **not** part of incident aftermath. Decide separately, only after Tier 1 is observed in production for at least a week and the bounded fix is confirmed to actually break the loop signature.
- Tier-2 candidates are **Option B** and **Option C** below, plus other broader work that is intentionally not designed here.

The intentional rule: if a future change adds a new table, a new cron, a new env flag, or modifies any of the 7 explicit `notify` callers, it has crossed the line into Tier 2 and should be revisited as its own design.

## Design options

### Option A — Inline dedup-before-schedule with `messageClass` (Tier 1, recommended)

Change the body of the `runAfter(0)` block in `systemLogger.ts:47` to inline a dedup check before scheduling:

```ts
if (args.level === "error" && !DISABLE_ERROR_ALERT_FANOUT) {
  const messageClass = classifyMessage(args.source, args.message);
  const guardKey = `error:${args.source}:${messageClass}`;
  const fresh = await checkAdminAlertDedupInline(ctx, guardKey);
  if (fresh) {
    try { await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
      category: "criticalErrors",
      dedupKey: guardKey,                    // also passed to handler for its own dedup write
      text: [
        `🚨 <b>Ошибка</b>`,
        ``,
        `<b>Источник:</b> <code>${args.source}</code>`,
        `<b>Класс:</b> <code>${messageClass}</code>`,
        `<b>Аккаунт:</b> ${args.accountId ?? "—"}`,
        `<b>Сообщение:</b> ${args.message}`,
        details ? `<pre>${JSON.stringify(details, null, 2).slice(0, 300)}</pre>` : '',
      ].filter(Boolean).join('\n'),
    }); } catch { /* non-critical */ }
  }
}
```

Key changes:

1. **Coarsened `guardKey`**: drops `accountId` and raw `message.slice(0, 50)`, uses normalized `messageClass`. A systemic error with one source class and N affected accounts produces 1 schedule per 30 min, not N.
2. **Inline dedup check**: reuses existing `adminAlertDedup` table directly from the `log` mutation. Both `systemLogger.log` and `adminAlertDedup.checkDedup` are mutations; same-tx access to the table is cheap.
3. **Per-account context preserved in alert text**: `accountId`, raw `message`, and `details` still appear in the Telegram payload so the operator knows which account triggered the dedup-winner.

**Pros**

- Minimum diff, ~10 lines changed in one file.
- Reuses existing `adminAlertDedup` infrastructure (table, TTL, schema).
- No new cron, no new table, no new env flag, no schema change.
- 7 explicit `notify` callers untouched: their volume is bounded by business events and they already pass through `adminAlertDedup` via `checkDedup`. They were never the amplification source.
- Reversible by reverting the file change. `DISABLE_ERROR_ALERT_FANOUT` env flag can stay as a kill-switch even after Tier 1 lands.

**Cons / risks**

- Still does `runAfter(0)` for the first occurrence per (source, messageClass) per 30-min window. This is intentional — first occurrence should reach the operator within seconds. The amplification loop is broken because the **second through Nth occurrences** of the same (source, messageClass) within the dedup window do not schedule.
- Loses per-account fidelity in the dedup *key*. Per-account context still appears in the alert *text* — the operator sees which accountId triggered the alert that won the race for the window.
- A new error pattern that is not in the `messageClass` mapping falls back to a hash/normalize-first-120-chars rule. If two semantically-identical errors have slightly different verbatim text, the fallback may produce different keys for them. See `messageClass normalization` below for mitigation.

**Diff size**: ~10 lines in `systemLogger.ts`, plus ~15 lines for `classifyMessage` helper. No other files.

**Deployment risk**: low. Reversible. No schema migration. No new cron. No new env flag introduced. `DISABLE_ERROR_ALERT_FANOUT` env flag retained as kill-switch.

### Option B — Cron-driven scan of `systemLogs` (Tier 1.5 candidate, deferred)

Remove the `runAfter(0)` block from `systemLogger.log` entirely. Add a new low-frequency cron that periodically scans recent `systemLogs` rows where `level=error`, aggregates by `(source, messageClass)`, and sends one batched Telegram summary per group with count + sample accountIds + timestamp range.

**Pros**

- Error path no longer schedules anything. Loop is architecturally impossible by construction.
- Better operator UX: summary message with aggregated counts and sample accountIds is more useful than a single per-account alert.
- Cron can be reused as the future queue-drain cron in Option C.

**Cons**

- Adds a new scheduled job to the system that was just recovered from a scheduled-jobs incident. Adding scheduler exposure as part of the fix-for-an-amplification-loop is the wrong direction for a Tier 1 minimal change.
- Requires `lastScannedAt` state tracking (small state row or derived from max `adminAlertDedup.lastSentAt` for scan-class keys).
- Increases minimum alert latency to the cron interval (e.g., 2-5 min) for non-systemic errors. Option A keeps first-occurrence latency at ~seconds.

**Verdict**: not Tier 1. Re-evaluate as Tier 1.5 after Option A is observed for at least one week and signal is collected on whether the dedup-coarsening trade-off is acceptable. If batched summaries become a clear operator need, Option B is the natural next step and reuses 100% of the messageClass mapping built in Tier 1.

### Option C — Unified `adminAlertQueue` table + cron drain + 7-caller migration (Tier 2)

Add a new table `adminAlertQueue { source, messageClass, accountId?, message, createdAt, sentAt? }`. All 8 alert producers (1 systemLogger auto + 7 explicit callers) write to the queue instead of calling `runAfter(0, internal.adminAlerts.notify, ...)`. A single low-frequency cron drains the queue with rate-limit and backpressure logic.

**Pros**

- Strongest possible separation: alert producers don't know about scheduling at all.
- Rate-limit and backpressure are centralized.
- Migration of all 7 explicit callers as part of this option means the entire alert path is uniform.

**Cons**

- New schema table and companion-sync risk per `CLAUDE.md`: every alert producer must use the queue, easy to bypass with a stray `runAfter(0)` in future code without enforcement.
- Migration of 7 callers means 7 distinct files touched (`syncMetrics.ts`, `ruleEngine.ts`, `adAccounts.ts`×2, `billing.ts`×3). Each has its own dedup story today; migration risks regression of working alerts.
- Adds new cron and new table, both of which were exactly the kind of artifact that caused the original incident.

**Verdict**: Tier 2. Decide separately, only if Tier 1 + Tier 1.5 prove insufficient.

## Recommended path

Adopt **Option A** as the Tier-1 quick bounded fix. It is the minimal correct change. Tier-1.5 (Option B) and Tier-2 (Option C) work is **not** initiated by adopting Option A.

Explicit non-decisions made by this document:

- Whether to add a periodic scanner cron — left open, will only be revisited if Option A's first-occurrence-still-schedules trade-off proves problematic.
- Whether to migrate 7 explicit `notify` callers to a unified queue — left open. They are not the amplification source; they should be touched only with their own RCA.
- Whether to introduce severity tiers above `error` (e.g., `fatal`) — left open as a separate audit, not part of this fix.
- Whether to change the Telegram delivery format or add email/push channels — out of scope.

### `messageClass` normalization

`classifyMessage(source, message)` returns a stable short string (max ~30 chars, lowercase, `[a-z0-9_]` only). Initial mapping covers the four error patterns observed during the incident and post-recovery period:

| Match condition | `messageClass` | Source category |
|---|---|---|
| `message` contains `Too many concurrent` | `too_many_concurrent` | Convex isolate / V8 slot saturation |
| `message` contains `Transient error` | `transient_error` | Convex transient / network |
| `message` contains `TOKEN_EXPIRED` | `token_expired` | VK token refresh failure |
| `source == "tokenRecovery"` AND `message` contains `failed` or `error` | `token_recovery_failed` | Token recovery cron |

Fallback rule (no pattern matches): take `message.slice(0, 120)`, lowercase it, replace any run of non-alphanumeric characters with `_`, trim leading/trailing `_`. This produces stable keys for verbatim-identical messages and reduces near-miss key explosion for similar messages with embedded IDs/timestamps.

The `source` field is part of the dedup key separately, so the same `messageClass` from two different sources still produces two keys. This is intentional — `auth/too_many_concurrent` and `syncMetrics/too_many_concurrent` have different operator response paths.

The mapping lives in code as a small `classifyMessage` helper (constant patterns array). It is **not** put in a DB table — that would be Tier 2 (configurable mapping). Tier 1 patterns are baked in.

### Pre-implementation prerequisite gate

Before editing code, run a read-only audit to confirm the four-class mapping covers the realistic top error volume:

1. Query last 7 days of `systemLogs` where `level=error`, group by `(source, classifyMessage(source, message))`.
2. Verify the four classes plus the fallback together cover ≥ 80% of error volume by row count.
3. Spot-check the top 10 fallback keys: confirm they are stable (no embedded UUIDs, timestamps, request IDs that would make each occurrence unique).
4. If any single fallback key dominates and contains an obvious dynamic substring, add it to the explicit mapping table before deploy.

This guardrail protects the bounded fix from silently being defeated by a dominant error class with high cardinality. If the gate fails (fallback dominates with high cardinality), do not deploy Option A as-is; expand the mapping first.

This audit is part of the implementation session, not a blocker for this design doc.

### Implementation hints (D1a only — code change session)

This is **not an authorization to implement**. It is reference material so a future short session does not have to redo the analysis.

These hints cover **D1a only** (the code change in `systemLogger.ts`, with gate kept at `1` and handler kept no-op). D1b (gate lift) and D1c (handler restore) each have their own setup, captured in the sub-step structure section below. Do not bundle.

1. Read current `systemLogger.log` and `adminAlerts.checkDedup` (already done in this design).
2. Run pre-implementation audit query (above) and confirm mapping coverage ≥ 80%.
3. Edit `convex/systemLogger.ts`: add `classifyMessage` helper, replace the existing `if (args.level === "error" && !DISABLE_ERROR_ALERT_FANOUT)` block with the inline-dedup variant.
4. Note the inline dedup pattern: `systemLogger.log` is an `internalMutation`, so it already has `ctx.db` access. Inline the same read+conditional-write logic that `adminAlerts.checkDedup` uses, instead of calling `checkDedup` via `runMutation` (which would require an action context).
5. Add unit/integration tests covering both gate states:
   - With `DISABLE_ERROR_ALERT_FANOUT=1` (D1a runtime state): call `systemLogger.log({ level: "error", source: "auth", message: "Too many concurrent #1", accountId: A })` 5 times in quick succession with different accountIds and slight message variations. Verify `0` `adminAlerts.notify` schedules created (gate is suppressing).
   - With `DISABLE_ERROR_ALERT_FANOUT=0` (D1b runtime state, simulated in test env): same 5-call burst. Verify exactly `1` `adminAlerts.notify` schedule created within the dedup window.
   - Verify the 5th occurrence's accountId is NOT lost from `systemLogs` in either case.
6. Run `npx tsc --noEmit -p convex/tsconfig.json` (mandatory per `CLAUDE.md`).
7. Run `npm run test` (mandatory per `CLAUDE.md`).
8. Deploy as **D1a** — code change only. No env changes, no handler change. `DISABLE_ERROR_ALERT_FANOUT` stays at `1`, `adminAlerts.notify` handler stays no-op. The new dedup logic exists in code but is suppressed by the gate.
9. Verify D1a per the verification section: post-deploy synthetic burst against production should produce `0` schedules (gate is active).
10. **Stop**. Do not lift the gate or restore the handler in the same session. D1b and D1c are separate sessions per the sub-step structure below.

### Tier 1 sub-step structure (D1a → D1b → D1c)

Tier 1 is implemented as three explicit sub-steps, each with its own deploy, canary, and revert path. They are **not** bundled. This honors the "minimal bounded fix" framing while acknowledging that the effective Tier 1 outcome — operator-visible admin alerts working again, with the loop fixed — requires both a `systemLogger.ts` change and an `adminAlerts.ts` handler restore. Splitting them keeps each sub-step within "one file at a time, one risk at a time."

**D1a — code change, no behavior change**

- Edit `convex/systemLogger.ts`: add `classifyMessage` helper, replace the existing `if (args.level === "error" && !DISABLE_ERROR_ALERT_FANOUT)` block with the inline-dedup variant.
- `DISABLE_ERROR_ALERT_FANOUT` stays at `1`. `adminAlerts.notify` handler stays no-op.
- Effect: zero behavior change. The new dedup logic is in the code but never executes (gate suppresses).
- Why a separate sub-step: lands the code without committing to behavior change. If the gate-check itself is broken in the new code (e.g. typo in `process.env.DISABLE_ERROR_ALERT_FANOUT`), it surfaces as `>0` schedules during D1a verification, before any production alert delivery is at risk.
- Revert: revert the file change.

**D1b — gate lift canary (alert delivery still no-op)**

- `npx convex env set DISABLE_ERROR_ALERT_FANOUT 0` (or unset).
- `adminAlerts.notify` handler still no-op. Schedules are created but Telegram does not fire.
- Effect: dedup logic begins executing in production. `_scheduled_jobs` accumulates `adminAlerts.notify` rows at the rate Tier 1 is supposed to enforce (bounded by distinct `(source, messageClass)` pairs × 30-min dedup window).
- Why a separate sub-step: this is where the dedup math gets tested in production for the first time. If the math is wrong, schedule rate spikes — but with handler still no-op, no Telegram spam reaches operators. Revert is instant via env flag, no code change required.
- Revert: `npx convex env set DISABLE_ERROR_ALERT_FANOUT 1`. Instant.

**D1c — handler restore (alert delivery resumes)**

- Edit `convex/adminAlerts.ts:139-149`: restore the `notify` handler body to its pre-drain implementation (Telegram fan-out via `getEnabledAdmins` + `getAdminUser` + Telegram bot). Recover from git history pre-`f452348`.
- Effect: scheduled `notify` workers actually deliver to Telegram. Operators receive admin alerts again.
- Why a separate sub-step: the dedup math is already proven by the D1b observation window. This sub-step only verifies that handler delivery works and that no operator-side spam emerges from messageClass coverage gaps. If handler logic itself has a bug, it is isolated from the dedup change — D1a and D1b are unaffected.
- Revert: revert the handler file change. Setting `DISABLE_ERROR_ALERT_FANOUT=1` is also a fast secondary brake — schedules stop being created, so Telegram fan-out stops too.

Each sub-step is its own session with its own go. D1a may land days before D1b. D1b should sit in canary at least one full sync/UZ cycle (≥ 24h) before D1c lands.

Tier 1 does **not** touch:

- `SYNC_ESCALATION_ALERTS_ENABLED` — this gate guards a different code path (`syncMetrics.scheduleEscalationAlert`, added in `9f62cfa`) which already uses `adminAlertDedup` and was not part of the amplification loop. It has its own canary criteria and is decided separately, after D1c.
- The 7 explicit `notify` callers — they continue to call `runAfter(0, internal.adminAlerts.notify, ...)` as before. Their volume is bounded by business events (account connect/disconnect, payment success/failure, rule trigger), not by error rate.

### Rollout safety

- Reversible: revert `systemLogger.ts`, set `DISABLE_ERROR_ALERT_FANOUT=1` again. Restores drain-mode behavior.
- No data is permanently written that would survive the rollback (the `adminAlertDedup` rows have a 1-day TTL via `cleanupDedup`).
- No external API call from this code path itself (the scheduled `notify` worker calls Telegram, but that is unchanged).
- No schema change.
- `DISABLE_ERROR_ALERT_FANOUT` env retained as kill-switch even after Tier 1 lands and is verified.

### Verification per sub-step

**After D1a deploy (gate stays at `1`, handler stays no-op)**

1. `npx tsc --noEmit -p convex/tsconfig.json` — clean.
2. `npm run test` — pass (including new dedup tests covering both gate states).
3. Deploy succeeds, `/version` HTTP 200.
4. Synthetic burst (one-off script): call `systemLogger.log` 10 times with identical `(source: "auth", message: "Too many concurrent test")` over 10 seconds. Expected: `0` new `adminAlerts.notify` schedules in `_scheduled_jobs` latest-state. The gate is suppressing — no schedule should fire even with the new code in place. This is the "no behavior change" verification.
5. If anything other than `0` schedules: stop, revert D1a file change, investigate (the gate-check is broken in the new code).

**After D1b gate lift (handler still no-op)**

1. Synthetic burst (same one-off script): expected exactly `1` new `adminAlerts.notify` schedule in the burst window — dedup is enforcing.
2. If `0`: dedup is over-aggressive (e.g. always returns false). Revert env (`set DISABLE_ERROR_ALERT_FANOUT 1`), investigate `classifyMessage` mapping or dedup-key writing logic.
3. If `>1`: dedup is under-aggressive. Revert env immediately, investigate dedup window config or `guardKey` shape.
4. 24h passive observation:
   - `_scheduled_jobs` latest-state `adminAlerts.notify` schedules per hour bounded by roughly `(distinct (source, messageClass)) × 2` (with 30-min dedup window). For the four initial classes + fallback in a non-incident day, this is on the order of tens of schedules per day, not thousands.
   - Compare with baseline `failed = 38` for `adminAlerts.js:notify` (drain-mode counter): expected to remain flat (handler no-op cannot fail), not spike.
5. Loop signature check: scan backend stdout for any `Too many concurrent` cluster correlated with `adminAlerts.notify` schedules in the same `±50ms` window. Expected: `0` such clusters. This is the canonical incident signature; its absence is the primary success criterion.
6. Hold for at least 24h before scheduling D1c.

**After D1c handler restore**

1. Synthetic burst (one-off script): expected `1` new `adminAlerts.notify` schedule + `1` Telegram message to admin chat in the burst window.
2. If schedule but no Telegram: handler logic broken. Revert handler file change.
3. If multiple Telegram messages from the burst: handler is firing duplicate sends per single schedule. Revert handler file change.
4. 24h observation: confirm no operator-reported alert spam, no Telegram rate-limit hits, no `Too many concurrent` recurrence in backend stdout.

## Out of scope (intentionally not opened by Tier 1)

- Migration of the 7 explicit `notify` callers (`syncMetrics:844`, `ruleEngine:2091`, `adAccounts:375`, `adAccounts:531`, `billing:542`, `billing:756`, `billing:922`). They stay with `runAfter(0)` and their existing per-call dedup logic.
- Periodic scanner cron / batched summary alerts (Option B). Tier 1.5.
- Unified `adminAlertQueue` table + cron drain (Option C). Tier 2.
- Severity tier rework (e.g., adding `fatal` level above `error`).
- Telegram message format / channel changes / email / push.
- Admin UI changes to view alert history.
- Audit of all `runAfter(0)` paths in the codebase. Separate concern.
- Lift of `SYNC_ESCALATION_ALERTS_ENABLED`. Separate decision with own canary.

## Open questions for implementer

- Should `DISABLE_ERROR_ALERT_FANOUT` env flag be retained as a kill-switch after Tier 1 is verified, or removed for cleanliness? Recommendation: **retain**. It is one line of code and provides a fast revert path for any future amplification surprise. Removing it is cosmetic and saves nothing.
- Should `messageClass` mapping live in code (constant in `systemLogger.ts`) or in a config DB row? Recommendation: **code constant**. Tier 1 has 4 patterns; making it config-driven adds a query per error log and is Tier 2 if it ever matters.
- Should the dedup window stay at 30 min, or be tunable per `messageClass`? Recommendation: **stay at 30 min** for Tier 1. Tunable-per-class is Tier 2.
- Should `source` and `messageClass` be persisted as separate columns in `systemLogs` to make the audit query and future migration easier? Recommendation: **out of scope for Tier 1**. The audit query can run `classifyMessage` at query time. Storing precomputed columns is Tier 2.

## Estimated effort (Tier 1, split per sub-step)

**D1a — code change session**

- Pre-implementation audit (read-only systemLogs query): 15 minutes.
- Code (helper + inline dedup): 30 minutes.
- Unit/integration tests (both gate states): 30 minutes.
- Typecheck + test run: 5 minutes.
- Deploy + post-deploy synthetic burst (expected `0`): 15 minutes.
- Total active work: ~1.5 hours in one non-emergency session.

**D1b — gate lift session (after D1a stabilized)**

- Synthetic burst (expected `1`): 10 minutes.
- 24h passive observation: 0 active minutes (just check counters at the 24h mark).
- Total active work: ~10 minutes spread across two checkpoints.

**D1c — handler restore session (after D1b 24h window passes clean)**

- Code (restore handler body, recover from git history pre-`f452348`): 30 minutes.
- Unit test for handler delivery: 15 minutes.
- Deploy + post-deploy synthetic burst (expected 1 schedule + 1 Telegram): 15 minutes.
- 24h passive observation: 0 active minutes.
- Total active work: ~1 hour.

**Tier 1 total**: ~2.5–3 hours active work, spread across three sessions over at least 2 calendar days (D1b 24h observation window gates D1c).

Tier 1.5 and Tier 2 effort is intentionally not estimated here. If Tier 1 closes the amplification signature and the dedup-coarsening trade-off is acceptable in production, Tier 1.5 may not be needed at all.

## Decision request

This document asks the operator only for the following decisions, each later, not now, and each separately:

1. After Phase 8 housekeeping is committed (already done: commit `c450737`), schedule a separate dedicated session to implement **D1a** (code change only, gate stays at `1`, handler stays no-op).
2. After D1a is stable in production, schedule **D1b** session (gate lift to `0`, handler still no-op). Hold for at least 24h passive observation before scheduling D1c.
3. After D1b 24h observation window passes clean, schedule **D1c** session (handler restore to deliver Telegram alerts again).
4. After D1c stabilizes for at least one week, evaluate whether Tier 1.5 (Option B periodic scanner) or Tier 2 (Option C unified queue) are needed. Re-evaluate based on whether the dedup-coarsening trade-off causes operator-reported alert fatigue, lost signal, or whether new error patterns emerge that the four-class mapping does not capture cleanly.

Anything beyond these four decisions is out of scope for this proposal.
