# D2a pre-impl baseline (frozen)

Date captured: 2026-05-07T04:55:36Z (env re-verify); item-5/item-6 SSH side captured ~05:00–05:10Z by operator.
HEAD at capture: `4c9d0f1 docs(sync): clarify UZ cadence stays unchanged`.
Branch: `emergency/drain-scheduled-jobs`.
Reference: `docs/2026-05-06-recordRateLimit-redesign-design.md` (D2 design + post-throughput baseline section).

This memory exists to give the future D2a implementation session a single point of entry: known state at the moment go is given for code edits, distinct from sync canary memory which is a different track.

## Frozen baseline values

| # | Item | Value | Method |
|---|---|---|---|
| 1 | `_scheduled_jobs` recordRateLimit pending/inProgress | effectively `0/0` | `_scheduled_functions` via `npx convex data`: 0 entries with `name=="vkApiLimits.js:recordRateLimit"` in latest 8000 + 0 in oldest 8000 (CLI page cap 8192). Strong signal, not absolute proof — table size > 16000 is possible. The blocking condition is growth after deploy, not historical residue, so this is sufficient per design. |
| 2 | `vkApiLimits` row count | `268` rows | `npx convex data vkApiLimits --limit 8000` returned 268 (well under cap, full count). |
| 2a | `vkApiLimits` last `capturedAt` | `2026-05-05T02:34:54.203Z` | Latest row by `capturedAt`, matches drain-mode start window. No new rows since drain. |
| 2b | `vkApiLimits` oldest `capturedAt` | `2026-04-20T08:25:30.743Z` | 15 days old — past the 7-day retention boundary. See follow-up below. |
| 3 | 4 producers in `vkApi.ts` guarded by `if (false && hasData)` | confirmed | `grep -c "if (false && hasData)" convex/vkApi.ts` = `4`, lines `546`, `676`, `871`, `1085`. |
| 4 | `vk-throttling-probe` cron commented in `convex/crons.ts` | confirmed | block fully commented. |
| 5 | Backend stdout `429` count last 24h | `0` | Refined grep by operator: initial `grep -cE '429\|Too Many Requests'` returned `329`, but those were substring matches like `response_size: Some(...429...)` and timing such as `latency 494.429ms`. Operator-refined grep on actual HTTP `429`/Too Many Requests returned `0`. |
| 6 | `pg_wal` exact byte baseline | `1,577,058,304` bytes | `docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal`. Same value as the sync canary worker-bump baseline at `2026-05-07T03:09:26Z` — Postgres in stationary WAL-archiving regime, delta `0` over ~2h. |
| 7 | env/gates post-Phase-8 conservative profile | confirmed | re-verified `2026-05-07T04:55:36Z`. |

### env profile at capture

```text
SYNC_METRICS_V2_ENABLED=1
SYNC_WORKER_COUNT_V2=2
SYNC_BATCH_SIZE_V2=20
SYNC_METRICS_V2_POLL_MODERATION=0
SYNC_ESCALATION_ALERTS_ENABLED=0
UZ_BUDGET_V2_ENABLED=1
DISABLE_ERROR_ALERT_FANOUT=1
APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16
```

### prod health at capture

- `/version`: HTTP `200`, time `0.687s` against `http://178.172.235.49:3220/version`.
- HEAD `4c9d0f1` == `origin/emergency/drain-scheduled-jobs`.

## Why these specific values matter for D2a

- **`DISABLE_ERROR_ALERT_FANOUT=1`** is the critical safety guarantee: if any code path in D2a leaks an `error`-level `systemLogger.log`, the admin-alert fanout is gated. D2a design forbids new error paths until D1 is implemented; this env var is the runtime safety net behind that design constraint.
- **0 backend 429s in last 24h** means D2a has a clean signal floor. Any `vkApiLimits` row inserted after deploy is attributable to a real new throttling event, not historical residue or a flapping condition that pre-dates the change.
- **`vkApiLimits=268 rows` baseline** is small and bounded. Post-deploy delta is the primary effectiveness signal; row growth must equal observed `429` event count.
- **`pg_wal=1,577,058,304` exact bytes** is the byte-anchor for WAL pressure attribution. Sync canary closures used the same anchor; D2a closure should use the same byte-exact diff method.
- **0 pending recordRateLimit** in `_scheduled_functions` means the drain achieved its goal. D2a does not need to coexist with stale pending jobs; it starts on a clean queue.

## Parked follow-up (out of D2a scope)

### `cleanupOldVkApiLimits` cron — likely also in drain

The 7-day retention cleanup cron `cleanupOldVkApiLimits` (defined `convex/logCleanup.ts:70-85`) appears not to be running. Evidence: oldest `vkApiLimits` row is `2026-04-20T08:25:30.743Z`, 15 days before capture and well past the 7-day boundary. If cleanup were active, no rows older than `now - 7d` should exist.

Why this matters after D2a:

- D2a starts inserting `vkApiLimits` rows again on real `429` events.
- Without active cleanup, the table grows unbounded.
- Storage and write-amp impact accumulates over time, even at low 429 rate.

Why this is parked, not blocking:

- Today the table is small (`268` rows). D2a-induced growth in the canary window will be small (current 429 rate is `0` per the refined grep).
- The decision and timing for restoring `cleanupOldVkApiLimits` belongs to a separate follow-up that includes verifying which other `logCleanup.ts` crons are also drained (`cleanup-old-metrics-daily`, `cleanup-old-realtime-metrics`, `cleanup-old-ai-generations`, `cleanup-credential-history` are listed in `docs/2026-05-06-merge-cleanup-scope.md` as disabled in the emergency branch).

Action when D2a closes clean:

- Open a separate follow-up to verify the state of `logCleanup.ts` crons in `convex/crons.ts`.
- If `cleanupOldVkApiLimits` is commented out, schedule its restoration as part of the broader cleanup-cron restoration runbook (per `docs/2026-05-06-restore-matrix-uz-runbook.md` style: cron-by-cron, gated by triggers).
- Do not include the cleanup restoration in D2a code edits or D2a deploy.

## Resume path for the implementation session

After explicit go for code edits:

1. Implement the 8 D2a deliverables per `docs/2026-05-06-recordRateLimit-redesign-design.md` "Required D2a deliverables" section.
2. `npx tsc --noEmit -p convex/tsconfig.json` must be clean.
3. `npm run test`: D2a tests pass; no regressions in unrelated suites; the 2 pre-existing `vkApiLimits.test.ts > recordRateLimit` failures (noted in `memory/b1-closure-2026-05-06.md`) should now flip to passing because the `429`-only insert predicate matches their assertions.
4. Stop, present diff and test results, wait for explicit go on deploy.
5. Deploy via `npx convex deploy --yes` against `http://178.172.235.49:3220`, observe per design 3-hour acceptance window, attribute deltas against this frozen baseline.

## Do not do during D2a

- Do not change `SYNC_*`, `UZ_*`, `DISABLE_ERROR_ALERT_FANOUT`, or `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` env vars.
- Do not restore `vk-throttling-probe`.
- Do not modify `cleanupOldVkApiLimits` or any other `logCleanup.ts` cron.
- Do not introduce any `systemLogger.log({ level: "error" })` path; failures of `recordRateLimit` go to `console.warn` only.
- Do not bundle D1 implementation into D2a.
