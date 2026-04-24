import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { messagesGetConversations, messagesGetHistory, usersGet } from "./vkCommunityApi";
import { extractPhones } from "./phoneExtractor";
import { normalizePhone } from "./phoneExtractor";
import { fetchLeadDetails } from "./vkApi";
import { getSubscribersByDateRange } from "./senlerApi";

// ─── Types ─────────────────────────────────────────────────

export type Granularity = "day" | "day_campaign" | "day_group" | "day_banner";

export interface ReportRow {
  date: string;
  weekday?: string;
  campaignId?: string;
  campaignName?: string;
  groupId?: string;
  groupName?: string;
  adId?: string;
  adName?: string;
  communityId?: number;
  communityName?: string;
  impressions?: number;
  clicks?: number;
  spent?: number;
  spent_with_vat?: number;
  cpc?: number;
  ctr?: number;
  cpm?: number;
  leads?: number;
  cpl?: number;
  message_starts?: number;
  phones_count?: number;
  senler_subs?: number;
}

export interface PhoneEntry {
  date: string;
  leftAt: number;
  phone: string;
  firstName: string;
  lastName: string;
  dialogUrl?: string;
  source: "vk_dialog" | "lead_ad";
  campaignId?: string;
  groupId?: string;
  adId?: string;
}

export interface ReportResult {
  dateFrom: string;
  dateTo: string;
  rows: ReportRow[];
  totals: Partial<ReportRow>;
  phonesDetail: PhoneEntry[];
  partialErrors: string[];
}

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

function weekday(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return WEEKDAYS[d.getUTCDay()];
}

// ─── Internal queries ───────────────────────────────────────

export const _readAdMetrics = internalQuery({
  args: {
    accountIds: v.array(v.id("adAccounts")),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args) => {
    const results = [];
    for (const accountId of args.accountIds) {
      const rows = await ctx.db
        .query("metricsDaily")
        .withIndex("by_accountId_date", (q) =>
          q.eq("accountId", accountId)
            .gte("date", args.dateFrom)
            .lte("date", args.dateTo)
        )
        .collect();
      results.push({ accountId, rows });
    }
    return results;
  },
});

export const _readCommunityProfiles = internalQuery({
  args: { userId: v.id("users"), vkGroupIds: v.array(v.number()) },
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("communityProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    return profiles.filter((p) => args.vkGroupIds.includes(p.vkGroupId));
  },
});

export const _readAccounts = internalQuery({
  args: { accountIds: v.array(v.id("adAccounts")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.accountIds) {
      const acc = await ctx.db.get(id);
      if (acc) out.push(acc);
    }
    return out;
  },
});

// ─── Public action: buildReport ────────────────────────────

export const buildReport = action({
  args: {
    userId: v.id("users"),
    accountIds: v.array(v.id("adAccounts")),
    campaignIds: v.optional(v.array(v.string())),
    groupIds: v.optional(v.array(v.number())),
    communityIds: v.optional(v.array(v.number())),
    campaignStatus: v.optional(v.string()),
    granularity: v.union(
      v.literal("day"),
      v.literal("day_campaign"),
      v.literal("day_group"),
      v.literal("day_banner")
    ),
    fields: v.array(v.string()),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args): Promise<ReportResult> => {
    const partialErrors: string[] = [];

    // 1. Ad metrics
    const metricsData = await ctx.runQuery(
      internal.clientReport._readAdMetrics,
      {
        accountIds: args.accountIds,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
      }
    );

    const rowMap = new Map<string, ReportRow>();
    for (const { rows } of metricsData) {
      for (const m of rows) {
        if (args.campaignIds?.length && m.campaignId && !args.campaignIds.includes(m.campaignId)) continue;

        const key = buildKey(args.granularity, m);
        const existing = rowMap.get(key) ?? initRow(args.granularity, m);
        existing.impressions = (existing.impressions ?? 0) + m.impressions;
        existing.clicks = (existing.clicks ?? 0) + m.clicks;
        existing.spent = (existing.spent ?? 0) + m.spent;
        existing.leads = (existing.leads ?? 0) + m.leads;
        rowMap.set(key, existing);
      }
    }

    // 2. Community dialogs (message_starts, phones_count, phones_detail)
    const needsDialogs = args.fields.some((f) =>
      ["message_starts", "phones_count", "phones_detail"].includes(f)
    );
    const phonesDetail: PhoneEntry[] = [];

    if (needsDialogs && args.communityIds && args.communityIds.length > 0) {
      const profiles = await ctx.runQuery(
        internal.clientReport._readCommunityProfiles,
        { userId: args.userId, vkGroupIds: args.communityIds }
      );
      const fromTs = Date.parse(args.dateFrom + "T00:00:00Z") / 1000;
      const toTs = Date.parse(args.dateTo + "T23:59:59Z") / 1000;

      for (const profile of profiles) {
        try {
          const newDialogs: Array<{ peerId: number; firstMessageDate: number }> = [];
          let offset = 0;
          for (let page = 0; page < 50; page++) {
            const res = await messagesGetConversations(
              profile.vkCommunityToken, offset, 200
            );
            if (!res.items || res.items.length === 0) break;
            let allOlder = true;
            for (const item of res.items) {
              const lastDate = item.last_message?.date ?? item.conversation.last_message?.date;
              if (lastDate === undefined) continue;
              if (lastDate >= fromTs) allOlder = false;
              if (lastDate >= fromTs && lastDate <= toTs) {
                newDialogs.push({
                  peerId: item.conversation.peer.id,
                  firstMessageDate: lastDate,
                });
              }
            }
            if (allOlder) break;
            offset += 200;
            await new Promise((r) => setTimeout(r, 400));
          }

          // Batch fetch user info
          const peerIds = Array.from(new Set(newDialogs.map((d) => d.peerId)));
          const peerInfo = new Map<number, { firstName: string; lastName: string }>();
          for (let i = 0; i < peerIds.length; i += 100) {
            const batch = peerIds.slice(i, i + 100).filter((id) => id > 0);
            if (batch.length === 0) continue;
            const users = await usersGet(profile.vkCommunityToken, batch);
            for (const u of users) {
              peerInfo.set(u.id, { firstName: u.first_name, lastName: u.last_name });
            }
            await new Promise((r) => setTimeout(r, 400));
          }

          // Count dialog starts by date
          const dialogStartsByDate = new Map<string, number>();
          for (const d of newDialogs) {
            const dateStr = new Date(d.firstMessageDate * 1000).toISOString().slice(0, 10);
            dialogStartsByDate.set(dateStr, (dialogStartsByDate.get(dateStr) ?? 0) + 1);
          }

          // Read message history and extract phones
          for (const d of newDialogs) {
            try {
              const hist = await messagesGetHistory(
                profile.vkCommunityToken, d.peerId, 50, 1
              );
              const groupIdAbs = Math.abs(profile.vkGroupId);
              const inbound = hist.items.filter(
                (m) => m.from_id !== -groupIdAbs && m.from_id > 0
              );
              for (const msg of inbound) {
                const phones = extractPhones(msg.text);
                for (const p of phones) {
                  const info = peerInfo.get(d.peerId) ?? { firstName: "", lastName: "" };
                  const leftAtMs = msg.date * 1000;
                  phonesDetail.push({
                    date: new Date(leftAtMs).toISOString().slice(0, 10),
                    leftAt: leftAtMs,
                    phone: p.phone,
                    firstName: info.firstName,
                    lastName: info.lastName,
                    dialogUrl: `https://vk.me/gim${Math.abs(profile.vkGroupId)}?sel=${d.peerId}`,
                    source: "vk_dialog",
                  });
                }
              }
              await new Promise((r) => setTimeout(r, 400));
            } catch (err) {
              partialErrors.push(
                `Сообщество ${profile.vkGroupName}, peer ${d.peerId}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }

          // Add message_starts to rows
          if (args.fields.includes("message_starts")) {
            for (const [date, count] of dialogStartsByDate) {
              const key = buildKeyFromDate(args.granularity, date);
              const existing = rowMap.get(key);
              if (existing) {
                existing.message_starts = (existing.message_starts ?? 0) + count;
              } else {
                const newRow: ReportRow = { date, message_starts: count };
                if (args.fields.includes("weekday")) newRow.weekday = weekday(date);
                rowMap.set(key, newRow);
              }
            }
          }
        } catch (err) {
          partialErrors.push(
            `Сообщество ${profile.vkGroupName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // 3. Lead Ads contacts (phones_detail / phones_count)
    if (needsDialogs) {
      const accounts = await ctx.runQuery(internal.clientReport._readAccounts, {
        accountIds: args.accountIds,
      });
      for (const acc of accounts) {
        if (!acc.accessToken) continue;
        try {
          const leads = await fetchLeadDetails(
            acc.accessToken,
            args.dateFrom,
            args.dateTo,
          );
          for (const lead of leads) {
            if (lead.phone) {
              phonesDetail.push({
                date: new Date(lead.createdAt).toISOString().slice(0, 10),
                leftAt: lead.createdAt,
                phone: normalizePhone(lead.phone),
                firstName: lead.firstName ?? "",
                lastName: lead.lastName ?? "",
                source: "lead_ad",
                adId: String(lead.bannerId),
              });
            }
          }
        } catch (err) {
          partialErrors.push(
            `Кабинет ${acc.name} (Lead Ads): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // 4. Senler subs
    if (args.fields.includes("senler_subs") && args.communityIds && args.communityIds.length > 0) {
      const profiles = await ctx.runQuery(
        internal.clientReport._readCommunityProfiles,
        { userId: args.userId, vkGroupIds: args.communityIds }
      );
      const fromTs = Date.parse(args.dateFrom + "T00:00:00Z") / 1000;
      const toTs = Date.parse(args.dateTo + "T23:59:59Z") / 1000;
      for (const profile of profiles) {
        if (!profile.senlerApiKey) continue;
        try {
          const subs = await getSubscribersByDateRange(
            profile.senlerApiKey, fromTs, toTs
          );
          for (const sub of subs) {
            const date = new Date(sub.date_subscribe * 1000).toISOString().slice(0, 10);
            const key = buildKeyFromDate(args.granularity, date);
            const existing = rowMap.get(key);
            if (existing) {
              existing.senler_subs = (existing.senler_subs ?? 0) + 1;
            } else {
              const newRow: ReportRow = { date, senler_subs: 1 };
              if (args.fields.includes("weekday")) newRow.weekday = weekday(date);
              rowMap.set(key, newRow);
            }
          }
        } catch (err) {
          partialErrors.push(
            `Senler ${profile.vkGroupName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // 5. phones_count per-row (from phonesDetail)
    if (args.fields.includes("phones_count")) {
      const countsByDate = new Map<string, number>();
      for (const p of phonesDetail) {
        countsByDate.set(p.date, (countsByDate.get(p.date) ?? 0) + 1);
      }
      for (const [date, count] of countsByDate) {
        const key = buildKeyFromDate(args.granularity, date);
        const existing = rowMap.get(key);
        if (existing) {
          existing.phones_count = (existing.phones_count ?? 0) + count;
        } else {
          const newRow: ReportRow = { date, phones_count: count };
          if (args.fields.includes("weekday")) newRow.weekday = weekday(date);
          rowMap.set(key, newRow);
        }
      }
    }

    // Derived metrics per row + final rows array
    const rows: ReportRow[] = [];
    for (const r of rowMap.values()) {
      if (args.fields.includes("spent_with_vat") && r.spent !== undefined) {
        r.spent_with_vat = Math.round(r.spent * 1.2 * 100) / 100;
      }
      if (args.fields.includes("cpc") && r.clicks && r.spent) {
        r.cpc = Math.round((r.spent / r.clicks) * 100) / 100;
      }
      if (args.fields.includes("ctr") && r.impressions && r.clicks !== undefined) {
        r.ctr = Math.round((r.clicks / r.impressions) * 10000) / 100;
      }
      if (args.fields.includes("cpm") && r.impressions && r.spent) {
        r.cpm = Math.round((r.spent / r.impressions) * 1000 * 100) / 100;
      }
      if (args.fields.includes("cpl") && r.leads && r.spent) {
        r.cpl = Math.round((r.spent / r.leads) * 100) / 100;
      }
      if (args.fields.includes("weekday") && !r.weekday) {
        r.weekday = weekday(r.date);
      }
      rows.push(r);
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));

    const totals = computeTotals(rows, args.fields);

    return {
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      rows,
      totals,
      phonesDetail,
      partialErrors,
    };
  },
});

// ─── Helpers ───────────────────────────────────────────────

function buildKey(
  granularity: Granularity,
  m: { date: string; campaignId?: string; adId: string }
): string {
  switch (granularity) {
    case "day": return m.date;
    case "day_campaign": return `${m.date}|c${m.campaignId ?? ""}`;
    case "day_group": return `${m.date}|c${m.campaignId ?? ""}|g`;
    case "day_banner": return `${m.date}|a${m.adId}`;
  }
}

function buildKeyFromDate(granularity: Granularity, date: string): string {
  if (granularity === "day") return date;
  return `comm:${date}`;
}

function initRow(
  granularity: Granularity,
  m: { date: string; campaignId?: string; adId: string }
): ReportRow {
  const row: ReportRow = { date: m.date };
  if (granularity === "day_campaign" || granularity === "day_group" || granularity === "day_banner") {
    row.campaignId = m.campaignId;
  }
  if (granularity === "day_banner") {
    row.adId = m.adId;
  }
  return row;
}

function computeTotals(rows: ReportRow[], fields: string[]): Partial<ReportRow> {
  const totals: Partial<ReportRow> = {};
  let impressions = 0, clicks = 0, spent = 0, leads = 0;
  let messageStarts = 0, phonesCount = 0, senlerSubs = 0;
  for (const r of rows) {
    impressions += r.impressions ?? 0;
    clicks += r.clicks ?? 0;
    spent += r.spent ?? 0;
    leads += r.leads ?? 0;
    messageStarts += r.message_starts ?? 0;
    phonesCount += r.phones_count ?? 0;
    senlerSubs += r.senler_subs ?? 0;
  }
  if (fields.includes("impressions")) totals.impressions = impressions;
  if (fields.includes("clicks")) totals.clicks = clicks;
  if (fields.includes("spent")) totals.spent = Math.round(spent * 100) / 100;
  if (fields.includes("spent_with_vat")) totals.spent_with_vat = Math.round(spent * 1.2 * 100) / 100;
  if (fields.includes("leads")) totals.leads = leads;
  if (fields.includes("cpc") && clicks) totals.cpc = Math.round((spent / clicks) * 100) / 100;
  if (fields.includes("ctr") && impressions) totals.ctr = Math.round((clicks / impressions) * 10000) / 100;
  if (fields.includes("cpm") && impressions) totals.cpm = Math.round((spent / impressions) * 1000 * 100) / 100;
  if (fields.includes("cpl") && leads) totals.cpl = Math.round((spent / leads) * 100) / 100;
  if (fields.includes("message_starts")) totals.message_starts = messageStarts;
  if (fields.includes("phones_count")) totals.phones_count = phonesCount;
  if (fields.includes("senler_subs")) totals.senler_subs = senlerSubs;
  return totals;
}
