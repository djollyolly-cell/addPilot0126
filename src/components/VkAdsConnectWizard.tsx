import { useState, useEffect } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Loader2, AlertCircle, CheckCircle2, ExternalLink, X, ChevronRight, Crown, Zap } from 'lucide-react';
import { cn } from '../lib/utils';
import { useNavigate } from 'react-router-dom';

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

interface AccountWithCustomName extends AvailableAccount {
  customName: string;
}

const TIER_LIMITS = {
  freemium: { accounts: 1, name: 'Freemium' },
  start: { accounts: 3, name: 'Start' },
  pro: { accounts: 10, name: 'Pro' },
};

export function VkAdsConnectWizard({ userId, onClose, onConnected }: VkAdsConnectWizardProps) {
  const typedUserId = userId as Id<"users">;
  const navigate = useNavigate();

  const savedCredentials = useQuery(api.users.getVkAdsCredentialsForFrontend, { userId: typedUserId });
  const limits = useQuery(api.users.getLimits, { userId: typedUserId });

  const saveCredentials = useMutation(api.users.saveVkAdsCredentials);
  const fetchAvailableAccounts = useAction(api.adAccounts.fetchAvailableAccounts);
  const connectSelectedAccounts = useAction(api.adAccounts.connectSelectedAccounts);

  const [step, setStep] = useState<1 | 2 | 3 | 'limit'>(1);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState<AccountWithCustomName[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [connectingSelected, setConnectingSelected] = useState(false);
  const [credentialsChecked, setCredentialsChecked] = useState(false);
  const [autoFetchAttempted, setAutoFetchAttempted] = useState(false);

  // Calculate available slots
  const currentCount = limits?.usage.accounts ?? 0;
  const maxCount = limits?.limits.accounts ?? 1;
  const availableSlots = Math.max(0, maxCount - currentCount);
  const tier = limits?.tier ?? 'freemium';

  // Check if limit reached on mount
  useEffect(() => {
    if (limits && availableSlots === 0) {
      setStep('limit');
    }
  }, [limits, availableSlots]);

  // Pre-fill credentials from DB (but don't auto-skip if already failed)
  useEffect(() => {
    if (savedCredentials && step === 1 && !credentialsChecked && !autoFetchAttempted && availableSlots > 0) {
      setClientId(savedCredentials.clientId);
      setClientSecret(savedCredentials.clientSecret);
      setAutoFetchAttempted(true);
      setStep(2);
    }
  }, [savedCredentials, step, credentialsChecked, autoFetchAttempted, availableSlots]);

  // Step 2: auto-fetch accounts when entering this step
  useEffect(() => {
    if (step !== 2) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    const effectiveClientId = clientId || savedCredentials?.clientId;
    const effectiveClientSecret = clientSecret || savedCredentials?.clientSecret;

    fetchAvailableAccounts({
      userId: typedUserId,
      clientId: effectiveClientId || undefined,
      clientSecret: effectiveClientSecret || undefined,
    })
      .then((result) => {
        if (cancelled) return;
        // Add customName field to each account
        const accountsWithNames = result.accounts.map((a) => ({
          ...a,
          customName: a.name,
        }));
        setAccounts(accountsWithNames);
        // Pre-select accounts up to available slots
        const toSelect = result.accounts.slice(0, availableSlots).map((a) => a.id);
        setSelected(new Set(toSelect));
        setStep(3);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось загрузить кабинеты');
        setCredentialsChecked(true);
        setStep(1);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, savedCredentials]);

  const handleSubmitCredentials = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError('Заполните оба поля');
      return;
    }

    setLoading(true);
    setError(null);
    setCredentialsChecked(false);

    try {
      await saveCredentials({
        userId: typedUserId,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
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
        // Check if we can add more
        if (next.size >= availableSlots) {
          setError(`Можно выбрать максимум ${availableSlots} кабинетов на тарифе ${TIER_LIMITS[tier as keyof typeof TIER_LIMITS]?.name}`);
          return prev;
        }
        next.add(id);
      }
      setError(null);
      return next;
    });
  };

  const updateCustomName = (id: string, name: string) => {
    setAccounts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, customName: name } : a))
    );
  };

  const handleConnectSelected = async () => {
    if (selected.size === 0) return;

    if (selected.size > availableSlots) {
      setError(`Превышен лимит. Доступно слотов: ${availableSlots}`);
      return;
    }

    setConnectingSelected(true);
    setError(null);

    const toConnect = accounts
      .filter((a) => selected.has(a.id))
      .map((a) => ({ id: a.id, name: a.customName || a.name }));

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
      const msg = err instanceof Error ? err.message : 'Ошибка подключения';
      if (msg.includes('Лимит')) {
        setStep('limit');
      } else {
        setError(msg);
      }
    } finally {
      setConnectingSelected(false);
    }
  };

  const handleUpgrade = () => {
    onClose();
    navigate('/pricing');
  };

  // Limit reached screen
  if (step === 'limit') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <Card className="w-full max-w-md mx-4 relative">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
          >
            <X className="w-5 h-5" />
          </button>

          <CardHeader className="text-center">
            <div className="mx-auto mb-4 p-3 rounded-full bg-warning/10 w-fit">
              <AlertCircle className="h-8 w-8 text-warning" />
            </div>
            <CardTitle>Лимит кабинетов достигнут</CardTitle>
            <CardDescription>
              На тарифе <strong>{TIER_LIMITS[tier as keyof typeof TIER_LIMITS]?.name}</strong> доступно{' '}
              <strong>{maxCount}</strong> {maxCount === 1 ? 'кабинет' : maxCount < 5 ? 'кабинета' : 'кабинетов'}.
              <br />
              Вы уже подключили {currentCount}.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {tier !== 'start' && (
                <button
                  type="button"
                  onClick={handleUpgrade}
                  className={cn(
                    'flex flex-col items-center gap-2 p-4 rounded-lg border-2 border-primary bg-primary/5 hover:bg-primary/10 transition-colors'
                  )}
                >
                  <Zap className="h-6 w-6 text-primary" />
                  <span className="font-medium">Start</span>
                  <span className="text-xs text-muted-foreground">3 кабинета</span>
                  <span className="text-sm font-bold">990 ₽/мес</span>
                </button>
              )}
              {tier !== 'pro' && (
                <button
                  type="button"
                  onClick={handleUpgrade}
                  className={cn(
                    'flex flex-col items-center gap-2 p-4 rounded-lg border-2 border-amber-500 bg-amber-500/5 hover:bg-amber-500/10 transition-colors'
                  )}
                >
                  <Crown className="h-6 w-6 text-amber-500" />
                  <span className="font-medium">Pro</span>
                  <span className="text-xs text-muted-foreground">10 кабинетов</span>
                  <span className="text-sm font-bold">2490 ₽/мес</span>
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-full px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors"
            >
              Закрыть
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="vk-ads-wizard">
      <Card className="w-full max-w-lg mx-4 relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
          data-testid="wizard-close"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Step indicator */}
        <CardHeader>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className={cn('px-2 py-0.5 rounded-full', step >= 1 ? 'bg-primary text-primary-foreground' : 'bg-muted')}>1</span>
              <ChevronRight className="w-3 h-3" />
              <span className={cn('px-2 py-0.5 rounded-full', step >= 2 ? 'bg-primary text-primary-foreground' : 'bg-muted')}>2</span>
              <ChevronRight className="w-3 h-3" />
              <span className={cn('px-2 py-0.5 rounded-full', step >= 3 ? 'bg-primary text-primary-foreground' : 'bg-muted')}>3</span>
            </div>
            {/* Slots indicator */}
            <span className={cn(
              'px-2.5 py-1 rounded-full text-xs font-medium',
              availableSlots > 0 ? 'bg-green-500/10 text-green-600' : 'bg-warning/10 text-warning'
            )}>
              {availableSlots} из {maxCount} слотов
            </span>
          </div>

          {step === 1 && (
            <>
              <CardTitle>Подключение VK Ads</CardTitle>
              <CardDescription>
                Введите Client ID и Client Secret вашего рекламного кабинета
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
                Выберите до {availableSlots} {availableSlots === 1 ? 'кабинета' : 'кабинетов'} и укажите название для идентификации
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
                <p className="font-medium">Где взять Client ID и Client Secret:</p>
                <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                  <li>
                    Откройте{' '}
                    <a
                      href="https://ads.vk.com/hq/settings/access"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline inline-flex items-center gap-1"
                    >
                      ads.vk.com → Настройки → Доступ к API
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
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

          {/* Step 3: Account selection with custom names */}
          {step === 3 && (
            <div className="space-y-4">
              {accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Не найдено доступных кабинетов
                </p>
              ) : (
                <div className="space-y-3 max-h-80 overflow-y-auto">
                  {accounts.map((account) => (
                    <div
                      key={account.id}
                      className={cn(
                        'p-3 rounded-lg border transition-colors',
                        selected.has(account.id)
                          ? 'border-primary bg-primary/5'
                          : 'border-border'
                      )}
                    >
                      <label className="flex items-center gap-3 cursor-pointer">
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
                            {account.username ? ` · ${account.username}` : ''}
                          </p>
                        </div>
                        {selected.has(account.id) && (
                          <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                        )}
                      </label>

                      {/* Custom name input - shown when selected */}
                      {selected.has(account.id) && (
                        <div className="mt-3 pl-7">
                          <label className="block text-xs text-muted-foreground mb-1">
                            Название для идентификации (клиент/проект)
                          </label>
                          <input
                            type="text"
                            value={account.customName}
                            onChange={(e) => updateCustomName(account.id, e.target.value)}
                            placeholder="Например: Клиент Иванов, Проект А..."
                            className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-3">
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={handleConnectSelected}
                    disabled={selected.size === 0 || connectingSelected}
                    className={cn(
                      'flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
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
                        Подключить ({selected.size})
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleUpgrade}
                    className="px-4 py-2 rounded-lg border-2 border-primary text-primary font-medium text-sm hover:bg-primary/5 transition-colors flex items-center gap-1"
                  >
                    <Crown className="w-4 h-4" />
                    {availableSlots < accounts.length ? 'Больше слотов' : 'Тарифы'}
                  </button>
                </div>

                {/* Button to add another account with different credentials */}
                <button
                  type="button"
                  onClick={() => {
                    setClientId('');
                    setClientSecret('');
                    setCredentialsChecked(true); // Keep true to prevent auto-skip
                    // Don't reset autoFetchAttempted - keep it true to prevent useEffect from auto-skipping
                    setAccounts([]);
                    setSelected(new Set());
                    setError(null);
                    setStep(1);
                  }}
                  className="w-full px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted transition-colors text-muted-foreground"
                >
                  + Подключить другой аккаунт (другие credentials)
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
