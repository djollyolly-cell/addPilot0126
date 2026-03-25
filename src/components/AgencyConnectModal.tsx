import { useState } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Loader2, AlertCircle, X, KeyRound, Info, ChevronDown, ChevronUp, Copy, CheckCircle2 } from 'lucide-react';
import { cn } from '../lib/utils';

interface AgencyConnectModalProps {
  userId: string;
  onClose: () => void;
  onConnected: () => void;
}

const TEMPLATE_TEXT = `Здравствуйте!

Прошу предоставить API-ключ (access token) для рекламного кабинета ID [ВАШ_ID_КАБИНЕТА] для получения статистики через myTarget API v2.

Ключ нужен с правами на чтение статистики (read_stats).

Спасибо!`;

export function AgencyConnectModal({ userId, onClose, onConnected }: AgencyConnectModalProps) {
  const typedUserId = userId as Id<"users">;
  const connectAgency = useAction(api.adAccounts.connectAgencyAccount);

  const [accessToken, setAccessToken] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showInstruction, setShowInstruction] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(TEMPLATE_TEXT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const handleSubmit = async () => {
    if (!accessToken.trim()) {
      setError('Введите API-ключ');
      return;
    }
    if (!name.trim()) {
      setError('Введите название кабинета');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await connectAgency({
        userId: typedUserId,
        accessToken: accessToken.trim(),
        name: name.trim(),
      });
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка подключения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="agency-connect-modal">
      <Card className="w-full max-w-lg mx-4 relative max-h-[90vh] overflow-y-auto">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
        >
          <X className="w-5 h-5" />
        </button>

        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" />
            Агентский кабинет
          </CardTitle>
          <CardDescription>
            Подключите кабинет через API-ключ, полученный от сервиса (Vitamin.tools, eLama и др.)
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Instruction toggle */}
          <button
            type="button"
            onClick={() => setShowInstruction(!showInstruction)}
            className="w-full flex items-center gap-2 p-3 rounded-lg bg-muted text-sm font-medium hover:bg-muted/80 transition-colors"
          >
            <Info className="w-4 h-4 text-primary shrink-0" />
            <span className="flex-1 text-left">Как получить API-ключ?</span>
            {showInstruction ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </button>

          {showInstruction && (
            <div className="p-4 rounded-lg border bg-muted/50 space-y-3 text-sm">
              <p className="font-medium">Для агентских кабинетов API-ключ выдаёт сервис:</p>
              <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                <li>Напишите в поддержку сервиса, через который работает ваш рекламный кабинет (Vitamin.tools, eLama, Click.ru и т.д.)</li>
                <li>Попросите предоставить <strong>API-ключ (access token)</strong> для myTarget API v2 с правами на чтение статистики</li>
                <li>Укажите ID вашего рекламного кабинета в запросе</li>
                <li>Полученный ключ вставьте в поле ниже</li>
              </ol>

              <div className="mt-3 pt-3 border-t">
                <p className="font-medium mb-2">Шаблон запроса в поддержку:</p>
                <div className="relative">
                  <pre className="p-3 rounded-lg bg-background border text-xs whitespace-pre-wrap text-muted-foreground">
                    {TEMPLATE_TEXT}
                  </pre>
                  <button
                    type="button"
                    onClick={handleCopyTemplate}
                    className={cn(
                      'absolute top-2 right-2 p-1.5 rounded-md transition-colors',
                      copied ? 'bg-green-500/10 text-green-600' : 'bg-muted hover:bg-muted-foreground/10 text-muted-foreground'
                    )}
                  >
                    {copied ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-warning/10 text-warning text-xs">
                <strong>Важно:</strong> API-ключи от сервисов обычно имеют ограниченный срок действия (24 часа). Уточните у сервиса, как получать ключи на постоянной основе.
              </div>
            </div>
          )}

          {/* Form */}
          <div>
            <label className="block text-sm font-medium mb-1">Название кабинета</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например: Клиент Иванов (Vitamin.tools)"
              className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              data-testid="agency-name-input"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">API-ключ (access token)</label>
            <textarea
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="Вставьте ключ, полученный от сервиса..."
              rows={3}
              className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none font-mono"
              data-testid="agency-token-input"
            />
          </div>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || !accessToken.trim() || !name.trim()}
            className={cn(
              'w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
              'bg-primary text-primary-foreground hover:bg-primary/90',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            data-testid="agency-connect-submit"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Проверка и подключение...
              </>
            ) : (
              'Подключить кабинет'
            )}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
