# Auto-Linking Videos + Telegram Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автоматически привязывать видео к VK-объявлениям через content.video_id из API + отправлять Telegram-уведомления о досмотренности после AI-анализа.

**Architecture:**
- При sync расширяем запрос баннеров полем `content`, извлекаем video media ID из слотов с `type === "video"`, сопоставляем с `videos.vkMediaId`
- Ручной фоллбэк: дропдаун в VideoItem для привязки к объявлению
- После AI-анализа досмотренности — Telegram-уведомление (всегда при первом, при ре-анализе если score ±15)

**Tech Stack:** Convex, myTarget API v2 (`banners.json?fields=content`), Telegram Bot API

---

## Файловая структура

| Файл | Действие | Ответственность |
|------|----------|-----------------|
| `convex/vkApi.ts` | Modify | Расширить `MtBanner` полем `content`, добавить `content` в fields |
| `convex/videos.ts` | Modify | Добавить `autoLinkVideos` internalMutation, `listAdsByAccount` query |
| `convex/syncMetrics.ts` | Modify | Вызывать авто-линковку после получения баннеров |
| `convex/creativeAnalytics.ts` | Modify | Telegram-уведомление после AI-анализа |
| `src/components/VideoItem.tsx` | Modify | Кнопка ручной привязки, Badge привязанного объявления |

---

### Task 1: Расширить MtBanner интерфейс и fields

**Files:**
- Modify: `convex/vkApi.ts:148-156` (MtBanner interface)
- Modify: `convex/vkApi.ts:553` (fields parameter)

- [ ] **Step 1: Расширить MtBanner интерфейс**

В `convex/vkApi.ts`, заменить текущий `MtBanner` (строки 148-156):

```typescript
export interface MtBannerContentSlot {
  id: number;
  type?: string; // "static" | "video"
  variants?: Record<string, { media_type: string; url?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface MtBanner {
  id: number;
  campaign_id: number;
  textblocks?: Record<string, { text: string }>;
  content?: Record<string, MtBannerContentSlot>;
  status: string;
  moderation_status: string;
  created: string;
  updated: string;
}
```

- [ ] **Step 2: Добавить `content` в fields запроса**

В `getMtBanners` action (строка 553), заменить:

```typescript
fields: "id,campaign_id,textblocks,status,moderation_status,created,updated",
```

на:

```typescript
fields: "id,campaign_id,textblocks,status,moderation_status,created,updated,content",
```

- [ ] **Step 3: Commit**

```bash
git add convex/vkApi.ts
git commit -m "feat: add content field to MtBanner for video auto-linking

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Авто-привязка видео в videos.ts

**Files:**
- Modify: `convex/videos.ts`

- [ ] **Step 1: Добавить `autoLinkVideos` internalMutation**

В `convex/videos.ts`, после `listLinkedVideos` internalQuery, добавить:

```typescript
// Auto-link videos to ads by matching vkMediaId with banner content.video_id
export const autoLinkVideos = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    bannerVideoMap: v.array(v.object({
      bannerId: v.string(),
      videoMediaId: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    if (args.bannerVideoMap.length === 0) return;

    // Get all videos for this account that don't have vkAdId yet
    const allVideos = await ctx.db
      .query("videos")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();

    const unlinkedVideos = allVideos.filter(
      (v) => !v.vkAdId && v.vkMediaId && v.uploadStatus === "ready"
    );

    if (unlinkedVideos.length === 0) return;

    let linked = 0;
    for (const mapping of args.bannerVideoMap) {
      const video = unlinkedVideos.find(
        (v) => v.vkMediaId === mapping.videoMediaId
      );
      if (video) {
        await ctx.db.patch(video._id, {
          vkAdId: mapping.bannerId,
          updatedAt: Date.now(),
        });
        linked++;
        console.log(
          `[autoLink] Linked video "${video.filename}" → banner ${mapping.bannerId}`
        );
      }
    }

    if (linked > 0) {
      console.log(
        `[autoLink] Account ${args.accountId}: auto-linked ${linked} videos`
      );
    }
  },
});
```

- [ ] **Step 2: Добавить `listAdsByAccount` query для дропдауна**

```typescript
// List all ads for an account (for manual linking dropdown)
export const listAdsByAccount = query({
  args: {
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ads")
      .withIndex("by_accountId_vkAdId", (q) => q.eq("accountId", args.accountId))
      .collect();
    return ads
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((ad) => ({
        _id: ad._id,
        vkAdId: ad.vkAdId,
        name: ad.name,
        status: ad.status,
      }));
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add convex/videos.ts
git commit -m "feat: add autoLinkVideos mutation and listAdsByAccount query

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Вызов авто-линковки в syncMetrics

**Files:**
- Modify: `convex/syncMetrics.ts:56-60`

- [ ] **Step 1: Добавить авто-линковку после bannerCampaignMap**

В `convex/syncMetrics.ts`, после блока `bannerCampaignMap` (строка 60), перед `if (!stats || stats.length === 0)`, добавить:

```typescript
        // Auto-link videos to banners by matching content.video_id with videos.vkMediaId
        try {
          const bannerVideoMap: { bannerId: string; videoMediaId: string }[] = [];
          for (const banner of banners) {
            if (!banner.content) continue;
            for (const slotKey of Object.keys(banner.content)) {
              const slot = banner.content[slotKey];
              // Check if this slot contains a video
              const isVideo =
                slot.type === "video" ||
                (slot.variants &&
                  Object.values(slot.variants).some(
                    (v: any) => v.media_type === "video"
                  ));
              if (isVideo && slot.id) {
                bannerVideoMap.push({
                  bannerId: String(banner.id),
                  videoMediaId: String(slot.id),
                });
                break; // one video per banner is enough
              }
            }
          }

          if (bannerVideoMap.length > 0) {
            await ctx.runMutation(internal.videos.autoLinkVideos, {
              accountId: account._id,
              bannerVideoMap,
            });
          }
        } catch (error) {
          console.error(
            `[syncMetrics] Auto-link error for account ${account._id}:`,
            error instanceof Error ? error.message : error
          );
        }
```

- [ ] **Step 2: Commit**

```bash
git add convex/syncMetrics.ts
git commit -m "feat: auto-link videos to banners during sync via content.video_id

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Telegram-уведомления в creativeAnalytics

**Files:**
- Modify: `convex/creativeAnalytics.ts:327-332`

- [ ] **Step 1: Добавить отправку Telegram после анализа**

В `convex/creativeAnalytics.ts`, заменить блок (строки 327-332):

```typescript
      // Mark video as analyzed (for re-analysis scheduling)
      await ctx.runMutation(internal.creativeAnalytics.markVideoAnalyzed, {
        videoId: args.videoId,
      });

      console.log(`[creativeAnalytics] Video ${video.filename}: score=${analysis.score} (${isReanalysis ? "re-analysis" : "first analysis"})`);
```

на:

```typescript
      // Mark video as analyzed (for re-analysis scheduling)
      await ctx.runMutation(internal.creativeAnalytics.markVideoAnalyzed, {
        videoId: args.videoId,
      });

      console.log(`[creativeAnalytics] Video ${video.filename}: score=${analysis.score} (${isReanalysis ? "re-analysis" : "first analysis"})`);

      // Send Telegram notification
      try {
        const user = await ctx.runQuery(internal.users.getById, { userId: video.userId });
        if (user?.telegramChatId) {
          let shouldNotify = false;
          let prevScore: number | undefined;

          if (!isReanalysis) {
            // First analysis — always notify
            shouldNotify = true;
          } else {
            // Re-analysis — notify only if score changed ≥15 points
            prevScore = latestStat.aiWatchScore ?? undefined;
            if (prevScore !== undefined) {
              shouldNotify = Math.abs(analysis.score - prevScore) >= 15;
            } else {
              shouldNotify = true; // no previous score, treat as first
            }
          }

          if (shouldNotify) {
            const funnel = `100% → ${retention.p3s}% (3с) → ${retention.p25}% (25%) → ${retention.p50}% (50%) → ${retention.p100}% (100%)`;

            let text: string;
            if (!isReanalysis) {
              const recs = (analysis.recommendations || [])
                .slice(0, 3)
                .map((r: any) => `• ${r.issue}`)
                .join("\n");

              text = `📊 <b>Анализ видео «${video.filename}»</b>\n\nОценка удержания: <b>${analysis.score}/100 — ${analysis.scoreLabel}</b>\nВоронка: ${funnel}${recs ? `\n\n⚠️ Рекомендации:\n${recs}` : ""}`;
            } else {
              const diff = analysis.score - (prevScore || 0);
              const sign = diff > 0 ? "+" : "";
              const emoji = diff > 0 ? "📈" : "📉";

              text = `📊 <b>Ре-анализ видео «${video.filename}»</b>\n\nОценка удержания: <b>${analysis.score}/100 — ${analysis.scoreLabel}</b>\n${emoji} Изменение: ${prevScore} → ${analysis.score} (${sign}${diff} за 7 дней)\nВоронка: ${funnel}`;
            }

            await ctx.runAction(internal.telegram.sendMessage, {
              chatId: user.telegramChatId,
              text,
            });
          }
        }
      } catch (tgError) {
        console.error(
          `[creativeAnalytics] Telegram notification error:`,
          tgError instanceof Error ? tgError.message : tgError
        );
      }
```

- [ ] **Step 2: Commit**

```bash
git add convex/creativeAnalytics.ts
git commit -m "feat: send Telegram notification after video watch rate analysis

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: UI — ручная привязка и Badge в VideoItem

**Files:**
- Modify: `src/components/VideoItem.tsx`

- [ ] **Step 1: Добавить `onLinkToAd` в VideoItemProps и `ads` в VideoData**

В `src/components/VideoItem.tsx`, расширить интерфейсы:

В `VideoData` (строка 16-38), добавить после `createdAt`:

```typescript
  vkAdId?: string;
```

В `VideoItemProps` (строка 40-49), добавить после `onAnalyze`:

```typescript
  onLinkToAd: (videoId: string, vkAdId: string) => void;
  ads?: Array<{ _id: string; vkAdId: string; name: string; status: string }>;
```

В деструктуризации пропсов (строка 51-59), добавить:

```typescript
  onLinkToAd,
  ads,
```

- [ ] **Step 2: Добавить импорт Link иконки**

Добавить `Link2` в импорт lucide-react:

```typescript
import {
  ChevronDown,
  ChevronRight,
  Trash2,
  Loader2,
  Sparkles,
  FileText,
  Link2,
} from 'lucide-react';
```

- [ ] **Step 3: Добавить блок привязки в expanded content**

В expanded-секции, перед `{/* Transcription */}` (строка 150), добавить:

```tsx
          {/* Ad linking */}
          {!video.vkAdId ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-primary" />
                <h4 className="font-medium text-sm">Привязка к объявлению</h4>
              </div>
              {ads && ads.length > 0 ? (
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      onLinkToAd(video._id, e.target.value);
                    }
                  }}
                >
                  <option value="" disabled>Выберите объявление...</option>
                  {ads.map((ad) => (
                    <option key={ad._id} value={ad.vkAdId}>
                      {ad.name} ({ad.status})
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Нет объявлений. Видео привяжется автоматически при следующей синхронизации.
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Привязано к объявлению</span>
              <Badge variant="secondary">{video.vkAdId}</Badge>
            </div>
          )}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/VideoItem.tsx
git commit -m "feat: add manual ad linking dropdown and linked badge to VideoItem

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Подключить props в VideosPage

**Files:**
- Modify: `src/pages/VideosPage.tsx`

- [ ] **Step 1: Добавить query для ads и handleLinkToAd**

В `src/pages/VideosPage.tsx`, после `const analyzeVideo = useAction(api.videos.analyzeVideo);` (строка 60), добавить:

```typescript
  const linkToAd = useMutation(api.videos.linkToAd);
  const ads = useQuery(
    api.videos.listAdsByAccount,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );
```

После `handleAnalyze` (строка 212), добавить:

```typescript
  const handleLinkToAd = async (videoId: string, vkAdId: string) => {
    try {
      await linkToAd({ videoId: videoId as Id<"videos">, vkAdId });
      setSuccess('Видео привязано к объявлению');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка привязки');
    }
  };
```

- [ ] **Step 2: Передать новые props в VideoItem**

В `<VideoItem>` (строки 329-339), добавить два пропса:

```tsx
                  <VideoItem
                    key={video._id}
                    video={video}
                    onToggleActive={handleToggleActive}
                    onDelete={handleDelete}
                    onTranscribe={handleTranscribe}
                    onAnalyze={handleAnalyze}
                    onLinkToAd={handleLinkToAd}
                    ads={ads || undefined}
                    deleting={deletingId === video._id}
                    transcribing={transcribingId === video._id}
                    analyzing={analyzingId === video._id}
                  />
```

- [ ] **Step 3: Commit**

```bash
git add src/pages/VideosPage.tsx
git commit -m "feat: wire up ad linking and ads list to VideoItem

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Codegen, typecheck, build, deploy

**Files:**
- All modified files

- [ ] **Step 1: Codegen**

```bash
ADMIN_KEY=$(CONVEX_INSTANCE_SECRET=2de125637ad4cefdbb60e5e350aa0894545bc813a4bc296fcdbd3e3506490e19 node gen_key.cjs) && \
CONVEX_SELF_HOSTED_URL="https://convex.aipilot.by" \
CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
npx convex codegen
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit -p convex/tsconfig.json && npx tsc --noEmit
```
Expected: No new errors

- [ ] **Step 3: Build**

```bash
npm run build
```
Expected: Build success

- [ ] **Step 4: Deploy Convex**

```bash
ADMIN_KEY=$(CONVEX_INSTANCE_SECRET=2de125637ad4cefdbb60e5e350aa0894545bc813a4bc296fcdbd3e3506490e19 node gen_key.cjs) && \
CONVEX_SELF_HOSTED_URL="https://convex.aipilot.by" \
CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
npx convex deploy --yes
```

- [ ] **Step 5: Commit codegen и push**

```bash
git add convex/_generated/api.d.ts
git commit -m "chore: update codegen types for auto-linking and telegram notifications

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git push
```
