# Админ инициирует переписку с пользователем — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Админ может первым написать любому зарегистрированному пользователю — сообщение появится in-app на странице `/support`.

**Architecture:** Добавляем мутацию `startThreadToUser` (создаёт root-сообщение с `direction: "admin_to_user"`). Обновляем `listFeedback` чтобы показывать и admin-initiated треды. Добавляем UI-форму в `FeedbackListSection` с выбором пользователя.

**Tech Stack:** Convex mutation, React (shadcn/ui components)

---

## Анализ текущего состояния

**Проблема:** Сейчас тред всегда начинает пользователь (`sendFeedback` → `direction: "user_to_admin"`). Админ может только отвечать (`replyToFeedback`). `listFeedback` ищет только root-сообщения с `direction: "user_to_admin"` — admin-initiated треды не появятся.

**Что нужно изменить:**

| Файл | Что |
|---|---|
| `convex/userNotifications.ts` | +мутация `startThreadToUser`, правка `listFeedback` |
| `src/pages/admin/sections/FeedbackListSection.tsx` | +форма «Написать пользователю» с выбором из списка |
| `src/components/Layout.tsx` | Перенести бейдж adminUnread с `/support` на `/admin` |

**Что уже работает и не трогаем:**
- `getUserThreads` — группирует по root-сообщениям без фильтра по direction, покажет admin-initiated треды
- `getThread` — показывает все сообщения треда по threadId, direction-agnostic
- `SupportPage.tsx` — отображает треды пользователя, работает с любым direction
- Схема БД — поля `direction`, `threadId` уже поддерживают оба направления

---

### Task 1: Мутация `startThreadToUser`

**Files:**
- Modify: `convex/userNotifications.ts` (после `replyToFeedback`, ~строка 151)

- [ ] **Step 1: Добавить мутацию `startThreadToUser`**

В `convex/userNotifications.ts` после `replyToFeedback` (строка 151) добавить:

```typescript
// Admin initiates a new support thread to a user
export const startThreadToUser = mutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.message.trim()) throw new Error("Введите сообщение");

    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("Пользователь не найден");

    await ctx.db.insert("userNotifications", {
      userId: args.userId,
      title: args.title.trim() || "Сообщение от поддержки",
      message: args.message.trim(),
      type: "feedback",
      direction: "admin_to_user",
      isRead: false,
      createdAt: Date.now(),
    });

    return { success: true };
  },
});
```

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: без ошибок

- [ ] **Step 3: Commit**

```bash
git add convex/userNotifications.ts
git commit -m "feat(support): add startThreadToUser mutation for admin-initiated threads"
```

---

### Task 2: Обновить `listFeedback` — показывать admin-initiated треды

**Files:**
- Modify: `convex/userNotifications.ts` — функция `listFeedback` (строки 230-276)

- [ ] **Step 1: Изменить `listFeedback` чтобы включать admin-initiated root-сообщения**

Текущий код ищет только `direction: "user_to_admin"`. Нужно искать все feedback root-сообщения (без `threadId`):

Заменить текущую `listFeedback` (строки 230-276) на:

```typescript
// Get all feedback threads (for admin panel) — includes both user-initiated and admin-initiated
export const listFeedback = query({
  args: {},
  handler: async (ctx) => {
    // Get ALL feedback messages (both directions)
    const allFeedback = await ctx.db
      .query("userNotifications")
      .collect();

    // Root messages only: type=feedback, no threadId
    const rootMessages = allFeedback.filter(
      (m) => m.type === "feedback" && !m.threadId
    );

    const result = await Promise.all(
      rootMessages.map(async (f) => {
        const user = await ctx.db.get(f.userId);

        // Count replies in thread
        const replies = await ctx.db
          .query("userNotifications")
          .withIndex("by_threadId", (q) => q.eq("threadId", f._id))
          .collect();

        const allInThread = [f, ...replies];
        const lastMessage = allInThread.sort(
          (a, b) => b.createdAt - a.createdAt
        )[0];
        const unreadFromUser = allInThread.filter(
          (m) => !m.isRead && m.direction === "user_to_admin"
        ).length;

        return {
          ...f,
          userName: user?.name || user?.email || "—",
          userEmail: user?.email || "—",
          replyCount: replies.length,
          lastMessageAt: lastMessage.createdAt,
          lastDirection: lastMessage.direction,
          unreadFromUser,
        };
      })
    );

    return result.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  },
});
```

**Ключевое изменение:** убираем `.withIndex("by_direction", ...)` и фильтруем root-сообщения по `type === "feedback" && !threadId` вместо `direction === "user_to_admin"`.

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: без ошибок

- [ ] **Step 3: Commit**

```bash
git add convex/userNotifications.ts
git commit -m "fix(support): listFeedback shows both user-initiated and admin-initiated threads"
```

---

### Task 3: UI — форма «Написать пользователю» в админке

**Files:**
- Modify: `src/pages/admin/sections/FeedbackListSection.tsx`

- [ ] **Step 1: Добавить форму отправки нового сообщения пользователю**

В начало компонента `FeedbackListSection` добавить state и UI для создания нового треда. Полная замена компонента:

```tsx
import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Loader2, Send, Plus, X } from 'lucide-react';
import { Id } from '../../../../convex/_generated/dataModel';
import { useAuth } from '../../../lib/useAuth';

export function FeedbackListSection() {
  const { user } = useAuth();
  const feedback = useQuery(api.userNotifications.listFeedback, {});
  const users = useQuery(
    api.admin.listUsers,
    user?.sessionToken ? { sessionToken: user.sessionToken } : 'skip'
  );
  const replyToFeedback = useMutation(api.userNotifications.replyToFeedback);
  const markRead = useMutation(api.userNotifications.markRead);
  const startThread = useMutation(api.userNotifications.startThreadToUser);

  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);

  // New thread form state
  const [showNewForm, setShowNewForm] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newMessage, setNewMessage] = useState('');
  const [newSending, setNewSending] = useState(false);
  const [userSearch, setUserSearch] = useState('');

  const totalUnread = feedback?.reduce((sum, f) => sum + f.unreadFromUser, 0) ?? 0;

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const handleReply = async (rootMessageId: string) => {
    if (!replyText.trim()) return;
    setReplySending(true);
    try {
      await replyToFeedback({
        rootMessageId: rootMessageId as Id<'userNotifications'>,
        message: replyText.trim(),
      });
      setReplyText('');
      setReplyingTo(null);
    } catch (err) {
      console.error('Reply failed:', err);
    } finally {
      setReplySending(false);
    }
  };

  const handleStartThread = async () => {
    if (!newUserId || !newMessage.trim()) return;
    setNewSending(true);
    try {
      await startThread({
        userId: newUserId as Id<'users'>,
        title: newTitle.trim(),
        message: newMessage.trim(),
      });
      setShowNewForm(false);
      setNewUserId('');
      setNewTitle('');
      setNewMessage('');
      setUserSearch('');
    } catch (err) {
      console.error('Start thread failed:', err);
    } finally {
      setNewSending(false);
    }
  };

  // Filter users for search
  const filteredUsers = users?.filter((u) => {
    if (!userSearch.trim()) return true;
    const q = userSearch.toLowerCase();
    return (
      (u.name?.toLowerCase().includes(q)) ||
      (u.email?.toLowerCase().includes(q))
    );
  }) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {totalUnread > 0 && (
          <Badge variant="destructive">{totalUnread} непрочитанных</Badge>
        )}
        <Button
          variant={showNewForm ? 'secondary' : 'outline'}
          size="sm"
          className="gap-1.5"
          onClick={() => setShowNewForm(!showNewForm)}
        >
          {showNewForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showNewForm ? 'Отмена' : 'Написать пользователю'}
        </Button>
      </div>

      {/* New thread form */}
      {showNewForm && (
        <div className="p-4 rounded-lg border border-primary/30 bg-primary/5 space-y-3">
          <p className="text-sm font-medium">Новое сообщение пользователю</p>

          {/* User picker */}
          <div className="space-y-1">
            <input
              type="text"
              placeholder="Поиск пользователя по имени или email..."
              value={newUserId ? (users?.find(u => u._id === newUserId)?.name || users?.find(u => u._id === newUserId)?.email || '') : userSearch}
              onChange={(e) => {
                setUserSearch(e.target.value);
                setNewUserId('');
              }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {userSearch.trim() && !newUserId && filteredUsers.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-background">
                {filteredUsers.slice(0, 10).map((u) => (
                  <button
                    key={u._id}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                    onClick={() => {
                      setNewUserId(u._id);
                      setUserSearch('');
                    }}
                  >
                    <span className="font-medium">{u.name || '—'}</span>
                    <span className="text-muted-foreground ml-2">{u.email}</span>
                  </button>
                ))}
              </div>
            )}
            {userSearch.trim() && !newUserId && filteredUsers.length === 0 && (
              <p className="text-xs text-muted-foreground px-1">Не найдено</p>
            )}
          </div>

          <input
            type="text"
            placeholder="Тема (необязательно)"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <textarea
            placeholder="Сообщение..."
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            className="w-full min-h-[80px] p-3 rounded-lg border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button
            size="sm"
            onClick={handleStartThread}
            disabled={newSending || !newUserId || !newMessage.trim()}
            className="gap-1.5"
          >
            {newSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Отправить
          </Button>
        </div>
      )}

      {!feedback ? (
        <div className="flex justify-center py-4">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : feedback.length === 0 ? (
        <p className="text-center text-muted-foreground py-4">Сообщений пока нет</p>
      ) : (
        <div className="space-y-3">
          {feedback.map((f) => (
            <div key={f._id}>
              {/* Thread header */}
              <div
                className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  f.unreadFromUser > 0
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-border bg-muted/30 hover:bg-muted/50'
                }`}
                onClick={() => setOpenThreadId(openThreadId === f._id ? null : f._id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium">{f.userName}</span>
                      <span className="text-xs text-muted-foreground">{f.userEmail}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(f.lastMessageAt)}</span>
                      {f.replyCount > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          {f.replyCount + 1} сообщ.
                        </Badge>
                      )}
                      {f.unreadFromUser > 0 && (
                        <Badge variant="destructive" className="text-xs">
                          {f.unreadFromUser} новых
                        </Badge>
                      )}
                      {f.direction === 'admin_to_user' && !f.threadId && (
                        <Badge variant="outline" className="text-xs">от поддержки</Badge>
                      )}
                    </div>
                    {f.title && f.title !== 'Обратная связь' && f.title !== 'Сообщение от поддержки' && (
                      <p className="text-sm font-medium mb-1">{f.title}</p>
                    )}
                    <p className="text-sm text-muted-foreground line-clamp-2">{f.message}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setReplyingTo(replyingTo === f._id ? null : f._id);
                        setOpenThreadId(f._id);
                      }}
                    >
                      Ответить
                    </Button>
                    {f.unreadFromUser > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          markRead({ notificationId: f._id as Id<'userNotifications'> });
                        }}
                      >
                        Прочитано
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Thread messages */}
              {openThreadId === f._id && (
                <FeedbackThread
                  threadId={f._id as Id<'userNotifications'>}
                  replyingTo={replyingTo}
                  replyText={replyText}
                  replySending={replySending}
                  onReplyTextChange={setReplyText}
                  onReply={() => handleReply(f._id)}
                  onStartReply={() => setReplyingTo(f._id)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Компонент `FeedbackThread` (строки 146-237) остаётся без изменений.

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 3: Проверить lint**

Run: `npm run lint`
Expected: без новых ошибок

- [ ] **Step 4: Проверить визуально в браузере**

1. Открыть `/admin` → Инструменты → Обратная связь
2. Должна появиться кнопка «Написать пользователю»
3. Нажать → появляется форма с поиском пользователя, темой, сообщением
4. Выбрать пользователя, написать сообщение, отправить
5. Тред должен появиться в списке с бейджем «от поддержки»
6. У пользователя на `/support` должен появиться новый тред

- [ ] **Step 5: Commit**

```bash
git add src/pages/admin/sections/FeedbackListSection.tsx
git commit -m "feat(support): admin can initiate support threads to any user"
```

---

### Task 4: Перенести бейдж непрочитанных обращений на «Админ»

**Files:**
- Modify: `src/components/Layout.tsx` (строки 90-92, 182-184)

**Проблема:** Сейчас для админа бейдж `adminUnread` (непрочитанные обращения от пользователей) показывается на пункте «Поддержка» (`/support`). Но админ отвечает на обращения в `/admin` → Инструменты → Обратная связь. Нужно:
- Бейдж `adminUnread` → показывать на `/admin`
- Бейдж `supportUnread` → показывать на `/support` для всех (включая админа — его собственные непрочитанные ответы от поддержки)

- [ ] **Step 1: Исправить логику бейджей в desktop sidebar**

В `src/components/Layout.tsx`, строки 90-92, заменить:

```tsx
const badge = item.href === '/support'
  ? (isAdmin ? adminUnread : supportUnread)
  : 0;
```

на:

```tsx
const badge =
  item.href === '/support' ? supportUnread
  : item.href === '/admin' ? adminUnread
  : 0;
```

- [ ] **Step 2: Исправить логику бейджей в mobile bottom nav**

В `src/components/Layout.tsx`, строки 182-184, заменить аналогично:

```tsx
const badge = item.href === '/support'
  ? (isAdmin ? adminUnread : supportUnread)
  : 0;
```

на:

```tsx
const badge =
  item.href === '/support' ? supportUnread
  : item.href === '/admin' ? adminUnread
  : 0;
```

- [ ] **Step 3: Проверить typecheck**

Run: `npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 4: Проверить визуально**

1. Как админ: бейдж непрочитанных обращений на «Админ», не на «Поддержка»
2. Как пользователь: бейдж ответов от поддержки на «Поддержка»

- [ ] **Step 5: Commit**

```bash
git add src/components/Layout.tsx
git commit -m "fix(layout): move admin unread badge from /support to /admin"
```

---

### Task 5: Статус «прочитано» для admin→user сообщений в админке

**Files:**
- Modify: `src/pages/admin/sections/FeedbackListSection.tsx` — компонент `FeedbackThread`

**Суть:** Когда пользователь открывает `/support`, вызывается `markAllRead` → `isRead` становится `true` для admin→user сообщений. Данные уже есть в `getThread` (каждое сообщение имеет `isRead`). Нужно только показать статус в UI админки рядом с каждым admin→user сообщением.

- [ ] **Step 1: Добавить индикатор «прочитано» к admin→user сообщениям в FeedbackThread**

В компоненте `FeedbackThread` (в `FeedbackListSection.tsx`), в блоке рендера сообщений, добавить иконку-галочку для admin→user сообщений. Найти строку:

```tsx
<span className="text-xs text-muted-foreground">{formatTime(msg.createdAt)}</span>
```

внутри `FeedbackThread` и заменить на:

```tsx
<span className="text-xs text-muted-foreground">{formatTime(msg.createdAt)}</span>
{msg.direction === 'admin_to_user' && (
  <span className={`text-xs ${msg.isRead ? 'text-primary' : 'text-muted-foreground/50'}`} title={msg.isRead ? 'Прочитано' : 'Не прочитано'}>
    {msg.isRead ? '✓✓' : '✓'}
  </span>
)}
```

Результат: рядом с временем admin-сообщения будет `✓` (серая, не прочитано) или `✓✓` (синяя, прочитано).

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc --noEmit`
Expected: без ошибок

- [ ] **Step 3: Commit**

```bash
git add src/pages/admin/sections/FeedbackListSection.tsx
git commit -m "feat(support): show read status for admin messages in feedback threads"
```
