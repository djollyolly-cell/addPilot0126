import { useState, useEffect } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  MessageCircle,
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { Id } from '../../convex/_generated/dataModel';

export function SupportPage() {
  const { user } = useAuth();

  if (!user) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div data-testid="support-page" className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <MessageCircle className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Поддержка</h1>
          <p className="text-muted-foreground">Задайте вопрос или оставьте отзыв</p>
        </div>
      </div>

      <SupportContent userId={user.userId as Id<'users'>} />
    </div>
  );
}

function SupportContent({ userId }: { userId: Id<'users'> }) {
  const sendFeedback = useMutation(api.userNotifications.sendFeedback);
  const threads = useQuery(api.userNotifications.getUserThreads, { userId });
  const markAllRead = useMutation(api.userNotifications.markAllRead);

  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<'success' | 'error' | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  const totalUnread = threads?.reduce((sum, t) => sum + t.unreadCount, 0) ?? 0;

  // Auto-mark admin replies as read when user views the page
  useEffect(() => {
    if (totalUnread > 0) {
      markAllRead({ userId });
    }
  }, [totalUnread, markAllRead, userId]);

  const handleSend = async () => {
    if (!message.trim()) return;
    setSending(true);
    setResult(null);
    try {
      await sendFeedback({
        userId,
        title: title.trim() || 'Обратная связь',
        message: message.trim(),
      });
      setResult('success');
      setTitle('');
      setMessage('');
      setTimeout(() => setResult(null), 3000);
    } catch (err) {
      setResult('error');
      setErrorMsg(err instanceof Error ? err.message : 'Ошибка отправки');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* New message */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Новое обращение</CardTitle>
          <CardDescription>Мы ответим в ближайшее время</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            type="text"
            placeholder="Тема (необязательно)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            data-testid="support-title"
          />
          <textarea
            placeholder="Опишите ваш вопрос или проблему..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full min-h-[100px] p-3 rounded-lg border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            data-testid="support-message"
          />
          {result === 'success' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-700 text-sm">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              Сообщение отправлено!
            </div>
          )}
          {result === 'error' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {errorMsg}
            </div>
          )}
          <Button
            onClick={handleSend}
            disabled={sending || !message.trim()}
            className="gap-2"
            data-testid="support-send"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Отправить
          </Button>
        </CardContent>
      </Card>

      {/* Thread list */}
      {threads && threads.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Ваши обращения</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {threads.map((t) => (
              <div key={t.threadId}>
                <button
                  onClick={() => setOpenThreadId(openThreadId === t.threadId ? null : t.threadId)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    t.unreadCount > 0
                      ? 'border-primary/30 bg-primary/5'
                      : 'border-border hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {t.title || 'Обратная связь'}
                      </p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {t.lastDirection === 'admin_to_user' ? 'Поддержка: ' : 'Вы: '}
                        {t.lastMessage}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {t.messageCount > 1 && (
                        <Badge variant="secondary" className="text-xs">
                          {t.messageCount}
                        </Badge>
                      )}
                      {t.unreadCount > 0 && (
                        <Badge variant="destructive" className="text-xs">{t.unreadCount}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {new Date(t.lastMessageAt).toLocaleDateString('ru-RU', {
                          day: '2-digit',
                          month: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>
                </button>

                {openThreadId === t.threadId && (
                  <ThreadMessages
                    threadId={t.threadId as Id<'userNotifications'>}
                    userId={userId}
                  />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}

function ThreadMessages({
  threadId,
  userId,
}: {
  threadId: Id<'userNotifications'>;
  userId: Id<'users'>;
}) {
  const thread = useQuery(api.userNotifications.getThread, { threadId });
  const sendFeedback = useMutation(api.userNotifications.sendFeedback);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  if (!thread) return null;

  const handleReply = async () => {
    if (!replyText.trim()) return;
    setSending(true);
    try {
      await sendFeedback({
        userId,
        title: '',
        message: replyText.trim(),
        threadId,
      });
      setReplyText('');
    } finally {
      setSending(false);
    }
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="mt-2 space-y-2 border-l-2 border-border pl-3 ml-3">
      {thread.map((msg) => (
        <div
          key={msg._id}
          className={`p-2.5 rounded-lg text-sm ${
            msg.direction === 'admin_to_user'
              ? 'bg-primary/10 border border-primary/20'
              : 'bg-muted/50 border border-border'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium">
              {msg.direction === 'admin_to_user' ? 'Поддержка' : 'Вы'}
            </span>
            <span className="text-xs text-muted-foreground">{formatTime(msg.createdAt)}</span>
          </div>
          <p className="text-sm whitespace-pre-wrap">{msg.message}</p>
        </div>
      ))}

      {/* Reply */}
      <div className="flex gap-2 pt-1">
        <textarea
          className="flex-1 min-h-[40px] p-2 rounded-lg border border-border bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="Ответить..."
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          rows={1}
        />
        <Button
          size="sm"
          onClick={handleReply}
          disabled={sending || !replyText.trim()}
          className="shrink-0 self-end"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}
