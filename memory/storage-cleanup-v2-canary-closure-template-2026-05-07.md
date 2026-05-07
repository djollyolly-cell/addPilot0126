# Storage Cleanup V2 — Canary Closure Template

Status: TEMPLATE — copy this file to `memory/storage-cleanup-v2-canary-closure-<actual-date>.md` and fill all `<FILL_IN>` / `<ISO>` / `<n>` / `<bytes>` / `<✅/⚠️/🛑>` placeholders with real values captured during canary. Do NOT edit this template file when filling — copy it first.

Self-contained: all decision criteria, table shapes, and Source expectations live in this file. The companion runbook (`memory/storage-cleanup-v2-phase4-canary-runbook-2026-05-07.md`) is the procedural source for HOW to capture each value; this template is WHAT to record.

Placeholder vocabulary (use consistently — no synonyms):
- `<ISO>` — wall-clock timestamp in ISO 8601 (e.g. `2026-05-07T18:30:00Z`)
- `<n>` — integer count
- `<bytes>` — byte count, comma-thousands acceptable (e.g. `5,888,802,816`)
- `<n> (<ISO>)` — epoch-ms timestamp fields (e.g. `cutoffUsed`, `oldestRemainingTimestamp` in cleanupRunState row); record raw integer + human-readable ISO for legibility
- `<FILL_IN>` — free text (descriptions, follow-ups, notes)
- `<✅/⚠️/🛑>` — verdict for one row (replace with single emoji)
- `<clean | dirty>` — overall decision (pick one literal)
- `<== | !=>` — choice between equality operators (e.g. cross-check assertion)

Source column convention: every observed value MUST cite where it came from — `stdout`, `_scheduled_functions`, `cleanupRunState`, `cronHeartbeats`, `df -h`, `pg_wal`, `Convex dashboard SQL`, etc. Empty Source = unverifiable claim = closure memo is invalid.

---

# Storage Cleanup V2 — Canary Closure — <ISO date>

Status: <clean | dirty>
Trigger time: <ISO>
runId: `<FILL_IN>` (returned by `triggerMassCleanupV2`, format `<epoch-ms>-<12hex>`)
Operator: `<FILL_IN>`
Convex deployment: `https://convex.aipilot.by` (Phase 1 code at commit `2410f14`)

References:
- Runbook (procedure): `memory/storage-cleanup-v2-phase4-canary-runbook-2026-05-07.md` (commit `5d3aa81`)
- Phase 1 design: `memory/storage-cleanup-v2-phase1-design-2026-05-07.md` (commit `b3e4bd4`)
- Phase 1 code: commit `2410f14 feat(storage-cleanup): add metricsRealtime cleanup V2`
- Phase 3 deploy closure: `memory/storage-cleanup-v2-phase3-deploy-closure-2026-05-07.md` (commit `1358aaa`)
- Preflight baseline: `memory/storage-cleanup-v2-preflight-2026-05-07.md` (commit `ae2506b`)

## Canary parameters (Step 4 trigger args)

```text
batchSize:     <n>
timeBudgetMs:  <n>          # stored only, not enforced in Phase 1
restMs:        <n>
maxRuns:       <n>
```

Expected for first canary per design defaults: `{ batchSize: 500, timeBudgetMs: 10000, restMs: 60000, maxRuns: 1 }`.

---

## 1. Anchors (recaptured immediately before trigger — Step 2)

| Anchor | Pre | Post | Delta | Threshold | Verdict | Source |
|---|---|---|---|---|---|---|
| `/version` HTTP | <n> | <n> | — | == 200 | <✅/🛑> | `curl -s -o /dev/null -w "%{http_code}" https://convex.aipilot.by/version` |
| `/version` time | <FILL_IN>s | <FILL_IN>s | <FILL_IN>s | drift <2s | <✅/⚠️/🛑> | same as above with `%{time_total}` |
| disk free | <FILL_IN>G | <FILL_IN>G | <FILL_IN>G | no drop ≥20G unexplained | <✅/⚠️/🛑> | `ssh root@178.172.235.49 "df -h /"` |
| `pg_wal` | <bytes> | <bytes> | <bytes> | warn=<bytes>, hard-stop=<bytes> | <✅/⚠️/🛑> | `ssh + docker exec convex-postgres-1 du -sb /var/lib/postgresql/data/pg_wal` |
| `metricsRealtime` total | <n> | <n> | <n> | informational; concurrent sync writes may keep flat or grow during window | <✅/⚠️> | Convex dashboard SQL / read-only paginated count |
| `metricsRealtime` eligible | <n> | <n> | <n> | post == pre - deletedCount (authoritative — see Section 6) | <✅/🛑> | same query with `WHERE timestamp < cutoffUsed` |
| `oldestRemainingTimestamp` | <n> (<ISO>) | <n> (<ISO>) | <FILL_IN> | post >= pre (advance forward, NOT > cutoffUsed) | <✅/⚠️/🛑> | `min(timestamp) FROM metricsRealtime` across ALL rows (NOT filtered by cutoffUsed); matches what `markCompletedV2` writes to row at `convex/metrics.ts:559-563` |

Notes:
- `oldestRemainingTimestamp` post-condition is `>= pre`, NOT `> cutoffUsed`. The latter only holds when the entire backlog is drained (Phase 5+ goal); for one-batch canary against ~9.5M eligible rows, post is expected to remain below cutoffUsed.
- WAL `warn` and `hard-stop` thresholds are computed from a fresh pre-canary read, NOT copied from the runbook worked example. Record the actual numbers used here.

---

## 2. Core heartbeats (Step 2e and re-check after canary)

| Heartbeat | Pre | Post | Verdict | Source |
|---|---|---|---|---|
| `syncDispatch` | <ISO> completed err=- | <ISO> completed err=- | <✅/🛑> | `cronHeartbeats` table by name |
| `uzBudgetDispatch` | <ISO> completed err=- | <ISO> completed err=- | <✅/🛑> | `cronHeartbeats` table by name |
| `tokenRefreshDispatch` | <ISO> completed err=- | <ISO> completed err=- | <✅/🛑> | `cronHeartbeats` table by name |

Hard rule: any sync/UZ/token regression in the canary window overrides cleanup progress. Even if cleanup itself was clean, a regression here flips overall Decision to `dirty` and triggers Step 8 rollback in the runbook.

---

## 3. `_scheduled_functions` failed counters (Step 2f / 5d)

| UDF | Pre | Post | Delta | Verdict | Source |
|---|---|---|---|---|---|
| `auth.js:tokenRefreshOneV2` | <n> | <n> | <n> | delta == 0 | <✅/🛑> | `_scheduled_functions` failed-counter |
| `ruleEngine.js:uzBudgetBatchWorkerV2` | <n> | <n> | <n> | delta == 0 | <✅/🛑> | `_scheduled_functions` failed-counter |
| `syncMetrics.js:syncBatchWorkerV2` | <n> | <n> | <n> | delta == 0 | <✅/🛑> | `_scheduled_functions` failed-counter |
| `metrics.js:manualMassCleanup` (V1) | <n> | <n> | <n> | delta == 0 | <✅/🛑> | `_scheduled_functions` failed-counter |
| `metrics.js:manualMassCleanupV2` (V2) failed | 0 | <n> | <n> | post == 0 (absolute, NOT delta) | <✅/🛑> | `_scheduled_functions` failed-counter |
| `adminAlerts.js:notify` | <n> | <n> | <n> | delta == 0 | <✅/🛑> | `_scheduled_functions` failed-counter |

### V2 success entries (separate gate, REQUIRED for clean canary)

| UDF | Total entries | Success | Failed | Verdict | Source |
|---|---|---|---|---|---|
| `metrics.js:manualMassCleanupV2` | <n> (expect 1 for `maxRuns=1` canary) | <n> (expect 1) | <n> (expect 0) | <✅/🛑> | `_scheduled_functions` rows for udfPath in canary window |

Notes:
- V2 row uses **absolute** == 0, not delta, for the failed counter. Pre-canary baseline must be 0 (per Phase 4 prereq); any post-canary V2 failure is critical.
- V2 success row uses **absolute counts** in the canary window. For `maxRuns=1` canary, exactly one V2 entry total, one success, zero failed. >1 entries = chain self-scheduled despite `maxRuns=1` (Decision E violation).
- V1 `manualMassCleanup` failed-count must NOT advance. If it did, V2 code accidentally scheduled V1 udfPath — naming collision violation per Decision A.

---

## 4. `cleanupRunState` final row

Source: `cleanupRunState` table, lookup by `by_runId` index with `runId = <runId>`.

```text
cleanupName:                metrics-realtime-v2
runId:                      <FILL_IN>
state:                      <claimed | running | completed | failed>     # expect: completed
isActive:                   <true | false>                                # expect: false (atomic with terminal state)
startedAt:                  <ISO>
lastBatchAt:                <ISO>
batchesRun:                 <n>                                           # expect: 1 for canary maxRuns=1
maxRuns:                    <n>                                           # set at trigger; expect: 1
cutoffUsed:                 <n> (<ISO>)                                   # epoch-ms; immutable for the run
deletedCount:               <n>                                           # expect: > 0 and ≤ batchSize
oldestRemainingTimestamp:   <n> (<ISO>) or undefined                      # epoch-ms; sampled in markCompletedV2 across ALL metricsRealtime rows (not eligible-only)
durationMs:                 <n>                                           # expect: > 0, likely 100ms — 30s
error:                      <undefined or string>                         # expect: undefined for clean
batchSize:                  <n>
timeBudgetMs:               <n>
restMs:                     <n>
```

Verdict (against expected for clean canary): <✅/🛑>

Notes:
- Schema reference: `convex/schema.ts:825-849` at commit `2410f14`. Field names verbatim — any mismatch in this dump means the row was not loaded correctly.
- `state: "failed"` with `error: "disabled_mid_chain"` is the env-toggle graceful exit (Decision D); operator-distinguishable from code-bug failure but both flip Decision to `dirty`.

---

## 5. Backend stdout summary

| Pattern | Expected count | Observed | Verdict | Source |
|---|---|---|---|---|
| `[cleanup-v2] start runId=...` | 1 (per chunk) | <n> | <✅/🛑> | `docker logs --since <window>` |
| `[cleanup-v2] end runId=... decision=complete` | 1 (canary maxRuns=1) | <n> | <✅/🛑> | `docker logs --since <window>` |
| `[cleanup-v2] end runId=... decision=schedule` | 0 (canary maxRuns=1) | <n> | <✅/🛑> | `docker logs --since <window>` |
| `[cleanup-v2] end runId=... decision=failed` | 0 | <n> | <✅/🛑> | `docker logs --since <window>` |
| `[cleanup-v2] skip reason=disabled` | 0 (env was set) | <n> | <✅/🛑> | `docker logs --since <window>` |
| `[cleanup-v2] skip reason=disabled_mid_chain` | 0 | <n> | <✅/🛑> | `docker logs --since <window>` |
| `Too many concurrent` | 0 | <n> | <✅/🛑> | `docker logs --since <window>` grep |
| `Transient error` | 0 | <n> | <✅/🛑> | `docker logs --since <window>` grep |
| `TOKEN_EXPIRED` | 0 | <n> | <✅/🛑> | `docker logs --since <window>` grep |
| `syncBatchV2.*Account .* failed` | 0 | <n> | <✅/🛑> | `docker logs --since <window>` grep |

Window: from <ISO> (trigger) to <ISO> (post-canary check). Record exact `--since` value used.

Sample stdout excerpt (verbatim, useful for post-mortem if dirty):

```text
<FILL_IN — paste 5-10 most relevant log lines, including [cleanup-v2] start/end>
```

---

## 6. Eligible count delta cross-check (Step 5f) — AUTHORITATIVE GATE

This is the authoritative gate. Total count cross-check is informational only because concurrent sync inserts during the canary window add fresh rows with `timestamp = Date.now()`, which are NEWER than `cutoffUsed` and therefore never counted in `eligible`. Eligible delta is unaffected by concurrent writes.

**Cutoff alignment:** eligible pre/post MUST use the same cutoff value to make the equality check strict. If pre-count was captured at Step 2 with an approximate `now - 172_800_000` cutoff (which differs from `cleanupRunState.cutoffUsed` by `T_trigger - T_recapture`, typically 1-5 min), record the Step 2 cutoff separately and treat the equality check as **approximate / boundary-sensitive**: expected `|delta| ≈ deletedCount ± M`, where `M` = rows with timestamp in `[Step 2 cutoff, cleanupRunState.cutoffUsed)`. `M` reflects historical rows that were inserted 2 days ago in a `(T_trigger - T_recapture)` window — they were not eligible at Step 2 but are eligible at trigger. Strict `|delta| == deletedCount` only holds if Step 2 and trigger used the identical cutoff value.

```text
metricsRealtime_eligible_pre   = <n>           # WHERE timestamp < <pre_cutoff_ms>
pre_cutoff_used                = <n> (<ISO>)   # cutoff at Step 2 recapture (NOT necessarily == cleanupRunState.cutoffUsed)
metricsRealtime_eligible_post  = <n>           # WHERE timestamp < cleanupRunState.cutoffUsed
delta                          = <n>           # post - pre (negative for cleanup)
deletedCount (from row)        = <n>
boundary_M_estimate            = <n>           # rows with timestamp in [pre_cutoff_used, cleanupRunState.cutoffUsed); approximate

Strict expected (if pre_cutoff_used == cleanupRunState.cutoffUsed):  |delta| == deletedCount
Approximate expected (otherwise):                                    |delta| ≈ deletedCount ± boundary_M_estimate

Observed: |delta| <== | !=> deletedCount
Verdict:  <✅/🛑>     # ✅ if within boundary tolerance; 🛑 if large unexplained gap beyond M
```

If gap exceeds `boundary_M_estimate` materially: cleanup operated on the wrong cutoff, OR a concurrent write inserted a historical-timestamp row (would be a separate bug — `saveRealtime` / `saveRealtimeBatch` at `convex/metrics.ts` use `Date.now()`).

Total count delta is recorded in Section 1 anchors row "metricsRealtime total" but is NOT a clean-canary gate — it can drift by `+sync_inserts_in_window`.

---

## 7. Decision

Overall: **<clean | dirty>**

Clean canary criteria (ALL must hold):
- ✅ `_scheduled_functions`: 1 V2 success, 0 V1 unattributed growth, 0 V2 failed
- ✅ `cleanupRunState` row: `state: "completed"`, `isActive: false`, `deletedCount > 0`, `oldestRemainingTimestamp` advanced (>= pre)
- ✅ `metricsRealtime` eligible count decreased by exactly `deletedCount`
- ✅ `pg_wal` delta within warn threshold
- ✅ Backend stdout: 0 rollback patterns; 1 start + 1 end-with-decision=complete log line
- ✅ Core heartbeats unchanged (sync/UZ/token all `completed`, no new error)
- ✅ `adminAlerts.notify` failed counter unchanged

If any failed → `dirty`. Skip to Section 9 (rollback).

Reasoning narrative: <FILL_IN — 1-3 sentences explaining why the verdict is what it is, especially if mixed signals were present>

---

## 8. Post-canary state (clean path only — fill if Decision is clean)

| Item | State | Source |
|---|---|---|
| `METRICS_REALTIME_CLEANUP_V2_ENABLED` | 0 (returned to deploy-safe at Step 7a) | `npx convex env list` |
| `cleanup-old-realtime-metrics` cron | still commented in `convex/crons.ts` | `rg "cleanup-old-realtime-metrics" convex/crons.ts` |
| Phase 5 (controlled runs) readiness | <ready | blocked: <FILL_IN reason>> | reasoning below |
| Buffer recommendation | wait <FILL_IN minutes/hours> before Phase 5 trigger | next 1-2 sync ticks observed clean |

Phase 5 sizing notes (informed by canary observations — useful for next runbook):
- Per-chunk WAL footprint observed: <bytes> (vs threshold <bytes> warn)
- Per-chunk durationMs observed: <n>
- Suggested Phase 5 starting params: <FILL_IN — e.g. `batchSize: 1000, maxRuns: 5, restMs: 90000`>

---

## 9. Rollback documentation (dirty path only — fill if Decision is dirty)

| Step | Action taken | Outcome | Source |
|---|---|---|---|
| 8a — disable env | `npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0` | <FILL_IN — succeeded / failed / skipped> | `npx convex env list` post |
| 8b — chain mid-flight handling | <FILL_IN — was chain mid-flight? markFailedV2 fired? row transitioned?> | <FILL_IN> | `cleanupRunState` row final state |
| 8c — investigation | <FILL_IN — specific failure mode + correlation> | <FILL_IN> | per Step 8c runbook |

Specific failure mode: <FILL_IN — pg_wal runaway / V8 concurrency / V1 backlog growth / sync regression / row stuck non-terminal / other>

Investigation conclusions: <FILL_IN>

Action items before next canary attempt:
- <FILL_IN>
- <FILL_IN>

---

## 10. Open follow-ups

- <FILL_IN>
- <FILL_IN>

---

## Closing checklist (operator before considering this closure done)

- [ ] All `<FILL_IN>` / `<ISO>` / `<n>` / `<bytes>` / `<== | !=>` / `<clean | dirty>` placeholders replaced with real values.
- [ ] No `<✅/⚠️/🛑>` cell left as the literal placeholder.
- [ ] Source column populated for every row (no empty Source = invalid evidence).
- [ ] If Decision is clean: env flag set back to 0 confirmed; Sections 8 filled, Section 9 left empty.
- [ ] If Decision is dirty: Section 9 filled; Section 8 left empty; rollback memo filename also created if separate from this closure.
- [ ] File saved as `memory/storage-cleanup-v2-canary-closure-<actual-date>.md` (NOT this template file).
- [ ] commit doc-only after explicit go: `docs(storage-cleanup): record phase 4 canary closure`.
