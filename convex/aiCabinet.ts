import { v } from "convex/values";
import { query, mutation, action, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// ─── Queries ─────────────────────────────────────────────────────

export const listCampaigns = query({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("aiCampaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
});

export const getCampaign = query({
  args: { id: v.id("aiCampaigns") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.id);
  },
});

export const listBanners = query({
  args: { campaignId: v.id("aiCampaigns") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("aiBanners")
      .withIndex("by_campaignId", (q) => q.eq("campaignId", args.campaignId))
      .collect();
  },
});

export const listRecommendations = query({
  args: { campaignId: v.id("aiCampaigns") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("aiRecommendations")
      .withIndex("by_campaignId", (q) => q.eq("campaignId", args.campaignId))
      .collect();
  },
});

// Get aggregated today's metrics for AI campaigns under an account
export const getAccountMetrics = query({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const today = new Date().toISOString().slice(0, 10);
    // Get all AI campaigns for this account
    const campaigns = await ctx.db
      .query("aiCampaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();

    const vkCampaignIds = campaigns
      .filter((c) => c.vkCampaignId)
      .map((c) => c.vkCampaignId!);

    if (vkCampaignIds.length === 0) {
      return { spent: 0, leads: 0, cpl: 0 };
    }

    // Get today's metrics for these campaigns
    const metrics = await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId).eq("date", today)
      )
      .collect();

    const aiMetrics = metrics.filter((m) => m.campaignId && vkCampaignIds.includes(m.campaignId));

    let spent = 0, leads = 0;
    for (const m of aiMetrics) {
      spent += m.spent;
      leads += m.leads;
    }

    return { spent, leads, cpl: leads > 0 ? spent / leads : 0 };
  },
});

// Get metrics for a single campaign (today)
export const getCampaignMetrics = query({
  args: { campaignId: v.id("aiCampaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign || !campaign.vkCampaignId) {
      return { spent: 0, leads: 0, cpl: 0, ctr: 0, impressions: 0, clicks: 0 };
    }

    const today = new Date().toISOString().slice(0, 10);
    const metrics = await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", campaign.accountId).eq("date", today)
      )
      .collect();

    const campaignMetrics = metrics.filter((m) => m.campaignId === campaign.vkCampaignId);

    let spent = 0, leads = 0, clicks = 0, impressions = 0;
    for (const m of campaignMetrics) {
      spent += m.spent;
      leads += m.leads;
      clicks += m.clicks;
      impressions += m.impressions;
    }

    return {
      spent,
      leads,
      clicks,
      impressions,
      cpl: leads > 0 ? spent / leads : 0,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    };
  },
});

// ─── Mutations ───────────────────────────────────────────────────

export const createCampaign = mutation({
  args: {
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
    businessDirection: v.string(),
    objective: v.string(),
    targetUrl: v.string(),
    regions: v.array(v.number()),
    ageFrom: v.number(),
    ageTo: v.number(),
    sex: v.string(),
    dailyBudget: v.number(),
  },
  handler: async (ctx, args) => {
    if (!args.businessDirection.trim()) throw new Error("Введите направление бизнеса");
    if (!args.targetUrl.trim()) throw new Error("Введите ссылку");
    if (args.regions.length === 0) throw new Error("Выберите хотя бы один регион");
    if (args.dailyBudget < 100) throw new Error("Минимальный бюджет: 100₽");

    const name = `AI: ${args.businessDirection} — ${args.objective}`;
    const now = Date.now();

    return ctx.db.insert("aiCampaigns", {
      userId: args.userId,
      accountId: args.accountId,
      name,
      businessDirection: args.businessDirection,
      objective: args.objective,
      targetUrl: args.targetUrl,
      regions: args.regions,
      ageFrom: args.ageFrom,
      ageTo: args.ageTo,
      sex: args.sex,
      dailyBudget: args.dailyBudget,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateCampaign = mutation({
  args: {
    id: v.id("aiCampaigns"),
    regions: v.optional(v.array(v.number())),
    ageFrom: v.optional(v.number()),
    ageTo: v.optional(v.number()),
    sex: v.optional(v.string()),
    dailyBudget: v.optional(v.number()),
    status: v.optional(v.string()),
    vkCampaignId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    const filtered: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(updates)) {
      if (val !== undefined) filtered[k] = val;
    }
    await ctx.db.patch(id, filtered);
  },
});

export const createBanner = mutation({
  args: {
    campaignId: v.id("aiCampaigns"),
    title: v.string(),
    text: v.string(),
    imageStorageId: v.optional(v.id("_storage")),
    wideImageStorageId: v.optional(v.id("_storage")),
    iconStorageId: v.optional(v.id("_storage")),
    isSelected: v.boolean(),
  },
  handler: async (ctx, args) => {
    if (args.title.length > 25) throw new Error("Заголовок: максимум 25 символов");
    if (args.text.length > 90) throw new Error("Текст: максимум 90 символов");

    const now = Date.now();
    return ctx.db.insert("aiBanners", {
      campaignId: args.campaignId,
      title: args.title,
      text: args.text,
      imageStorageId: args.imageStorageId,
      wideImageStorageId: args.wideImageStorageId,
      iconStorageId: args.iconStorageId,
      isSelected: args.isSelected,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateBanner = mutation({
  args: {
    id: v.id("aiBanners"),
    title: v.optional(v.string()),
    text: v.optional(v.string()),
    isSelected: v.optional(v.boolean()),
    vkBannerId: v.optional(v.string()),
    vkContentIds: v.optional(v.object({
      image600: v.optional(v.number()),
      image1080: v.optional(v.number()),
      icon: v.optional(v.number()),
    })),
    moderationStatus: v.optional(v.string()),
    moderationReason: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    const filtered: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(updates)) {
      if (val !== undefined) filtered[k] = val;
    }
    await ctx.db.patch(id, filtered);
  },
});

export const toggleBannerSelected = mutation({
  args: { id: v.id("aiBanners") },
  handler: async (ctx, args) => {
    const banner = await ctx.db.get(args.id);
    if (!banner) throw new Error("Баннер не найден");
    await ctx.db.patch(args.id, {
      isSelected: !banner.isSelected,
      updatedAt: Date.now(),
    });
  },
});

export const deleteCampaign = mutation({
  args: { id: v.id("aiCampaigns"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.id);
    if (!campaign) throw new Error("Кампания не найдена");
    if (campaign.userId !== args.userId) throw new Error("Нет доступа");
    // Delete all banners
    const banners = await ctx.db
      .query("aiBanners")
      .withIndex("by_campaignId", (q) => q.eq("campaignId", args.id))
      .collect();
    for (const b of banners) {
      await ctx.db.delete(b._id);
    }
    // Delete all recommendations
    const recs = await ctx.db
      .query("aiRecommendations")
      .withIndex("by_campaignId", (q) => q.eq("campaignId", args.id))
      .collect();
    for (const r of recs) {
      await ctx.db.delete(r._id);
    }
    await ctx.db.delete(args.id);
  },
});

// Internal mutation for launch orchestrator
export const setCampaignStatus = internalMutation({
  args: {
    id: v.id("aiCampaigns"),
    status: v.string(),
    vkCampaignId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = {
      status: args.status,
      updatedAt: Date.now(),
    };
    if (args.vkCampaignId !== undefined) updates.vkCampaignId = args.vkCampaignId;
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    await ctx.db.patch(args.id, updates);
  },
});

export const setBannerVkIds = internalMutation({
  args: {
    id: v.id("aiBanners"),
    vkBannerId: v.string(),
    vkContentIds: v.optional(v.object({
      image600: v.optional(v.number()),
      image1080: v.optional(v.number()),
      icon: v.optional(v.number()),
    })),
    status: v.union(v.literal("draft"), v.literal("active"), v.literal("paused")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      vkBannerId: args.vkBannerId,
      vkContentIds: args.vkContentIds,
      status: args.status,
      updatedAt: Date.now(),
    });
  },
});

// Fetch regions from myTarget API (token resolved server-side)
export const fetchRegions = action({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<unknown> => {
    const accessToken = await ctx.runAction(
      internal.auth.getValidTokenForAccount,
      { accountId: args.accountId }
    );
    return ctx.runAction(api.vkApi.getMtRegions, { accessToken });
  },
});

// ─── Helper: safe base64 encoding for large buffers ──────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

// ─── Helper: upload a storage file to myTarget ───────────────────

async function uploadStorageImage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { storage: { getUrl(id: Id<"_storage">): Promise<string | null> }; runAction: (...args: any[]) => any },
  storageId: Id<"_storage">,
  accessToken: string,
  filename: string,
  width: number,
  height: number,
): Promise<number | null> {
  const imageUrl = await ctx.storage.getUrl(storageId);
  if (!imageUrl) return null;

  const resp = await fetch(imageUrl);
  const buf = await resp.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);

  const result = await ctx.runAction(api.vkApi.uploadMtImage, {
    accessToken,
    imageData: base64,
    filename,
    width,
    height,
  });
  return result.id;
}

// ─── Actions ─────────────────────────────────────────────────────

// Launch campaign: upload images → create campaign → create banners
// Token is resolved server-side via getValidTokenForAccount — NEVER from client
export const launchCampaign = action({
  args: {
    campaignId: v.id("aiCampaigns"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; vkCampaignId: string }> => {
    // 1. Get campaign data
    const campaign = await ctx.runQuery(api.aiCabinet.getCampaign, { id: args.campaignId });
    if (!campaign) throw new Error("Кампания не найдена");
    if (campaign.status !== "draft") throw new Error("Кампания уже запущена");

    // 2. Resolve access token server-side (source of truth)
    const accessToken = await ctx.runAction(
      internal.auth.getValidTokenForAccount,
      { accountId: campaign.accountId }
    );

    // 3. Get selected banners
    const allBanners = await ctx.runQuery(api.aiCabinet.listBanners, { campaignId: args.campaignId });
    const selectedBanners = allBanners.filter((b: { isSelected: boolean }) => b.isSelected);
    if (selectedBanners.length === 0) throw new Error("Выберите хотя бы один баннер");

    // Set status to creating
    await ctx.runMutation(internal.aiCabinet.setCampaignStatus, {
      id: args.campaignId,
      status: "creating",
    });

    try {
      // 4. Upload ALL image sizes for each banner (600x600, 1080x607, 256x256)
      for (const banner of selectedBanners) {
        const contentIds: { image600?: number; image1080?: number; icon?: number } = {};

        if (banner.imageStorageId) {
          const id = await uploadStorageImage(
            ctx, banner.imageStorageId as Id<"_storage">,
            accessToken, "image_600x600.png", 600, 600,
          );
          if (id) contentIds.image600 = id;
        }

        if (banner.wideImageStorageId) {
          const id = await uploadStorageImage(
            ctx, banner.wideImageStorageId as Id<"_storage">,
            accessToken, "image_1080x607.png", 1080, 607,
          );
          if (id) contentIds.image1080 = id;
        } else if (banner.imageStorageId) {
          // Fallback: upload 600x600 as wide image too (myTarget will crop)
          const id = await uploadStorageImage(
            ctx, banner.imageStorageId as Id<"_storage">,
            accessToken, "image_1080x607.png", 1080, 607,
          );
          if (id) contentIds.image1080 = id;
        }

        if (banner.iconStorageId) {
          const id = await uploadStorageImage(
            ctx, banner.iconStorageId as Id<"_storage">,
            accessToken, "icon_256x256.png", 256, 256,
          );
          if (id) contentIds.icon = id;
        } else if (banner.imageStorageId) {
          // Fallback: upload 600x600 as icon too (myTarget will crop)
          const id = await uploadStorageImage(
            ctx, banner.imageStorageId as Id<"_storage">,
            accessToken, "icon_256x256.png", 256, 256,
          );
          if (id) contentIds.icon = id;
        }

        // Store content IDs on the banner
        await ctx.runMutation(internal.aiCabinet.setBannerVkIds, {
          id: banner._id,
          vkBannerId: "",
          vkContentIds: contentIds,
          status: "draft",
        });
      }

      // 5. Build age array for myTarget (e.g. [22, 23, 24, ..., 55])
      const ageArray: number[] = [];
      for (let a = campaign.ageFrom; a <= campaign.ageTo; a++) {
        ageArray.push(a);
      }

      // 6. Create campaign in myTarget
      const targetings: Record<string, unknown> = {
        regions: campaign.regions,
        sex: campaign.sex === "MF" ? "MF" : campaign.sex === "M" ? "M" : "F",
        age: ageArray,
      };

      const vkCampaign: any = await ctx.runAction(api.vkApi.createMtCampaign, {
        accessToken,
        name: campaign.name,
        packageId: campaign.packageId || 960,
        targetings,
        dailyBudget: String(campaign.dailyBudget) + ".00",
        url: campaign.targetUrl,
      });

      const vkCampaignId = String(vkCampaign.id);

      // 7. Create banners in myTarget
      for (const banner of selectedBanners) {
        // Re-read to get updated contentIds
        const updatedBanners = await ctx.runQuery(api.aiCabinet.listBanners, { campaignId: args.campaignId });
        const current = updatedBanners.find((b: { _id: string }) => b._id === banner._id);
        if (!current) continue;

        const contentSlots: Record<string, { id: number }> = {};
        if (current.vkContentIds?.image600) {
          contentSlots["image_600x600"] = { id: current.vkContentIds.image600 };
        }
        if (current.vkContentIds?.image1080) {
          contentSlots["image_1080x607"] = { id: current.vkContentIds.image1080 };
        }
        if (current.vkContentIds?.icon) {
          contentSlots["icon"] = { id: current.vkContentIds.icon };
        }

        const vkBanner = await ctx.runAction(api.vkApi.createMtBanner, {
          accessToken,
          campaignId: vkCampaign.id,
          textblocks: {
            title: { text: banner.title },
            text: { text: banner.text },
          },
          content: contentSlots,
          url: campaign.targetUrl,
        });

        await ctx.runMutation(internal.aiCabinet.setBannerVkIds, {
          id: banner._id,
          vkBannerId: String(vkBanner.id),
          status: "active",
        });
      }

      // 8. Mark campaign as active
      await ctx.runMutation(internal.aiCabinet.setCampaignStatus, {
        id: args.campaignId,
        status: "active",
        vkCampaignId,
      });

      return { success: true, vkCampaignId };
    } catch (error) {
      await ctx.runMutation(internal.aiCabinet.setCampaignStatus, {
        id: args.campaignId,
        status: "error",
        errorMessage: error instanceof Error ? error.message : "Ошибка запуска",
      });
      throw error;
    }
  },
});

// Pause/resume campaign in myTarget
// Token resolved server-side — NEVER from client
export const toggleCampaignStatus = action({
  args: {
    campaignId: v.id("aiCampaigns"),
  },
  handler: async (ctx, args) => {
    const campaign = await ctx.runQuery(api.aiCabinet.getCampaign, { id: args.campaignId });
    if (!campaign || !campaign.vkCampaignId) throw new Error("Кампания не найдена в VK");

    // Resolve token server-side
    const accessToken = await ctx.runAction(
      internal.auth.getValidTokenForAccount,
      { accountId: campaign.accountId }
    );

    const newStatus = campaign.status === "active" ? "blocked" : "active";

    await ctx.runAction(api.vkApi.updateMtCampaign, {
      accessToken,
      campaignId: Number(campaign.vkCampaignId),
      data: { status: newStatus },
    });

    await ctx.runMutation(internal.aiCabinet.setCampaignStatus, {
      id: args.campaignId,
      status: newStatus === "active" ? "active" : "paused",
    });
  },
});
