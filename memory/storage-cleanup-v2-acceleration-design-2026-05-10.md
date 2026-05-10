# Storage Cleanup V2 — Acceleration Design (2026-05-10)

## Goal & scope
Design only. **NOT** a runbook for execution. Адресует "retention gap widening" strategic signal из `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`. Не авторизует никаких runtime изменений и не задаёт конкретных дат/cron-расписаний.

## Why now
Phase 2 baseline (preflight 2026-05-10 06:30Z): floor advance ≈ 14m57s/day vs now-clock 24h/day → `gap_delta = +23h45m/day` widening. Manual safe-profile cadence математически не сходится к 48h retention. Operator-driven cadence имеет hard ceiling (1–6 waves/day реалистично). PG tuning (`shared_buffers` 128MB → 3GB и далее) — отдельный track; этот design работает на **текущих** PG settings, после tuning может пересматриваться.

## Step 0 — Measure real V2 ingest rate (prerequisite)

**Goal:** Establish actual current V2 ingest rate baseline for `metricsRealtime`.

**Expected:** **unknown; do not infer from historical floor density.** Previous rough estimates (≈160K/hour from "8K rows / 3 min historical density"; 50–80K/hour from footprint × retention age) — order-of-magnitude only, **NOT** input for sizing. Историческая плотность старых данных ≠ текущему ingest after V1 5-min → V2 15-min sync cadence change.

**Safe methods (in order of preference):**

1. **Bounded page scan:** `db.query("metricsRealtime").withIndex("by_timestamp").order("desc").take(N)` with hard-capped `N` (например 1000). Read timestamp range of returned rows, derive rate as `N / (latest_ts − oldest_ts)`. Hard cap N, **never** unbounded.
2. **Two-snapshot delta:** capture latest timestamp at T0 via bounded page scan; capture again at T0+15min; count rows in window via bounded page scan. Дает instantaneous rate в текущем окне.
3. **Sampled estimate:** sample N rows uniformly across recent timestamps (paginated), derive density per minute.
4. **Exact count:** только если query strictly bounded (LIMIT clause) AND timeout/progress controlled (`statement_timeout` + cursor/page-by-page).

**Forbidden:**
- `.collect()` on `metricsRealtime` (unbounded).
- Unbounded `COUNT(*)` (через Convex или PG).
- PG raw probes на `documents` за `table_id = metricsRealtime` — banned per drain plan PG raw probes section, пока `shared_buffers ≥ 1GB` AND `documents` heap hit ≥ 50%.

**Outcome:** Single estimated value — rows/hour ingest rate (с confidence band если применимо). **Без этой цифры никакой Tier не запускается** — размер acceleration зависит от ratio `target_drain / ingest`.

## Tier 1 — `maxRuns` 8 → 16/24

**Why first:**
- Same per-chunk risk profile: chunk size, `restMs`, `timeBudgetMs` не меняются.
- Longer wave duration but **no new failure mode** — каждый chunk идёт через тот же already-validated cleanup path.
- Fewer operator triggers per drained-rows total → less operator overhead.

**Math (chunk avg ~7.5s observed in BD-2 closures):**
- `maxRuns=8` (current): `8 × 7.5s + 7 × 90s = 690s ≈ 11.5 min/wave`, 8000 rows.
- `maxRuns=16`: `16 × 7.5s + 15 × 90s = 1470s ≈ 24.5 min/wave`, 16000 rows.
- `maxRuns=24`: `24 × 7.5s + 23 × 90s = 2250s ≈ 37.5 min/wave`, 24000 rows.

**Cron-window runway fit:**
- Окно 12:05 → 17:55 UTC (между cleanup-old-realtime-metrics cron boundaries) = 5h50m.
- Помещает 30+ waves of `maxRuns=8`, или 14 waves of `maxRuns=16`, или 9 waves of `maxRuns=24`. **Не constraint** для Tier 1.

**Decision criteria (consistent with drain plan re-eval gate):**
- ≥10 consecutive clean waves at `maxRuns=16` + fresh PG snapshot green → bump to `maxRuns=24`.
- Same gates as drain plan: WAL bytes/day & FPI within baseline; 0 waiting locks / 0 idle-in-tx; `documents.n_dead_tup` not trending up; cache hit not degraded vs current 66.95%.

## Tier 2 — Automation / scheduled drain

**Why required:** Math requires it for convergence beyond what manual cadence ceiling allows. Even at maximum reasonable manual rate (`maxRuns=24` × 6 waves/day = 144K rows/day), if Step 0 ingest rate × 24h > 144K, manual + Tier 1 не сходится. Automation становится обязательной.

**Required for convergence, but gated:** behind Step 0 ingest measurement + Tier 1 validation. Не запускать раньше, потому что (a) без реального ingest rate невозможно sized properly, (b) без Tier 1 stability нельзя доверять scheduled trigger без operator oversight.

### Tier 2a — Controlled scheduled manual-equivalent waves (preferred first form)
- Scheduler triggers wave at fixed cadence (например каждые N часов).
- **Each scheduled run:** flips env to `"1"` for the run only → executes wave → flips env back to idle-safe state (unset OR `!= "1"`).
- Same per-wave attribution as manual; differs только в trigger source (scheduler vs operator).
- env **NEVER** held `"1"` between scheduled runs.
- Per-run profile = the validated Tier 1 profile (e.g. `maxRuns=24` если уже валидирован).

### Tier 2b — Adjust existing 6h cron profile (later)
- After 2a validated, можно adjust `cleanup-old-realtime-metrics` cron profile from current `(500/10000/90000/5)` → larger profile.
- Mixes attribution explicitly between scheduled-cron-driven and manual-equivalent runs.
- Cron работает ТОЛЬКО когда env=`"1"` (fail-closed); при Tier 2a model env флипается per-run only.

**Forbidden patterns (do NOT design around these):**
- env held `"1"` permanently — нарушает Operational rules в drain plan (organic cron смешает атрибуцию навсегда).
- Scheduler running waves WITHOUT env-toggle per-run — same problem.
- Long-running scheduled drain with no Stop criteria → blackbox accumulation.

**Decision criteria for entering Tier 2:**
- Tier 1 fully validated: 10 consecutive clean waves at `maxRuns=24` + fresh PG snapshot green.
- Step 0 ingest rate measured (real number, not inferred).
- Math: real ingest rate × 24h > current manual ceiling → automation required.

## Tier 3 — `batchSize` 1000 → 1500

**Why third:** Per-chunk impact. ~+50% I/O per chunk. Может trigger новый DataFileRead pattern на 50 GB heap при текущем `shared_buffers=128MB`. Risk profile higher than Tier 1/2 — каждый chunk read'ит больше pages в крошечный pool → больше cache thrashing.

**Decision criteria:** Tier 2 validated + fresh PG snapshot green per drain plan re-eval gate (10 clean waves at Tier 2 + WAL/locks/dead_tup/cache hit baseline).

## Tier 4 — `restMs` 90 → 75

**Why fourth:** BD-3 outlier 9.572s at `restMs=60s` — empirical signal что 60s слишком близко к chunk-completion latency распределению. 75s = 15s buffer от 60s, small margin. Smallest throughput gain (~17%), highest empirical risk per drain plan VACUUM/I/O policy.

**Decision criteria:** Tier 3 validated + fresh PG snapshot green per drain plan re-eval gate.

## Tier 5 — Parallel waves / larger architecture

**Why last:** Bypasses already-running guard или вводит новую concurrency mechanic. Lock / I/O / WAL spike risk + mixed attribution. Requires:
- PG tuning landed (`shared_buffers` 128MB → 3GB + docker `--memory` limit одновременно) per separate tuning design doc.
- New canary phase для validation на новых PG settings.

**Examples (illustrative, not selected):**
- 2 parallel waves on different table partitions (если table partitioning возможен).
- Larger chunks (`batchSize` 5000+) only viable at increased `shared_buffers`.
- Alternative drain mechanism (например partition drop for old data instead of row-level delete).

**Decision criteria:** Tier 4 validated + PG tuning landed + new canary phase passed.

## Decision gates (consistent across tiers)

Same as drain plan re-eval gate, applied between consecutive tiers:
- ≥10 consecutive clean waves at current Tier (no Stop criteria triggered, no Yellow/hold signals from drain plan).
- Fresh PG snapshot green: WAL bytes/day & FPI within baseline; 0 waiting locks / 0 idle-in-tx; `documents.n_dead_tup` not trending up; cache hit rate not degraded vs current.
- **Tier 2 additional gate:** real ingest rate measured (Step 0 done, with concrete number).
- **Tier 5 additional gate:** PG tuning landed + new canary passed.

## Out of scope (explicitly NOT included)

- **Not a runbook.** No execution authorization, no specific dates, no cron schedules to register, no env edits.
- **Not target retention re-evaluation.** Если Tier 5 + PG tuning still не сходится, открывается separate question — снизить retention target (e.g. 48h → 168h), снизить ingest at source (sampling, longer sync interval), или alternative storage architecture.
- **Not PG tuning design.** Separate doc.
- **Not ingest reduction design.** Если real ingest rate (Step 0) too high to drain reasonably even at Tier 5, separate question (sampling, sync interval bump, schema change for metricsRealtime).
- **Not parallel-execution design.** Tier 5 listed only as last-resort placeholder; concrete parallel mechanic нужен отдельный design after PG tuning.

## Open questions for execution time (not for this design)

- Что считается "fresh PG snapshot green" с точки зрения thresholds? — drain plan re-eval gate говорит про trends ("not trending up", "not degraded"), нужны concrete numeric thresholds на момент исполнения.
- Tier 2a scheduler choice: Convex internal scheduler / external cron / manual operator-with-timer? — execution decision, не design.
- Step 0 measurement frequency: one-shot baseline или recurring measurement? Если ingest rate volatile, нужно recurring.
