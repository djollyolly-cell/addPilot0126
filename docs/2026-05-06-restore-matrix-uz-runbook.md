# Convex recovery restore matrix + UZ runbook

Date: 2026-05-06
Branch: `emergency/drain-scheduled-jobs`
Scope: emergency recovery after the 2026-05-04/05 Convex scheduled jobs incident.

This document is an operator runbook. It does not authorize any gate change by itself.
Every prod-touching command still requires an explicit human go.

## Current operating posture

- Sync V2 is live after throughput bumps:
  - `SYNC_METRICS_V2_ENABLED=1`
  - `SYNC_WORKER_COUNT_V2=2`
  - `SYNC_BATCH_SIZE_V2=20`
  - `SYNC_METRICS_V2_POLL_MODERATION=0`
  - `SYNC_ESCALATION_ALERTS_ENABLED=0`
- The emergency branch contains a prepared `sync-metrics` cadence change
  (`45 min -> 15 min`) in `ffdd32b`, but it must not be deployed until the
  D2a watch closes clean and an explicit deploy go is given.
- UZ V2 cron is registered at `45 min` and is live after business go:
  - `UZ_BUDGET_V2_ENABLED=1`
  - first organic production tick at `2026-05-06T12:12:10Z` closed clean
- Token refresh V2 is live.
- `DISABLE_ERROR_ALERT_FANOUT=1` remains on.
- Do not restore V1 sync or V1 UZ crons.
- Do not restore `recordRateLimit` in the old per-response scheduled-job form.
- Do not restore `adminAlerts.notify` as part of UZ/sync recovery.

## Restore matrix

| Area | Current state | User impact | Can restore today? | Required trigger | Risk | Runbook |
|---|---|---:|---:|---|---|---|
| Sync metrics V2 | Live after throughput bumps (`worker=2`, `batch=20`); `15 min` cadence prepared but not deployed | High | Already reopened; cadence deploy pending D2a closure | Organic ticks pass acceptance criteria | Medium: WAL/V8 pressure | Keep monitoring; no manual sync trigger |
| UZ budget V2 | Live after first clean organic tick | High for active UZ rules | Already opened | Business/ops confirmed unattended budget actions at `2026-05-06T11:35Z` | Medium: real VK budget changes and Telegram notifications | Monitor second organic tick with same criteria |
| Token refresh V2 | V2 live; V1 `auth.tokenRefreshOne` stays no-op | High | Already restored | Continued clean 2h ticks | Medium during overlap windows | Monitor `09:09Z`, `11:09Z`, etc.; do not restore V1 before a separate historical-backlog purge decision |
| Safe cleanup crons restored in Phase 1 | Live | Medium | Already restored | N/A | Low | Keep as-is |
| Billing/subscription crons | Disabled except `cleanup-stuck-payments` | Medium/high if renewals/expiry need automation | Candidate after sync + UZ are calm | Explicit product decision for billing automation | Medium: user-visible billing state changes | Separate one-cron-at-a-time runbook |
| Digests/reports | Disabled | Medium | Candidate after core ops | Need product decision; not incident-critical | Low/medium: message fan-out | Restore later, one cadence at a time |
| Token health check | Disabled | Medium | Candidate after core ops | Need monitoring value vs added VK calls | Medium: API calls + notifications | Separate gate preferred |
| Metrics cleanup crons | Mostly disabled | Low direct, high storage over time | Candidate after 24h calm | Need storage pressure signal | Medium: deletes/WAL | Restore with conservative batch/window |
| AI/creative/recommendation crons | Disabled | Feature-specific | Not first wave | Usage pressure from feature owners | Medium/high: API/action fan-out | Separate canary |
| UZ reset cron | Disabled | Medium for UZ accounting | After UZ unattended is stable | UZ owner confirms reset correctness needed | Medium | Separate from UZ increase |
| Video rotation tick | Disabled | Feature-specific | After core ops | Usage pressure | Medium: 5-min cadence | Needs cadence review |
| Moderation poll in sync | `SYNC_METRICS_V2_POLL_MODERATION=0` | Feature-specific | Not now unless needed | Creative moderation usage signal | Medium: extra VK/API work inside sync | Enable only after sync stable |
| Sync escalation alerts | `SYNC_ESCALATION_ALERTS_ENABLED=0` | Admin visibility only | No | Requires alert redesign | High: can schedule `adminAlerts.notify` | Last wave |
| `adminAlerts.notify` | no-op, fan-out disabled | Admin visibility only | No | Bounded alert redesign | High: known amplification loop | Last wave |
| `vk-throttling-probe` cron | Disabled | Observability only | No | Same bounded telemetry redesign as `recordRateLimit` | High: creates VK calls and writes through `recordRateLimit` | Keep disabled until `recordRateLimit` V2 exists |
| `recordRateLimit` | D2a deployed under observation: direct 429-only mutation; old scheduled per-response form forbidden | Observability only | D2a code restored; broader D2b/D2c deferred | D2a 3h canary closes clean | Medium if kept 429-only; high if expanded without redesign | Do not restore `vk-throttling-probe` or 200-response sampling until a separate runbook |
| Merge emergency branch to `main` | Not ready | Engineering hygiene | No | After cleanup strategy | High if V1 handlers accidentally restored | Separate checklist |

## Rule-adjacent cron restore queue

This section tracks cron-backed rule/automation behavior that is still disabled
after the emergency drain. It is intentionally separate from the D2a watch and
from the sync cadence `45 -> 15 min` deploy.

### What still works through `sync-metrics`

The ordinary rule-evaluation path is not one cron per rule type. The active
`sync-metrics` V2 pipeline evaluates the normal rules after account metrics sync.
This covers the current set of standard rule types that depend on rule
evaluation cadence. The prepared cadence change to `15 min` is the latency fix
for that path.

### Restore priority after D2a and sync cadence closure

Do not bundle these restores with D2a, sync cadence deploy, D1, or D2. Each item
requires its own short runbook, commit, deploy go, and observation window.

| Priority | Cron | Current state | Why it matters | Required next artifact | First safe shape |
|---:|---|---|---|---|---|
| R1 | `uz-budget-reset` (`internal.uzBudgetCron.resetBudgets`) | Disabled/commented | UZ daily reset lifecycle is incomplete; reset does not run for any user. | `docs/2026-05-07-uz-budget-reset-restore-runbook.md` | Restore the existing `30 min` cron only after preflight verifies active reset rules, stale/pending jobs, and rollback signals. |
| R2 | `video-rotation-tick` (`internal.videoRotation.tick`) | Disabled/commented | `video_rotation` rules do not get periodic switching/self-healing while the tick is off. | `docs/2026-05-07-video-rotation-tick-restore-runbook.md` | Do not blindly restore the old `5 min` cadence. First count active rotation rules/states and decide cadence/business go. |

### R1 outline: `uz-budget-reset`

Goal: restore the existing reset cron without changing UZ increase cadence.

Preflight must answer:

- How many active `uz_budget_manage` rules have `resetDaily=true`?
- How many target accounts/campaigns can be touched by one reset window?
- Are there any pending/in-progress historical `uzBudgetCron.resetBudgets`
  scheduled jobs?
- Are recent UZ increase ticks still clean (`error=null`, V2 failed `0`)?
- Are backend rollback greps, `/version`, and byte-exact `pg_wal` baseline clean?

Expected code shape:

```ts
crons.interval(
  "uz-budget-reset",
  { minutes: 30 },
  internal.uzBudgetCron.resetBudgets,
);
```

Watch after deploy:

- first organic reset tick heartbeat completes with `error=null`;
- `actionLogs` contains expected `budget_reset` rows and `0` failures/reverts;
- backend stdout has `0` rollback patterns;
- V2 failed counters stay flat;
- `pg_wal` delta remains below the same conservative restore thresholds.

Rollback: comment the cron again, deploy, and verify the next scheduler state does
not register new reset jobs.

### R2 outline: `video-rotation-tick`

Goal: restore periodic rotation only if the product/business owner confirms that
active `video_rotation` users need it now.

Preflight must answer:

- How many active `video_rotation` rules exist?
- How many `rotationState` rows are active/orphaned?
- How much VK write fan-out can one tick create?
- Is the old `5 min` cadence still required, or should restore start at a lower
  cadence with a canary account/user?

This cron is side-effecting: it can stop/start VK campaigns and send user
notifications. Restore it after `uz-budget-reset` unless product priority says
otherwise, and never in the same deploy as reset.

## UZ unattended runbook

### Observed production restore result

Business go was received on `2026-05-06`, with explicit acknowledgement that UZ makes real VK Ads budget changes and sends user-facing Telegram notifications.

Gate action:

- `UZ_BUDGET_V2_ENABLED 0 -> 1` at approximately `2026-05-06T11:35Z`.
- No manual UZ trigger was run.
- No sync/token/adminAlerts/recordRateLimit gates were changed.

First organic UZ production tick:

- `uzBudgetDispatch` heartbeat started `2026-05-06T12:12:10.525Z`, finished `2026-05-06T12:12:10.674Z`, `status=completed`, `error=null`.
- `ruleEngine.js:uzBudgetBatchWorkerV2` total success moved `6 -> 8`; failed remained `0`.
- `adminAlerts.js:notify` schedules in the UZ window: `0`.
- `systemLogs` error level during the UZ worker window through `12:18Z`: `0`.
- Backend rollback-pattern grep in `12:10Z..12:25Z`: `0` for `Too many concurrent`, `Transient error`, `TOKEN_EXPIRED`, `[uzBatchV2#.*] Account .* failed`, and `syncBatchV2.*Account .* failed`.
- Exact `pg_wal`: `1,627,389,952 -> 1,627,389,952` bytes, delta `0`.
- Failed counters stayed on baseline: `adminAlerts.js:notify=38`, `syncMetrics.js:syncBatchWorker=37`, `ruleEngine.js:uzBudgetBatchWorker=36`, `auth.js:tokenRefreshOneV2=14`, `metrics.js:manualMassCleanup=1`, `ruleEngine.js:uzBudgetBatchWorkerV2 failed=0`.
- `/version`: HTTP `200`.
- ActionLogs audit for `12:10Z..12:55Z`: `216` `budget_increased|success`, `0` failed/reverted budget actions, across `7` users, `19` accounts, `20` rules, `216` ads. No `budget_reset` or `zero_spend_alert` rows in the window.

Post-UZ sync tick:

- `syncDispatch` at `2026-05-06T12:19:10Z` closed clean by sync hard criteria: heartbeat completed/error null, `syncBatchWorkerV2 success=9`, failed counters flat, adminAlerts `0`, backend rollback grep `0`.
- Secondary yellow note: `systemLogs` later recorded one `syncMetrics` error at `2026-05-06T12:20:12Z` (`checkRulesForAccount failed: request timed out`). This was after UZ workers had completed and is not a UZ rollback trigger, but it should be watched on later sync ticks.

Current status:

- First UZ organic production tick is clean.
- Second UZ organic production tick is also clean:
  - `uzBudgetDispatch` started `2026-05-06T12:57:10.529Z`, finished `2026-05-06T12:57:10.665Z`, `status=completed`, `error=null`.
  - `ruleEngine.js:uzBudgetBatchWorkerV2` total success moved `8 -> 10`; failed remained `0`.
  - Backend rollback-pattern grep in `12:55Z..13:35Z`: `0`.
  - `adminAlerts.js:notify`: `0`.
  - `systemLogs` error level: `0`.
  - Exact `pg_wal` stayed `1,627,389,952` bytes.
  - Failed counters stayed on baseline.
  - `/version`: HTTP `200`.
  - ActionLogs audit for `12:55Z..13:35Z`: `89` `budget_increased|success`, `0` failed/reverted budget actions.
- Keep `UZ_BUDGET_V2_ENABLED=1` unless business asks to pause.
- The following `13:09Z` token refresh dispatcher stayed clean; watch the next sync ticks for repeats of the `12:20Z` `syncMetrics` timeout before restoring additional side-effecting crons.
- The backend did not expose custom `[uzBudgetDispatchV2]` / `[uzBatchV2#N] Done:` console lines in `docker logs`; worker completion was verified through `_scheduled_jobs` and actionLogs instead.

### Purpose

Enable `uz-budget-increase` unattended production mode using the already deployed V2 cron:

```ts
crons.interval("uz-budget-increase", { minutes: 45 }, internal.ruleEngine.uzBudgetDispatchV2)
```

This is not a code deploy. The only intended prod change is:

```text
UZ_BUDGET_V2_ENABLED=0 -> 1
```

### Preconditions

All must be true:

- Explicit human go for UZ unattended.
- Sync V2 remains live and clean in conservative profile.
- Last token refresh checkpoint clean enough for the current window.
- `UZ_BUDGET_V2_ENABLED=0` immediately before opening.
- `SYNC_METRICS_V2_ENABLED=1`.
- `SYNC_WORKER_COUNT_V2=1`.
- `SYNC_BATCH_SIZE_V2=10`.
- `SYNC_METRICS_V2_POLL_MODERATION=0`.
- `SYNC_ESCALATION_ALERTS_ENABLED=0`.
- `DISABLE_ERROR_ALERT_FANOUT=1`.
- No manual UZ trigger after opening the gate.
- No sync manual trigger.
- No deploy/codegen/push as part of this runbook.
- At least two clean live sync ticks after `SYNC_METRICS_V2_ENABLED` was reopened, unless the operator explicitly accepts UZ as an overlap canary.
- Current `cronHeartbeats[name=uzBudgetDispatch]` is `completed`, not `running`. If it is `running`, investigate before opening the gate.

### Pre-open read-only baseline

Capture current UTC time:

```bash
date -u
```

Check service:

```bash
curl --resolve convex.aipilot.by:443:178.172.235.49 \
  -sS -o /tmp/convex-version-before-uz-open.out \
  -w '%{http_code} %{time_total}\n' \
  https://convex.aipilot.by/version
```

Check env guards:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get UZ_BUDGET_V2_ENABLED

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_METRICS_V2_ENABLED

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get SYNC_ESCALATION_ALERTS_ENABLED

CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get DISABLE_ERROR_ALERT_FANOUT
```

Expected:

```text
UZ_BUDGET_V2_ENABLED=0
SYNC_METRICS_V2_ENABLED=1
SYNC_ESCALATION_ALERTS_ENABLED=0
DISABLE_ERROR_ALERT_FANOUT=1
```

Capture heartbeats:

```bash
node check-token-refresh-tick.cjs
```

Confirm `uzBudgetDispatch` heartbeat specifically:

```bash
node check-uz-tick.cjs <recent-window-start-iso> <now-iso>
```

Expected before opening:

```text
cronHeartbeats[name=uzBudgetDispatch].status = completed
cronHeartbeats[name=uzBudgetDispatch].error = null
```

If status is `running`, do not open UZ yet. The V2 dispatcher has a fresh-running guard and may skip the first organic tick instead of dispatching workers.

Capture exact WAL baseline:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal"
```

Optional latest-state scheduled-job map, if not already captured by the `check-uz-tick.cjs` call above:

```bash
node check-uz-tick.cjs <recent-window-start-iso> <now-iso>
```

Capture active UZ rule/account baseline. Rule type is `uz_budget_manage`.
Expected UZ V2 worker count is `min(2, unique_accounts)` because `UZ_WORKER_COUNT_V2` is clamped at `2`.

```bash
node -e '
const { execSync } = require("child_process");
const adminKey = execSync("node gen-admin-key.cjs").toString().trim();
(async () => {
  const resp = await fetch("https://convex.aipilot.by/api/list_snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Convex " + adminKey },
    body: JSON.stringify({ tableName: "rules" }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const json = await resp.json();
  const rows = json.values || json.results || json.documents || json;
  const rules = Array.isArray(rows) ? rows : (rows.values || []);
  const activeUz = rules.filter((r) => r.type === "uz_budget_manage" && r.isActive);
  const accounts = new Set(activeUz.flatMap((r) => r.targetAccountIds || []));
  const users = new Set(activeUz.map((r) => r.userId));
  console.log(JSON.stringify({
    activeUzRules: activeUz.length,
    users: users.size,
    uniqueAccounts: accounts.size,
    expectedWorkers: Math.min(2, accounts.size),
  }, null, 2));
})();
'
```

Sanity-check token readiness for active UZ accounts before opening:

- Active UZ rules should target accounts with current VK Ads tokens. Use `adAccounts` admin snapshot or an existing diagnostic query; do not guess from historical logs.
- `tokenRefreshOneV2` failed counter should remain at the known baseline (`14`) and should not grow during UZ.
- If a large share of UZ target accounts has missing/expired tokens, do not open UZ before deciding whether this is acceptable business behavior.

Baseline failed counters to compare after the tick:

```text
adminAlerts.js:notify failed = 38
syncMetrics.js:syncBatchWorker failed = 37
ruleEngine.js:uzBudgetBatchWorker failed = 36
auth.js:tokenRefreshOneV2 failed = 14
metrics.js:manualMassCleanup failed = 1
ruleEngine.js:uzBudgetBatchWorkerV2 failed = 0, success = 6
```

### Open gate

Only after explicit go:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set UZ_BUDGET_V2_ENABLED 1
```

Immediately verify:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get UZ_BUDGET_V2_ENABLED
```

Expected:

```text
1
```

Do not run `ruleEngine:uzBudgetDispatchV2` manually after opening. The first run must be an organic cron tick.

### Expected first organic tick

The UZ cron interval is `45 min`. The first real run can happen at the next Convex scheduler tick after the env change; do not assume exact wall-clock alignment.

Overlap note:

- Sync V2 and UZ V2 both run every `45 min`.
- Token refresh runs every `2h` and can occupy slots for several minutes through staggered workers.
- A worst-case window can include token refresh workers, one sync worker, and two UZ workers.
- UZ V2 workers may run for up to `25 min` (`UZ_WORKER_TIMEOUT_MS_V2`), so the overlap risk window extends for at least 25 minutes after the UZ dispatcher starts. The next sync tick is 45 minutes later and can still land near the tail of a slow UZ worker.
- Either open UZ in a window where the first UZ tick is unlikely to land on the token refresh `xx:09Z` window, or explicitly treat the first UZ tick as an intentional overlap canary.
- Do not combine UZ opening with any concurrency, sync worker/batch, moderation, alert, or telemetry change.

Timeout/heartbeat note:

- `uzBudgetDispatch` heartbeat tracks the dispatcher only. The dispatcher normally finishes in `<5s`.
- `UZ_DISPATCH_SAFETY_TIMEOUT_MS=60s` is only the stale-dispatcher takeover threshold.
- Worker completion is separate and must be verified via backend stdout and `_scheduled_jobs`.
- A backend log line like `[uzBudgetDispatchV2] takeover: stale running heartbeat ...` is a warning and should be recorded, but it is not a rollback trigger by itself if the new run completes cleanly.

Expected behavior:

- `cronHeartbeats[name=uzBudgetDispatch]` updates.
- `status=completed`.
- `error=null`.
- `ruleEngine.js:uzBudgetBatchWorkerV2` success count increments.
- `ruleEngine.js:uzBudgetBatchWorkerV2` failed count remains `0`.
- Backend stdout shows `[uzBudgetDispatchV2] Dispatched N V2 batch workers for X accounts (Y rules)`, and `N` matches the expected worker count.
- Every dispatched worker emits one final `[uzBatchV2#N] Done: X processed, 0 errors out of Z` line.
- Backend stdout has:
  - `0` `Too many concurrent`
  - `0` `Transient error`
  - `0` unexpected `TOKEN_EXPIRED`
  - `0` lines matching `[uzBatchV2#.*] Account .* failed`
- `adminAlerts.js:notify` schedules in the UZ tick window: `0`.
- `systemLogs` error-level records in window: `0`.
- `pg_wal` delta from the exact pre-open/tick baseline is `< 50 MB`.
- `/version` remains `HTTP 200`.

Real side effects are expected:

- VK Ads budget operations may run according to active UZ rules.
- Telegram/user-facing budget notifications may be sent by UZ business logic.
- These are not rollback criteria by themselves if they correspond to active rules.

Notification/catch-up note:

- `uzBudgetDispatchV2` evaluates active UZ rules at tick time by loading current active rules and current campaign/account state.
- It does not replay missed cron schedules from the offline window.
- A notification burst is still possible if many active rules are currently eligible at the first tick, but that is fresh evaluation, not scheduled backlog catch-up.
- Validate the business result through `actionLogs`, not only infra criteria.

### Post-tick verification

Use an explicit window around the observed UZ heartbeat. Because UZ workers can run up to `25 min`, use at least a `35 min` window after dispatcher start; `40 min` is safer if the tick overlaps token refresh or sync. Example:

```bash
node check-uz-tick.cjs 2026-05-06T10:00:00Z 2026-05-06T10:40:00Z
```

Add explicit backend stdout checks for worker-level failures and worker completion:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker logs adpilot-convex-backend --since <window-start-iso> --until <window-end-iso> 2>&1 \
   | grep -cE '\\[uzBatchV2#[0-9]+\\] Account .* failed|Too many concurrent|Transient error|TOKEN_EXPIRED' || true"

ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker logs adpilot-convex-backend --since <window-start-iso> --until <window-end-iso> 2>&1 \
   | grep -E '\\[uzBudgetDispatchV2\\] Dispatched|\\[uzBatchV2#[0-9]+\\] Done:' || true"
```

Also check current heartbeats:

```bash
node check-token-refresh-tick.cjs
```

Check service:

```bash
curl --resolve convex.aipilot.by:443:178.172.235.49 \
  -sS -o /tmp/convex-version-after-uz-tick.out \
  -w '%{http_code} %{time_total}\n' \
  https://convex.aipilot.by/version
```

Check exact WAL after the tick:

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  "docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal"
```

Audit real UZ business actions in `actionLogs` for the tick window. Convex tables are not ordinary Postgres tables, so use Convex admin snapshot or an existing Convex query/diagnostic, not `SELECT * FROM actionLogs` against Postgres.

```bash
WINDOW_START_MS=<window_start_ms> WINDOW_END_MS=<window_end_ms> node -e '
const { execSync } = require("child_process");
const adminKey = execSync("node gen-admin-key.cjs").toString().trim();
const start = Number(process.env.WINDOW_START_MS);
const end = Number(process.env.WINDOW_END_MS);
(async () => {
  const resp = await fetch("https://convex.aipilot.by/api/list_snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Convex " + adminKey },
    body: JSON.stringify({ tableName: "actionLogs" }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const json = await resp.json();
  const rows = json.values || json.results || json.documents || json;
  const logs = Array.isArray(rows) ? rows : (rows.values || []);
  const uz = logs
    .filter((l) => l.createdAt >= start && l.createdAt <= end)
    .filter((l) => ["budget_increased", "budget_reset", "zero_spend_alert"].includes(l.actionType));
  const counts = {};
  for (const l of uz) counts[`${l.actionType}|${l.status}`] = (counts[`${l.actionType}|${l.status}`] || 0) + 1;
  console.log("counts", JSON.stringify(counts, null, 2));
  console.log("samples", JSON.stringify(uz
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map((l) => ({
      time: new Date(l.createdAt).toISOString(),
      ruleId: l.ruleId,
      accountId: l.accountId,
      actionType: l.actionType,
      status: l.status,
      savedAmount: l.savedAmount,
      reason: String(l.reason || "").slice(0, 180),
      errorMessage: l.errorMessage || null,
    })), null, 2));
})();
'
```

The goal is to confirm that real budget changes match active UZ rule expectations.

### Acceptance criteria

All must hold for the first organic tick:

- `uzBudgetDispatch` heartbeat completed, `error=null`, in the observed window.
- `ruleEngine.js:uzBudgetBatchWorkerV2` success increments by the expected worker count.
- `ruleEngine.js:uzBudgetBatchWorkerV2` failed remains `0`.
- Backend stdout contains the expected `[uzBudgetDispatchV2] Dispatched N V2 batch workers for X accounts (Y rules)` line.
- Backend stdout contains one `[uzBatchV2#N] Done: X processed, 0 errors out of Z` line per dispatched worker.
- Backend stdout has `0` lines matching `[uzBatchV2#.*] Account .* failed`.
- Backend stdout has `0` `Too many concurrent`.
- Backend stdout has `0` `Transient error`.
- Backend stdout has `0` unexpected `TOKEN_EXPIRED`.
- `adminAlerts.js:notify` schedules in the window = `0`.
- `systemLogs` error level in the window = `0`.
- Exact `pg_wal` delta in the UZ window is `< 50 MB`.
- Existing failed counters do not grow from the baseline:
  - `adminAlerts.js:notify failed=38`
  - `syncMetrics.js:syncBatchWorker failed=37`
  - `ruleEngine.js:uzBudgetBatchWorker failed=36`
  - `auth.js:tokenRefreshOneV2 failed=14`
  - `metrics.js:manualMassCleanup failed=1`
  - `ruleEngine.js:uzBudgetBatchWorkerV2 failed=0`
- `actionLogs` audit shows any `budget_increased` rows are expected by active UZ rules and have acceptable `status`.
- `/version` remains `HTTP 200`.

### Rollback triggers

Any one means close UZ immediately and do not retry before analysis:

- `uzBudgetDispatch` heartbeat `failed` or `error != null`.
- Any new `ruleEngine.js:uzBudgetBatchWorkerV2` failed.
- Any backend stdout line matching `[uzBatchV2#.*] Account .* failed`.
- Any dispatched worker has a final `Done:` line with non-zero errors.
- Missing `Done:` lines after a full 35-40 minute verification window, unless analysis proves the worker is still legitimately running and below timeout.
- Any backend stdout `Too many concurrent`.
- Any backend stdout `Transient error`.
- Unexpected `TOKEN_EXPIRED` burst correlated with UZ.
- Any `adminAlerts.js:notify` schedule in the UZ window.
- New `systemLogs` error-level records caused by UZ.
- `pg_wal` delta `>= 50 MB` in the first UZ tick window.
- `actionLogs` show unexpected budget increases, unexpected failed budget actions, or clear mismatch with active rules.
- Backend `/version` stops returning `HTTP 200`.
- Clear business-side incorrect budget action.

Rollback:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set UZ_BUDGET_V2_ENABLED 0
```

Verify rollback:

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get UZ_BUDGET_V2_ENABLED
```

Expected:

```text
0
```

### After first clean UZ tick

If the first organic tick is clean:

- Keep `UZ_BUDGET_V2_ENABLED=1` unless business wants manual pause.
- Monitor the second organic UZ tick with the same criteria.
- Do not combine with concurrency bump, sync worker/batch bump, moderation poll, `recordRateLimit`, or `adminAlerts` restore.
- Update:
  - `memory/phase-6-sync-canary-status.md` or a new UZ status memory note.
  - `docs/2026-05-05-convex-recovery-plan-execution-report.md`.

## Candidate sequencing after UZ

Recommended emergency order:

1. Confirm sync second live tick after reopen.
2. Open UZ only with explicit business go.
3. Observe first and second organic UZ ticks.
4. Restore selected safe crons one at a time.
5. Revisit concurrency `8 -> 16` only after the service has stayed clean under real user-facing jobs.
6. Revisit sync throughput only after concurrency is stable.
7. Defer `recordRateLimit` to a bounded telemetry redesign.
8. Defer `adminAlerts.notify` and sync escalation alerts to the final alerting redesign wave.
