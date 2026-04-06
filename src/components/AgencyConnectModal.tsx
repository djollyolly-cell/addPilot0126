import { useState } from 'react';
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

export function AgencyConnectModal({ userId, onClose, onConnected }: AgencyConnectModalProps) {
  const typedUserId = userId as Id<"users">;
  const connectAgency = useAction(api.adAccounts.connectAgencyAccount);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saveCredentials = useMutation((api as any).agencyProviders.saveCredentials);

  // Load all providers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers = useQuery((api as any).agencyProviders.list) as AgencyProvider[] | undefined;

  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedProviderData = providers?.find((p: AgencyProvider) => p._id === selectedProvider);

  const handleFieldChange = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleBack = () => {
    setSelectedProvider(null);
    setFieldValues({});
    setError(null);
  };

  const handleSubmit = async () => {
    if (!selectedProviderData) return;

    const fields = (selectedProviderData.requiredFields ?? []) as ProviderField[];

    // Validate all required fields
    for (const field of fields) {
      if (!fieldValues[field.key]?.trim()) {
        setError(`Заполните поле: ${field.label}`);
        return;
      }
    }

    setLoading(true);
    setError(null);

    try {
      const providerName = selectedProviderData.name;
      const providerId = selectedProviderData._id as Id<"agencyProviders">;

      if (providerName === "vitamin") {
        // Save API key as credential, then connect account with token from Vitamin API
        await saveCredentials({
          userId: typedUserId,
          providerId,
          apiKey: fieldValues.apiKey.trim(),
        });

        // For now, connect as agency account — token refresh will use the saved credentials
        // The user still needs to provide initial token or we fetch it via Vitamin API
        // TODO: auto-fetch token via Vitamin API using apiKey + cabinetId
        // For now: show success that credentials are saved
        onConnected();
      } else if (providerName === "getuniq") {
        // Save OAuth credentials
        await saveCredentials({
          userId: typedUserId,
          providerId,
          oauthClientId: fieldValues.clientId.trim(),
          oauthClientSecret: fieldValues.clientSecret.trim(),
        });
        // TODO: trigger OAuth flow to get access token, then fetch cabinet token
        onConnected();
      } else if (providerName === "targethunter" || providerName === "cerebro") {
        // Manual token — connect directly via existing connectAgencyAccount
        const accountName = fieldValues.accountName?.trim() ||
          `${selectedProviderData.displayName} кабинет`;

        await connectAgency({
          userId: typedUserId,
          accessToken: fieldValues.accessToken.trim(),
          name: accountName,
        });

        // Save credential record for tracking
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

  // Loading state
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
            {selectedProvider && (
              <button
                type="button"
                onClick={handleBack}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <KeyRound className="w-5 h-5 text-primary" />
            {selectedProvider ? selectedProviderData?.displayName : 'Агентский кабинет'}
          </CardTitle>
          <CardDescription>
            {selectedProvider
              ? selectedProviderData?.notes || 'Заполните данные для подключения'
              : 'Выберите сервис, через который работает ваш рекламный кабинет'
            }
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

          {!selectedProvider ? (
            // Step 1: Provider selection
            <div className="space-y-2" data-testid="provider-list">
              {providers.map((provider: AgencyProvider) => (
                <button
                  key={provider._id}
                  type="button"
                  onClick={() => {
                    setSelectedProvider(provider._id);
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
          ) : (
            // Step 2: Provider-specific fields
            <div className="space-y-4" data-testid="provider-fields">
              {((selectedProviderData?.requiredFields ?? []) as ProviderField[]).map((field) => (
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

              {/* Docs link */}
              {selectedProviderData?.docsUrl && (
                <a
                  href={selectedProviderData.docsUrl}
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
                onClick={handleSubmit}
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
                    Подключение...
                  </>
                ) : (
                  'Подключить'
                )}
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
