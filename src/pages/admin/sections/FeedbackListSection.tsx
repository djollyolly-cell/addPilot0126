import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Loader2, Send, Plus, X } from 'lucide-react';
import { Id } from '../../../../convex/_generated/dataModel';

export function FeedbackListSection({ sessionToken }: { sessionToken: string }) {
  const feedback = useQuery(api.userNotifications.listFeedback, {});
  const users = useQuery(api.admin.listUsers, { sessionToken });
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
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
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

function FeedbackThread({
  threadId,
  replyingTo,
  replyText,
  replySending,
  onReplyTextChange,
  onReply,
  onStartReply,
}: {
  threadId: Id<'userNotifications'>;
  replyingTo: string | null;
  replyText: string;
  replySending: boolean;
  onReplyTextChange: (v: string) => void;
  onReply: () => void;
  onStartReply: () => void;
}) {
  const thread = useQuery(api.userNotifications.getThread, { threadId });

  if (!thread || thread.length <= 1) {
    // Only root message, show reply form if active
    return replyingTo === threadId ? (
      <div className="ml-4 mt-2 space-y-2">
        <textarea
          className="w-full min-h-[60px] p-2 rounded-lg border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="Ваш ответ..."
          value={replyText}
          onChange={(e) => onReplyTextChange(e.target.value)}
          autoFocus
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={onReply} disabled={replySending || !replyText.trim()}>
            {replySending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Send className="w-4 h-4 mr-1" />}
            Отправить
          </Button>
        </div>
      </div>
    ) : null;
  }

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="ml-4 mt-2 space-y-2 border-l-2 border-border pl-3">
      {thread.slice(1).map((msg) => (
        <div
          key={msg._id}
          className={`p-2 rounded-lg text-sm ${
            msg.direction === 'admin_to_user'
              ? 'bg-primary/10 border border-primary/20'
              : 'bg-muted/50 border border-border'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium">
              {msg.direction === 'admin_to_user' ? 'Админ' : 'Пользователь'}
            </span>
            <span className="text-xs text-muted-foreground">{formatTime(msg.createdAt)}</span>
            {msg.direction === 'admin_to_user' && (
              <span className={`text-xs ${msg.isRead ? 'text-primary' : 'text-muted-foreground/50'}`} title={msg.isRead ? 'Прочитано' : 'Не прочитано'}>
                {msg.isRead ? '✓✓' : '✓'}
              </span>
            )}
          </div>
          <p className="text-sm whitespace-pre-wrap">{msg.message}</p>
        </div>
      ))}

      {/* Reply form */}
      {replyingTo === threadId ? (
        <div className="space-y-2">
          <textarea
            className="w-full min-h-[60px] p-2 rounded-lg border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Ваш ответ..."
            value={replyText}
            onChange={(e) => onReplyTextChange(e.target.value)}
            autoFocus
          />
          <Button size="sm" onClick={onReply} disabled={replySending || !replyText.trim()}>
            {replySending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Send className="w-4 h-4 mr-1" />}
            Отправить
          </Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="text-xs" onClick={onStartReply}>
          Ответить
        </Button>
      )}
    </div>
  );
}
