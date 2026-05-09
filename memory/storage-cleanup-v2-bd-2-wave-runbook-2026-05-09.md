# Storage Cleanup V2 - BD-2 Wave Runbook - 2026-05-09

**Status: safe fallback operating procedure.** Not an escalation plan. Not
an authorization to ramp.

This runbook describes how to fire **one** BD-2-profile drainage wave at a
time, manually, with explicit operator go and a closure. It exists so that
the next operator (or a future-you under time pressure) does not have to
reassemble the procedure from five separate closure documents.

## Scope

- **Profile (frozen for this runbook):**
  ```
  batchSize    = 1000
  timeBudgetMs = 10000
  restMs       = 90000
  maxRuns      = 8
  ```
- **One wave per go.** No automation. No back-to-back waves without a
  fresh BD-0-lite + closure between them.
- **Manual env-touch only.** No launchd. No cron-driven `restMs<90` /
  `batchSize>1000`. No BD-4.

If you find yourself wanting to change any value in the profile or chain
two waves without a closure — **stop**. That is a different decision and
needs the bulk-drain plan, not this runbook.

## Forbidden moves (hard rules)

- **No `restMs < 90_000`.** Frozen by BD-3 dirty closure (`358663a`)
  pending verification of Hypothesis C (PG tombstone accumulation). See
  `memory/storage-cleanup-v2-bd-3-investigate-2026-05-09.md` (commit
  `2e18962`).
- **No `batchSize > 1000`.** Frozen by BD-2 repeat closure caveat
  (`7d10154`) — max-chunk drift +207 ms across two BD-2 runs at this
  batch size; further increase has no headroom.
- **No BD-4 (cron-driven drainage at this profile).** Frozen by the
  BD-3 dirty closure.
- **No `npx convex run metrics:triggerMassCleanupV2` without explicit go
  in the current session.** Operator must say "go BD-2 wave" (or
  equivalent) before the agent triggers anything.
- **No env=1 left enabled past the chain.** The wave's env=0 step is
  not optional. If the chain ends and env is still 1, that is a dirty
  outcome regardless of the chain itself.
- **No direct SQL deletes from Convex storage tables.** See bulk-drain
  plan Hard Guardrails.

## When to fire a wave

A BD-2 wave is **not** scheduled. It is fired in response to one of:

1. **Disk pressure**: `/dev/sda1` usage rising past ~65% with no other
   reclaim option in sight, or pg_wal warn/hard threshold approached.
2. **`oldestRemainingTimestamp` growing significantly older than the 48h
   retention envelope** — i.e. the deletion edge is falling behind ingest.
3. **Operator-decided drainage push** during an investigation window
   where extra rows-deleted help separate pg-side hypotheses.

A wave is **not** fired:

- For "regular maintenance" — Phase 6 cron at `batchSize=500, maxRuns=5`
  every 6 h is the regular-maintenance baseline.
- To "test" the profile — repeatability is already proven (BD-2 first +
  BD-2 repeat).
- Under operator fatigue. If you've already done 2+ runtime steps in
  the current session, prefer to defer the wave to a fresh session.

## Procedure (single wave)

All steps performed by the agent require operator authorization for the
state-changing ones (marked **OPERATOR-GO**). Read-only steps are safe
without authorization.

### Step 0 — Confirm scope

- Operator says **"go BD-2 wave"** (or equivalent unambiguous go).
- Agent verifies the request is for a single wave at the frozen profile,
  not a parameter change.
- If admin key not in the current shell session, agent regenerates it
  per `memory/convex-deploy.md`. Save under `/tmp/.cnvx_admin_key` (mode
  600, ephemeral).

### Step 1 — BD-0-lite preflight (read-only, no env touch)

All seven gates must pass before continuing:

```
1. /version × 3                                → all HTTP 200, latency stable
2. METRICS_REALTIME_CLEANUP_V2_ENABLED         → "0"
3. cleanupRunState                             → no isActive=true row
4. pg_wal size                                 → ≤ last-known-baseline + 25 MiB
5. df -h /                                     → no jump from baseline
6. _scheduled_functions failed/inProgress      → 0 for syncDispatchV2, uzBudgetDispatchV2, manualMassCleanupV2; 0 V1 manualMassCleanup
7. backend stdout (last 15 min)                → 0 rollback / TOKEN_EXPIRED / Too many concurrent / [cleanup-v2] end failed / FATAL / panic
```

Plus heartbeats with **alarm-attribution rule** applied
(`memory/storage-cleanup-v2-bd-1-closure-2026-05-09.md`, BD-1 closure):

```
sync-metrics: lag ≤ 16 min total       (cron 15 min, watcher 10, ≤6 beyond) → non-blocker
uz-budget-increase: lag ≤ 45 min total (cron 45 min, watcher 15, ≤30 beyond) → non-blocker
cleanup-realtime: STUCK any value      (legacy V1 heartbeat name, pre-existing) → non-blocker
any other STUCK                                                         → BLOCKER, abort
```

If any gate fails or any heartbeat is outside the attribution rule:

- **abort the wave**. Do not env-set. Do not trigger.
- Document the blocker. Decide separately what to do (often: wait, or
  escalate to investigate path).

### Step 2 — Set env=1 (OPERATOR-GO + verify)

```bash
export CONVEX_SELF_HOSTED_URL=https://convex.aipilot.by
export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat /tmp/.cnvx_admin_key)
npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1
npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED   # must print 1
```

If env-set verify does not print `1`: abort, do not trigger.

### Step 3 — Trigger the chain (single command)

```bash
npx convex run metrics:triggerMassCleanupV2 \
  '{"batchSize":1000,"timeBudgetMs":10000,"restMs":90000,"maxRuns":8}'
```

Capture the response. It must be:

```json
{ "runId": "<13-digit-ms>-<hex>", "status": "scheduled" }
```

If response is `"already-running"`: STOP — there is an active chain that
preflight missed. Investigate before doing anything else.

If response is `"disabled"`: env didn't take effect. Re-verify env, do
**not** retrigger.

Save the `runId` for the rest of the wave.

### Step 4 — Poll until terminal

Expected wall time: **~11.5 min** (BD-1: 658,064 ms; BD-2 first: 687,745
ms; BD-2 repeat: 686,545 ms). Poll cadence ≥ 45 s (do not hammer the
admin API).

```bash
RUNID=<from step 3>
while true; do
  ROW=$(npx convex data cleanupRunState --limit 1 --format jsonArray)
  echo "$ROW" | python3 -c "import json,sys
d=json.loads(sys.stdin.read(),strict=False)
r=d[0] if d else {}
print(r.get('runId',''),r.get('isActive',''),r.get('state',''),
      'batches=',r.get('batchesRun',0),'deleted=',r.get('deletedCount',0),
      'dur=',r.get('durationMs',0))"
  # exit when terminal
  echo "$ROW" | grep -q "\"isActive\": false" && \
    echo "$ROW" | grep -q "\"$RUNID\"" && break
  sleep 45
done
```

Hard stop conditions while polling — abort by jumping to Step 5 (env=0)
**immediately**:

- `state == "failed"` on the row.
- `isActive=true` for > expected_duration + restMs + 30 s
  (i.e. > ~13.5 min from trigger). This indicates a stuck chain.
- backend `/version` starts returning non-200 or repeated latency
  outliers ≥ 3× baseline.
- `cleanup-v2 disabled_mid_chain` appears in stdout (means env was
  flipped during the chain — should not happen here, but check).

### Step 5 — Set env=0 (always, even after abort)

```bash
npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0
npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED   # must print 0
```

Env=0 is **mandatory** at the end of every wave, including aborted ones.
If env-set 0 fails, that is itself a dirty outcome — escalate immediately.

### Step 6 — Post-run audit (read-only)

Collect fresh values:

```
/version × 3                                  → HTTP 200 stable
pg_wal size                                   → growth ≤ 25 MiB above pre-run (warn); ≤ 150 MiB (hard)
df -h /                                       → no growth from pre-run
DB total size                                 → no rounded-GB jump
backend stdout (last 15 min)                  → 0 rollback / TOKEN_EXPIRED / etc.
_scheduled_functions for this runId           → 8 entries, 8 success, 0 failed
_scheduled_functions V1 manualMassCleanup     → 0 entries
healthCheck.checkCronHeartbeats               → apply attribution rule
cleanupRunState final row                     → state=completed, isActive=false, batchesRun=8, deletedCount=8000
```

Also extract per-chunk action times:

```python
# from npx convex data _scheduled_functions --limit 80 --format jsonArray
# filter by runId, sort by scheduledTime, compute completedTime - scheduledTime per chunk
# report min / max / avg / total
```

### Step 7 — Apply hard gates

| Gate | Threshold | Verdict if exceeded |
|---|---|---|
| state | `completed` | dirty if not |
| isActive | `false` | dirty if true |
| deletedCount | 8,000 | dirty if not exact (or non-zero short-circuit) |
| env after | `0` | dirty if not |
| `manualMassCleanupV2` | 8 success / 0 failed | dirty if any failed |
| max chunk action time | ≤ 8.5 s soft / ≤ 8.7 s hold-BD-4 / **> 9.0 s = dirty** | per BD-3 hard rule |
| durationMs | ≤ 745,000 ms | dirty if exceeded |
| pg_wal growth | ≤ 25 MiB | yellow at warn; > 150 MiB = dirty |
| backend stdout errors | 0 | dirty if any |
| heartbeat alarms | within attribution rule | dirty if outside |

All gates must PASS for **clean**. Any single gate FAIL = **dirty**.

If clean → wave succeeded. If dirty → see closure naming below + write
investigate-next.

### Step 8 — Closure

File name:

```
memory/storage-cleanup-v2-bd-2-wave-<YYYY-MM-DD>-<short-runid>.md
```

Use the BD-2 repeat closure as the structural template
(`memory/storage-cleanup-v2-bd-2-repeat-closure-2026-05-09.md`,
commit `7d10154`). Required sections:

1. Status: `clean` / `clean with caveat` / `dirty`.
2. Summary: profile, runId, trigger time, completion time, durationMs,
   batchesRun, deletedCount, env restored.
3. Operator / Agent Trace (table with timestamps).
4. Anchors table: pre / post / delta / threshold / verdict.
5. cleanupRunState final row (raw).
6. Per-chunk action times table + min/max/avg/total + comparison to
   prior runs at this profile.
7. Hard Gates table with PASS/FAIL per gate.
8. Scheduled Functions counts.
9. Backend Stdout pattern grep.
10. Heartbeat snapshot with attribution.
11. Density Note (`oldestRemainingTimestamp` delta + rows/source-second).
12. Decision (clean / clean with caveat / dirty).
13. If dirty: **Investigate Next** section with concrete checks before
    any further runtime action (per BD-3 closure template).
14. Post-run state.
15. Reference Pointers.

### Step 9 — Commit + push closure

Narrow:

```bash
git add memory/storage-cleanup-v2-bd-2-wave-<...>.md
git commit -m "docs(storage-cleanup): BD-2 wave <date> <verdict>"
git push origin emergency/drain-scheduled-jobs
```

No `git add .`. Do not touch any other files in the same commit.

### Step 10 — Cleanup

If session is ending after the wave:

```bash
rm -f /tmp/.cnvx_admin_key
```

If session continues with another investigate / runtime task, the key
may be retained for that work; remove it at the actual session end.

## Definitions

- **clean**: all hard gates passed. Wave succeeded; no follow-up except
  cumulative tracking.
- **clean with caveat**: all hard gates passed but one or more soft
  warnings hit (e.g. max chunk between 8.5 s and 8.7 s, or pg_wal
  growth between warn 25 MiB and hard 150 MiB). Caveat is documented in
  closure; no immediate action required, but the trend feeds into any
  future "more waves?" decision.
- **dirty**: any single hard gate failed. Wave verdict is dirty even if
  the V2 chain itself completed cleanly. **No further BD-* runs at this
  or higher profile** until the dirty's investigate-next has a written
  answer.

## Cumulative drainage tracker

(Update this list after each wave. Cumulative as of 2026-05-09 21:11 UTC:
**39,000 rows**.)

| Date | runId | profile | rows | verdict | closure |
|---|---|---|---:|---|---|
| 2026-05-08 | canary maxRuns=1 | b=500 r=60 m=1 | 500 | clean | canary closure |
| 2026-05-08 | Phase 5 #1 | b=500 r=90 m=3 | 1,500 | clean | controlled closure |
| 2026-05-08 | Phase 5 #2 | b=500 r=90 m=5 | 2,500 | clean | controlled-maxRuns5 closure |
| 2026-05-09 | emergency maxRuns=8 | b=500 r=90 m=8 | 4,000 | clean | emergency-maxRuns8 closure |
| 2026-05-09 | Gate B (cron) | b=500 r=90 m=5 | 2,500 | clean | phase6-gate-b closure |
| 2026-05-09 | BD-1 | b=500 r=90 m=8 | 4,000 | clean | bd-1 closure |
| 2026-05-09 | BD-2 first | b=1000 r=90 m=8 | 8,000 | clean with caveat | bd-2 closure |
| 2026-05-09 | BD-2 repeat | b=1000 r=90 m=8 | 8,000 | clean with caveat | bd-2-repeat closure |
| 2026-05-09 | BD-3 | b=1000 r=60 m=8 | 8,000 | **dirty** | bd-3 closure |

## Known anchors (as of session end 2026-05-09)

These are the most recent values; refresh during BD-0-lite step 1.

```
pg_wal:                       1,342,177,280 b
disk:                         54%, free 142G
DB size:                      143 GB
oldestRemainingTimestamp:     1,777,734,587,249 (2026-05-02T15:09:47.249Z) [post-BD-3]
env:                          METRICS_REALTIME_CLEANUP_V2_ENABLED = 0
HEAD/origin:                  2e18962 (will drift on the next commit)
Phase 6 cron next ticks:      every 6 h, 0 */6 * * *
UZ V2 cadence:                45 min (uz-budget-increase)
sync V2 cadence:              15 min (sync-metrics)
```

## References

- Bulk-drain + reclaim plan: `memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`
  (commit `e8cee10`). Hard Guardrails, BD-* phase ladder, closure template,
  stop conditions.
- BD-1 closure: `memory/storage-cleanup-v2-bd-1-closure-2026-05-09.md`
  (commit `71ceb87`). Heartbeat alarm-attribution rule.
- BD-2 first closure: `memory/storage-cleanup-v2-bd-2-closure-2026-05-09.md`
  (commit `73abede`). BD-2 readiness rules, original watch flags.
- BD-2 repeat closure: `memory/storage-cleanup-v2-bd-2-repeat-closure-2026-05-09.md`
  (commit `7d10154`). BD-3 readiness rules, per-chunk extraction recipe,
  closure template structure.
- BD-3 dirty closure: `memory/storage-cleanup-v2-bd-3-closure-2026-05-09.md`
  (commit `358663a`). The reason `restMs < 90` is frozen.
- BD-3 investigate note: `memory/storage-cleanup-v2-bd-3-investigate-2026-05-09.md`
  (commit `2e18962`). Hypothesis C / tombstone rationale; PG diagnostics
  next-session plan.
- Cleanup-track follow-ups: `memory/storage-cleanup-v2-followups-2026-05-09.md`
  (commit `a65d43b`). launchd late-fire, watcher mismatches, heartbeat
  update lag artifact, UZ schedule drift.
- Phase 6 Gate B closure: `memory/storage-cleanup-v2-phase6-gate-b-closure-2026-05-09.md`
  (commit `1074adf`). Cron certification (Gate A + Gate B).
- Convex deploy / admin key generation: `memory/convex-deploy.md`.
- Code references:
  - `convex/metrics.ts:444` — `triggerMassCleanupV2`.
  - `convex/metrics.ts:635` — `manualMassCleanupV2` (the chain worker).
  - `convex/metrics.ts:424` — `deleteRealtimeBatch` (the actual delete).
  - `convex/crons.ts:219` — Phase 6 cron registration.
  - `convex/healthCheck.ts:66-113` — heartbeat config (note maxStaleMin
    mismatches per follow-ups).

## Diff vs Phase 6 cron

This runbook does **not** change Phase 6 cron behaviour. The cron
remains registered every 6 h with profile `batchSize=500, maxRuns=5,
restMs=90_000`, fail-closed by env. Manual BD-2 waves are orthogonal.

If a manual wave fires while the Phase 6 cron is also active (env=1
during a 6-h cron boundary), the Convex active-row guard
(`triggerMassCleanupV2` checks `cleanupRunState.isActive=true`) means
only one chain runs at a time. The second trigger gets
`status: "already-running"` and skips. **However**, this only happens
under failed pre-flight (env=1 should be 0 at preflight, and the cron
won't fire anything if env=0).

For safety: do **not** enable env=1 within ±5 min of a 6-h cron
boundary (00:00, 06:00, 12:00, 18:00 UTC). Wave at any other time
window is fine.
