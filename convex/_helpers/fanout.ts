// Fan-out helper for slot-aware staggered scheduling.
//
// IMPORTANT: same constants and formula as the inline copy in convex/auth.ts.
// During the emergency drain we keep auth.ts untouched; once UZ V2 stabilises,
// auth.ts should be migrated to import from this module and the inline copy removed.

const DEFAULT_MAX_CONCURRENT_V8_ACTIONS = 32;
export const FANOUT_STAGGER_MS = 7_000;

export function getMaxConcurrentV8Actions(): number {
  const configured = Number(process.env.APPLICATION_MAX_CONCURRENT_V8_ACTIONS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_MAX_CONCURRENT_V8_ACTIONS;
}

// slotsPerWorker = peak V8 slots a worker holds simultaneously
// (1 = leaf action, 3 = action -> nested action -> refresh action).
// Reserves 50% of concurrency for non-fanout work.
//
// LIMITATION: this defends only the startup burst. Long-lived workers
// (e.g. UZ batch workers processing many accounts sequentially) keep holding
// 1 slot each for their entire lifetime, so saturation can also occur
// later when several long-lived workers happen to enter nested auth/VK
// actions at the same time. Use a conservative WORKER_COUNT for those.
export function getFanoutDelayMs(index: number, slotsPerWorker: number = 1): number {
  const concurrency = getMaxConcurrentV8Actions();
  const immediateSlots = Math.max(1, Math.floor(concurrency / (slotsPerWorker * 2)));
  if (index < immediateSlots) return 0;
  return (Math.floor((index - immediateSlots) / immediateSlots) + 1) * FANOUT_STAGGER_MS;
}
