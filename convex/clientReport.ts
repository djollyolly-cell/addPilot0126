import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { messagesGetConversations, messagesGetHistory, usersGet } from "./vkCommunityApi";
import { extractPhones, normalizePhone } from "./phoneExtractor";
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
  result_subscribes?: number;
  result_messages?: number;
  result_lead_forms?: number;
  result_other?: number;
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

export type CampaignTypeTotals = Record<string, Partial<ReportRow>>;

export interface ReportResult {
  dateFrom: string;
  dateTo: string;
  rows: ReportRow[];
  totals: Partial<ReportRow>;
  totalsByType: CampaignTypeTotals;
  phonesDetail: PhoneEntry[];
  partialErrors: string[];
}

export interface CommunityReportResult {
  messageStartsByDate: Record<string, number>;
  phonesDetail: PhoneEntry[];
  senlerSubsByDate: Record<string, number>;
  partialErrors: string[];
}

type ResultCategory = "subscribes" | "messages" | "lead_forms" | "other";

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

function weekday(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return WEEKDAYS[d.getUTCDay()];
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

/** Read metricsDaily for account + date range */
export const _getMetricsForReport = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId)
          .gte("date", args.dateFrom)
          .lte("date", args.dateTo)
      )
      .collect();
  },
});

/** Read campaign names + status: vkCampaignId -> { name, status, adPlanId } */
export const _getCampaignNames = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    const result: Record<string, { name: string; status: string; adPlanId?: string }> = {};
    for (const c of campaigns) {
      result[c.vkCampaignId] = { name: c.name, status: c.status, adPlanId: c.adPlanId };
    }
    return result;
  },
});

/** Read ad names: vkAdId -> { name, campaignId (vkCampaignId) } with batch campaign lookup */
export const _getAdNames = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ads")
      .withIndex("by_accountId_vkAdId", (q) => q.eq("accountId", args.accountId))
      .collect();

    // Batch: collect unique campaignIds (Convex doc IDs), fetch all at once
    const uniqueCampaignIds = [...new Set(ads.map((a) => a.campaignId))];
    const campaignMap = new Map<string, string>();
    for (const cId of uniqueCampaignIds) {
      const campaign = await ctx.db.get(cId);
      if (campaign) campaignMap.set(cId as string, campaign.vkCampaignId);
    }

    const result: Record<string, { name: string; campaignId: string }> = {};
    for (const a of ads) {
      result[a.vkAdId] = { name: a.name, campaignId: campaignMap.get(a.campaignId as string) ?? "" };
    }
    return result;
  },
});

// ─── Public action: buildReport (DB-only, single account) ──

export const buildReport = action({
  args: {
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
    campaignIds: v.optional(v.array(v.string())),
    groupIds: v.optional(v.array(v.number())),
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

    // 1. Read metrics from DB (instant)
    const [metrics, campaignNames, adNames] = await Promise.all([
      ctx.runQuery(internal.clientReport._getMetricsForReport, {
        accountId: args.accountId,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
      }),
      ctx.runQuery(internal.clientReport._getCampaignNames, {
        accountId: args.accountId,
      }),
      ctx.runQuery(internal.clientReport._getAdNames, {
        accountId: args.accountId,
      }),
    ]);

    // Map campaignType from metricsDaily to result category
    function typeToCategory(campaignType: string | undefined): ResultCategory {
      switch (campaignType) {
        case "subscription": return "subscribes";
        case "message": return "messages";
        case "lead": return "lead_forms";
        default: return "other";
      }
    }

    // Cast query results to proper types (Convex serialization loses type info)
    const campaignNameMap = campaignNames as Record<string, { name: string; status: string; adPlanId?: string }>;
    const adNameMap = adNames as Record<string, { name: string; campaignId: string }>;

    // Build ad_group status set for campaignStatus filter
    const activeGroupIds = args.campaignStatus
      ? new Set(
          Object.entries(campaignNameMap)
            .filter(([_, info]) => info.status === args.campaignStatus)
            .map(([vkId]) => vkId)
        )
      : null;

    // Convert groupIds (numbers) to string Set for comparison with campaignId (string)
    const groupIdFilter = args.groupIds?.length
      ? new Set(args.groupIds.map(String))
      : null;

    for (const m of metrics) {
      if (!m.campaignId) continue;

      const groupId = m.campaignId; // ad_group_id (string)
      const adInfo = adNameMap[m.adId];
      const campaignId = adInfo?.campaignId ?? ""; // ad_plan vkCampaignId

      // Apply campaign (ad_plan) filter
      if (args.campaignIds?.length && campaignId && !args.campaignIds.includes(campaignId)) continue;

      // Apply ad_group filter
      if (groupIdFilter && !groupIdFilter.has(groupId)) continue;

      // Apply campaignStatus filter (ad_group status from campaigns table)
      if (activeGroupIds && !activeGroupIds.has(groupId)) continue;

      const category = typeToCategory(m.campaignType);

      // lead_forms: take max(vkResult, formEvents) to preserve max-logic
      let vkResult = m.vkResult ?? 0;
      if (category === "lead_forms" && m.formEvents !== undefined) {
        vkResult = Math.max(vkResult, m.formEvents);
      }

      const key = buildKey(args.granularity, {
        date: m.date,
        campaignId,
        groupId,
        adId: m.adId,
      });

      const existing = rowMap.get(key) ?? initRow(args.granularity, {
        date: m.date,
        campaignId,
        groupId,
        adId: m.adId,
      });

      // Fill names
      if (args.granularity === "day_campaign" || args.granularity === "day_group" || args.granularity === "day_banner") {
        if (!existing.campaignName && campaignId) {
          // campaignNames is keyed by vkCampaignId — but for ad_groups, groupId is the key
          // adPlanId in campaignNames entry points to ad_plan
          // campaignId here IS the ad_plan vkCampaignId — not in campaignNames (those are ad_groups)
          // We need ad_plan name, not ad_group name for "campaign" display
          existing.campaignName = campaignId;
        }
      }
      if (args.granularity === "day_group" || args.granularity === "day_banner") {
        if (!existing.groupName && groupId) {
          existing.groupName = campaignNameMap[groupId]?.name ?? groupId;
        }
      }
      if (args.granularity === "day_banner") {
        if (!existing.adName) {
          existing.adName = adInfo?.name ?? m.adId;
        }
      }

      existing.impressions = (existing.impressions ?? 0) + m.impressions;
      existing.clicks = (existing.clicks ?? 0) + m.clicks;
      existing.spent = Math.round(((existing.spent ?? 0) + m.spent) * 100) / 100;

      // Route vkResult by campaignType
      switch (category) {
        case "subscribes":
          existing.result_subscribes = (existing.result_subscribes ?? 0) + vkResult;
          break;
        case "messages":
          existing.result_messages = (existing.result_messages ?? 0) + vkResult;
          break;
        case "lead_forms":
          existing.result_lead_forms = (existing.result_lead_forms ?? 0) + vkResult;
          break;
        default:
          if (vkResult > 0) existing.result_other = (existing.result_other ?? 0) + vkResult;
      }

      rowMap.set(key, existing);
    }

    // Derived metrics per row
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
      if (args.fields.includes("cpl") && r.spent) {
        const totalResults = (r.result_subscribes ?? 0) + (r.result_messages ?? 0) + (r.result_lead_forms ?? 0) + (r.result_other ?? 0);
        if (totalResults > 0) {
          r.cpl = Math.round((r.spent / totalResults) * 100) / 100;
        }
      }
      if (args.fields.includes("weekday") && !r.weekday) {
        r.weekday = weekday(r.date);
      }
      rows.push(r);
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));

    const totals = computeTotals(rows, args.fields);
    const totalsByType = computeTotalsByType(metrics, args.fields, args.campaignIds, groupIdFilter, adNameMap);

    return {
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      rows,
      totals,
      totalsByType,
      phonesDetail: [],
      partialErrors,
    };
  },
});

// ─── Public action: buildCommunityReport (VK API) ──────────

export const buildCommunityReport = action({
  args: {
    userId: v.id("users"),
    communityIds: v.array(v.number()),
    accountId: v.id("adAccounts"),
    fields: v.array(v.string()),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args): Promise<CommunityReportResult> => {
    const partialErrors: string[] = [];
    const messageStartsByDate: Record<string, number> = {};
    const senlerSubsByDate: Record<string, number> = {};
    const phonesDetail: PhoneEntry[] = [];
    const fromTs = Date.parse(args.dateFrom + "T00:00:00Z") / 1000;
    const toTs = Date.parse(args.dateTo + "T23:59:59Z") / 1000;

    const needsDialogs = args.fields.some((f) =>
      ["message_starts", "phones_count", "phones_detail"].includes(f)
    );

    // 1. Community dialogs
    if (needsDialogs && args.communityIds.length > 0) {
      const profiles = await ctx.runQuery(
        internal.clientReport._readCommunityProfiles,
        { userId: args.userId, vkGroupIds: args.communityIds }
      );

      for (const profile of profiles) {
        try {
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
            await new Promise((r) => setTimeout(r, 500));
          }

          const peerIds = Array.from(new Set(activeDialogs.map((d) => d.peerId)));
          const peerInfo = new Map<number, { firstName: string; lastName: string }>();
          for (let i = 0; i < peerIds.length; i += 100) {
            const batch = peerIds.slice(i, i + 100).filter((id) => id > 0);
            if (batch.length === 0) continue;
            const users = await usersGet(profile.vkCommunityToken, batch);
            for (const u of users) {
              peerInfo.set(u.id, { firstName: u.first_name, lastName: u.last_name });
            }
            await new Promise((r) => setTimeout(r, 300));
          }

          const needMessageStarts = args.fields.includes("message_starts");
          const needPhones = args.fields.some((f) => ["phones_count", "phones_detail"].includes(f));
          const groupIdAbs = Math.abs(profile.vkGroupId);
          const BATCH_SIZE = 2;

          for (let i = 0; i < activeDialogs.length; i += BATCH_SIZE) {
            const batch = activeDialogs.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (d) => {
              try {
                const requests: Promise<{ items: Array<{ date: number; from_id: number; text: string }> }>[] = [];
                if (needMessageStarts) {
                  requests.push(messagesGetHistory(profile.vkCommunityToken, d.peerId, 1, 0));
                }
                if (needPhones) {
                  requests.push(messagesGetHistory(profile.vkCommunityToken, d.peerId, 50, 1));
                }
                const results = await Promise.all(requests);
                let idx = 0;

                if (needMessageStarts) {
                  const firstMsg = results[idx].items[0];
                  if (firstMsg && firstMsg.date >= fromTs && firstMsg.date <= toTs) {
                    const dateStr = new Date(firstMsg.date * 1000).toISOString().slice(0, 10);
                    messageStartsByDate[dateStr] = (messageStartsByDate[dateStr] ?? 0) + 1;
                  }
                  idx++;
                }

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
              } catch (err) {
                partialErrors.push(
                  `Сообщество ${profile.vkGroupName}, peer ${d.peerId}: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            }));
            if (i + BATCH_SIZE < activeDialogs.length) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        } catch (err) {
          partialErrors.push(
            `Сообщество ${profile.vkGroupName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // 2. Lead Ads contacts
    if (needsDialogs) {
      const acc = await ctx.runQuery(internal.clientReport._readAccounts, {
        accountIds: [args.accountId],
      });
      for (const a of acc) {
        if (!a.accessToken) continue;
        try {
          const leads = await fetchLeadDetails(a.accessToken, args.dateFrom, args.dateTo);
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
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("404")) {
            partialErrors.push(`Lead Ads: ${msg}`);
          }
        }
      }
    }

    // 3. Senler subs
    if (args.fields.includes("senler_subs") && args.communityIds.length > 0) {
      const profiles = await ctx.runQuery(
        internal.clientReport._readCommunityProfiles,
        { userId: args.userId, vkGroupIds: args.communityIds }
      );
      for (const profile of profiles) {
        if (!profile.senlerApiKey) continue;
        try {
          const subs = await getSubscribersByDateRange(profile.senlerApiKey, fromTs, toTs);
          for (const sub of subs) {
            const date = new Date(sub.date_subscribe * 1000).toISOString().slice(0, 10);
            senlerSubsByDate[date] = (senlerSubsByDate[date] ?? 0) + 1;
          }
        } catch (err) {
          partialErrors.push(
            `Senler ${profile.vkGroupName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    return { messageStartsByDate, phonesDetail, senlerSubsByDate, partialErrors };
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
  let resultSubscribes = 0, resultMessages = 0, resultLeadForms = 0, resultOther = 0;
  let messageStarts = 0, phonesCount = 0, senlerSubs = 0;
  for (const r of rows) {
    impressions += r.impressions ?? 0;
    clicks += r.clicks ?? 0;
    spent += r.spent ?? 0;
    resultSubscribes += r.result_subscribes ?? 0;
    resultMessages += r.result_messages ?? 0;
    resultLeadForms += r.result_lead_forms ?? 0;
    resultOther += r.result_other ?? 0;
    messageStarts += r.message_starts ?? 0;
    phonesCount += r.phones_count ?? 0;
    senlerSubs += r.senler_subs ?? 0;
  }
  if (fields.includes("impressions")) totals.impressions = impressions;
  if (fields.includes("clicks")) totals.clicks = clicks;
  if (fields.includes("spent")) totals.spent = Math.round(spent * 100) / 100;
  if (fields.includes("spent_with_vat")) totals.spent_with_vat = Math.round(spent * 1.2 * 100) / 100;
  if (fields.includes("result_subscribes")) totals.result_subscribes = resultSubscribes;
  if (fields.includes("result_messages")) totals.result_messages = resultMessages;
  if (fields.includes("result_lead_forms")) totals.result_lead_forms = resultLeadForms;
  if (fields.includes("result_other")) totals.result_other = resultOther;
  if (fields.includes("cpc") && clicks) totals.cpc = Math.round((spent / clicks) * 100) / 100;
  if (fields.includes("ctr") && impressions) totals.ctr = Math.round((clicks / impressions) * 10000) / 100;
  if (fields.includes("cpm") && impressions) totals.cpm = Math.round((spent / impressions) * 1000 * 100) / 100;
  if (fields.includes("cpl")) {
    const totalResults = resultSubscribes + resultMessages + resultLeadForms + resultOther;
    if (totalResults > 0) totals.cpl = Math.round((spent / totalResults) * 100) / 100;
  }
  if (fields.includes("message_starts")) totals.message_starts = messageStarts;
  if (fields.includes("phones_count")) totals.phones_count = phonesCount;
  if (fields.includes("senler_subs")) totals.senler_subs = senlerSubs;
  return totals;
}

function computeTotalsByType(
  metrics: Array<{
    adId: string;
    campaignId?: string;
    campaignType?: string;
    impressions: number;
    clicks: number;
    spent: number;
    vkResult?: number;
    formEvents?: number;
  }>,
  fields: string[],
  campaignFilter: string[] | undefined,
  groupFilter: Set<string> | null,
  adNames: Record<string, { campaignId: string }>,
): CampaignTypeTotals {
  const byType: Record<string, { impressions: number; clicks: number; spent: number; results: number }> = {};

  for (const m of metrics) {
    if (!m.campaignId) continue;
    const adInfo = adNames[m.adId];
    const campaignId = adInfo?.campaignId ?? "";
    if (campaignFilter?.length && campaignId && !campaignFilter.includes(campaignId)) continue;
    if (groupFilter && !groupFilter.has(m.campaignId)) continue;

    const type = m.campaignType ?? "other";
    if (!byType[type]) byType[type] = { impressions: 0, clicks: 0, spent: 0, results: 0 };
    byType[type].impressions += m.impressions;
    byType[type].clicks += m.clicks;
    byType[type].spent += m.spent;
    // lead_forms: max(vkResult, formEvents) — same logic as in buildReport
    let result = m.vkResult ?? 0;
    if (type === "lead" && m.formEvents !== undefined) {
      result = Math.max(result, m.formEvents);
    }
    byType[type].results += result;
  }

  const result: CampaignTypeTotals = {};
  for (const [type, data] of Object.entries(byType)) {
    const row: Partial<ReportRow> = {};
    if (fields.includes("impressions")) row.impressions = data.impressions;
    if (fields.includes("clicks")) row.clicks = data.clicks;
    if (fields.includes("spent")) row.spent = Math.round(data.spent * 100) / 100;
    if (fields.includes("spent_with_vat")) row.spent_with_vat = Math.round(data.spent * 1.2 * 100) / 100;
    if (fields.includes("cpc") && data.clicks) row.cpc = Math.round((data.spent / data.clicks) * 100) / 100;
    if (fields.includes("ctr") && data.impressions) row.ctr = Math.round((data.clicks / data.impressions) * 10000) / 100;
    if (fields.includes("cpm") && data.impressions) row.cpm = Math.round((data.spent / data.impressions) * 1000 * 100) / 100;
    if (fields.includes("cpl") && data.results > 0) row.cpl = Math.round((data.spent / data.results) * 100) / 100;

    // Route results to the correct column
    switch (type) {
      case "subscription": row.result_subscribes = data.results; break;
      case "message": row.result_messages = data.results; break;
      case "lead": row.result_lead_forms = data.results; break;
      default: row.result_other = data.results; break;
    }

    // Use ASCII keys — Convex doesn't allow non-ASCII in field names
    result[type] = row;
  }

  return result;
}

// ─── Backfill: populate campaignType for existing metricsDaily ───

/** Read metricsDaily rows for one account + date range, returning id + campaignId */
export const _getMetricsForBackfill = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId)
          .gte("date", args.dateFrom)
          .lte("date", args.dateTo)
      )
      .collect();

    return all
      .filter((m) => m.campaignId)
      .map((m) => ({ id: m._id as string, campaignId: m.campaignId!, currentType: m.campaignType }));
  },
});

/** Batch-patch metricsDaily rows with campaignType */
export const _backfillBatch = internalMutation({
  args: {
    updates: v.array(v.object({
      id: v.id("metricsDaily"),
      campaignType: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    for (const u of args.updates) {
      await ctx.db.patch(u.id, { campaignType: u.campaignType });
    }
    return args.updates.length;
  },
});

/** One-time backfill: populate campaignType for all metricsDaily records missing it */
/** Backfill one account at a time (accepts accountId to avoid timeout) */
export const backfillCampaignTypes = internalAction({
  args: { accountId: v.optional(v.id("adAccounts")) },
  handler: async (ctx, args) => {
    const allAccounts = await ctx.runQuery(internal.syncMetrics.listActiveAccounts);
    const accounts = args.accountId
      ? allAccounts.filter((a) => a._id === args.accountId)
      : allAccounts;

    let totalUpdated = 0;

    for (const account of accounts) {
      if (!account || !account.accessToken) {
        console.log(`[backfill] Skipping — no token`);
        continue;
      }

      let typeMap: Array<{ adGroupId: string; adPlanId: number; type: string }>;
      try {
        typeMap = await ctx.runAction(internal.vkApi.getCampaignTypeMap, {
          accessToken: account.accessToken,
        });
      } catch (err) {
        console.error(`[backfill] getCampaignTypeMap failed for ${account.name}: ${err}`);
        continue;
      }

      const campaignTypeMap = new Map<string, string>();
      for (const entry of typeMap) {
        campaignTypeMap.set(entry.adGroupId, entry.type);
      }

      if (campaignTypeMap.size === 0) {
        console.log(`[backfill] ${account.name} — no campaign types found`);
        continue;
      }

      // Read day by day to stay under Convex return size limits
      let accountUpdated = 0;
      const start = new Date("2025-01-01");
      const end = new Date();
      const d = new Date(start);
      while (d <= end) {
        const from = d.toISOString().slice(0, 10);
        const to = from;
        d.setDate(d.getDate() + 1);

        const rows = await ctx.runQuery(internal.clientReport._getMetricsForBackfill, {
          accountId: account._id,
          dateFrom: from,
          dateTo: to,
        });
        if (rows.length === 0) continue;

        const updates: Array<{ id: Id<"metricsDaily">; campaignType: string }> = [];
        for (const m of rows) {
          const type = campaignTypeMap.get(m.campaignId);
          if (type && type !== m.currentType) {
            updates.push({ id: m.id as Id<"metricsDaily">, campaignType: type });
          }
        }

        const BATCH = 250;
        for (let i = 0; i < updates.length; i += BATCH) {
          await ctx.runMutation(internal.clientReport._backfillBatch, {
            updates: updates.slice(i, i + BATCH),
          });
        }
        accountUpdated += updates.length;
      }

      totalUpdated += accountUpdated;
      console.log(`[backfill] ${account.name}: ${accountUpdated} rows updated`);
    }

    console.log(`[backfill] Done. Total updated: ${totalUpdated}`);
    return { totalUpdated };
  },
});

