// Heartbeat guard for cron dispatchers.
//
// SCOPE: protects ONLY against a stuck/overlapping dispatcher heartbeat,
// i.e. cases where a dispatcher already wrote `status: "running"` and crashed
// or hung before reaching the `completed`/`failed` write. It does NOT prevent
// long-running workers spawned by previous ticks from overlapping with workers
// of the next tick — that requires a separate per-worker mechanism (semaphore,
// per-entity lock, or a sufficiently large cron interval).
//
// This is intentionally a pure decision function. The caller is responsible
// for: reading the previous heartbeat, calling this helper, then doing
// whatever logging / DB writes / early-returns are appropriate.

export type HeartbeatGuardDecision =
  | "acquire" // No prior heartbeat or prior is non-running — proceed normally.
  | "skip_fresh" // Prior dispatcher is still running and within safety window.
  | "takeover_stale"; // Prior dispatcher is running but past safety window — proceed and overwrite.

export interface HeartbeatLike {
  status: string;
  startedAt: number;
}

/**
 * Decide whether a new dispatcher invocation may proceed.
 *
 * @param prev   Previous heartbeat record (null/undefined if none).
 * @param now    Current timestamp in ms (Date.now()).
 * @param safetyTimeoutMs  How long after `startedAt` a "running" heartbeat is still considered live.
 */
export function tryAcquireHeartbeat(
  prev: HeartbeatLike | null | undefined,
  now: number,
  safetyTimeoutMs: number
): HeartbeatGuardDecision {
  if (!prev) return "acquire";
  if (prev.status !== "running") return "acquire";
  if (prev.startedAt > now - safetyTimeoutMs) return "skip_fresh";
  return "takeover_stale";
}
