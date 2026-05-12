import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";

// EMERGENCY: when set, suppress auto-scheduling adminAlerts.notify on every error log.
// Reason: while adminAlerts.notify is drain-mode no-op, each schedule still occupies a V8 slot
// during dispatch. A "Too many concurrent" error → systemLogger.log(error) → scheduled notify
// → competes for slots with token-refresh workers → more errors. Self-feeding amplification.
// Read at call time so D1b can flip the env without re-deploy.
// Retained as kill-switch per D1 design Open Questions even after D1c.
function disableErrorAlertFanout(): boolean {
  const v = process.env.DISABLE_ERROR_ALERT_FANOUT;
  return v === "1" || v === "true";
}

// Must match adminAlerts.DEDUP_WINDOW_MS — same value, kept local to avoid cross-module coupling.
const DEDUP_WINDOW_MS = 30 * 60 * 1000;

/**
 * Map (source, message) to a stable normalized class for dedup grouping.
 * Per D1 design: 4 explicit patterns + Russian token-expired variant + fallback.
 * Exported for unit testing.
 */
export function classifyMessage(source: string, message: string): string {
  if (message.includes("Too many concurrent")) return "too_many_concurrent";
  if (message.includes("Transient error")) return "transient_error";
  if (
    message.includes("TOKEN_EXPIRED") ||
    (message.includes("Токен") &&
      (message.includes("истёк") || message.includes("отсутствует")))
  ) {
    return "token_expired";
  }
  if (
    source === "tokenRecovery" &&
    (message.includes("failed") || message.includes("error"))
  ) {
    return "token_recovery_failed";
  }
  const sliced = message.slice(0, 120);
  const fb = sliced
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (fb !== "") return `_fb:${fb}`;
  // Non-latin-only message (e.g. cyrillic-only) — empty after normalization.
  // Use a stable djb2-style hash so distinct messages still get distinct dedup keys.
  let hash = 0;
  for (let i = 0; i < sliced.length; i++) {
    hash = ((hash << 5) - hash + sliced.charCodeAt(i)) | 0;
  }
  return `_fb:nl_${Math.abs(hash).toString(36)}`;
}

// Inline dedup-before-schedule. Same logic as adminAlerts.checkDedup but reads/writes
// adminAlertDedup directly from this mutation (internalMutation has ctx.db) instead of
// calling checkDedup via ctx.runMutation (which would require an action context).
async function checkAdminAlertDedupInline(
  ctx: MutationCtx,
  key: string,
): Promise<boolean> {
  const existing = await ctx.db
    .query("adminAlertDedup")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  const now = Date.now();
  if (existing && now - existing.lastSentAt < DEDUP_WINDOW_MS) {
    return false;
  }
  if (existing) {
    await ctx.db.patch(existing._id, { lastSentAt: now });
  } else {
    await ctx.db.insert("adminAlertDedup", { key, lastSentAt: now });
  }
  return true;
}

// ─── Запись системного лога ───

export const log = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    accountId: v.optional(v.id("adAccounts")),
    level: v.union(v.literal("error"), v.literal("warn"), v.literal("info")),
    source: v.string(),
    message: v.string(),
    details: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Обрезаем details если слишком большой (защита от bloat)
    let details = args.details;
    if (details) {
      const str = JSON.stringify(details);
      if (str.length > 50000) {
        details = { truncated: true, preview: str.slice(0, 500) };
      }
    }

    await ctx.db.insert("systemLogs", {
      userId: args.userId,
      accountId: args.accountId,
      level: args.level,
      source: args.source,
      message: args.message,
      details,
      createdAt: Date.now(),
    });

    // Авто-алерт админам при критических ошибках.
    // Dedup-before-schedule: coarsened guardKey by (source, messageClass) drops
    // accountId+raw-message from the key so that N accounts hitting the same systemic
    // error produce one schedule per 30-min window, not N. Per-account context still
    // appears in the alert text below.
    if (args.level === "error" && !disableErrorAlertFanout()) {
      const messageClass = classifyMessage(args.source, args.message);
      const guardKey = `error:${args.source}:${messageClass}`;
      const fresh = await checkAdminAlertDedupInline(ctx, guardKey);
      if (fresh) {
        // Do NOT pass dedupKey: D1a's checkAdminAlertDedupInline above already wrote
        // guardKey into adminAlertDedup. If we passed dedupKey here, the D1c-restored
        // notify handler would call adminAlerts.checkDedup(guardKey), see the just-
        // written entry as fresh, and silently drop the Telegram delivery. Inline
        // dedup IS the gate for systemLogger-generated schedules. The 7 explicit
        // notify callers still pass their own dedupKey — that path is untouched.
        try { await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
          category: "criticalErrors",
          text: [
            `🚨 <b>Ошибка</b>`,
            ``,
            `<b>Источник:</b> <code>${args.source}</code>`,
            `<b>Класс:</b> <code>${messageClass}</code>`,
            `<b>Аккаунт:</b> ${args.accountId ?? "—"}`,
            `<b>Сообщение:</b> ${args.message}`,
            details ? `<pre>${JSON.stringify(details, null, 2).slice(0, 300)}</pre>` : '',
          ].filter(Boolean).join('\n'),
        }); } catch { /* non-critical */ }
      }
    }
  },
});

// ─── Запросы для админки ───

export const getRecentByLevel = internalQuery({
  args: {
    level: v.union(v.literal("error"), v.literal("warn"), v.literal("info")),
    since: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("systemLogs")
      .withIndex("by_level_createdAt", (q) =>
        q.eq("level", args.level).gte("createdAt", args.since)
      )
      .order("desc")
      .take(args.limit);
  },
});

export const getRecent = internalQuery({
  args: { since: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("systemLogs")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", args.since))
      .order("desc")
      .take(args.limit);
  },
});

// ─── TTL-чистка (10 дней), batch 2000 ───

export const cleanupOld = internalMutation({
  handler: async (ctx) => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const old = await ctx.db
      .query("systemLogs")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", tenDaysAgo))
      .take(2000);
    for (const doc of old) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: old.length };
  },
});
