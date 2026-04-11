import { useState } from 'react';
import { useQuery, useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Button } from '../../../components/ui/button';
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

interface Props {
  sessionToken: string;
}

export function BroadcastSection({ sessionToken }: Props) {
  const telegramUsers = useQuery(api.admin.getTelegramUsers, { sessionToken });
  const broadcast = useAction(api.admin.broadcastTelegram);

  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: number; failed: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAll, setSelectedAll] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const recipients = selectedAll
    ? telegramUsers || []
    : (telegramUsers || []).filter((u) => selectedIds.has(u._id));

  const handleSend = async () => {
    if (!message.trim() || recipients.length === 0) return;
    setSending(true);
    setError(null);
    setResult(null);
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

  const toggleUser = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    setSelectedAll(false);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {telegramUsers && `${telegramUsers.length} получателей`}
      </p>

      {/* Templates */}
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

      {/* Message */}
      <div className="space-y-1">
        <Label className="text-xs">Сообщение (HTML-разметка)</Label>
        <textarea
          className="w-full min-h-[120px] p-3 rounded-lg border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="Введите текст сообщения..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      {/* Recipients */}
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

      {/* Status */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}
      {result && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-700 text-sm">
          <CheckCircle className="w-4 h-4 shrink-0" />
          Отправлено: {result.sent} из {result.total}
          {result.failed > 0 && `, ошибок: ${result.failed}`}
        </div>
      )}

      {/* Send */}
      <Button
        onClick={handleSend}
        disabled={sending || !message.trim() || recipients.length === 0}
      >
        {sending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
        Отправить {recipients.length > 0 ? `(${recipients.length})` : ''}
      </Button>
    </div>
  );
}
