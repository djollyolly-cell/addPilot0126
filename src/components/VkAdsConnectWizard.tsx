import { useState, useEffect } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Loader2, AlertCircle, CheckCircle2, ExternalLink, X, ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';

interface VkAdsConnectWizardProps {
  userId: string;
  onClose: () => void;
  onConnected: () => void;
}

interface AvailableAccount {
  id: string;
  name: string;
  type: 'own' | 'agency_client';
  username: string;
}

export function VkAdsConnectWizard({ userId, onClose, onConnected }: VkAdsConnectWizardProps) {
  const typedUserId = userId as Id<"users">;

  const hasCredentials = useQuery(api.users.hasVkAdsCredentials, { userId: typedUserId });

  const saveCredentials = useMutation(api.users.saveVkAdsCredentials);
  const fetchAvailableAccounts = useAction(api.adAccounts.fetchAvailableAccounts);
  const connectSelectedAccounts = useAction(api.adAccounts.connectSelectedAccounts);

  // Determine initial step: skip to step 2 if credentials already exist
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState<AvailableAccount[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [connectingSelected, setConnectingSelected] = useState(false);

  // If user already has credentials, skip to step 2 automatically
  useEffect(() => {
    if (hasCredentials === true && step === 1) {
      setStep(2);
    }
  }, [hasCredentials, step]);

  // Step 2: auto-fetch accounts when entering this step
  useEffect(() => {
    if (step !== 2) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchAvailableAccounts({
      userId: typedUserId,
      clientId: clientId || undefined,
      clientSecret: clientSecret || undefined,
    })
      .then((result) => {
        if (cancelled) return;
        setAccounts(result.accounts);
        // Pre-select all accounts
        setSelected(new Set(result.accounts.map((a) => a.id)));
        setStep(3);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось загрузить кабинеты');
        // Go back to step 1 so user can fix credentials
        setStep(1);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const handleSubmitCredentials = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError('Заполните оба поля');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Save credentials to user record
      await saveCredentials({
        userId: typedUserId,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });

      // Move to step 2 (auto-fetch)
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
      setLoading(false);
    }
  };

  const toggleAccount = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleConnectSelected = async () => {
    if (selected.size === 0) return;

    setConnectingSelected(true);
    setError(null);

    const toConnect = accounts
      .filter((a) => selected.has(a.id))
      .map((a) => ({ id: a.id, name: a.name }));

    try {
      const result = await connectSelectedAccounts({
        userId: typedUserId,
        accounts: toConnect,
      });
      if (result.connected > 0) {
        onConnected();
      } else {
        setError('Не удалось подключить кабинеты');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка подключения');
    } finally {
      setConnectingSelected(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <Card className="w-full max-w-lg mx-4 relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Step indicator */}
        <CardHeader>
          <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
            <span className={cn('px-2 py-0.5 rounded-full', step >= 1 ? 'bg-primary text-primary-foreground' : 'bg-muted')}>1</span>
            <ChevronRight className="w-3 h-3" />
            <span className={cn('px-2 py-0.5 rounded-full', step >= 2 ? 'bg-primary text-primary-foreground' : 'bg-muted')}>2</span>
            <ChevronRight className="w-3 h-3" />
            <span className={cn('px-2 py-0.5 rounded-full', step >= 3 ? 'bg-primary text-primary-foreground' : 'bg-muted')}>3</span>
          </div>

          {step === 1 && (
            <>
              <CardTitle>Подключение VK Ads</CardTitle>
              <CardDescription>
                Введите client_id и client_secret вашего приложения VK Ads
              </CardDescription>
            </>
          )}
          {step === 2 && (
            <>
              <CardTitle>Загрузка кабинетов</CardTitle>
              <CardDescription>Получаем токен и загружаем список кабинетов...</CardDescription>
            </>
          )}
          {step === 3 && (
            <>
              <CardTitle>Выберите кабинеты</CardTitle>
              <CardDescription>
                Отметьте кабинеты, которые хотите подключить
              </CardDescription>
            </>
          )}
        </CardHeader>

        <CardContent>
          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm mb-4">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Step 1: Credentials */}
          {step === 1 && !loading && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-muted text-sm space-y-2">
                <p className="font-medium">Как получить credentials:</p>
                <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                  <li>
                    Перейдите в{' '}
                    <a
                      href="https://ads.vk.com/hq/settings/access"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline inline-flex items-center gap-1"
                    >
                      ads.vk.com &rarr; Настройки &rarr; Доступ к API
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>Создайте приложение (или используйте существующее)</li>
                  <li>Скопируйте <strong>Client ID</strong> и <strong>Client Secret</strong></li>
                </ol>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Client ID</label>
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="Например: a1b2c3d4e5f6..."
                  className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Client Secret</label>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Секретный ключ приложения"
                  className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <button
                type="button"
                onClick={handleSubmitCredentials}
                disabled={!clientId.trim() || !clientSecret.trim()}
                className={cn(
                  'w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
                  'bg-primary text-primary-foreground hover:bg-primary/90',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                Продолжить
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Step 2: Loading */}
          {(step === 2 || (step === 1 && loading)) && (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                Получаем токен и загружаем кабинеты...
              </p>
            </div>
          )}

          {/* Step 3: Account selection */}
          {step === 3 && (
            <div className="space-y-4">
              {accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Не найдено доступных кабинетов
                </p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {accounts.map((account) => (
                    <label
                      key={account.id}
                      className={cn(
                        'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                        selected.has(account.id)
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-muted/50'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(account.id)}
                        onChange={() => toggleAccount(account.id)}
                        className="rounded border-muted-foreground"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{account.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {account.type === 'own' ? 'Свой аккаунт' : 'Клиент агентства'}
                          {account.username ? ` \u00b7 ${account.username}` : ''}
                        </p>
                      </div>
                      {selected.has(account.id) && (
                        <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                      )}
                    </label>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={handleConnectSelected}
                disabled={selected.size === 0 || connectingSelected}
                className={cn(
                  'w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
                  'bg-primary text-primary-foreground hover:bg-primary/90',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                {connectingSelected ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Подключение...
                  </>
                ) : (
                  <>
                    Подключить выбранные ({selected.size})
                  </>
                )}
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
