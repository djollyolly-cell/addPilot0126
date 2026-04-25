import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { callMtApi } from "./vkApi";
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
  vk_result?: number;
  lead_forms?: number;
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

// ─── VK API types (same as reports.ts) ──────────────────────

interface MtStatBase {
  shows: number;
  clicks: number;
  spent: string;
  goals: number;
  vk?: { result?: number | string; goals?: number | string };
}

interface MtStatRow {
  date: string;
  base: MtStatBase;
  events?: Record<string, { count?: number | string } | number>;
}

interface MtStatItem {
  id: number;
  rows: MtStatRow[];
}

interface MtBannerRaw {
  id: number;
  campaign_id: number; // myTarget: this is ad_group.id (Группа), NOT ad_plan.id (Кампания)
  status: string;
}

interface MtAdGroupRaw {
  id: number;
  ad_plan_id: number; // myTarget: this is the actual campaign (Кампания)
}

// ─── VK API helpers ─────────────────────────────────────────

const CHUNK_SIZE = 200;

async function fetchStatsBatched(
  endpoint: string,
  accessToken: string,
  ids: string[],
  dateFrom: string,
  dateTo: string
): Promise<MtStatItem[]> {
  if (ids.length === 0) return [];
  const allItems: MtStatItem[] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE).join(",");
    const data = await callMtApi<{ items: MtStatItem[] }>(
      endpoint, accessToken,
      { id: chunk, date_from: dateFrom, date_to: dateTo, metrics: "base,events" }
    );
    if (data.items) allItems.push(...data.items);
  }
  return allItems;
}

async function fetchAllBanners(accessToken: string): Promise<MtBannerRaw[]> {
  let banners: MtBannerRaw[] = [];
  let offset = 0;
  while (true) {
    const data = await callMtApi<{ items: MtBannerRaw[]; count: number }>(
      "banners.json", accessToken,
      { fields: "id,campaign_id,status", limit: "250", offset: String(offset), _status__in: "active,blocked" }
    );
    const items = data.items || [];
    banners = banners.concat(items);
    if (banners.length >= data.count || items.length === 0) break;
    offset += items.length;
  }
  return banners;
}

async function fetchAdGroups(accessToken: string): Promise<MtAdGroupRaw[]> {
  let groups: MtAdGroupRaw[] = [];
  let offset = 0;
  while (true) {
    const data = await callMtApi<{ items: MtAdGroupRaw[]; count: number }>(
      "campaigns.json", accessToken,
      { fields: "id,ad_plan_id", limit: "250", offset: String(offset) }
    );
    const items = data.items || [];
    groups = groups.concat(items);
    if (groups.length >= data.count || items.length === 0) break;
    offset += items.length;
  }
  return groups;
}

async function fetchLeadCounts(
  accessToken: string,
  dateFrom: string,
  dateTo: string
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  try {
    const subs = await callMtApi<{
      items: Array<{ id: number; banner_id: number }>;
    }>("lead_ads/vkontakte/subscriptions.json", accessToken, {});
    if (!subs.items || subs.items.length === 0) return result;

    const formToBanner = new Map<number, number>();
    for (const sub of subs.items) formToBanner.set(sub.id, sub.banner_id);

    const formIds = subs.items.map((s) => s.id).join(",");
    const leads = await callMtApi<{
      items: Array<{ form_id: number; leads: Array<{ id: number; created: string }> }>;
    }>("lead_ads/vkontakte/leads.json", accessToken, {
      form_id: formIds, date_from: dateFrom, date_to: dateTo,
    });

    if (leads.items) {
      for (const item of leads.items) {
        const bannerId = formToBanner.get(item.form_id);
        if (bannerId) {
          const key = String(bannerId);
          result[key] = (result[key] || 0) + (item.leads?.length || 0);
        }
      }
    }
  } catch {
    // Lead Ads 404 is expected for accounts without lead forms
  }
  return result;
}

/** Extract separate lead metrics from a VK stat row */
function extractLeadMetrics(row: MtStatRow): { vkResult: number; formEvents: number } {
  const vk = row.base.vk;
  const vkResult = vk ? (Number(vk.result) || 0) : 0;
  let formEvents = 0;
  if (row.events && typeof row.events === "object") {
    const sendingForm = (row.events as Record<string, unknown>).sending_form;
    if (typeof sendingForm === "number") {
      formEvents = sendingForm;
    } else if (sendingForm && typeof sendingForm === "object") {
      formEvents = Number((sendingForm as { count?: number | string }).count) || 0;
    }
  }
  return { vkResult, formEvents };
}

// ─── Internal queries ───────────────────────────────────────

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
    const rowMap = new Map<string, ReportRow>();

    // 1. Ad metrics — direct VK API calls
    const accounts = await ctx.runQuery(internal.clientReport._readAccounts, {
      accountIds: args.accountIds,
    });

    for (const acc of accounts) {
      if (!acc.accessToken) continue;
      try {
        // Fetch banners + ad groups in parallel
        const [banners, adGroups] = await Promise.all([
          fetchAllBanners(acc.accessToken),
          fetchAdGroups(acc.accessToken),
        ]);
        const bannerIds = banners.map((b) => String(b.id));

        // banner.campaign_id = ad_group.id (Группа)
        // ad_group.ad_plan_id = actual campaign (Кампания)
        const bannerToGroupId = new Map<number, number>();
        for (const b of banners) bannerToGroupId.set(b.id, b.campaign_id);

        const groupToAdPlanId = new Map<number, number>();
        for (const g of adGroups) groupToAdPlanId.set(g.id, g.ad_plan_id);

        // Fetch stats and lead counts in parallel
        const [statsItems, leadCounts] = await Promise.all([
          fetchStatsBatched(
            "statistics/banners/day.json", acc.accessToken,
            bannerIds, args.dateFrom, args.dateTo
          ),
          fetchLeadCounts(acc.accessToken, args.dateFrom, args.dateTo),
        ]);

        for (const item of statsItems) {
          const bannerId = String(item.id);
          const groupId = bannerToGroupId.get(item.id);
          const campaignId = groupId !== undefined ? groupToAdPlanId.get(groupId) : undefined;
          const campaignIdStr = campaignId !== undefined ? String(campaignId) : "";
          const groupIdStr = groupId !== undefined ? String(groupId) : "";

          if (args.campaignIds?.length && campaignIdStr && !args.campaignIds.includes(campaignIdStr)) continue;

          const leadAdsCount = leadCounts[bannerId] || 0;

          for (const row of item.rows) {
            const { vkResult, formEvents } = extractLeadMetrics(row);
            const rowSpent = parseFloat(row.base.spent || "0") || 0;

            const key = buildKey(args.granularity, { date: row.date, campaignId: campaignIdStr, groupId: groupIdStr, adId: bannerId });
            const existing = rowMap.get(key) ?? initRow(args.granularity, { date: row.date, campaignId: campaignIdStr, groupId: groupIdStr, adId: bannerId });
            existing.impressions = (existing.impressions ?? 0) + (row.base.shows || 0);
            existing.clicks = (existing.clicks ?? 0) + (row.base.clicks || 0);
            existing.spent = Math.round(((existing.spent ?? 0) + rowSpent) * 100) / 100;
            existing.vk_result = (existing.vk_result ?? 0) + vkResult;
            existing.lead_forms = (existing.lead_forms ?? 0) + Math.max(formEvents, leadAdsCount);
            rowMap.set(key, existing);
          }
        }
      } catch (err) {
        partialErrors.push(
          `Кабинет ${acc.name} (статистика): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // 2. Community dialogs (message_starts, phones_count, phones_detail)
    const needsDialogs = args.fields.some((f) =>
      ["message_starts", "phones_count", "phones_detail"].includes(f)
    );
    const phonesDetail: PhoneEntry[] = [];
    const fromTs = Date.parse(args.dateFrom + "T00:00:00Z") / 1000;
    const toTs = Date.parse(args.dateTo + "T23:59:59Z") / 1000;

    if (needsDialogs && args.communityIds && args.communityIds.length > 0) {
      const profiles = await ctx.runQuery(
        internal.clientReport._readCommunityProfiles,
        { userId: args.userId, vkGroupIds: args.communityIds }
      );

      for (const profile of profiles) {
        try {
          // Scan conversations with last activity in the date range
          const activeDialogs: Array<{ peerId: number; lastMessageDate: number }> = [];
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
                activeDialogs.push({
                  peerId: item.conversation.peer.id,
                  lastMessageDate: lastDate,
                });
              }
            }
            if (allOlder) break;
            offset += 200;
            await new Promise((r) => setTimeout(r, 200));
          }

          // Batch fetch user info
          const peerIds = Array.from(new Set(activeDialogs.map((d) => d.peerId)));
          const peerInfo = new Map<number, { firstName: string; lastName: string }>();
          for (let i = 0; i < peerIds.length; i += 100) {
            const batch = peerIds.slice(i, i + 100).filter((id) => id > 0);
            if (batch.length === 0) continue;
            const users = await usersGet(profile.vkCommunityToken, batch);
            for (const u of users) {
              peerInfo.set(u.id, { firstName: u.first_name, lastName: u.last_name });
            }
            await new Promise((r) => setTimeout(r, 200));
          }

          // For each dialog: check true start date + extract phones
          const dialogStartsByDate = new Map<string, number>();
          const needMessageStarts = args.fields.includes("message_starts");
          const needPhones = args.fields.some((f) => ["phones_count", "phones_detail"].includes(f));
          const groupIdAbs = Math.abs(profile.vkGroupId);

          for (const d of activeDialogs) {
            try {
              // Parallel: first message (for dialog start) + recent messages (for phones)
              const requests: Promise<{ items: Array<{ date: number; from_id: number; text: string }> }>[] = [];
              if (needMessageStarts) {
                requests.push(messagesGetHistory(profile.vkCommunityToken, d.peerId, 1, 0));
              }
              if (needPhones) {
                requests.push(messagesGetHistory(profile.vkCommunityToken, d.peerId, 50, 1));
              }
              const results = await Promise.all(requests);
              let idx = 0;

              // Dialog start detection
              if (needMessageStarts) {
                const firstMsg = results[idx].items[0];
                if (firstMsg && firstMsg.date >= fromTs && firstMsg.date <= toTs) {
                  const dateStr = new Date(firstMsg.date * 1000).toISOString().slice(0, 10);
                  dialogStartsByDate.set(dateStr, (dialogStartsByDate.get(dateStr) ?? 0) + 1);
                }
                idx++;
              }

              // Phone extraction from recent messages
              if (needPhones && results[idx]) {
                const inbound = results[idx].items.filter(
                  (m) => m.from_id !== -groupIdAbs && m.from_id > 0
                );
                for (const msg of inbound) {
                  if (msg.date < fromTs || msg.date > toTs) continue;
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
              }
              await new Promise((r) => setTimeout(r, 200));
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
          // Lead Ads 404 is expected for accounts without lead forms — skip silently
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("404")) {
            partialErrors.push(`Кабинет ${acc.name} (Lead Ads): ${msg}`);
          }
        }
      }
    }

    // 4. Senler subs
    if (args.fields.includes("senler_subs") && args.communityIds && args.communityIds.length > 0) {
      const profiles = await ctx.runQuery(
        internal.clientReport._readCommunityProfiles,
        { userId: args.userId, vkGroupIds: args.communityIds }
      );
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

    // 6. Derived metrics per row + final rows array
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
      if (args.fields.includes("cpl") && r.vk_result && r.spent) {
        r.cpl = Math.round((r.spent / r.vk_result) * 100) / 100;
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
  m: { date: string; campaignId?: string; groupId?: string; adId: string }
): string {
  switch (granularity) {
    case "day": return m.date;
    case "day_campaign": return `${m.date}|c${m.campaignId ?? ""}`;
    case "day_group": return `${m.date}|g${m.groupId ?? ""}`;
    case "day_banner": return `${m.date}|a${m.adId}`;
  }
}

function buildKeyFromDate(granularity: Granularity, date: string): string {
  if (granularity === "day") return date;
  return `comm:${date}`;
}

function initRow(
  granularity: Granularity,
  m: { date: string; campaignId?: string; groupId?: string; adId: string }
): ReportRow {
  const row: ReportRow = { date: m.date };
  if (granularity === "day_campaign") {
    row.campaignId = m.campaignId;
  }
  if (granularity === "day_group") {
    row.campaignId = m.campaignId;
    row.groupId = m.groupId;
  }
  if (granularity === "day_banner") {
    row.campaignId = m.campaignId;
    row.groupId = m.groupId;
    row.adId = m.adId;
  }
  return row;
}

function computeTotals(rows: ReportRow[], fields: string[]): Partial<ReportRow> {
  const totals: Partial<ReportRow> = {};
  let impressions = 0, clicks = 0, spent = 0;
  let vkResult = 0, leadForms = 0;
  let messageStarts = 0, phonesCount = 0, senlerSubs = 0;
  for (const r of rows) {
    impressions += r.impressions ?? 0;
    clicks += r.clicks ?? 0;
    spent += r.spent ?? 0;
    vkResult += r.vk_result ?? 0;
    leadForms += r.lead_forms ?? 0;
    messageStarts += r.message_starts ?? 0;
    phonesCount += r.phones_count ?? 0;
    senlerSubs += r.senler_subs ?? 0;
  }
  if (fields.includes("impressions")) totals.impressions = impressions;
  if (fields.includes("clicks")) totals.clicks = clicks;
  if (fields.includes("spent")) totals.spent = Math.round(spent * 100) / 100;
  if (fields.includes("spent_with_vat")) totals.spent_with_vat = Math.round(spent * 1.2 * 100) / 100;
  if (fields.includes("vk_result")) totals.vk_result = vkResult;
  if (fields.includes("lead_forms")) totals.lead_forms = leadForms;
  if (fields.includes("cpc") && clicks) totals.cpc = Math.round((spent / clicks) * 100) / 100;
  if (fields.includes("ctr") && impressions) totals.ctr = Math.round((clicks / impressions) * 10000) / 100;
  if (fields.includes("cpm") && impressions) totals.cpm = Math.round((spent / impressions) * 1000 * 100) / 100;
  if (fields.includes("cpl") && vkResult) totals.cpl = Math.round((spent / vkResult) * 100) / 100;
  if (fields.includes("message_starts")) totals.message_starts = messageStarts;
  if (fields.includes("phones_count")) totals.phones_count = phonesCount;
  if (fields.includes("senler_subs")) totals.senler_subs = senlerSubs;
  return totals;
}
