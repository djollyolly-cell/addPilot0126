# Storage Cleanup V2 — Wave 7 Caveats Handoff — 2026-05-16

Type: operator handoff / doc-only caveats
Source closure: `memory/storage-cleanup-v2-tier1-maxruns24-canary-2026-05-16-b02bca844e80.md`
Mode: read before any Wave 7 preflight

## Result Carried Forward

Wave 6 remains classified as **STRICT CLEAN with operational notes**:

- `durationMs=2165722`, below yellow threshold `2300000`.
- all six re-halt rules GREEN.
- no manual env rescue; restorer restored env to `0`.
- no unexplained sustained probe signal; T+3 burst settled by T+5.

This handoff does not authorize Wave 7, profile changes, automation, PG raw
probes, or database maintenance.

## Caveats For Wave 7

### 1. T+3 post-terminal CPU burst

Wave 6 T+3 post-terminal probe showed:

- Convex CPU `138.72%`;
- PG CPU `64.39%`;
- loadavg 1m `1.39`;
- waiting locks `0`;
- idle-in-tx `0`;
- DFR/BIO/BufferPin `0`;
- WAL flat at `721M`.

Runbook escalation did not fire because the PG-side burst lacked waits and
DFR/BIO/BufferPin. T+5 settle cleared to Convex `0.00%`, PG `0.02%`, loadavg
`0.20`, waits `0`, WAL `721M`.

Wave 7 action: explicitly watch for a repeat post-terminal PG CPU burst. If it
recurs, capture at least T+3 and T+5 settle probes and classify whether it is a
repeatable organic burst or a cleanup-adjacent signal.

### 2. Restorer noisy-JSON SPOF

The first Wave 6 restorer exited mid-run with:

```text
Unexpected token 'W', "WebSocket "... is not valid JSON
```

The target run was still active at `batchesRun=11`, so the operator re-armed the
same exact-run restorer. The re-armed restorer later restored env to `0` and
printed `env_verify=0`.

Wave 7 action: pin Wave 7 SOT to
`7cfa08cd218d2523188048853e1bcd5d0d48168e` or a later commit that deliberately
includes `memory/storage-cleanup-restorer-hardening-2026-05-16.md`. If Wave 7
is pinned to old `2b62f99`, the runbook must keep the noisy-JSON SPOF caveat and
an explicit operator re-arm/rescue plan live during terminal.

### 3. Repeated trigger `fetch failed`

Wave 6 first trigger attempt failed with:

```text
TypeError: fetch failed
```

No new `cleanupRunState` row was created; env was restored to `0`; a fresh
preflight then allowed a successful manual retry. This mirrors the earlier W4
first-attempt pattern, so it is no longer a pure one-off.

Wave 7 action: treat trigger `fetch failed` as an expected occasional pattern,
but only retry after all of these are true:

- env has been restored to `0`;
- fresh `cleanupRunState` read confirms no new target row was created;
- `/version` is clean;
- cron-avoid window still has runway;
- operator explicitly accepts the retry.

Do not auto-retry blindly.

### 4. ToD hypothesis downgrade

After Wave 6, the `maxRuns=24` observed duration band is:

- min: Wave 6 `2165722 ms` (`36m 05.722s`);
- max: Wave 1 `2240974 ms` (`37m 20.974s`);
- spread: about `3.47%`.

W5 morning was fast and W6 evening was fast, while W1/W2 morning were slower.
One time-of-day bucket now contains both outcomes. Treat ToD as weak/noisy
rather than a scheduling constraint for Wave 7.

### 5. Series State

- `maxRuns=24` series after Wave 6: `6/6` strict clean.
- cumulative deleted in this series: `144000`.
- W6 floor advance: `345101 ms` (`5m 45.101s`), sparse-density consistent.
- Re-evaluation gate remains: no profile bump until at least `10` consecutive
  strict-clean waves plus fresh PG snapshot and explicit operator decision.

## Not Authorized

Wave 6 and this handoff do not authorize:

- Wave 7 by inertia;
- `maxRuns > 24`;
- `batchSize > 1000`;
- `restMs < 90000`;
- timeBudget changes;
- Tier 2 automation;
- parallel waves;
- PG raw probes;
- `VACUUM FULL`, `pg_repack`, GUC changes, or container restarts.
