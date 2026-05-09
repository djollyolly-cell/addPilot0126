# Storage Cleanup V2 - Follow-ups Note - 2026-05-09

Status: **doc-only**. No runtime action, no code change in this note. Items
collected from Phase 4/5/6, emergency `maxRuns=8`, Gate B, and BD-1 runs.
Each item has a clear owner-style trigger; none is a runtime blocker for
BD-2 readiness rules in the BD-1 closure.

Source closures:

- Phase 6 Gate B: `memory/storage-cleanup-v2-phase6-gate-b-closure-2026-05-09.md`
  (commit `1074adf`).
- BD-1 (this note): `memory/storage-cleanup-v2-bd-1-closure-2026-05-09.md`
  (commit `71ceb87`).
- Bulk-drain plan: `memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`
  (commit `e8cee10`).

## 1. launchd late-fire — do not use launchd for timing-critical env touch

**What we observed.** Gate B prior attempt (2026-05-09T00:00:00Z, 03:00 МСК)
required `METRICS_REALTIME_CLEANUP_V2_ENABLED=1` to be set before the cron's
6-h boundary. The launchd-driven env-on fired at 00:04:50Z — **+4:50 late**.
The wrapper had already fired at 00:00:00.045Z reading env=0 and returned
the disabled-env path. Gate B was effectively missed (not dirty: env returned
to 0, no `cleanupRunState` row, no scheduled-functions side-effects).

**Why it matters.** Cron boundaries are precise (drift +20 ms observed in
the eventual successful Gate B). launchd `StartCalendarInterval` jobs can
fire late by minutes when the host is asleep, throttled, or the daemon
itself is queued. A several-minute miss is enough to make the env-on land
**after** the boundary, breaking the gate.

**Recommendation (no code change):**

- For **timing-critical env flips** that must land before a known cron
  boundary, do **not** use launchd. Use one of:
  1. Manual `npx convex env set` issued by the operator within a known-
     stable terminal session, ≥2 min before the boundary.
  2. An agent-driven Bash script that computes the UTC target via
     `python3 -c "...datetime..."`, then waits on the target via a
     `until [ "$(date -u +%s)" -ge "$TARGET" ]; do sleep <small>; done`
     loop, then issues `npx convex env set`. This is what was used
     successfully for Gate B retry on 2026-05-09T05:57:04Z (drift 0; 0:04
     before the 06:00:00Z cron tick).
  3. For pure post-tick env-off (no boundary precision required), launchd
     is acceptable, but still worse than agent-driven cleanup directly
     after the chain terminal.

- Do **not** return launchd to timing-critical env-on path until the prior
  late-fire is diagnosed. Likely contributors to investigate (when worth
  the cost): macOS sleep/wake state, launchd plist throttling settings
  (`ProcessType`, `LowPriorityIO`), daemon queue saturation at the boundary
  minute.

**Trigger:** if any future Gate / BD step requires env-on at a precise
boundary, follow recommendation (1) or (2). If launchd is being considered
again, this note is the gate.

## 2. Heartbeat watcher–cadence mismatches in `convex/healthCheck.ts`

**What we observed.** The heartbeat watcher in `convex/healthCheck.ts` uses
`maxStaleMin` thresholds that are **shorter than the actual cron cadences**
for at least two heartbeats. Result: the watcher fires alarms during the
expected stale window between cron fires.

| Heartbeat | Cron source | Cron cadence | Watcher source | Watcher `maxStaleMin` | Alarm window per cycle |
|---|---|---:|---|---:|---|
| `sync-metrics` (`syncDispatch`) | `convex/crons.ts:37–41` | 15 min | `convex/healthCheck.ts:79` | 10 | ~5 of 15 min (≈33%) |
| `uz-budget-increase` (`uzBudgetDispatch`) | `convex/crons.ts:127–131` | 45 min | `convex/healthCheck.ts:80` | 15 | ~30 of 45 min (≈67%) |

**Concrete examples from BD-1 audit (06:44:49Z and 06:51:47Z):**

- `sync-metrics: отстаёт (11 мин)` at 06:44:49 → cleared by 06:51:47
  (caught up on next 15-min tick).
- `uz-budget-increase: отстаёт (33 мин)` at 06:44:49 → grew to `40 мин`
  by 06:51:47 → cleared after the next cron fire at 06:57:10Z.

In both cases the underlying scheduler was healthy (workers spawned,
heartbeat updated on next fire). The alarms were noise.

**Recommendation (code change, deferred):**

- `convex/healthCheck.ts:79` (sync): `maxStaleMin: 10` → `maxStaleMin: 25`
  (15 min cadence + 10 min headroom).
- `convex/healthCheck.ts:80` (UZ increase): `maxStaleMin: 15` → `maxStaleMin: 60`
  (45 min cadence + 15 min headroom).

Headroom of ~10–15 min above cadence handles single missed ticks (worker
overlap, V8 saturation spike) without firing a false alarm; a regression
that misses **two** consecutive fires will still trigger.

**Trigger:** apply the code fix in a separate doc-only-paired commit on a
quiet day after BD-2. Until then, use the **alarm attribution rule** in
the BD-1 closure (BD-2 Readiness Rules section) to filter expected from
real alarms during pre-flights.

**Cross-reference for the future agent:** if the cron cadence is ever
shortened back (e.g. UZ V2 returns to 5 min after backlog risk clears),
re-tune `maxStaleMin` accordingly. The principle is `maxStaleMin = cadence
+ ~10–15 min headroom`; do not pin the threshold to a number unrelated to
the actual cadence.

## 3. Heartbeat update-lag artifact (UZ)

**What we observed.** During BD-1 audit at 06:44:49Z, the watcher reported
`uz-budget-increase: отстаёт (33 мин)` while the most recent UZ workers
in `_scheduled_functions` had `startedAt = 06:32:10Z` — only ~12.5 min
before the audit. The watcher's number (33 min) does not match the
expected lag from the most recent fire (~12 min), suggesting the heartbeat
row's `startedAt` field reflected an earlier cycle's value rather than
the 06:32:10 fire.

Hypothesis (unverified):

- The 06:32:10 dispatcher fire may have hit the `tryAcquireHeartbeat`
  branch logic (`convex/ruleEngine.ts:3406-3426`) in a way that the
  initial `upsertCronHeartbeat({ status: "running" })` succeeded, but the
  `finally`-block `upsertCronHeartbeat({ status: "completed" })` did not
  materialize (or wrote with an unexpected `startedAt`). Convex action
  timeout, mutation batching, or transient backend pressure are possible
  contributors.

- Workers spawned cleanly (visible in `_scheduled_functions`), so the
  dispatcher's body executed past `dispatchUzBatchesV2`. The artifact is
  in the heartbeat write path, not the work path.

**Recommendation (read-only investigation, deferred):**

- Read the heartbeat row schema (`internal.syncMetrics.upsertCronHeartbeat`,
  `internal.syncMetrics.getCronHeartbeat`) and the `tryAcquireHeartbeat`
  helper to confirm whether the watcher uses `startedAt` or some other
  field for staleness computation.
- Check whether the heartbeat row at 06:32:10 fire actually moved or
  stayed at the previous `startedAt`. If it stayed, the `finally`-block
  upsert is the suspect; instrument it.
- Cross-check against any known Convex backend errors at 06:32:10Z (none
  visible in BD-1 audit's stdout grep).

**Trigger:** investigate when there is bandwidth; pair with item 2 if the
fix touches the same area. Not a runtime blocker.

## 4. UZ dispatcher schedule drift (45 / 25 min gaps)

**What we observed.** UZ V2 dispatcher fires (inferred from
`uzBudgetBatchWorkerV2` `startedAt` in `_scheduled_functions`) over the
BD-1 window:

```
05:47:10Z  →  06:32:10Z   (gap 45 min — cadence)
06:32:10Z  →  06:57:10Z   (gap 25 min — non-cadence)
```

The cron is registered as `crons.interval({ minutes: 45 }, ...)` so 45-min
gaps are expected; the 25-min gap is anomalous.

Likely causes (not verified):

- **Cron timer reset on deploy.** Two deploys landed during the BD-1
  window's day: `e8cee10` (bulk-drain plan, ~05:00Z) and `1074adf`
  (Gate B closure, ~06:13Z). Convex cron registration recomputes intervals
  on deploy, which can effectively "reset" the next-fire time, producing
  shorter-than-cadence gaps right after a deploy.
- **`tryAcquireHeartbeat` `takeover_stale` branch.** If a previous
  dispatcher was still in `running` state and aged past the
  `UZ_DISPATCH_SAFETY_TIMEOUT_MS` (60 s), the branch warns and proceeds —
  effectively re-scheduling early. Less likely here (60-s threshold is
  short and the dispatcher itself completes in <5 s).

**Recommendation:** no action required. Drift will normalize once deploys
stop landing inside cron windows. If the 25-min gap pattern persists for
multiple cycles with no deploys, escalate to item 3 investigation.

## Putting items 1–4 together

These four items are independent in cause but share a common audit lens:
**watcher and scheduler signals must be interpreted in context of cadence
and recent deploys**. Two of them (items 2 and 3) directly affect heartbeat
attribution; items 1 and 4 affect the timing of cron / env interactions.

The BD-1 closure's **alarm attribution rule** (BD-2 Readiness Rules section)
is the operational substitute for items 2–3 until code changes land.

Items 1 and 4 do not gate BD-2: BD-2 trigger does not depend on launchd,
and a single deploy-induced 25-min UZ gap is not material to BD-2 V2
contract.

## Open code-change candidates (for the next quiet maintenance window)

1. `convex/healthCheck.ts:79` — `maxStaleMin: 10` → `maxStaleMin: 25` (sync).
2. `convex/healthCheck.ts:80` — `maxStaleMin: 15` → `maxStaleMin: 60` (UZ).
3. (Optional, conditional on item 3 investigation) — instrument
   `convex/ruleEngine.ts:3462–3468` `finally`-block heartbeat upsert with
   a sanity assertion or log line confirming the write completed.

Each is independent; first two can ship together as one small PR. None is
expected to change runtime behaviour beyond noise reduction in the
heartbeat panel.
