# Business Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить профиль бизнеса к рекламным аккаунтам с направлениями, AI-подсказками и интеграцией в промпты генерации.

**Architecture:** Общие поля профиля (companyName, industry, tone, website) добавляются в таблицу `adAccounts`. Направления бизнеса — отдельная таблица `businessDirections` с привязкой к аккаунту. Общий компонент `BusinessProfileEditor` используется на страницах Кабинеты и Настройки. При генерации текстов/изображений/анализе видео бизнес-контекст подставляется в AI-промпты.

**Tech Stack:** Convex, Claude API, DALL-E API, React

---

## Файловая структура

| Файл | Действие | Ответственность |
|------|----------|-----------------|
| `convex/schema.ts` | Modify | Добавить поля в adAccounts, создать таблицу businessDirections |
| `convex/businessDirections.ts` | Create | CRUD для направлений + AI-подсказки (suggest) |
| `convex/adAccounts.ts` | Modify | Мутация updateBusinessProfile |
| `convex/creatives.ts` | Modify | Бизнес-контекст в промпты generateText и generateImage |
| `convex/creativeAnalytics.ts` | Modify | Бизнес-контекст в промпт analyzeWatchRates |
| `src/components/BusinessProfileEditor.tsx` | Create | Общий компонент редактора профиля + направлений |
| `src/components/AccountCard.tsx` | Modify | Добавить секцию BusinessProfileEditor |
| `src/pages/SettingsPage.tsx` | Modify | Новая вкладка "Бизнес" с BusinessProfileEditor |
| `src/pages/CreativesPage.tsx` | Modify | Дропдаун выбора направления |
| `src/pages/VideosPage.tsx` | Modify | Дропдаун выбора направления (для анализа) |

---

### Task 1: Схема — расширить adAccounts и создать businessDirections

**Files:**
- Modify: `convex/schema.ts:43-62`

- [ ] **Step 1: Добавить поля профиля в adAccounts**

В `convex/schema.ts`, в определении таблицы `adAccounts` (строки 43-62), перед `status`, добавить 4 новых optional поля:

```typescript
adAccounts: defineTable({
  userId: v.id("users"),
  vkAccountId: v.string(),
  name: v.string(),
  accessToken: v.string(),
  refreshToken: v.optional(v.string()),
  tokenExpiresAt: v.optional(v.number()),
  clientId: v.optional(v.string()),
  clientSecret: v.optional(v.string()),
  // Business profile
  companyName: v.optional(v.string()),
  industry: v.optional(v.string()),
  tone: v.optional(v.string()),
  website: v.optional(v.string()),
  status: v.union(
    v.literal("active"),
    v.literal("paused"),
    v.literal("error")
  ),
  lastSyncAt: v.optional(v.number()),
  lastError: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_userId", ["userId"])
  .index("by_vkAccountId", ["vkAccountId"]),
```

- [ ] **Step 2: Создать таблицу businessDirections**

После закрытия `adAccounts` (строка 62) и перед `campaigns`, добавить:

```typescript
businessDirections: defineTable({
  accountId: v.id("adAccounts"),
  name: v.string(),
  targetAudience: v.optional(v.string()),
  usp: v.optional(v.string()),
  isActive: v.boolean(),
  createdAt: v.number(),
})
  .index("by_accountId", ["accountId"]),
```

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat: add business profile fields to adAccounts and businessDirections table

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Backend — CRUD для направлений и AI-подсказки

**Files:**
- Create: `convex/businessDirections.ts`

- [ ] **Step 1: Создать файл с CRUD операциями и AI-подсказками**

Создать `convex/businessDirections.ts`:

```typescript
import { v } from "convex/values";
import { query, mutation, action } from "./_generated/server";
import { internal } from "./_generated/api";

// List directions for an account
export const list = query({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("businessDirections")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
});

// Create a new direction
export const create = mutation({
  args: {
    accountId: v.id("adAccounts"),
    name: v.string(),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.name.trim()) throw new Error("Введите название направления");
    return await ctx.db.insert("businessDirections", {
      accountId: args.accountId,
      name: args.name.trim(),
      targetAudience: args.targetAudience,
      usp: args.usp,
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

// Update a direction
export const update = mutation({
  args: {
    id: v.id("businessDirections"),
    name: v.optional(v.string()),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    const filtered: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(updates)) {
      if (val !== undefined) filtered[k] = val;
    }
    await ctx.db.patch(id, filtered);
  },
});

// Delete a direction
export const remove = mutation({
  args: { id: v.id("businessDirections") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

// Get single direction (for AI prompt context)
export const get = query({
  args: { id: v.id("businessDirections") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// AI suggest target audience variants
export const suggestTargetAudience = action({
  args: {
    userId: v.id("users"),
    companyName: v.string(),
    industry: v.string(),
    directionName: v.string(),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY не настроен");

    // Check limits
    const usage = await ctx.runQuery(internal.aiLimits.getUsageInternal, {
      userId: args.userId,
      type: "text",
    });
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const tier = user?.subscriptionTier || "freemium";
    const limits: Record<string, number> = { freemium: 5, start: 50, pro: 200 };
    if (usage >= (limits[tier] || 5)) {
      throw new Error("Лимит генераций исчерпан. Обновите тариф.");
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: `Ты — маркетолог-стратег. На основе информации о бизнесе предложи 5 вариантов целевой аудитории. Каждый вариант — одна строка, максимум 80 символов. Формат: демография + география + интересы. Отвечай ТОЛЬКО JSON-массивом строк, без пояснений.`,
        messages: [{
          role: "user",
          content: `Компания: ${args.companyName}\nНиша: ${args.industry}\nНаправление: ${args.directionName}`,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "[]";

    // Record usage
    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    try {
      return JSON.parse(text) as string[];
    } catch {
      return [text.trim()];
    }
  },
});

// AI suggest USP variants
export const suggestUsp = action({
  args: {
    userId: v.id("users"),
    companyName: v.string(),
    industry: v.string(),
    directionName: v.string(),
    targetAudience: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY не настроен");

    // Check limits
    const usage = await ctx.runQuery(internal.aiLimits.getUsageInternal, {
      userId: args.userId,
      type: "text",
    });
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const tier = user?.subscriptionTier || "freemium";
    const limits: Record<string, number> = { freemium: 5, start: 50, pro: 200 };
    if (usage >= (limits[tier] || 5)) {
      throw new Error("Лимит генераций исчерпан. Обновите тариф.");
    }

    const audienceCtx = args.targetAudience ? `\nЦелевая аудитория: ${args.targetAudience}` : "";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: `Ты — маркетолог-стратег. На основе информации о бизнесе предложи 5 вариантов УТП (уникального торгового предложения). Каждый вариант — одна строка, максимум 80 символов. УТП должно быть конкретным и измеримым. Отвечай ТОЛЬКО JSON-массивом строк, без пояснений.`,
        messages: [{
          role: "user",
          content: `Компания: ${args.companyName}\nНиша: ${args.industry}\nНаправление: ${args.directionName}${audienceCtx}`,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "[]";

    // Record usage
    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    try {
      return JSON.parse(text) as string[];
    } catch {
      return [text.trim()];
    }
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add convex/businessDirections.ts
git commit -m "feat: add businessDirections CRUD and AI suggest actions

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Backend — updateBusinessProfile мутация в adAccounts

**Files:**
- Modify: `convex/adAccounts.ts`

- [ ] **Step 1: Добавить updateBusinessProfile мутацию**

В `convex/adAccounts.ts`, после `updateSyncTime` мутации (строка 813), добавить:

```typescript
// Update business profile fields
export const updateBusinessProfile = mutation({
  args: {
    accountId: v.id("adAccounts"),
    companyName: v.optional(v.string()),
    industry: v.optional(v.string()),
    tone: v.optional(v.string()),
    website: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { accountId, ...updates } = args;
    const filtered: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(updates)) {
      if (val !== undefined) filtered[k] = val;
    }
    if (Object.keys(filtered).length > 0) {
      await ctx.db.patch(accountId, filtered);
    }
  },
});

// Get account with business profile (for AI prompts)
export const getBusinessProfile = query({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    return {
      companyName: account.companyName,
      industry: account.industry,
      tone: account.tone,
      website: account.website,
    };
  },
});
```

Убедиться что `query` импортирован в файле (если нет — добавить в импорт).

- [ ] **Step 2: Commit**

```bash
git add convex/adAccounts.ts
git commit -m "feat: add updateBusinessProfile mutation and getBusinessProfile query

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — компонент BusinessProfileEditor

**Files:**
- Create: `src/components/BusinessProfileEditor.tsx`

- [ ] **Step 1: Создать компонент**

Создать `src/components/BusinessProfileEditor.tsx`:

```tsx
import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import {
  Sparkles,
  Loader2,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Briefcase,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const TONE_OPTIONS = [
  { value: 'friendly', label: 'Дружелюбный' },
  { value: 'professional', label: 'Деловой' },
  { value: 'expert', label: 'Экспертный' },
];

interface BusinessProfileEditorProps {
  accountId: string;
  userId: string;
}

export function BusinessProfileEditor({ accountId, userId }: BusinessProfileEditorProps) {
  const typedAccountId = accountId as Id<"adAccounts">;
  const typedUserId = userId as Id<"users">;

  const profile = useQuery(api.adAccounts.getBusinessProfile, { accountId: typedAccountId });
  const directions = useQuery(api.businessDirections.list, { accountId: typedAccountId });
  const updateProfile = useMutation(api.adAccounts.updateBusinessProfile);
  const createDirection = useMutation(api.businessDirections.create);
  const updateDirection = useMutation(api.businessDirections.update);
  const removeDirection = useMutation(api.businessDirections.remove);
  const suggestTA = useAction(api.businessDirections.suggestTargetAudience);
  const suggestUspAction = useAction(api.businessDirections.suggestUsp);

  // Profile form state
  const [companyName, setCompanyName] = useState('');
  const [industry, setIndustry] = useState('');
  const [tone, setTone] = useState('');
  const [website, setWebsite] = useState('');
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // Direction form state
  const [showAddDirection, setShowAddDirection] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [newDirTA, setNewDirTA] = useState('');
  const [newDirUsp, setNewDirUsp] = useState('');

  // AI suggestions state
  const [suggestingTA, setSuggestingTA] = useState<string | null>(null); // directionId or 'new'
  const [suggestingUsp, setSuggestingUsp] = useState<string | null>(null);
  const [taSuggestions, setTaSuggestions] = useState<string[]>([]);
  const [uspSuggestions, setUspSuggestions] = useState<string[]>([]);
  const [suggestTarget, setSuggestTarget] = useState<string | null>(null); // which field suggestions are for

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load profile data once
  if (profile && !profileLoaded) {
    setCompanyName(profile.companyName || '');
    setIndustry(profile.industry || '');
    setTone(profile.tone || '');
    setWebsite(profile.website || '');
    setProfileLoaded(true);
  }

  const handleSaveProfile = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateProfile({
        accountId: typedAccountId,
        companyName: companyName.trim() || undefined,
        industry: industry.trim() || undefined,
        tone: tone || undefined,
        website: website.trim() || undefined,
      });
      setSuccess('Профиль сохранён');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const handleAddDirection = async () => {
    if (!newDirName.trim()) return;
    setError(null);
    try {
      await createDirection({
        accountId: typedAccountId,
        name: newDirName.trim(),
        targetAudience: newDirTA.trim() || undefined,
        usp: newDirUsp.trim() || undefined,
      });
      setNewDirName('');
      setNewDirTA('');
      setNewDirUsp('');
      setShowAddDirection(false);
      setSuccess('Направление добавлено');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
  };

  const handleDeleteDirection = async (id: string) => {
    try {
      await removeDirection({ id: id as Id<"businessDirections"> });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    }
  };

  const handleSuggestTA = async (dirId: string, dirName: string) => {
    if (!companyName.trim() || !industry.trim()) {
      setError('Заполните название компании и нишу для AI-подсказок');
      return;
    }
    setSuggestingTA(dirId);
    setSuggestTarget(dirId);
    setTaSuggestions([]);
    try {
      const suggestions = await suggestTA({
        userId: typedUserId,
        companyName: companyName.trim(),
        industry: industry.trim(),
        directionName: dirName,
      });
      setTaSuggestions(suggestions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации');
    } finally {
      setSuggestingTA(null);
    }
  };

  const handleSuggestUsp = async (dirId: string, dirName: string, ta?: string) => {
    if (!companyName.trim() || !industry.trim()) {
      setError('Заполните название компании и нишу для AI-подсказок');
      return;
    }
    setSuggestingUsp(dirId);
    setSuggestTarget(dirId);
    setUspSuggestions([]);
    try {
      const suggestions = await suggestUspAction({
        userId: typedUserId,
        companyName: companyName.trim(),
        industry: industry.trim(),
        directionName: dirName,
        targetAudience: ta,
      });
      setUspSuggestions(suggestions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации');
    } finally {
      setSuggestingUsp(null);
    }
  };

  const handleSelectTASuggestion = async (dirId: string, value: string) => {
    if (dirId === 'new') {
      setNewDirTA(value);
    } else {
      await updateDirection({ id: dirId as Id<"businessDirections">, targetAudience: value });
    }
    setTaSuggestions([]);
    setSuggestTarget(null);
  };

  const handleSelectUspSuggestion = async (dirId: string, value: string) => {
    if (dirId === 'new') {
      setNewDirUsp(value);
    } else {
      await updateDirection({ id: dirId as Id<"businessDirections">, usp: value });
    }
    setUspSuggestions([]);
    setSuggestTarget(null);
  };

  return (
    <div className="space-y-4">
      {/* Messages */}
      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}
      {success && (
        <div className="p-3 rounded-lg bg-green-500/10 text-green-700 dark:text-green-400 text-sm">{success}</div>
      )}

      {/* Profile fields */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-primary" />
            Профиль бизнеса
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Название компании</Label>
            <input
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Например: ФудМастер"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </div>
          <div>
            <Label>Ниша / отрасль</Label>
            <input
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Например: Общепит и доставка"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            />
          </div>
          <div>
            <Label>Тон коммуникации</Label>
            <select
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
            >
              <option value="">Не выбран</option>
              {TONE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Сайт</Label>
            <input
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="https://example.com"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>
          <Button onClick={handleSaveProfile} disabled={saving} size="sm">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Сохранить профиль
          </Button>
        </CardContent>
      </Card>

      {/* Directions */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Направления бизнеса</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddDirection(!showAddDirection)}
            >
              <Plus className="h-4 w-4 mr-1" />
              Добавить
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Add direction form */}
          {showAddDirection && (
            <div className="rounded-lg border border-border p-4 space-y-3">
              <div>
                <Label>Название направления</Label>
                <input
                  className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  placeholder="Например: Доставка еды"
                  value={newDirName}
                  onChange={(e) => setNewDirName(e.target.value)}
                />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <Label>Целевая аудитория</Label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => handleSuggestTA('new', newDirName)}
                    disabled={!newDirName.trim() || suggestingTA !== null}
                  >
                    {suggestingTA === 'new' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                <input
                  className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  placeholder="Например: Офисные работники 25-45, Москва"
                  value={newDirTA}
                  onChange={(e) => setNewDirTA(e.target.value)}
                />
                {suggestTarget === 'new' && taSuggestions.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {taSuggestions.map((s, i) => (
                      <button
                        key={i}
                        className="w-full text-left text-sm px-3 py-1.5 rounded-md hover:bg-muted transition-colors"
                        onClick={() => handleSelectTASuggestion('new', s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <Label>УТП</Label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => handleSuggestUsp('new', newDirName, newDirTA)}
                    disabled={!newDirName.trim() || suggestingUsp !== null}
                  >
                    {suggestingUsp === 'new' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                <input
                  className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  placeholder="Например: Доставка за 30 минут или бесплатно"
                  value={newDirUsp}
                  onChange={(e) => setNewDirUsp(e.target.value)}
                />
                {suggestTarget === 'new' && uspSuggestions.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {uspSuggestions.map((s, i) => (
                      <button
                        key={i}
                        className="w-full text-left text-sm px-3 py-1.5 rounded-md hover:bg-muted transition-colors"
                        onClick={() => handleSelectUspSuggestion('new', s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddDirection} disabled={!newDirName.trim()}>
                  Сохранить
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowAddDirection(false)}>
                  Отмена
                </Button>
              </div>
            </div>
          )}

          {/* Existing directions */}
          {directions && directions.length > 0 ? (
            directions.map((dir) => (
              <DirectionItem
                key={dir._id}
                direction={dir}
                onDelete={handleDeleteDirection}
                onSuggestTA={handleSuggestTA}
                onSuggestUsp={handleSuggestUsp}
                suggestingTA={suggestingTA}
                suggestingUsp={suggestingUsp}
                suggestTarget={suggestTarget}
                taSuggestions={taSuggestions}
                uspSuggestions={uspSuggestions}
                onSelectTA={handleSelectTASuggestion}
                onSelectUsp={handleSelectUspSuggestion}
                onUpdate={updateDirection}
              />
            ))
          ) : !showAddDirection ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Нет направлений. Добавьте первое направление бизнеса.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// Direction item with inline editing
function DirectionItem({
  direction,
  onDelete,
  onSuggestTA,
  onSuggestUsp,
  suggestingTA,
  suggestingUsp,
  suggestTarget,
  taSuggestions,
  uspSuggestions,
  onSelectTA,
  onSelectUsp,
  onUpdate,
}: {
  direction: { _id: string; name: string; targetAudience?: string; usp?: string; isActive: boolean };
  onDelete: (id: string) => void;
  onSuggestTA: (dirId: string, name: string) => void;
  onSuggestUsp: (dirId: string, name: string, ta?: string) => void;
  suggestingTA: string | null;
  suggestingUsp: string | null;
  suggestTarget: string | null;
  taSuggestions: string[];
  uspSuggestions: string[];
  onSelectTA: (dirId: string, value: string) => void;
  onSelectUsp: (dirId: string, value: string) => void;
  onUpdate: (args: { id: Id<"businessDirections">; [key: string]: unknown }) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <button
          className="flex items-center gap-2 text-sm font-medium"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {direction.name}
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(direction._id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {!expanded && (direction.targetAudience || direction.usp) && (
        <div className="mt-1 text-xs text-muted-foreground truncate pl-6">
          {direction.targetAudience && `ЦА: ${direction.targetAudience}`}
          {direction.targetAudience && direction.usp && ' · '}
          {direction.usp && `УТП: ${direction.usp}`}
        </div>
      )}

      {expanded && (
        <div className="mt-3 pl-6 space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <Label className="text-xs">Целевая аудитория</Label>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => onSuggestTA(direction._id, direction.name)}
                disabled={suggestingTA !== null}
              >
                {suggestingTA === direction._id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
              </Button>
            </div>
            <input
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={direction.targetAudience || ''}
              onChange={(e) => onUpdate({ id: direction._id as Id<"businessDirections">, targetAudience: e.target.value })}
              placeholder="Целевая аудитория"
            />
            {suggestTarget === direction._id && taSuggestions.length > 0 && (
              <div className="mt-2 space-y-1">
                {taSuggestions.map((s, i) => (
                  <button
                    key={i}
                    className="w-full text-left text-xs px-3 py-1.5 rounded-md hover:bg-muted transition-colors"
                    onClick={() => onSelectTA(direction._id, s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Label className="text-xs">УТП</Label>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => onSuggestUsp(direction._id, direction.name, direction.targetAudience)}
                disabled={suggestingUsp !== null}
              >
                {suggestingUsp === direction._id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
              </Button>
            </div>
            <input
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={direction.usp || ''}
              onChange={(e) => onUpdate({ id: direction._id as Id<"businessDirections">, usp: e.target.value })}
              placeholder="Уникальное торговое предложение"
            />
            {suggestTarget === direction._id && uspSuggestions.length > 0 && (
              <div className="mt-2 space-y-1">
                {uspSuggestions.map((s, i) => (
                  <button
                    key={i}
                    className="w-full text-left text-xs px-3 py-1.5 rounded-md hover:bg-muted transition-colors"
                    onClick={() => onSelectUsp(direction._id, s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/BusinessProfileEditor.tsx
git commit -m "feat: add BusinessProfileEditor component with directions and AI suggestions

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Интегрировать BusinessProfileEditor в AccountCard и SettingsPage

**Files:**
- Modify: `src/components/AccountCard.tsx`
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Добавить в AccountCard**

В `src/components/AccountCard.tsx`, добавить импорт:

```typescript
import { BusinessProfileEditor } from './BusinessProfileEditor';
```

Расширить интерфейс `AccountCardProps.account`, добавив `userId`:

```typescript
interface AccountCardProps {
  account: {
    _id: string;
    vkAccountId: string;
    name: string;
    status: 'active' | 'paused' | 'error';
    lastSyncAt?: number;
    lastError?: string;
  };
  userId: string;
  onSync: (accountId: string) => Promise<void>;
  onDisconnect: (accountId: string) => void;
}
```

Обновить деструктуризацию:

```typescript
export const AccountCard = memo(function AccountCard({ account, userId, onSync, onDisconnect }: AccountCardProps) {
```

Добавить состояние для профиля (после `showCampaigns`):

```typescript
const [showProfile, setShowProfile] = useState(false);
```

После блока campaigns toggle (строка 117, перед `</CardContent>`), добавить новую секцию:

```tsx
        {/* Business profile toggle */}
        <div className="mt-3 pt-3 border-t">
          <button
            type="button"
            onClick={() => setShowProfile(!showProfile)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            data-testid="toggle-profile"
          >
            {showProfile ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            Профиль бизнеса
          </button>
          {showProfile && (
            <div className="mt-3">
              <BusinessProfileEditor accountId={account._id} userId={userId} />
            </div>
          )}
        </div>
```

- [ ] **Step 2: Обновить AccountList и AccountsPage для передачи userId**

В `src/components/AccountList.tsx`, добавить `userId` в интерфейс и передать в AccountCard:

```typescript
interface AccountListProps {
  accounts: Account[];
  userId: string;
  onSync: (accountId: string) => Promise<void>;
  onDisconnect: (accountId: string) => void;
}

export function AccountList({ accounts, userId, onSync, onDisconnect }: AccountListProps) {
```

В рендере AccountCard добавить `userId`:

```tsx
<AccountCard
  key={account._id}
  account={account}
  userId={userId}
  onSync={onSync}
  onDisconnect={onDisconnect}
/>
```

В `src/pages/AccountsPage.tsx`, найти `<AccountList` и добавить `userId` проп:

```tsx
<AccountList
  accounts={accounts.map((a) => ({...}))}
  userId={user.userId}
  onSync={handleSync}
  onDisconnect={handleDisconnect}
/>
```

- [ ] **Step 3: Добавить вкладку "Бизнес" в SettingsPage**

В `src/pages/SettingsPage.tsx`:

Добавить импорт:

```typescript
import { BusinessProfileEditor } from '@/components/BusinessProfileEditor';
```

Расширить тип `activeTab` (строка 33 примерно):

```typescript
const [activeTab, setActiveTab] = useState<'profile' | 'telegram' | 'api' | 'business'>('profile');
```

Добавить кнопку вкладки после "API" (строка 108):

```tsx
          <button
            data-testid="tab-business"
            onClick={() => setActiveTab('business')}
            className={cn(
              'pb-3 px-1 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'business'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Бизнес
          </button>
```

Добавить рендер вкладки в tab content (строка 114-120), заменить:

```tsx
      {activeTab === 'profile' ? (
        <ProfileTab user={user} />
      ) : activeTab === 'telegram' ? (
        <TelegramTab userId={user.userId as Id<'users'>} />
      ) : activeTab === 'api' ? (
        <ApiTab userId={user.userId as Id<'users'>} />
      ) : (
        <BusinessTab userId={user.userId} />
      )}
```

Добавить компонент BusinessTab в конец файла:

```tsx
function BusinessTab({ userId }: { userId: string }) {
  const settings = useQuery(
    api.userSettings.get,
    userId ? { userId: userId as Id<"users"> } : 'skip'
  );
  const accountId = settings?.activeAccountId;

  if (!accountId) {
    return (
      <div className="text-center py-12">
        <Briefcase className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-lg font-medium mb-2">Выберите аккаунт</h3>
        <p className="text-muted-foreground">
          Выберите активный аккаунт на вкладке Профиль
        </p>
      </div>
    );
  }

  return <BusinessProfileEditor accountId={accountId} userId={userId} />;
}
```

Добавить импорт `Briefcase` в lucide-react и `useQuery` / `api` / `Id` если не импортированы.

- [ ] **Step 4: Commit**

```bash
git add src/components/AccountCard.tsx src/components/AccountList.tsx src/pages/AccountsPage.tsx src/pages/SettingsPage.tsx
git commit -m "feat: integrate BusinessProfileEditor into AccountCard and SettingsPage

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Дропдаун выбора направления в CreativesPage

**Files:**
- Modify: `src/pages/CreativesPage.tsx`

- [ ] **Step 1: Добавить query направлений и state**

В `src/pages/CreativesPage.tsx`, после запроса `accounts` (добавленного ранее), добавить:

```typescript
  const directions = useQuery(
    api.businessDirections.list,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );
  const profile = useQuery(
    api.adAccounts.getBusinessProfile,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );

  const [selectedDirectionId, setSelectedDirectionId] = useState<string | ''>('');
```

Добавить авто-выбор единственного направления (после state):

```typescript
  // Auto-select if only one direction
  const activeDirections = directions?.filter((d) => d.isActive) || [];
  if (activeDirections.length === 1 && !selectedDirectionId) {
    setSelectedDirectionId(activeDirections[0]._id);
  }
  const selectedDirection = activeDirections.find((d) => d._id === selectedDirectionId);
```

- [ ] **Step 2: Добавить UI дропдауна перед кнопкой генерации**

Найти кнопку генерации (блок `<div className="mt-6">` с `generate-creative-btn`). Перед ней вставить:

```tsx
          {/* Direction selector */}
          {activeDirections.length > 0 && (
            <div className="mt-4">
              <Label>Направление бизнеса</Label>
              <div className="flex gap-2 mt-1">
                <select
                  className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={selectedDirectionId}
                  onChange={(e) => setSelectedDirectionId(e.target.value)}
                >
                  <option value="">Выберите направление...</option>
                  {activeDirections.map((dir) => (
                    <option key={dir._id} value={dir._id}>{dir.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
```

Добавить импорт `Label`:

```typescript
import { Label } from '@/components/ui/label';
```

- [ ] **Step 3: Передать бизнес-контекст в генерацию текста**

Обновить `handleGenerateField` — в вычислении `context` (строка ~83) добавить бизнес-контекст:

Заменить:

```typescript
      const context = Object.entries(values)
        .filter(([k, v]) => k !== field && v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
```

на:

```typescript
      const fieldContext = Object.entries(values)
        .filter(([k, v]) => k !== field && v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');

      const bizParts: string[] = [];
      if (profile?.companyName) bizParts.push(`Компания: ${profile.companyName}`);
      if (profile?.industry) bizParts.push(`Ниша: ${profile.industry}`);
      if (profile?.tone) bizParts.push(`Тон: ${profile.tone}`);
      if (selectedDirection?.name) bizParts.push(`Направление: ${selectedDirection.name}`);
      if (selectedDirection?.targetAudience) bizParts.push(`ЦА: ${selectedDirection.targetAudience}`);
      if (selectedDirection?.usp) bizParts.push(`УТП: ${selectedDirection.usp}`);

      const context = [fieldContext, ...bizParts].filter(Boolean).join('; ') || undefined;
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/CreativesPage.tsx
git commit -m "feat: add direction selector and business context to creative generation

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Бизнес-контекст в промптах generateImage и analyzeWatchRates

**Files:**
- Modify: `convex/creatives.ts:209-245`
- Modify: `convex/creativeAnalytics.ts:224-251`

- [ ] **Step 1: Расширить generateImage args и промпт**

В `convex/creatives.ts`, в `generateImage` action (строка 209), добавить optional args:

```typescript
export const generateImage = action({
  args: {
    creativeId: v.id("creatives"),
    userId: v.id("users"),
    offer: v.string(),
    bullets: v.string(),
    benefit: v.string(),
    cta: v.string(),
    businessContext: v.optional(v.string()),
  },
```

Обновить промпт DALL-E (строки 238-245), заменить на:

```typescript
      const bizCtx = args.businessContext ? `\nBrand context: ${args.businessContext}` : "";
      const prompt = `Create a professional advertising banner for VK Ads (Russian social media). The banner should be modern, clean, and visually appealing with bold text overlay.

Main offer: ${args.offer}
Key benefits: ${args.bullets}
Value proposition: ${args.benefit}
Call to action: ${args.cta}${bizCtx}

Style: Professional marketing banner, bright colors, clean typography, Russian text. Size 1080x1080.`;
```

- [ ] **Step 2: Передать businessContext из CreativesPage**

В `src/pages/CreativesPage.tsx`, обновить `handleGenerateImage` — найти вызов `generateImage` и добавить `businessContext`:

Перед вызовом `generateImage`, собрать контекст:

```typescript
      const bizParts: string[] = [];
      if (profile?.companyName) bizParts.push(profile.companyName);
      if (profile?.industry) bizParts.push(profile.industry);
      if (selectedDirection?.name) bizParts.push(selectedDirection.name);
      const businessContext = bizParts.length > 0 ? bizParts.join(', ') : undefined;
```

Добавить в вызов:

```typescript
      await generateImage({
        creativeId,
        userId: user.userId as Id<"users">,
        offer: values.offer,
        bullets: values.bullets,
        benefit: values.benefit,
        cta: values.cta,
        businessContext,
      });
```

- [ ] **Step 3: Добавить бизнес-контекст в analyzeWatchRates**

В `convex/creativeAnalytics.ts`, в `analyzeWatchRates` action, найти построение `systemPrompt` (строка 224). После строки `- Глубина просмотра <30% = видео не соответствует аудитории` (строка 251), перед закрывающей обратной кавычкой, добавить:

```typescript
    // Add business context if available
    let businessCtx = "";
    try {
      const account = await ctx.runQuery(internal.adAccounts.getInternal, { accountId: video.accountId });
      if (account?.companyName || account?.industry) {
        const parts: string[] = [];
        if (account.companyName) parts.push(`Компания: ${account.companyName}`);
        if (account.industry) parts.push(`Ниша: ${account.industry}`);

        // Get direction linked to this video if available
        const allDirections = await ctx.runQuery(internal.businessDirections.listInternal, { accountId: video.accountId });
        if (allDirections.length > 0) {
          const dir = allDirections[0]; // Use first active direction for now
          if (dir.name) parts.push(`Направление: ${dir.name}`);
          if (dir.targetAudience) parts.push(`ЦА: ${dir.targetAudience}`);
        }

        businessCtx = `\n\nКонтекст бизнеса: ${parts.join(", ")}`;
      }
    } catch {
      // Ignore — business context is optional
    }
```

Добавить `businessCtx` в конец systemPrompt:

Заменить конец system prompt (строка перед `const userMessage`):

```typescript
- Глубина просмотра <30% = видео не соответствует аудитории`;
```

на:

```typescript
- Глубина просмотра <30% = видео не соответствует аудитории` + businessCtx;
```

- [ ] **Step 4: Добавить internal queries**

В `convex/adAccounts.ts`, добавить internal query:

```typescript
import { internalQuery } from "./_generated/server";

export const getInternal = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.accountId);
  },
});
```

В `convex/businessDirections.ts`, добавить internal query:

```typescript
import { internalQuery } from "./_generated/server";

export const listInternal = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("businessDirections")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    return all.filter((d) => d.isActive);
  },
});
```

- [ ] **Step 5: Commit**

```bash
git add convex/creatives.ts convex/creativeAnalytics.ts convex/adAccounts.ts convex/businessDirections.ts src/pages/CreativesPage.tsx
git commit -m "feat: integrate business context into AI prompts for text, image, and video analysis

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Codegen, typecheck, build, deploy

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
Expected: No new errors (existing TS6133 warnings are pre-existing)

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

- [ ] **Step 5: Commit and push**

```bash
git add -A && git status
git commit -m "chore: codegen and build for business profile feature

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git push
```
