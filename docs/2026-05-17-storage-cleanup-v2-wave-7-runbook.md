# Storage Cleanup V2 — Wave 7 Runbook (Tier 1 maxRuns=24, 2026-05-17)

Type: forward-looking operational runbook
Scope: Storage Cleanup V2 / Tier 1 supervised `maxRuns=24` wave 7
Profile: `{ batchSize: 1000, timeBudgetMs: 10000, restMs: 90000, maxRuns: 24 }` — **frozen, identical to Waves 1–6**
Source of truth (SOT): pinned commit `1dc5c72431543f5e00759d20fa5d36b447bd4336` on `origin/emergency/drain-scheduled-jobs` (clean detached worktree; runtime-minimum ancestor `7cfa08cd218d2523188048853e1bcd5d0d48168e`)
Author session: 2026-05-16
Earliest execution window: `2026-05-17T00:06Z` onwards (no D1c gate; constrained only by cron-avoid windows below)
Predecessor wave closure: `memory/storage-cleanup-v2-tier1-maxruns24-canary-2026-05-16-b02bca844e80.md`
Caveats handoff: `memory/storage-cleanup-v2-wave7-caveats-handoff-2026-05-16.md`
Restorer hardening receipt: `memory/storage-cleanup-restorer-hardening-2026-05-16.md`
SOT prep receipt: `memory/wave7-clean-sot-restorer-prep-2026-05-16.md`

---

## TL;DR

Wave 7 is the 7th supervised canary in the `maxRuns=24` series. **Same profile as Waves 1–6.** No parameter changes, no escalation, no automation, no parallel waves. Predicted band is built from n=6 observed series (`2,165,722 – 2,240,974 ms`, ~3.47% spread); yellow = `>2,300,000 ms`; hard re-halt = `>2,400,000 ms`. All gates are explicit; nothing is authorized "by inertia".

What's new vs Wave 6 runbook:

- **Pinned SOT advanced:** `2b62f99` → `1dc5c72` (`7cfa08c` is runtime-minimum ancestor). Restorer now tolerates noisy Convex CLI JSON output.
- **D1c gate removed:** D1c 24h closeout PASSed during Wave 6 preflight. No re-validation needed unless an operator explicitly re-fires a synthetic D1c canary (separate go).
- **Restorer noisy-JSON SPOF: FIXED.** New rehearsal #3 (parser regression) added.
- **`fetch failed` trigger protocol formalized** in section 4.4. Recurring pattern (2/6 waves), no longer one-off.
- **T+3 post-terminal CPU expectations updated** in section 4.10/4.11. Wave 6 observed Convex 138.72% + PG 64.39% without waits/DFR/BIO; this is an information signal, not an abort signal. Explicit watch in Wave 7.
- **ToD hypothesis downgraded** to "weak/noisy" — section 10.6.
- **Series ledger updated** to 6/6 strict clean (Appendix B).

Local timezone notes:

- Operator timezone: Europe/Minsk (UTC+3, no DST).
- All UTC times in this doc are written as `HH:MMZ`; Minsk = `+3h`.

---

## 0. Hard Pre-Conditions (must ALL be true before any trigger)

If any of these fail, **do not flip env**. Diagnose first, re-evaluate.

| # | Gate | Verification path |
|---|---|---|
| 0.1 | Pinned SOT confirmed: `origin/emergency/drain-scheduled-jobs == 1dc5c72…` AND runtime-min `7cfa08c` is ancestor | Section 1.1 |
| 0.2 | `METRICS_REALTIME_CLEANUP_V2_ENABLED=0` confirmed via ≥2 independent paths | Section 1.2 |
| 0.3 | No active `cleanupRunState` row (`isActive=false` on latest; last N rows = `state="completed"`) | Section 1.3 |
| 0.4 | All 6 re-halt rules verified GREEN on preflight | Section 1.4 |
| 0.5 | PG mini-snapshot: storm-fix holds, host headroom ≥25 GiB, WAL stable | Section 1.5 |
| 0.6 | Cron-avoid time window respected: ±5 min of `00:00 / 06:00 / 12:00 / 18:00 / 02:00 / 05:30` UTC, with 45-min wave envelope clear | Section 1.6 |
| 0.7 | Execution worktree exists at canonical path, HEAD=`1dc5c72`, clean status | Section 1.7 |
| 0.8 | `gen-admin-key.cjs` helper sha256 matches prepared helper | Section 1.7 |
| 0.9 | All three restorer rehearsals pass (positive dry-run, negative dry-run, **parser regression**) | Section 4.2 |
| 0.10 | Operator explicit `go Wave 7` in current session | — |

> "Eligibility ≠ authorization." 6/6 strict clean from Wave 6 closure does **not** auto-authorize Wave 7. Each wave needs its own explicit `go`.

---

## 1. Pre-Wave Preflight (read-only)

All steps are read-only. No env writes. No DB mutations. No deploys.

### 1.1 Pinned SOT confirmation

```bash
git rev-parse origin/emergency/drain-scheduled-jobs
```

PASS only if it prints:

```text
1dc5c72431543f5e00759d20fa5d36b447bd4336
```

Verify runtime-minimum ancestor:

```bash
git merge-base --is-ancestor 7cfa08cd218d2523188048853e1bcd5d0d48168e 1dc5c72431543f5e00759d20fa5d36b447bd4336 && echo "ANCESTOR_OK" || echo "ANCESTOR_FAIL"
```

PASS only if `ANCESTOR_OK`.

If origin differs from `1dc5c72`, **HOLD wave** and classify the diff:

```bash
git diff --stat 1dc5c72431543f5e00759d20fa5d36b447bd4336..origin/emergency/drain-scheduled-jobs
git diff --name-only 1dc5c72431543f5e00759d20fa5d36b447bd4336..origin/emergency/drain-scheduled-jobs
```

Classification:

- Unrelated to cleanup/restorer/Convex runtime: operator may continue on pin `1dc5c72` only after explicit unrelated-classification confirmation.
- Cleanup/restorer/Convex runtime touched: re-pin deliberately, recreate clean SOT worktree, repeat rehearsals A/B/C before considering Wave 7 eligible again.

### 1.2 Env state verification (multi-path)

Cleanup env must be confirmed `0` via at least **two** independent paths:

| Path | What to check | Acceptance |
|---|---|---|
| A. Local Convex CLI | `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` against `https://convex.aipilot.by` | returns `0` (string, exact match against `'0'`, NOT `1`) |
| B. Server-side docker logs (best effort, not authoritative) | `docker logs adpilot-convex-backend` last `[cleanup-v2] cron tick` line shows `env=0` | optional — function only logs when invoked; absence does not invalidate |
| C. Indirect via `cleanupRunState` | Latest 5 rows: `state="completed"`, `isActive=false`, no active runs | required as corroboration |

DNS / local-CLI flake caveat (from Wave 2 closure `8cd44b08a1d8`): a single local CLI read can transiently return `'1'` during WebSocket reconnect after DNS flap. **Never trust a single CLI path** for env-state decisions. Require: ≥2 paths agree before treating env state as known.

Also verify auxiliary env:

- `SYNC_METRICS_V2_ENABLED=1` (expected; do not touch)
- `SYNC_BATCH_SIZE_V2=20` (expected; do not touch)
- `SYNC_WORKER_COUNT_V2=2` (expected; do not touch)
- `DISABLE_ERROR_ALERT_FANOUT=0` (expected post-D1c; do not touch)

### 1.3 `cleanupRunState` quiet

Via Convex admin (read-only):

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex data cleanupRunState --limit 10
```

Expected rows (top 6, descending by `startedAt`, post Wave 6):

| runId suffix | state | isActive | batchesRun | deletedCount | oldestRemainingTimestamp |
|---|---|---|---|---|---|
| `b02bca844e80` (W6) | completed | false | 24 | 24,000 | `1,777,741,818,661` |
| `2d97cfccdf0a` (W5) | completed | false | 24 | 24,000 | `1,777,741,473,560` |
| `605b8ed53962` (W4) | completed | false | 24 | 24,000 | `1,777,740,889,783` |
| `76e7fd71103f` (W3) | completed | false | 24 | 24,000 | `1,777,740,304,836` |
| `8cd44b08a1d8` (W2) | completed | false | 24 | 24,000 | `1,777,739,710,006` |
| `24c7323b15b8` (W1) | completed | false | 24 | 24,000 | `1,777,739,132,058` |

Accept only if: no row has `isActive=true`, no fresh `state="claimed"`/`state="running"` row exists. If anything is active → **wait, do not trigger**.

### 1.4 Re-halt rules — verify GREEN on preflight

The 6 canon rules are evaluated across preflight, in-wave, and post-wave where they are observable. Thresholds below are scaled for `maxRuns=24`.

| # | Rule | Threshold (maxRuns=24) | How to verify at preflight |
|---|---|---|---|
| 1 | Hard duration ceiling | `durationMs > 2,400,000 ms` | N/A pre-trigger; classify only after target terminal row has `durationMs` — prior wave durations all ≤ ceiling (canon: `2,165k – 2,241k`) |
| 2 | Sustained PG waits across multiple probes | 0 waiting locks, 0 long-active, 0 idle-in-tx | `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock';` via Convex admin or allowed indirect path |
| 3 | Loadavg elevated and not settled in post-audit window | `uptime` loadavg ≤ ~1.0 on 1m, settles within T+~3 / T+~5 of any wave terminal | `uptime` on host (via SSH probe) |
| 4 | env not back to `0` / `!= "1"` after terminal | `env == "0"` strictly | preflight: env=`0` confirmed via section 1.2 |
| 5 | non-cache RSS growth + MEM>30% + host headroom <5 GiB (all three) | `non-cache RSS ~300 MB`, MEM% ≤ ~21 on `adpilot-postgres` (W6 observed peak), host headroom ≥25 GiB | `free -h`, `docker stats` snapshot |
| 6 | Runtime / SQL / cleanup discipline breach (DDL/DML, GUC toggle, VACUUM run, container restart) | none during preflight window | confirm "no maintenance running"; check `docker ps` healthy |

Rules 1 (duration) and 4 (env=0 after terminal) cannot be checked pre-trigger directly; rule 1 is terminal-only. Rules 2/3/5/6 must be GREEN now.

Rule 5 baseline note: W6 observed PG MEM% peak ~21% (still healthy headroom). Rule 5 is a compound fire condition — RED only if RSS grows materially AND PG MEM% exceeds `30%` AND host headroom falls below `5 GiB` together.

### 1.5 PG mini-snapshot

Storm-fix from 2026-05-03 must still hold. From `memory/pg-readonly-diagnostic-2026-05-11.md` and W6 preflight:

- `pg_wal`: ~449M at W6 preflight (within stable band; `max_wal_size=8 GB` headroom).
- `shared_buffers = 128 MB` (TODO жив — PG raw probe ban contributor #1).
- `documents heap_hit rate ~36%` (<50% — PG raw probe ban contributor #2).
- Host: `Mem available ≥25 GiB`, `Disk / 142 GB free / 161 GB used / 315 GB total (54%)`.

Verify via allowed paths only (NO PG raw probes — see section 5):

- `df -h /` — disk free ≥ ~140 GB.
- `free -h` — mem available ≥25 GiB.
- `docker stats --no-stream` — `adpilot-postgres` MEM% ≤ ~25%, `adpilot-convex-backend` CPU at idle baseline.
- `/version` HTTP 200 (probe `https://convex.aipilot.by/version`).
- `pg_stat_activity` aggregate counts (this is `pg_stat_*` snapshot, NOT a `documents`/`indexes` heap scan — allowed).

If WAL has grown unbounded (e.g. `pg_wal` > ~6 GB / approaching `max_wal_size=8 GB`) → **HOLD**, investigate before wave.

Expected: Telegram delivery from `healthReport.ts` may include `Здоровье системы — N проблем` with `cleanup-realtime: STUCK` legacy heartbeat. Ignore this for Wave 7 preflight unless it appears as a repeated/spammy alert cluster or correlates with fresh runtime errors.

### 1.6 Cron-avoid window check

Per `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, **6 fixed UTC no-go points (±5 min each)**:

| UTC time | Cron name | Cadence |
|---|---|---|
| `00:00 / 06:00 / 12:00 / 18:00` | `cleanup-old-realtime-metrics` (profile 500/5) | `0 */6 * * *` |
| `02:00` | `cleanup-old-logs` | `0 2 * * *` |
| `05:30` | `cleanup-expired-invites` | `30 5 * * *` |

Wave 7 trigger must fall **outside ±5 min of all six**, with the full 45-min runtime envelope inside the open window.

Available trigger windows for 2026-05-17 UTC | Minsk:

| UTC window | Length | Minsk |
|---|---|---|
| `00:06 – 01:10Z` | 1h 4m | `03:06 – 04:10` |
| `02:06 – 04:40Z` | 2h 34m | `05:06 – 07:40` |
| `06:06 – 11:10Z` | 5h 4m | `09:06 – 14:10` ← wide |
| `12:06 – 17:10Z` | 5h 4m | `15:06 – 20:10` ← wide |
| `18:06 – 23:10Z` | 5h 4m | `21:06 – 02:10` ← wide |

Runway requirement: wave terminal predicted at `T+~37 min`. Use a conservative 45 min runtime envelope plus the ±5 min cron no-go buffer. Before an upcoming UTC cron boundary, last safe trigger is `boundary - 50 min`.

Reminder: interval crons (`sync-metrics` 15m, `uz-budget-*`, `proactive-token-refresh` 2h, `cleanup-stuck-payments` 2h) are background, **NOT no-go windows** (registration-time aligned, not UTC-aligned).

### 1.7 Execution worktree confirmation

Canonical Wave 7 execution worktree:

```text
/private/tmp/adpilot-wave7-sot-2026-05-16-origin-head
```

Verification (mandatory before any env-write step):

```bash
git -C /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head rev-parse HEAD
git -C /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head status --short
```

PASS only if `rev-parse HEAD` prints:

```text
1dc5c72431543f5e00759d20fa5d36b447bd4336
```

and `status --short` prints nothing.

If `/private/tmp` worktree is missing (volatile, lost on reboot), recreate it from the main checkout:

```bash
cd "<repo root>"
git fetch origin emergency/drain-scheduled-jobs
git worktree add --detach /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head 1dc5c72431543f5e00759d20fa5d36b447bd4336
git -C /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head rev-parse HEAD
git -C /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head status --short
```

If origin advanced past `1dc5c72`, **HOLD wave** and reconcile per section 1.1.

**Reference worktrees** (NOT for execution; informational only — if missing, runbook proceeds):

- `/private/tmp/adpilot-wave7-sot-2026-05-16` @ `7cfa08c` — runtime-minimum reference
- `/private/tmp/adpilot-restorer-hardening-2026-05-16` @ `1dc5c72` — branch worktree

**Admin-key helper caveat:** `gen-admin-key.cjs` is a local untracked helper in the main checkout, not part of the pinned SOT commit. Before any Convex CLI command that uses it:

```bash
shasum -a 256 gen-admin-key.cjs
```

Expected:

```text
5da266ec3132c4c8415d8b41e95edd71f91088a3ddb26c116547015f393c0179  gen-admin-key.cjs
```

If it differs or the helper is missing, **HOLD wave** and re-validate the admin key path separately. Do not paste generated admin keys into notes or chat.

---

## 2. Wave 7 Profile (frozen)

```json
{
  "batchSize": 1000,
  "timeBudgetMs": 10000,
  "restMs": 90000,
  "maxRuns": 24
}
```

This is identical to Waves 1–6. **No parameter changes.** Per sustained-drain plan re-evaluation gate: no bump until ≥10 consecutive strict-clean waves AND a fresh PG snapshot green AND a single-parameter bump with explicit operator go. None of those conditions is currently met (6/6 strict clean as of Wave 6).

The action being invoked is the internal mutation `metrics:triggerMassCleanupV2` with these args. This:

1. Checks env gate `METRICS_REALTIME_CLEANUP_V2_ENABLED === "1"`. If not "1" → `status: "disabled"`, no row created.
2. Checks for any active `cleanupRunState` row for `cleanupName: "metrics-realtime-v2"`. If active → `status: "already-running"`, no new row.
3. Inserts a `cleanupRunState` row with `state: "claimed"`, `isActive: true`, `runId: makeCleanupRunId()`, with the four args persisted on the row.
4. Schedules `internal.metrics.manualMassCleanupV2({ runId })` at `runAfter(0, ...)`.
5. Returns `{ status: "scheduled", runId }`.

`manualMassCleanupV2` then loops: `markRunning → deleteRealtimeBatch (batchSize rows) → recordBatchProgress → scheduleNextChunk` until `batchesRun >= maxRuns` OR `!hasMore` OR env flipped to `0` mid-chain (→ `markFailedV2(error="disabled_mid_chain")`).

Source: `convex/metrics.ts` (origin/`emergency/drain-scheduled-jobs` @ `1dc5c72`). Schema: `convex/schema.ts`.

---

## 3. Predicted Band (built from n=6 observed series)

Series ledger after Wave 6 (from `memory/storage-cleanup-v2-tier1-maxruns24-canary-2026-05-16-b02bca844e80.md`):

| Wave | RunId suffix | Trigger UTC | ToD bucket | durationMs | Duration | State |
|---:|---|---|---|---:|---|---|
| 1 | `24c7323b15b8` | `2026-05-11T06:24:44Z` | early morning | `2,240,974` | `37m 20.97s` | clean |
| 2 | `8cd44b08a1d8` | `2026-05-11T07:43:27Z` | early morning | `2,230,273` | `37m 10.27s` | clean |
| 3 | `76e7fd71103f` | `2026-05-11T12:08:18Z` | daytime | `2,183,464` | `36m 23.46s` | clean |
| 4 | `605b8ed53962` | `2026-05-11T18:43:59Z` | evening | `2,172,368` | `36m 12.37s` | clean |
| 5 | `2d97cfccdf0a` | `2026-05-14T09:34:03Z` | morning | `2,175,131` | `36m 15.13s` | clean |
| 6 | `b02bca844e80` | `2026-05-16T18:19:02Z` | evening | `2,165,722` | `36m 05.72s` | clean (fastest) |

### Statistics (n=6)

- **Min:** `2,165,722 ms` (W6 — new series minimum)
- **Max:** `2,240,974 ms` (W1)
- **Range:** `75,252 ms` = `~3.47%` of min
- **Mean:** `(2,240,974 + 2,230,273 + 2,183,464 + 2,172,368 + 2,175,131 + 2,165,722) / 6 = 13,167,932 / 6 ≈ 2,194,655 ms` (~36m 35s)
- **Median:** sorted `[2,165,722 ; 2,172,368 ; 2,175,131 ; 2,183,464 ; 2,230,273 ; 2,240,974]` → mid-pair mean = `(2,175,131 + 2,183,464) / 2 = 2,179,298 ms`

### Wave 7 predicted band

| Band | Value | Rationale |
|---|---:|---|
| Predicted clean band (n=6 observed) | `2,165,000 – 2,241,000 ms` | observed min–max with rounding |
| Predicted centre (mean of n=6) | `~2,195,000 ms` | mean as best-guess |
| Yellow watch threshold | `> 2,300,000 ms` | canon Tier 1 maxRuns=24 yellow |
| Hard re-halt ceiling | `> 2,400,000 ms` | canon Tier 1 maxRuns=24 hard |
| Predicted upper bound for clean (+5%) | `~2,353,000 ms` (max × 1.05) | informational only; still below yellow |

Notes on the band:

- 6 samples remain **descriptive**, not statistically fixed. Use the band as an expectation, not a hard contract.
- Trend: each consecutive wave has been faster than or comparable to its predecessor in the fast cluster (W3/W4/W5/W6 all in `36m 05–23s` range). One hypothesis: sparser-density horizons remaining → faster chunk completion. Not proven; do not infer policy from trend.
- A 7th sample mostly tightens variance; it does NOT unlock series-of-10 / Tier 2 / parameter bump by itself.

### Re-halt rule 1 (duration) thresholds for Wave 7 — explicit

- Strict clean: `durationMs ≤ 2,300,000 ms` (≤ yellow)
- Yellow watch (closure-eligible with note): `2,300,001 – 2,400,000 ms`
- Hard red closure after terminal: `> 2,400,000 ms`

`durationMs` is populated only when the target `cleanupRunState` row reaches a terminal state. It is not a direct mid-wave abort signal. Mid-wave aborts use live proxy signals only: slow inter-chunk gaps, PG waits/locks/BIO, WAL growth, and `/version` degradation (section 7.2).

---

## 4. Execution Steps (ordered)

### Step 4.1 — Mini-preflight #1 (T-15…T-5 min)

Run all checks from section 1. If anything fails — HOLD.

Final "go" gate (read-only):

```text
[ ] origin/emergency/drain-scheduled-jobs == 1dc5c72  (pinned SOT not drifted)
[ ] git merge-base --is-ancestor 7cfa08c 1dc5c72 == true
[ ] env METRICS_REALTIME_CLEANUP_V2_ENABLED = "0" via ≥2 paths (local CLI + cleanupRunState)
[ ] no active cleanupRunState row (last 6 all completed/isActive=false)
[ ] /version HTTP 200, response ≤ ~2s
[ ] PG mini-snapshot: pg_wal ≤ ~6 GB, 0 waiting locks, 0 idle-in-tx, MEM% ≤ ~25 on PG
[ ] host: mem available ≥25 GiB, disk free ≥100 GB
[ ] UTC cron-avoid window cleared (no boundary inside T0..T0+45min)
[ ] D1b/D1c sibling env: DISABLE_ERROR_ALERT_FANOUT = "0"
[ ] /private/tmp execution worktree: HEAD=1dc5c72, status --short empty
[ ] all three restorer rehearsals pass (positive + negative + parser regression)
[ ] gen-admin-key.cjs helper sha256 matches prepared helper
[ ] Operator explicit "go Wave 7"
```

If two consecutive mini-preflight passes show an organic burst (Convex CPU > 50% on either), wait one cycle then re-probe — burst on a single sample is documented baseline noise; sustained burst defers the wave.

### Step 4.2 — Restorer rehearsals (mandatory, read-only, before any env write)

Wave 7 requires **three** rehearsals to pass before env flip. All three are mandatory.

First, verify the execution worktree has the hardened restorer script:

```bash
git -C /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head rev-parse HEAD
git -C /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head status --short
test -f /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head/scripts/storage-cleanup-restorer.cjs
node /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head/scripts/storage-cleanup-restorer.cjs --help
```

Required: `rev-parse HEAD == 1dc5c72`, `status --short` empty, file exists, `--help` smoke passes.

#### Rehearsal A — Positive dry-run

Target Wave 6 terminal runId `1778955542827-b02bca844e80` (current, visible, known-terminal):

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
node /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head/scripts/storage-cleanup-restorer.cjs \
  --target-run-id 1778955542827-b02bca844e80 \
  --dry-run \
  --once \
  --read-limit 10
```

PASS: restorer prints `action=restore_env`, `reason=target_terminal`, and `env_verify=dry-run`. Do NOT actually let it set env=0 during rehearsal.

#### Rehearsal B — Negative dry-run (invalid runId)

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
node /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head/scripts/storage-cleanup-restorer.cjs \
  --target-run-id 0000000000000-000000000000 \
  --dry-run \
  --once \
  --read-limit 10
```

PASS: restorer prints `action=wait`, `reason=target_not_visible`, and no restore attempt.

#### Rehearsal C — Parser regression (NEW for Wave 7)

The Wave 6 first restorer exited mid-run with `Unexpected token 'W', "WebSocket "...`. The hardening in `7cfa08c` extracts the first balanced JSON array from noisy output. This rehearsal verifies the parser tolerates noise.

Use fixture-driven CLI rehearsal or run targeted vitest:

```bash
# Option A — vitest harness (preferred; validates the test file itself)
cd /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head
npm ci
npm run test:unit -- storage-cleanup-restorer
```

PASS: vitest reports `11/11 passed` (or all tests in `tests/unit/storage-cleanup-restorer.test.ts` pass).

```bash
# Option B — fixture-driven CLI dry-run (faster, validates runtime path)
# Target a known-running row id via the noisy-running fixture; the parser should
# tolerate WebSocket-like noise before/after the JSON array payload.
```

PASS: restorer survives noisy input, parses rows correctly, makes correct `action=wait` / `action=restore_env` decision based on fixture state.

- Post-rehearsal env must remain `0` (verify via section 1.2 path A).

If any of A, B, C fails — **HOLD wave**. The hardening must pass all three rehearsals before any env flip.

### Step 4.3 — Env flip `0 → 1` (T-0 minus seconds)

This is the **first** runtime write of the wave. From this moment until terminal, env = `"1"`.

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1
# verify
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED
# expect: 1
```

Verify env=`"1"` via CLI BEFORE invoking the trigger. If the CLI returned an error or a non-`"1"` value, do NOT proceed.

### Step 4.4 — Trigger wave action (T0)

Invoke exactly once.

```bash
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex run metrics:triggerMassCleanupV2 \
  '{"batchSize": 1000, "timeBudgetMs": 10000, "restMs": 90000, "maxRuns": 24}'
```

Shell quoting caveat: the JSON payload above must reach Convex as one argument. If your shell mangles quotes or line continuations, stop and run a local `printf '%s\n' '{"batchSize": 1000, "timeBudgetMs": 10000, "restMs": 90000, "maxRuns": 24}'` check first; do not improvise a partially quoted trigger command.

Expected response:

```json
{ "status": "scheduled", "runId": "<unixMs>-<12hex>" }
```

If response is `{"status": "disabled"}` → env did not actually flip; verify env, do not re-trigger blindly.
If response is `{"status": "already-running", "runId": "..."}` → an active run exists; do NOT trigger again, investigate.

Record `runId` (the full string and the short suffix) — this is the **target** for both watcher and restorer.

#### 4.4.1 `fetch failed` protocol (formalized for Wave 7)

Pattern observed in W4 first attempt and W6 first attempt — 2/6 waves (~33%). No longer one-off. Formal protocol below; **auto-retry is forbidden**.

If trigger response is `TypeError: fetch failed` or equivalent transient error:

| Step | Action | Acceptance |
|---|---|---|
| (a) | Read `cleanupRunState --limit 3` immediately | No new target row created. If any row with fresh `claimed`/`running` exists → STOP, treat as `already-running` situation, do not retry |
| (b) | Restore env=0 explicitly (do not assume) | `npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0` + verify via path A reads `0` |
| (c) | Run full fresh preflight (sections 1.1–1.7) | All 0.1–0.9 gates pass again |
| (d) | Verify cron-avoid runway sufficient for retry attempt + 45min envelope | New T0 still inside the open UTC window |
| (e) | Operator explicit re-confirm | `go Wave 7 retry` from operator in current session |
| (f) | Re-trigger ONCE | Same args |
| (g) | If second attempt also `fetch failed` | STOP completely. Capture network/Convex diagnostics. Do NOT auto-retry a third time. Investigate `/version` health, DNS, local network, Convex deploy state under separate go |

Failure event MUST be documented in closure memo:

- Timestamp of failed trigger
- Exact error message (verbatim)
- `cleanupRunState --limit 3` snapshot proving no-row-created
- Env verification after restore (`0` confirmed)
- Timestamp of successful retry trigger
- Runway/window calculation showing retry was inside acceptable UTC band

### Step 4.5 — Arm SSH short-poll watcher (T+1 min, background)

Pattern proven in Waves 1–6 (`memory/storage-cleanup-v2-tier1-maxruns24-canary-2026-05-1*`):

- Watcher polls `cleanupRunState` for the target runId every 60–90 s via SSH + Convex admin or via Convex CLI from the local box.
- Logs heartbeat (`alive, last_observed_state=X, batchesRun=N`) every poll.
- Captures inter-chunk gap durations. Expected: 21–23 visible gaps in `93–97 s` band (per W2/W3/W6 observations).
- Marker for slow-chunk concern: **>145 s inter-chunk gap** = `SLOW_CHUNK_THRESHOLD`. No fires expected; no >145 s slowdown was observed in W1–W6.
- Avoid long-running local `npx convex` watcher (Wave 1 closure: it can hang on extended sessions). Prefer SSH short-poll from a fresh subshell each iteration, with retry on `rc=255`.

The watcher is **observational only**. It does NOT decide env state. That is the restorer's job (next step).

### Step 4.6 — Arm independent terminal-restorer (T+5…T+35 min, background)

The hardened restorer (`7cfa08c`) now tolerates noisy Convex CLI JSON output. Key properties (unchanged from Wave 5 hardening plus noisy-JSON fix):

- Exact `targetRunId` binding (not "any terminal row").
- Parsed-field decision (`state == "completed"` AND `isActive == false`), not shell `$?` inference.
- **NEW (`7cfa08c`):** `parseRowsJson` extracts the first balanced JSON array from output, tolerating WebSocket/reconnect noise before or after the payload. Wave 6 first restorer SPOF (`Unexpected token 'W', "WebSocket "...`) is now closed.
- Heartbeat JSON every poll.
- Live `env=0` restore only after target terminal observed.
- Post-restore env verification (`get` after `set`; must read back `"0"`, not `"1"`).
- Atomic close — env returns to `0` within ~12 s of computed terminal in normal flow.

Cadence: 60 s baseline, 30 s after T+30 min (terminal becoming imminent).

The restorer should be a **separate process** from the watcher (independent SSH/local subshell or background process). This is intentional — if the watcher hangs, the restorer still runs; if the restorer hangs, the watcher still gives operator visibility.

### Step 4.7 — In-wave probes (T+~17 / T+~25 / T+~31)

Sampled probes during the rest phase between chunks. Each probe captures (via SSH read-only):

- Convex CPU (`docker stats --no-stream` adpilot-convex-backend)
- PG CPU (same for adpilot-postgres)
- PG `pg_stat_activity` aggregate: `count(*) FILTER (WHERE state='active' AND xact_start IS NOT NULL)`, `count(*) FILTER (WHERE wait_event_type='Lock')`, `count(*) FILTER (WHERE state='idle in transaction')`
- Loadavg (`uptime`)
- WAL `pg_ls_waldir()` agg, OR `du -sh $PGDATA/pg_wal` via docker exec

Expected (per W1–W6 norms):

- Convex CPU `0.06–3.5 %` (idle-baseline; samples land in rest phase between chunks)
- PG CPU `0.02–7.5 %`
- Loadavg 1m `0.10–0.50`
- Waiting locks: `0`
- Long-active: `0`
- Idle-in-tx: `0`
- WAL: stable, no >+1 GB delta vs preflight

Chunk-compute phase sampling (rare, e.g. T+~5–6 min or coincident with active batch): expect Convex CPU spike to `80–140%`, PG `30–62%`, but `0` waits/locks/DFR/BIO — this is normal active DELETE batch. NOT a halt signal.

If any probe shows: PG waiting locks > 0, OR DFR/BIO/BufferPin > 0 sustained, OR sustained loadavg 1m > 1.0 — escalate per section 7.

### Step 4.8 — Terminal detection (T+~37 min)

Terminal = `cleanupRunState` for target runId has `state="completed"` AND `isActive=false` AND `batchesRun=24` AND `deletedCount=24,000` AND `durationMs` populated.

Watcher should observe terminal within ~7–60 s of row finalization (poll-based detection latency).

Compute `terminal_observed_utc` and capture `durationMs` and final `oldestRemainingTimestamp` for the closure note.

### Step 4.9 — Atomic env restore `1 → 0` (T+~37 min)

The **restorer fires first** on its first terminal poll:

```bash
# inside restorer process, once parsed-field state=="completed" && isActive==false:
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0
# immediate verify in same process
CONVEX_SELF_HOSTED_URL=http://178.172.235.49:3220 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node gen-admin-key.cjs)" \
npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED
# expected stdout: 0
```

Multi-path verification (within next ~60 s):

| Path | Check | Acceptance |
|---|---|---|
| A. Restorer log | restorer printed `env_verify=0` line | YES line present |
| B. Independent local CLI (separate shell, fresh subshell) | `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` | returns `0` |
| C. cleanupRunState re-probe | latest row `state="completed"`, `isActive=false`, no new run row | corroborated |

If local CLI briefly returns `"1"` due to WebSocket / DNS flake (Wave 2 pattern) — wait 30–60 s, re-check. Restorer log is authoritative if it shows `env set 0` + `env verify '0'` independently.

If after 3 attempts via independent paths env is still `"1"` → **HARD RED**. Manually `npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0` again, verify, alert operator, document the failure in closure.

### Step 4.10 — Post-wave audit T+~3 min from terminal

Capture another snapshot of:

- `/version` HTTP 200 ×3 (all 200, response time ≤ 2 s)
- env reads `"0"` (paths A+B+C)
- Convex CPU, PG CPU
- Loadavg 1m drained below 0.5
- PG waiting locks 0, long-active 0, idle-in-tx 0
- WAL: Δ vs preflight. Healthy pattern (per W2/W3): WAL file count drops or stays flat after wave (checkpoint absorbs the burst). Anything like +2 GB / +50 files net is YELLOW.

**T+3 burst expectations — updated post Wave 6:**

Wave 6 T+3 observed Convex CPU `138.72%` + PG CPU `64.39%` + loadavg `1.39` simultaneously, but with `waits=0`, `idle-in-tx=0`, `DFR/BIO/BufferPin=0`, WAL flat. Settled by T+5 to Convex `0.00%`, PG `0.02%`, loadavg `0.20`.

Interpretation for Wave 7:

- **High Convex/PG CPU at T+3 alone is an information signal, not an abort signal.** Document for trend.
- **Abort signal (re-halt rule 2):** PG-side burst with `waits/locks/DFR/BIO/BufferPin > 0` sustained. All three (or any) hard PG-internal signals must be present, not just CPU.
- If W7 repeats the W6 pattern (Convex ~140%, PG ~65%, no PG-internal waits, settles by T+5) → new baseline established, update runbook for W8.
- If W7 returns to W1–W5 pattern (Convex 30–55%, PG 0–7% post-terminal) → W6 was an outlier; document and reduce attention.

### Step 4.11 — Post-wave settle T+~5 to T+~17 min from terminal

Optional but recommended for Wave 7 given the T+3 caveat. Captures organic burst differentiation:

- A Convex CPU burst at T+~5 of magnitude `30–55%` is **expected baseline** (documented in W2, W3, W5 closures). PG-side stays at 0–7% with no waits → confirms organic, not cleanup-related.
- The W6 T+3 pattern (Convex 138%, PG 64%) settling by T+5 to `0.00%`/`0.02%` is **the explicit watch item** for Wave 7.
- A PG-side burst at T+5 (PG CPU >20% AND waits >0 AND BIO/DFR>0) post-terminal would be NEW signal → escalate.

T+~5 capture for Wave 7 is RECOMMENDED, not optional, even if T+3 was clean.

### Step 4.12 — Closure decision

Three buckets:

- **Strict clean**: durationMs ≤ 2,300,000 ms, all re-halt rules GREEN, no operator manual env intervention, no unexplained probe signals.
- **Yellow (closure-eligible with note)**: durationMs in `(2,300,001 – 2,400,000)` OR one off-rule corroborated but not sustained (e.g. one-sample organic burst at T+~5 with PG-side clean).
- **Red**: durationMs > 2,400,000 ms (hard re-halt) OR re-halt rule 2/3/4/5/6 RED OR restorer failed to restore env without manual intervention.

Note on `fetch failed` retry: a single `fetch failed → no-row verify → fresh preflight → successful retry` cycle is **operationally non-trivial but not a yellow signal by itself** (the wave that ran did so cleanly). Document in closure operational notes section.

Write closure memo per section 8.

---

## 5. Six Re-halt Rules (canon, scaled for maxRuns=24)

| # | Rule | Threshold | Source-of-truth verification |
|---|---|---|---|
| 1 | **Duration ceiling** | `durationMs > 2,400,000 ms` = RED. `> 2,300,000 ms` = YELLOW. | `cleanupRunState.durationMs` for target runId |
| 2 | **Sustained PG waits across multiple probes** | Any `wait_event_type='Lock'` count > 0 sustained across ≥2 probes; OR any `DataFileRead`/`BufferIO`/`BufferPin` sustained | `pg_stat_activity` aggregate, mid-wave AND T+~3 AND T+~5. **Note:** PG CPU alone is NOT a fire condition (see W6 T+3 baseline above). |
| 3 | **Loadavg elevated and not settled** | loadavg 1m > 1.0 sustained at T+~3 AND not down below 0.5 by T+~5 | `uptime` on host. **Note:** transient loadavg spike at T+3 (W6 had 1.39) is informational if it settles by T+5. |
| 4 | **Env not back to `0`** | env reads `"1"` (or anything `!= "0"`) after terminal; OR remains "1" after restorer fires | local CLI `env get` + restorer verify line |
| 5 | **Non-cache RSS + MEM>30% + headroom<5 GiB** | ALL THREE simultaneously: non-cache RSS growth on PG (≫ 300 MB baseline), `docker stats` MEM% on adpilot-postgres > 30%, host headroom < 5 GiB | `docker stats`, cgroup memory.stat split, `free -h` |
| 6 | **Runtime / SQL / cleanup discipline breach** | Any DDL/DML outside cleanup, GUC toggle, ad-hoc VACUUM/ANALYZE, container restart, parallel cleanup, PG raw probe during the wave | Operator self-attest + git log + audit |

ALL six must be GREEN at preflight, in-wave, post-wave. ANY single RED = red closure for the wave.

---

## 6. Restorer Pattern (independent terminal-restorer)

Status: production-validated end-to-end at Wave 6 with noisy-JSON SPOF caveat. **Hardened in `7cfa08c` ("tolerate noisy restorer JSON")** — pinned SOT for Wave 7 includes this fix. Wave 7 is the first production run on the noisy-JSON-tolerant restorer.

Required properties (any of these missing → restorer is unfit):

1. **Exact targetRunId binding.** Restorer accepts target `runId` as input; only restores env when THAT runId terminates. Never on any-runId terminal.
2. **Parsed-field decision.** State decision is on parsed JSON fields (`state`, `isActive`), not on shell exit code of a command substitution. The W4 SPOF was exactly this — `$?` after command substitution behaved differently than expected.
3. **NEW (`7cfa08c`): Noisy-JSON tolerance.** `parseRowsJson` extracts the first balanced JSON array from output, tolerating WebSocket/reconnect noise before or after the payload. The W6 first restorer SPOF (`Unexpected token 'W', "WebSocket "... is not valid JSON`) is now closed.
4. **Heartbeat per poll.** Each iteration logs `restorer alive, iter=N, observed_state=X, batchesRun=Y, isActive=Z`. Silent restorer = operator-blind.
5. **Atomic env-set + verify in same process.** After detecting terminal: `env set 0` immediately followed by `env get`. Both in restorer log. If `env get` doesn't return `"0"`, restorer retries up to N times then alerts (does not silently exit).
6. **Failsafe with guarded conditions** (defence in depth; optional but recommended): at `expectedDuration + 10 min`, if target still active → halt automation + alert operator. NEVER force env=0 on timeout alone.

Failure modes (historical):

- **W4 SPOF**: shell `$?` ambiguity after command substitution. Fixed in `f46594e`.
- **W2 Local DNS flake on env-verify**: single CLI path can transiently return stale `"1"` during WebSocket reconnect. Mitigated by multi-path verification.
- **W1 Local `npx convex` long-running watcher hung**: mitigated by SSH short-poll pattern.
- **W4 `fetch failed` on trigger**: no `cleanupRunState` row created, env immediately restored to 0, retried later cleanly. Formalized in section 4.4.1.
- **W6 noisy-JSON SPOF**: fixed in `7cfa08c`. Verified by vitest harness (11/11 in isolated worktree after `npm ci`) + live positive dry-run vs W6 runId + live negative dry-run vs invalid runId.

Rehearsal procedure (mandatory before flip — see section 4.2 for full commands):

```text
A. Positive dry-run: target W6 runId 1778955542827-b02bca844e80
   Expected: action=restore_env, reason=target_terminal, env_verify=dry-run

B. Negative dry-run: target invalid runId 0000000000000-000000000000
   Expected: action=wait, reason=target_not_visible

C. Parser regression: vitest harness OR fixture-driven CLI dry-run
   Expected: parser tolerates noisy WebSocket-like output, all assertions pass

Post-rehearsal: env STILL "0"
```

If any of A, B, C fails → restorer broken → **HOLD wave**.

---

## 7. Aborts / Rollback

### 7.1 Abort before env flip (pre-wave HOLD)

Trigger HOLD if any of these are true at preflight or rehearsal:

- Pinned SOT drifted (origin no longer at `1dc5c72`)
- env already `"1"` (means previous wave didn't close cleanly — investigate first)
- An active `cleanupRunState` row exists
- PG storm-fix not holding (pg_wal > 6 GB approaching `max_wal_size=8 GB`)
- Any of three restorer rehearsals (A/B/C) failed
- Cron-avoid window violation predicted
- `/version` HTTP non-200 or response > 5 s repeatedly
- Operator unsure / lost shell context

HOLD is cheap; "fire-and-hope" is not. Document the HOLD in conversation log.

### 7.2 Mid-wave emergency abort

Trigger only if **ANY** of these are observed live:

- Slow-chunk: ≥3 consecutive inter-chunk gaps > 145 s OR any single gap > 200 s
- Sustained PG CPU > 50% for > 2 consecutive probes **WITH** waits/locks/BIO > 0 (CPU alone is not a fire condition — see W6 T+3 baseline)
- WAL Δ > 5 GB above preflight baseline (approaching `max_wal_size=8 GB`)
- Waiting locks > 0 sustained across 2 probes
- `DataFileRead`/`BufferIO`/`BufferPin` events appear and persist > 1 probe interval
- `/version` HTTP 5xx repeated, or response > 10 s
- `pg_stat_activity` shows queries stuck > 30 s on heap-scan style waits

**Abort procedure:**

1. `npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0` — **first action, atomic**.
2. Verify env=`"0"` via multi-path (paths A/B/C).
3. The currently-running `manualMassCleanupV2` chunk will complete its current batch (it's already in flight), then `markFailedV2(error="disabled_mid_chain")` on the next iteration — chain terminates cleanly. Do NOT try to kill in-flight DELETE.
4. Do NOT trigger another wave. Do NOT escalate cleanup-side. Move to root-cause diagnostic of the underlying signal (PG / WAL / etc.) under a separate go.
5. Document in conversation; closure memo records the abort with timestamps and observed signals.

### 7.3 Post-wave red closure

If the wave completes but is RED (duration > hard ceiling, OR re-halt rule RED, OR restorer needed manual rescue):

1. env must already be `"0"` (atomic) — verify.
2. **Do NOT auto-trigger Wave 8.** A red wave invalidates the series-by-inertia chain.
3. Capture full post-mortem in closure memo (section 8).
4. Operator decides next wave separately after RC analysis. Likely steps before Wave 8: fresh PG snapshot, possibly re-evaluate profile, possibly hold series for an observation window.

---

## 8. Post-Wave Reporting

### 8.1 Data to capture in closure memo

- runId (full + short)
- Trigger UTC + Minsk
- Terminal UTC + Minsk
- `lastBatchAt`, computed terminal (= `startedAt + durationMs`)
- `durationMs` + human-readable duration
- `batchesRun` (expect 24), `deletedCount` (expect 24,000), `error` (expect `null`)
- Final `state="completed"`, `isActive=false`
- Final env: `"0"` + verification paths
- W6 → W7 floor advance: `oldestRemainingTimestamp` Δ (W6 = `1,777,741,818,661` = `2026-05-02T17:10:18.661Z`)
- Cumulative series totals: deleted (was `144,000` after W6; +24,000 after W7 expected = `168,000`), waves ledger `7/7` if clean
- Threshold check table (% of yellow, % of hard, vs predicted band)
- Mid-wave probes table (T+~17/T+~25/T+~31): Convex CPU, PG CPU, loadavg, waits, locks, DFR/BIO
- Post-wave audits T+~3 / T+~5 (and T+~17 if captured): same fields, with **explicit notation whether T+3 reproduced W6 burst pattern**
- All 6 re-halt rules: result row
- `fetch failed` retry events (if any) per section 4.4.1 protocol
- Operator hygiene: single trigger (per retry cycle), no retry mid-wave, admin key ephemeral + unset, no GUC, no VACUUM/ANALYZE, no DDL/DML, no container changes

### 8.2 Where to save closure

- Closure memo path: `memory/storage-cleanup-v2-tier1-maxruns24-canary-2026-05-17-<runIdShort>.md`
- Use Wave 6 closure as the format template (`memory/storage-cleanup-v2-tier1-maxruns24-canary-2026-05-16-b02bca844e80.md`).
- Update `memory/MEMORY.md` index with a new bullet referencing the closure memo.

Both writes are doc-only; no runtime, no env, no git push from this runbook's authoring session.

### 8.3 Series ledger after Wave 7 (if clean)

| Metric | Pre-W7 (after W6) | Post-W7 expected (if clean) |
|---|---:|---:|
| maxRuns=24 ledger | 6/6 strict clean | 7/7 strict clean |
| Cumulative deleted | 144,000 | 168,000 |
| Cumulative floor advance (from 16-series anchor `2026-05-02T16:19:44Z`) | +50m 34s (W6 floor `17:10:18Z`) | +Δ from W7 (density-dependent) |
| Yellow runs | 0 | 0 (if clean) |
| Red runs | 0 | 0 (if clean) |

---

## 9. NOT Authorized by Wave 7 Closure

A strict-clean Wave 7 closure does NOT, by itself, authorize ANY of the following. Each requires a separate explicit operator decision and a separate runbook/design:

- **Series of 10** at maxRuns=24 (would need Waves 8–10 each with their own explicit go).
- **maxRuns > 24**.
- **batchSize > 1000** (frozen by BD-2 repeat closure caveat `7d10154`).
- **restMs < 90000** (frozen by BD-3 dirty closure `358663a` pending Hypothesis C verification).
- **timeBudgetMs changes**.
- **Tier 2 automation** (cron-driven sustained drain at this profile).
- **Parallel waves** (two cleanup chains active simultaneously).
- **PG raw probes** (`COUNT(*)`, `MIN/MAX(ts)`, `GROUP BY table_id` over `documents`/`indexes`). Ban remains active because both gating conditions are still TRUE:
  - `shared_buffers < 1 GB` (current 128 MB)
  - `documents heap_hit rate < 50%` (current ~36%)
- **VACUUM FULL / pg_repack** on `documents` or `indexes`. Per live baseline 2026-05-14: do not reclaim while logical cleanup is still actively draining backlog. Decision deferred until `metricsRealtime` is near retention target AND fresh PG snapshot AND operator-approved maintenance window.
- **Skipping mini-preflight + explicit go for Wave 8** (no "series by inertia").

Per Wave 6 closure: "Wave 6 completion does not authorize Wave 7 or any escalation by inertia." Apply the same standard here: Wave 7 success does not authorize Wave 8 or any escalation.

---

## 10. Open Caveats

| # | Caveat | Source | Action |
|---|---|---|---|
| 10.1 | Pinned SOT advanced from `2b62f99` (W6) to `1dc5c72` (W7). Runtime-minimum ancestor `7cfa08c`. Local main checkout may still be dirty/behind. | session state, git log | Treat the pinned clean worktree at `/private/tmp/adpilot-wave7-sot-2026-05-16-origin-head` as SOT. If origin advances past `1dc5c72`, HOLD and reconcile. |
| 10.2 | CI did not fire on `7cfa08c` / `1dc5c72` commits — known pending track `ci/expand-trigger-branches` (CI triggers exclude `emergency/**`). Plus `ci.yml` has `continue-on-error: true` on typecheck. | `memory/ci-fix-2026-05-09-closure.md`, `memory/ci-workflow-typecheck-continue-on-error.md` | NOT a blocker: restorer is a local operator script (not Convex function), no deploy gap. Vitest harness validated locally (`npm ci` in isolated worktree, 11/11 passed). |
| 10.3 | PG raw probe ban active (`shared_buffers=128 MB`, `documents heap_hit ~36%`). | `memory/pg-readonly-diagnostic-2026-05-11.md` | Allowed paths only: Convex admin reads, `cleanupRunState`, `pg_stats` estimates, `pg_stat_*` aggregates. No `COUNT(*)`/`GROUP BY table_id` over heap tables. |
| 10.4 | Sustained drain ceiling: real live row count of `metricsRealtime` is **unknown** in idle. Ingest rate in idle is **unknown**. | `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md` | Wave 7 closure should capture floor advance to update drain math. |
| 10.5 | Cumulative floor anchor: end of 16-series at `2026-05-02T16:19:44Z`; W6 floor `2026-05-02T17:10:18.661Z` (`oldestRemainingTimestamp=1,777,741,818,661`). After Wave 7, floor advance is density-dependent (W1 was +5m 48s sparse, W2–W4 ~+9m 40s, W6 +5m 45s). | Wave closures W1–W6 | Capture W7 floor in closure memo for trend continuity. |
| 10.6 | **ToD hypothesis downgraded.** After Wave 6 (n=6): W5 morning fast + W6 evening fast vs W1/W2 morning slow → same ToD bucket gives both outcomes. Treat ToD as weak/noisy, not a scheduling constraint. | W6 closure / handoff | Wave 7 ToD is NOT a constraint. Operator can pick any time-of-day inside cron-avoid windows. |
| 10.7 | **T+3 post-terminal PG CPU burst** observed at W6 (Convex 138.72% + PG 64.39%, settled by T+5 with `waits=0/DFR=0/BIO=0`). Information signal, not abort signal (re-halt rule 2 requires PG-internal waits, not just CPU). | W6 closure / handoff | Wave 7 — explicit watch. Capture T+3 and T+5 settle probes. If W7 reproduces W6 pattern → new baseline for W8. If returns to W1–W5 pattern → W6 was outlier. |
| 10.8 | **Restorer noisy-JSON SPOF: FIXED in `7cfa08c`.** Verified by vitest 11/11 in isolated worktree + live dry-runs. | hardening receipt | First production run on hardened restorer. Treat rehearsal C (parser regression) as MANDATORY. |
| 10.9 | **`fetch failed` trigger pattern recurring** (W4 + W6 = 2/6 waves ~33%). | W6 closure | Formal protocol in section 4.4.1. Auto-retry forbidden. Operator explicit retry only after fresh full preflight. |
| 10.10 | `cleanup-realtime: STUCK` legacy V1 heartbeat noise revived by D1c (healthReport.ts now delivers again). | D1c canary memo | Cosmetic. NOT a Wave 7 blocker. Separate healthReport tuning track. Do NOT run `resetStuckCleanupHeartbeat` without a separate explicit go. |
| 10.11 | `indexes` 93 GB bloat (open caveat since 2026-05-11). Cleanup is logical-row drain, not physical reclaim. | `pg-readonly-diagnostic-2026-05-11.md`, `tier1-maxruns16-series-summary` | Decision deferred until after W10 + fresh PG snapshot + operator maintenance window go. Not affected by Wave 7. |

---

## 11. Quick Reference (single-screen operator card)

```text
PROFILE (frozen):  batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=24
ACTION:            metrics:triggerMassCleanupV2
ENV gate:          METRICS_REALTIME_CLEANUP_V2_ENABLED 0 → 1 → 0
EXPECTED DURATION: ~36m 05s – 37m 21s  (n=6 observed)
YELLOW > 2,300,000 ms;  HARD > 2,400,000 ms
SLOW_CHUNK_THRESHOLD = 145 s

PINNED SOT:        1dc5c72431543f5e00759d20fa5d36b447bd4336  (origin/emergency/drain-scheduled-jobs)
RUNTIME-MIN:       7cfa08cd218d2523188048853e1bcd5d0d48168e  (must be ancestor of pin)
EXEC WORKTREE:     /private/tmp/adpilot-wave7-sot-2026-05-16-origin-head

EARLIEST GO:       2026-05-17T00:06Z onwards (no D1c gate; cron-avoid only)

CRON-AVOID UTC (±5min): 00:00 / 02:00 / 05:30 / 06:00 / 12:00 / 18:00
LAST SAFE TRIGGER:       <= cron_boundary - 50min
                          (45min wave envelope + 5min no-go buffer)

PREFLIGHT GATES:   (0.1) pinned SOT + ancestor  (0.2) env=0 ×2 paths
                   (0.3) no active runState  (0.4) 6 re-halt rules GREEN
                   (0.5) PG mini-snapshot green  (0.6) cron window clear
                   (0.7) exec worktree HEAD/clean  (0.8) admin-key sha256
                   (0.9) restorer rehearsals A+B+C  (0.10) operator go

REHEARSALS (all 3): A = positive dry-run vs W6 runId 1778955542827-b02bca844e80
                    B = negative dry-run vs invalid 0000000000000-000000000000
                    C = parser regression (vitest 11/11 OR fixture CLI)

EXEC ORDER:        preflight → rehearsals A+B+C → env 0→1 verify
                   → trigger (single; if fetch failed → section 4.4.1 protocol)
                   → arm watcher → arm restorer → in-wave probes T+17/T+25/T+31
                   → terminal detect → restorer atomic env 1→0
                   → multi-path verify env=0  → audit T+~3 (WATCH W6 burst pattern)
                   → settle T+~5  → closure decision  → closure memo

EXPLICIT WATCH:    T+3 post-terminal — does W7 reproduce W6 Convex/PG CPU burst
                   pattern? Document either way (new baseline or W6 outlier).

NOT AUTHORIZED:    Wave 8-by-inertia, maxRuns>24, restMs<90k, batchSize>1000,
                   timeBudgetMs change, Tier 2 automation, parallel waves,
                   PG raw probes, VACUUM FULL / pg_repack

ON ABORT:          env=0 first (atomic), verify, do NOT retrigger,
                   document in closure, escalate diagnostic separately
```

---

## Appendix A. Action signatures (from convex/metrics.ts on origin)

```typescript
// internalMutation — env-gated, single trigger entrypoint
metrics:triggerMassCleanupV2({
  batchSize: v.number(),
  timeBudgetMs: v.number(),
  restMs: v.number(),
  maxRuns: v.number(),
})
// returns: { status: "scheduled", runId } | { status: "disabled" } | { status: "already-running", runId }
```

```typescript
// internalAction — per-chunk worker, scheduled by trigger and by scheduleNextChunkV2
metrics:manualMassCleanupV2({ runId: v.string() })
// chain: markRunning → deleteRealtimeBatch → recordBatchProgress
//        → (if batchesRun<maxRuns && hasMore) scheduleNextChunk
//        → (else) markCompleted
// on env=0 mid-chain: markFailedV2(error="disabled_mid_chain")
```

```typescript
// internalQuery — for restorer/watcher to read state
metrics:getCleanupRunStateV2({ runId: v.string() })
// returns: cleanupRunState row or null
```

```typescript
// internalAction — the cron-tick path (cron currently disabled). Logs env each tick.
metrics:cleanupOldRealtimeMetricsV2({ batchSize, timeBudgetMs, restMs, maxRuns })
// not invoked from manual wave; documented here for grep completeness
```

### Schema (origin/emergency/drain-scheduled-jobs @ `1dc5c72`:convex/schema.ts:849–873)

```typescript
cleanupRunState: defineTable({
  cleanupName: v.string(),
  runId: v.string(),
  state: v.union(v.literal("claimed"), v.literal("running"),
                 v.literal("completed"), v.literal("failed")),
  isActive: v.boolean(),
  startedAt: v.number(),
  lastBatchAt: v.optional(v.number()),
  batchesRun: v.number(),
  maxRuns: v.number(),
  cutoffUsed: v.number(),
  deletedCount: v.number(),
  oldestRemainingTimestamp: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  error: v.optional(v.string()),
  batchSize: v.number(),
  timeBudgetMs: v.number(),
  restMs: v.number(),
})
  .index("by_cleanupName_isActive", ["cleanupName", "isActive"])
  .index("by_runId", ["runId"]),
```

`oldestRemainingTimestamp` is populated only on `markCompletedV2` via Convex `db.query("metricsRealtime").withIndex("by_timestamp").order("asc").first()` — real oldest live row, not tombstone/version. `markFailedV2` does NOT update this field. Therefore floor-advance trend is measured between `completed` waves only.

---

## Appendix B. Series ledger (canonical, post-Wave 6)

```
maxRuns=24 series (Tier 1 supervised canary):

W1  2026-05-11T06:24:44Z  24c7323b15b8  37m 20.97s  2,240,974 ms  clean
W2  2026-05-11T07:43:27Z  8cd44b08a1d8  37m 10.27s  2,230,273 ms  clean
W3  2026-05-11T12:08:18Z  76e7fd71103f  36m 23.46s  2,183,464 ms  clean
W4  2026-05-11T18:43:59Z  605b8ed53962  36m 12.37s  2,172,368 ms  clean
W5  2026-05-14T09:34:03Z  2d97cfccdf0a  36m 15.13s  2,175,131 ms  clean  (first post-restorer-hardening prod)
W6  2026-05-16T18:19:02Z  b02bca844e80  36m 05.72s  2,165,722 ms  clean  (fastest; first post-noisy-JSON-hardening prod)

Cumulative deleted:    144,000 rows
Min:                   2,165,722 ms
Max:                   2,240,974 ms
Mean:                  2,194,655 ms
Median:                2,179,298 ms
Spread:                ~3.47 %
Yellow watch:          > 2,300,000 ms
Hard re-halt ceiling:  > 2,400,000 ms

W6 oldestRemainingTimestamp: 1,777,741,818,661  = 2026-05-02T17:10:18.661Z
```

Predecessor: Tier 1 maxRuns=16 series summary `5428e77` (10/10 strict clean + 1 yellow, anchor floor `2026-05-02T16:19:44Z`).

---

End of runbook.
