import { useState } from 'react';
import { useQuery, useAction, useMutation } from 'convex/react';
import type { FunctionReference } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Send, Loader2, AlertCircle, CheckCircle } from 'lucide-react';

const SYSTEM_TEMPLATES = [
  {
    label: 'Тех. работы',
    text: '🔧 <b>Плановые технические работы</b>\n\nСервис будет недоступен ориентировочно 30 минут.\nПриносим извинения за неудобства.',
  },
  {
    label: 'Работы завершены',
    text: '✅ <b>Технические работы завершены</b>\n\nСервис работает в штатном режиме. Спасибо за терпение!',
  },
  {
    label: 'Обновление',
    text: '🚀 <b>Обновление AddPilot</b>\n\nМы добавили новые возможности! Подробности в личном кабинете.',
  },
];

const IN_APP_TEMPLATES = [
  {
    label: 'Инфо',
    title: 'Информация',
    message: '',
    type: 'info' as const,
  },
];

interface Props {
  sessionToken: string;
}

type Channel = 'telegram' | 'inapp';
type InAppAudience = 'all' | 'paid';
type InAppType = 'info' | 'warning' | 'payment';
type SendResult = { sent: number; failed?: number; total: number };
type InAppBroadcastArgs = {
  sessionToken: string;
  title: string;
  message: string;
  type: InAppType;
  audience: InAppAudience;
  dryRun: boolean;
  expectedCount?: number;
  maxRecipients?: number;
};
type InAppBroadcastResult = {
  dryRun: boolean;
  sent: number;
  total: number;
  audience: InAppAudience;
};
type InAppBroadcastRef = FunctionReference<
  'mutation',
  'public',
  InAppBroadcastArgs,
  InAppBroadcastResult
>;
const adminApi = api.admin as unknown as typeof api.admin & {
  broadcastInAppNotification: InAppBroadcastRef;
};

export function BroadcastSection({ sessionToken }: Props) {
  const telegramUsers = useQuery(api.admin.getTelegramUsers, { sessionToken });
  const broadcast = useAction(api.admin.broadcastTelegram);
  const broadcastInApp = useMutation(adminApi.broadcastInAppNotification);

  const [channel, setChannel] = useState<Channel>('telegram');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAll, setSelectedAll] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [inAppTitle, setInAppTitle] = useState('');
  const [inAppMessage, setInAppMessage] = useState('');
  const [inAppType, setInAppType] = useState<InAppType>('info');
  const [inAppAudience, setInAppAudience] = useState<InAppAudience>('all');
  const [inAppPreviewCount, setInAppPreviewCount] = useState<number | null>(null);

  const recipients = selectedAll
    ? telegramUsers || []
    : (telegramUsers || []).filter((u) => selectedIds.has(u._id));

  const resetStatus = () => {
    setError(null);
    setResult(null);
  };

  const handleTelegramSend = async () => {
    if (!message.trim() || recipients.length === 0) return;
    setSending(true);
    resetStatus();
    try {
      const res = await broadcast({
        sessionToken,
        message: message.trim(),
        chatIds: recipients.map((u) => u.telegramChatId),
      });
      setResult(res);
      if (res.sent === res.total) setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка отправки');
    } finally {
      setSending(false);
    }
  };

  const handleInAppPreview = async () => {
    if (!inAppTitle.trim() || !inAppMessage.trim()) return;
    setSending(true);
    resetStatus();
    setInAppPreviewCount(null);
    try {
      const res = await broadcastInApp({
        sessionToken,
        title: inAppTitle.trim(),
        message: inAppMessage.trim(),
        type: inAppType,
        audience: inAppAudience,
        dryRun: true,
        maxRecipients: 500,
      });
      setInAppPreviewCount(res.total);
      setResult({ sent: 0, total: res.total });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка предпросмотра');
    } finally {
      setSending(false);
    }
  };

  const handleInAppSend = async () => {
    if (!inAppTitle.trim() || !inAppMessage.trim() || inAppPreviewCount === null) return;
    setSending(true);
    resetStatus();
    try {
      const res = await broadcastInApp({
        sessionToken,
        title: inAppTitle.trim(),
        message: inAppMessage.trim(),
        type: inAppType,
        audience: inAppAudience,
        dryRun: false,
        expectedCount: inAppPreviewCount,
        maxRecipients: 500,
      });
      setResult({ sent: res.sent, total: res.total });
      if (res.sent === res.total) {
        setInAppPreviewCount(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка отправки');
    } finally {
      setSending(false);
    }
  };

  const toggleUser = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    setSelectedAll(false);
  };

  const setInAppTemplate = (template: (typeof IN_APP_TEMPLATES)[number]) => {
    setInAppTitle(template.title);
    setInAppMessage(template.message);
    setInAppType(template.type);
    setInAppPreviewCount(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={channel === 'telegram' ? 'default' : 'outline'}
          onClick={() => { setChannel('telegram'); resetStatus(); }}
        >
          Telegram
        </Button>
        <Button
          size="sm"
          variant={channel === 'inapp' ? 'default' : 'outline'}
          onClick={() => { setChannel('inapp'); resetStatus(); }}
        >
          В сервисе
        </Button>
      </div>

      {channel === 'telegram' ? (
        <>
          <p className="text-sm text-muted-foreground">
            {telegramUsers && `${telegramUsers.length} получателей`}
          </p>

          <div className="flex flex-wrap gap-2">
            {SYSTEM_TEMPLATES.map((t) => (
              <Button
                key={t.label}
                size="sm"
                variant="outline"
                onClick={() => setMessage(t.text)}
              >
                {t.label}
              </Button>
            ))}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Сообщение (HTML-разметка)</Label>
            <textarea
              className="w-full min-h-[120px] p-3 rounded-lg border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Введите текст сообщения..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Label className="text-xs">Получатели:</Label>
              <Button
                size="sm"
                variant={selectedAll ? 'default' : 'outline'}
                onClick={() => { setSelectedAll(true); setSelectedIds(new Set()); }}
              >
                Все
              </Button>
              <Button
                size="sm"
                variant={!selectedAll ? 'default' : 'outline'}
                onClick={() => setSelectedAll(false)}
              >
                Выбрать
              </Button>
            </div>

            {!selectedAll && telegramUsers && (
              <div className="flex flex-wrap gap-2 max-h-[120px] overflow-y-auto p-2 border border-border rounded-lg">
                {telegramUsers.map((u) => (
                  <Button
                    key={u._id}
                    size="sm"
                    variant={selectedIds.has(u._id) ? 'default' : 'outline'}
                    onClick={() => toggleUser(u._id)}
                  >
                    {u.telegramFirstName || u.name}
                    {u.telegramUsername && ` @${u.telegramUsername}`}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <Button
            onClick={handleTelegramSend}
            disabled={sending || !message.trim() || recipients.length === 0}
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
            Отправить {recipients.length > 0 ? `(${recipients.length})` : ''}
          </Button>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {IN_APP_TEMPLATES.map((t) => (
              <Button
                key={t.label}
                size="sm"
                variant="outline"
                onClick={() => setInAppTemplate(t)}
              >
                {t.label}
              </Button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <select
              className="text-sm border border-border rounded px-2 py-2 bg-background"
              value={inAppType}
              onChange={(e) => { setInAppType(e.target.value as InAppType); setInAppPreviewCount(null); }}
            >
              <option value="info">Инфо</option>
              <option value="warning">Предупреждение</option>
              <option value="payment">Оплата</option>
            </select>
            <Input
              placeholder="Заголовок"
              value={inAppTitle}
              onChange={(e) => { setInAppTitle(e.target.value); setInAppPreviewCount(null); }}
            />
          </div>

          <textarea
            className="w-full min-h-[120px] p-3 rounded-lg border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Текст уведомления в сервисе..."
            value={inAppMessage}
            onChange={(e) => { setInAppMessage(e.target.value); setInAppPreviewCount(null); }}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Label className="text-xs">Аудитория:</Label>
            <Button
              size="sm"
              variant={inAppAudience === 'all' ? 'default' : 'outline'}
              onClick={() => { setInAppAudience('all'); setInAppPreviewCount(null); }}
            >
              Все
            </Button>
            <Button
              size="sm"
              variant={inAppAudience === 'paid' ? 'default' : 'outline'}
              onClick={() => { setInAppAudience('paid'); setInAppPreviewCount(null); }}
            >
              Платные активные
            </Button>
            {inAppPreviewCount !== null && (
              <span className="text-sm text-muted-foreground">
                Предпросмотр: {inAppPreviewCount} получателей
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleInAppPreview}
              disabled={sending || !inAppTitle.trim() || !inAppMessage.trim()}
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Предпросмотр
            </Button>
            <Button
              onClick={handleInAppSend}
              disabled={sending || inAppPreviewCount === null || !inAppTitle.trim() || !inAppMessage.trim()}
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
              Отправить всем {inAppPreviewCount !== null ? `(${inAppPreviewCount})` : ''}
            </Button>
          </div>
        </>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}
      {result && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-700 text-sm">
          <CheckCircle className="w-4 h-4 shrink-0" />
          {result.sent > 0 ? `Отправлено: ${result.sent} из ${result.total}` : `Получателей: ${result.total}`}
          {(result.failed ?? 0) > 0 && `, ошибок: ${result.failed}`}
        </div>
      )}
    </div>
  );
}
