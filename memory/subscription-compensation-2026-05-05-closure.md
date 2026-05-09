# Subscription Compensation Closure - 2026-05-05 Incident

Status: **applied 2026-05-09, idempotency verified**.

Incident key: `subscription_compensation_2026_05_05_convex_incident`.

## Outcome

- 18 paid subscriptions extended by **+10 days**.
- 0 organizations affected (none had paid subscriptions active on the
  incident day).
- 0 reactivations (all 18 were paid-active at apply time, no freemium-grace
  recoveries).
- 0 state-backed evidence used; all 18 candidates were `payment_backed`.
- `includeStateBacked` flag was `false` (default) — preview(true) confirmed
  zero delta vs preview(false), so the safer default was sufficient.

## Distribution

- By target type: `user: 18`, `organization: 0`.
- By tier at snapshot: `pro: 14`, `start: 4`.
- By evidence: `payment_backed: 18`, `state_backed_no_pre_snapshot_payment: 0`.

## Implementation

Branch: `compensation/2026-05-05` based on `origin/emergency/drain-scheduled-jobs`.

Commits:

- `cd76575` — feat(billing): add 2026-05-05 subscription compensation
  (preview/apply functions, marker table `subscriptionCompensations`).
- `de468fb` — docs(runbook): fix deploy URL and gen-admin-key path.

Deploy:

- Endpoint: `https://convex.aipilot.by`
- Date: 2026-05-09
- Schema change: added table `subscriptionCompensations` with 4 indexes
  (`by_incident`, `by_incident_target`, `by_userId`, `by_orgId`).
- No indexes deleted, no destructive schema migration.

Apply call:

```text
internal.billing.applyIncidentSubscriptionCompensation
{
  "confirm": "APPLY_2026_05_05_COMPENSATION",
  "expectedToApplyCount": 18,
  "maxApplyCount": 200,
  "includeStateBacked": false,
  "appliedBy": "operator:anzelika"
}
```

Result: `appliedCount: 18`, exit 0.

## Verification

Post-apply read-only checks (operator-confirmed):

- `previewIncidentSubscriptionCompensation({includeStateBacked:false})`:
  `toApplyCount=0`, `alreadyAppliedCount=18`, `truncated=false`.
- `previewIncidentSubscriptionCompensation({includeStateBacked:true})`:
  `toApplyCount=0`, `stateBackedOnly=[]`, `alreadyAppliedCount=18`.
- `subscriptionCompensations`: 18 marker rows under the incident key,
  matching the apply distribution.
- `auditLog`: 18 entries with `action="subscription_incident_compensation"`,
  all `status=success`.
- `/version`: HTTP 200.
- Cleanup recovery jobs unaffected: `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`,
  active cleanup rows = 0.

Idempotency: re-running apply produces `toApply=[]` because every
`(incidentKey, targetType, targetId)` already exists in
`subscriptionCompensations`. The marker check is fail-closed.

## Interpretation Note

In post-apply preview, `alreadyApplied[i].expiresAtBefore` reflects the
**current** value of `users.subscriptionExpiresAt` (already including the
+10 days), not the pre-apply value. This is expected: the plan builder
always reads live state. The fact that this value matches the prior
`expiresAtAfter` from the apply response is what confirms the write
landed. Pre-apply values are recoverable from `subscriptionCompensations`
(`expiresAtBefore`/`expiresAtAfter` columns) and from `auditLog.details`.

## Pending

- User communication: a short message about the +10 days has not yet been
  sent. To be done as a separate step.
- Branch merge: `compensation/2026-05-05` is two commits ahead of
  `emergency/drain-scheduled-jobs`. To be merged into the long-lived
  branch separately.
