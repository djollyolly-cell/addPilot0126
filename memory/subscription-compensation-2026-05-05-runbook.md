# Subscription Compensation Runbook - 2026-05-05 Incident

Status: **prepared, not applied**.

Goal: add **10 paid days** to every paid subscription that was active on
2026-05-05 Europe/Minsk. The outage was our fault; users must not lose paid
time because of it.

## Scope

Incident key:

```text
subscription_compensation_2026_05_05_convex_incident
```

Snapshot window:

```text
2026-05-05 00:00:00.000 Europe/Minsk
-> 2026-05-05 23:59:59.999 Europe/Minsk

UTC:
2026-05-04T21:00:00.000Z
-> 2026-05-05T20:59:59.999Z
```

Extension:

```text
+10 days
```

Targets:

- Individual paid subscriptions: `users.subscriptionTier in {start, pro}`.
- Agency paid subscriptions: `organizations.subscriptionTier in {agency_s, agency_m, agency_l, agency_xl}`.
- Users inside an organization are covered by the organization subscription,
  not by a duplicate per-member compensation, unless they also have their own
  individual paid subscription evidence.

## Safety Contract

Implementation:

- `convex/billing.ts`
  - `internal.billing.previewIncidentSubscriptionCompensation`
  - `internal.billing.applyIncidentSubscriptionCompensation`
- `convex/schema.ts`
  - permanent table `subscriptionCompensations`

The permanent marker table is intentionally separate from `payments`.
Compensation is not a financial payment and must not distort payment history,
revenue totals, or last-payment UI.

Apply is guarded by:

- explicit confirm literal:
  `APPLY_2026_05_05_COMPENSATION`
- `expectedToApplyCount` from the most recent preview;
- `maxApplyCount` (default 200) to avoid one oversized Convex mutation;
- permanent marker:
  `(incidentKey, targetType, targetId)`.

Re-running apply after success should produce `toApplyCount=0` and
`alreadyAppliedCount=<previous count>`.

## Eligibility

A target is eligible when all of the following hold:

1. `subscriptionExpiresAt` exists and overlaps the incident day:
   `subscriptionExpiresAt >= 2026-05-04T21:00:00.000Z`.
2. There is evidence the target was paid before or during the incident day:
   - `payment_backed`: completed paid payment with `completedAt/createdAt <= snapshotEnd`, or
   - `state_backed_no_pre_snapshot_payment`: current state indicates paid subscription,
     target existed by snapshot end, and there are no post-snapshot paid payments that
     could explain the current paid state.
3. The target has not already been marked in `subscriptionCompensations`.

For individual users whose tier is currently `freemium`, apply may reactivate
the previous paid tier only if `oldExpiresAt + 10 days > now`. Reactivation uses
the same billing-safe helper as payment upgrade flow and only restores
billing-disabled accounts/rules.

For organizations whose `oldExpiresAt + 10 days > now`, apply extends the org
subscription and clears only expiry-grace flags:

- `expiredGracePhase`
- `expiredGraceStartedAt`

It intentionally preserves overage/credit fields:

- `pendingCredit`
- `pendingCreditCurrency`
- `overageNotifiedAt`
- `overageGraceStartedAt`
- `featuresDisabledAt`

Reason: compensation restores paid time after an incident; it is not an overage
resolution and must not erase client credit.

## Commands

Use the self-hosted Convex environment. Do not run apply until preview has been
reviewed.

### 1. Deploy Code

The functions and schema must be deployed before preview/apply exist in prod.
Deploy only from an isolated worktree based on
`origin/emergency/drain-scheduled-jobs`. Do **not** deploy from the dirty main
workspace.

Include only:

- `convex/billing.ts` compensation block;
- `convex/schema.ts` `subscriptionCompensations` table;
- this runbook.

Do **not** include unrelated dirty worktree changes such as
`bannerActiveSnapshots`.

```bash
CONVEX_SELF_HOSTED_URL=https://convex.aipilot.by \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node "/Users/anzelikamedvedeva/основное/ИИ и все что с ним связано/addpilot from claude/gen-admin-key.cjs")" \
npx convex deploy --yes
```

### 2. Preview Payment-Backed Targets

Default preview excludes state-backed targets. This is the first review pass
and should contain only targets backed by completed paid payments.

```bash
CONVEX_SELF_HOSTED_URL=https://convex.aipilot.by \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node "/Users/anzelikamedvedeva/основное/ИИ и все что с ним связано/addpilot from claude/gen-admin-key.cjs")" \
npx convex run internal.billing.previewIncidentSubscriptionCompensation \
  '{"limit":500,"includeStateBacked":false}'
```

### 3. Preview State-Backed Delta

Run this only to inspect the additional targets that would be included by
current-state evidence. Review `stateBackedOnly` carefully.

```bash
CONVEX_SELF_HOSTED_URL=https://convex.aipilot.by \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node "/Users/anzelikamedvedeva/основное/ИИ и все что с ним связано/addpilot from claude/gen-admin-key.cjs")" \
npx convex run internal.billing.previewIncidentSubscriptionCompensation \
  '{"limit":500,"includeStateBacked":true}'
```

Review:

- `summary.toApplyCount`
- `summary.alreadyAppliedCount`
- `summary.byTargetType`
- `summary.byTier`
- `summary.byEvidence`
- `stateBackedOnly` (must be manually reviewed before applying with
  `includeStateBacked=true`)
- every returned candidate's:
  - `label`
  - `email`
  - `tierAtSnapshot`
  - `tierBefore`
  - `tierAfter`
  - `expiresAtBefore`
  - `expiresAtAfter`
  - `willReactivate`
  - `evidence`

If the list is too long and `truncated=true`, rerun with a larger `limit`.

### 4. Apply

Only after preview is accepted by the operator:

```bash
CONVEX_SELF_HOSTED_URL=https://convex.aipilot.by \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node "/Users/anzelikamedvedeva/основное/ИИ и все что с ним связано/addpilot from claude/gen-admin-key.cjs")" \
npx convex run internal.billing.applyIncidentSubscriptionCompensation \
  '{"confirm":"APPLY_2026_05_05_COMPENSATION","expectedToApplyCount":<FROM_PREVIEW>,"maxApplyCount":200,"includeStateBacked":false,"appliedBy":"operator:anzelika"}'
```

Do not guess `<FROM_PREVIEW>`. It must match the latest preview's
`summary.toApplyCount`.

Use `includeStateBacked:true` in apply only if the state-backed delta preview
was explicitly accepted.

### 5. Post-Apply Verification

Immediately run preview again:

```bash
CONVEX_SELF_HOSTED_URL=https://convex.aipilot.by \
CONVEX_SELF_HOSTED_ADMIN_KEY="$(node "/Users/anzelikamedvedeva/основное/ИИ и все что с ним связано/addpilot from claude/gen-admin-key.cjs")" \
npx convex run internal.billing.previewIncidentSubscriptionCompensation \
  '{"limit":500,"includeStateBacked":false}'
```

Expected:

```text
summary.toApplyCount = 0
summary.alreadyAppliedCount = <appliedCount from apply>
```

Also spot-check:

- several affected `users.subscriptionExpiresAt`;
- several affected `organizations.subscriptionExpiresAt` if org targets exist;
- `subscriptionCompensations` contains one marker per target;
- `auditLog` has `action="subscription_incident_compensation"` entries.

If `includeStateBacked:true` was used in apply, verify with the same flag.

## Dirty Conditions

Stop and do not apply if:

- preview includes targets clearly created/paid only after 2026-05-05;
- `toApplyCount` unexpectedly changes between preview and apply;
- `toApplyCount > maxApplyCount`;
- `willReactivate` list includes users/orgs that should stay expired;
- deploy includes unrelated dirty working-tree changes;
- any runtime health check is red for a new, unattributed reason.

## Notes

- `auditLog` is not used as the idempotency marker because it is TTL-cleaned.
- `payments` is not used as the marker because compensation is not payment
  revenue.
- The plan builder reads payments through `by_userId` / `by_orgId` indexes; it
  does not scan the whole `payments` table.
- This runbook does not authorize deploy or apply by itself. Both require
  explicit operator go.
