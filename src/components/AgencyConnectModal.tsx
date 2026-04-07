import { useState, useEffect, useCallback } from 'react';
import { useQuery, useAction, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Loader2, AlertCircle, X, KeyRound, ArrowLeft, CheckCircle2, ExternalLink } from 'lucide-react';
import { cn } from '../lib/utils';

interface AgencyConnectModalProps {
  userId: string;
  onClose: () => void;
  onConnected: () => void;
}

interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  type?: string;
}

interface AgencyProvider {
  _id: Id<"agencyProviders">;
  name: string;
  displayName: string;
  hasApi: boolean;
  authMethod?: string;
  requiredFields?: ProviderField[];
  notes?: string;
  docsUrl?: string;
}

interface GetUniqAccount {
  id: number | string;
  name?: string;
  login?: string;
  status?: string;
  type?: string;
}

type Step = 'select' | 'fields' | 'getuniq_auth' | 'getuniq_accounts';

export function AgencyConnectModal({ userId, onClose, onConnected }: AgencyConnectModalProps) {
  const typedUserId = userId as Id<"users">;
  const connectAgency = useAction(api.adAccounts.connectAgencyAccount);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saveCredentials = useMutation((api as any).agencyProviders.saveCredentials);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getuniqStartAuth = useAction((api as any).agencyProviders.getuniqStartAuth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getuniqListAccounts = useAction((api as any).agencyProviders.getuniqListAccounts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getuniqConnect = useAction((api as any).agencyProviders.getuniqConnectAccount);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vitaminConnect = useAction((api as any).agencyProviders.vitaminConnectAccount);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers = useQuery((api as any).agencyProviders.list) as AgencyProvider[] | undefined;

  const [step, setStep] = useState<Step>('select');
  const [selectedProvider, setSelectedProvider] = useState<AgencyProvider | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [getuniqAccounts, setGetuniqAccounts] = useState<GetUniqAccount[]>([]);

  const handleFieldChange = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleBack = () => {
    if (step === 'getuniq_accounts') {
      setStep('getuniq_auth');
    } else if (step === 'getuniq_auth' || step === 'fields') {
      setStep('select');
      setSelectedProvider(null);
      setFieldValues({});
    }
    setError(null);
  };

  // Listen for GetUNIQ OAuth popup result
  const handleStorageEvent = useCallback((e: StorageEvent) => {
    if (e.key === 'getuniq_result' && e.newValue) {
      try {
        const result = JSON.parse(e.newValue);
        localStorage.removeItem('getuniq_result');
        if (result.success) {
          // OAuth done — fetch accounts
          loadGetuniqAccounts();
        } else if (result.error) {
          setError(`Ошибка авторизации: ${result.error}`);
        }
      } catch { /* ignore */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider]);

  useEffect(() => {
    window.addEventListener('storage', handleStorageEvent);
    return () => window.removeEventListener('storage', handleStorageEvent);
  }, [handleStorageEvent]);

  const loadGetuniqAccounts = async () => {
    if (!selectedProvider) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getuniqListAccounts({
        userId: typedUserId,
        providerId: selectedProvider._id,
      });
      setGetuniqAccounts(result.accounts || []);
      setStep('getuniq_accounts');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки кабинетов');
    } finally {
      setLoading(false);
    }
  };

  // Step: save GetUNIQ credentials and show OAuth button
  const handleGetuniqCredentialsSave = async () => {
    if (!selectedProvider) return;
    if (!fieldValues.clientId?.trim() || !fieldValues.clientSecret?.trim()) {
      setError('Заполните Client ID и Client Secret');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await saveCredentials({
        userId: typedUserId,
        providerId: selectedProvider._id,
        oauthClientId: fieldValues.clientId.trim(),
        oauthClientSecret: fieldValues.clientSecret.trim(),
      });
      setStep('getuniq_auth');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setLoading(false);
    }
  };

  // Open GetUNIQ OAuth popup
  const handleGetuniqAuth = async () => {
    if (!selectedProvider) return;
    setLoading(true);
    setError(null);

    const redirectUri = `${window.location.origin}/auth/getuniq-callback`;

    try {
      const result = await getuniqStartAuth({
        userId: typedUserId,
        providerId: selectedProvider._id,
        redirectUri,
      });

      // Save state for the callback page (localStorage — shared across windows, unlike sessionStorage)
      localStorage.setItem('getuniq_userId', typedUserId);
      localStorage.setItem('getuniq_providerId', selectedProvider._id);
      localStorage.setItem('getuniq_redirectUri', redirectUri);

      // Clear any old result
      localStorage.removeItem('getuniq_result');

      // Open popup
      const w = 600, h = 700;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      const popup = window.open(
        result.authUrl,
        'getuniq_oauth',
        `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no`
      );

      if (!popup) {
        setError('Браузер заблокировал всплывающее окно. Разрешите попапы для этого сайта.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  // Connect a selected GetUNIQ account
  const handleGetuniqConnect = async (account: GetUniqAccount) => {
    if (!selectedProvider) return;
    setLoading(true);
    setError(null);

    try {
      await getuniqConnect({
        userId: typedUserId,
        providerId: selectedProvider._id,
        getuniqAccountId: String(account.id),
        accountName: account.name || account.login || `GetUNIQ #${account.id}`,
      });
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка подключения');
    } finally {
      setLoading(false);
    }
  };

  // Submit for non-GetUNIQ providers
  const handleSubmit = async () => {
    if (!selectedProvider) return;

    const fields = (selectedProvider.requiredFields ?? []) as ProviderField[];
    for (const field of fields) {
      if (!fieldValues[field.key]?.trim()) {
        setError(`Заполните поле: ${field.label}`);
        return;
      }
    }

    setLoading(true);
    setError(null);

    try {
      const providerName = selectedProvider.name;
      const providerId = selectedProvider._id;

      if (providerName === "vitamin") {
        await vitaminConnect({
          userId: typedUserId,
          providerId,
          accessToken: fieldValues.accessToken.trim(),
          cabinetId: fieldValues.cabinetId.trim(),
        });
        onConnected();
      } else if (providerName === "targethunter" || providerName === "cerebro") {
        const accountName = fieldValues.accountName?.trim() ||
          `${selectedProvider.displayName} кабинет`;

        await connectAgency({
          userId: typedUserId,
          accessToken: fieldValues.accessToken.trim(),
          name: accountName,
          agencyProviderId: providerId,
        });

        await saveCredentials({
          userId: typedUserId,
          providerId,
        });

        onConnected();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка подключения');
    } finally {
      setLoading(false);
    }
  };

  // Loading providers
  if (providers === undefined) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <Card className="w-full max-w-lg mx-4">
          <CardContent className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </div>
    );
  }

  const showBack = step !== 'select';
  const title = step === 'select'
    ? 'Агентский кабинет'
    : step === 'getuniq_accounts'
      ? 'Выберите кабинет'
      : selectedProvider?.displayName || '';

  const description = step === 'select'
    ? 'Выберите сервис, через который работает ваш рекламный кабинет'
    : step === 'getuniq_auth'
      ? 'Авторизуйтесь в GetUNIQ для получения списка кабинетов'
      : step === 'getuniq_accounts'
        ? 'Выберите кабинет для подключения'
        : selectedProvider?.notes || 'Заполните данные для подключения';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="agency-connect-modal">
      <Card className="w-full max-w-lg mx-4 relative max-h-[90vh] overflow-y-auto">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground z-10"
        >
          <X className="w-5 h-5" />
        </button>

        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {showBack && (
              <button
                type="button"
                onClick={handleBack}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <KeyRound className="w-5 h-5 text-primary" />
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Step 1: Provider selection */}
          {step === 'select' && (
            <div className="space-y-2" data-testid="provider-list">
              {providers.map((provider: AgencyProvider) => (
                <button
                  key={provider._id}
                  type="button"
                  onClick={() => {
                    setSelectedProvider(provider);
                    setStep(provider.name === 'getuniq' ? 'fields' : 'fields');
                    setError(null);
                  }}
                  className={cn(
                    'w-full flex items-center justify-between p-4 rounded-lg border transition-all',
                    'hover:border-primary hover:bg-primary/5',
                    'text-left'
                  )}
                  data-testid={`provider-${provider.name}`}
                >
                  <div>
                    <div className="font-medium">{provider.displayName}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {provider.hasApi ? (
                        <span className="flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3 text-green-500" />
                          Автообновление токенов
                        </span>
                      ) : (
                        'Ручная замена токена'
                      )}
                    </div>
                  </div>
                  {provider.docsUrl && (
                    <ExternalLink className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Step 2: Provider fields */}
          {step === 'fields' && selectedProvider && (
            <div className="space-y-4" data-testid="provider-fields">
              {((selectedProvider.requiredFields ?? []) as ProviderField[]).map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium mb-1">{field.label}</label>
                  {field.type === 'textarea' ? (
                    <textarea
                      value={fieldValues[field.key] || ''}
                      onChange={(e) => handleFieldChange(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      rows={3}
                      className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none font-mono"
                      data-testid={`field-${field.key}`}
                    />
                  ) : (
                    <input
                      type={field.type === 'password' ? 'password' : 'text'}
                      value={fieldValues[field.key] || ''}
                      onChange={(e) => handleFieldChange(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                      data-testid={`field-${field.key}`}
                    />
                  )}
                </div>
              ))}

              {selectedProvider.docsUrl && (
                <a
                  href={selectedProvider.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="w-3 h-3" />
                  Документация API
                </a>
              )}

              <button
                type="button"
                onClick={selectedProvider.name === 'getuniq' ? handleGetuniqCredentialsSave : handleSubmit}
                disabled={loading}
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
                    {selectedProvider.name === 'getuniq' ? 'Сохранение...' : 'Подключение...'}
                  </>
                ) : (
                  selectedProvider.name === 'getuniq' ? 'Далее' : 'Подключить'
                )}
              </button>
            </div>
          )}

          {/* Step 3 (GetUNIQ): OAuth authorization button */}
          {step === 'getuniq_auth' && selectedProvider && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-muted text-sm text-muted-foreground">
                Credentials сохранены. Нажмите кнопку ниже — откроется окно авторизации GetUNIQ.
                После подтверждения доступа список ваших кабинетов загрузится автоматически.
              </div>

              <button
                type="button"
                onClick={handleGetuniqAuth}
                disabled={loading}
                className={cn(
                  'w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
                  'bg-primary text-primary-foreground hover:bg-primary/90',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Загрузка...
                  </>
                ) : (
                  <>
                    <ExternalLink className="w-4 h-4" />
                    Авторизоваться в GetUNIQ
                  </>
                )}
              </button>
            </div>
          )}

          {/* Step 4 (GetUNIQ): Account picker */}
          {step === 'getuniq_accounts' && (
            <div className="space-y-2" data-testid="getuniq-account-list">
              {getuniqAccounts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  Нет подтверждённых кабинетов в GetUNIQ
                </div>
              ) : (
                getuniqAccounts.map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => handleGetuniqConnect(account)}
                    disabled={loading}
                    className={cn(
                      'w-full flex items-center justify-between p-4 rounded-lg border transition-all text-left',
                      'hover:border-primary hover:bg-primary/5',
                      'disabled:opacity-50'
                    )}
                  >
                    <div>
                      <div className="font-medium">
                        {account.name || account.login || `Кабинет #${account.id}`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        ID: {account.id}
                        {account.status && ` · ${account.status}`}
                      </div>
                    </div>
                    {loading ? (
                      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                    ) : (
                      <span className="text-xs text-primary">Подключить</span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
