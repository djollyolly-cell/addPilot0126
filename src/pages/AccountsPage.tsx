import { useState } from 'react';
import { useQuery, useAction, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { AccountList } from '../components/AccountList';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Building2, Plus, Loader2, AlertCircle, LogIn } from 'lucide-react';
import { cn } from '../lib/utils';
import { Id } from '../../convex/_generated/dataModel';

export function AccountsPage() {
  const { user } = useAuth();
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = useQuery(
    api.adAccounts.list,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  const getVkAccounts = useAction(api.vkApi.getAccounts);
  const connectAccount = useMutation(api.adAccounts.connect);
  const disconnectAccount = useMutation(api.adAccounts.disconnect);
  const syncNow = useAction(api.adAccounts.syncNow);

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const handleConnect = async () => {
    setIsConnecting(true);
    setError(null);

    try {
      // Get the user's access token from their session/account
      // For now we use the token stored in the first connected account or from auth
      const vkAccounts = await getVkAccounts({
        accessToken: '', // This will be populated from stored VK token
      });

      if (!vkAccounts || vkAccounts.length === 0) {
        setError('Нет доступных кабинетов VK Ads');
        return;
      }

      // Connect each available account
      for (const vkAccount of vkAccounts) {
        try {
          await connectAccount({
            userId: user.userId as Id<"users">,
            vkAccountId: String(vkAccount.account_id),
            name: vkAccount.account_name || `Кабинет ${vkAccount.account_id}`,
            accessToken: '', // Access token will come from VK OAuth
          });
        } catch (err) {
          // Skip duplicates or limit errors
          if (err instanceof Error && !err.message.includes('уже подключён')) {
            throw err;
          }
        }
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'TOKEN_EXPIRED') {
          setError('Токен истёк. Переавторизуйтесь.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Ошибка VK API');
      }
    } finally {
      setIsConnecting(false);
    }
  };

  const handleSync = async (accountId: string) => {
    await syncNow({
      accountId: accountId as Id<"adAccounts">,
      userId: user.userId as Id<"users">,
    });
  };

  const handleDisconnect = async (accountId: string) => {
    setError(null);
    try {
      await disconnectAccount({
        accountId: accountId as Id<"adAccounts">,
        userId: user.userId as Id<"users">,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка при отключении');
    }
  };

  const isLoading = accounts === undefined;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6" data-testid="accounts-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Building2 className="w-7 h-7" />
            Рекламные кабинеты
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Подключённые кабинеты VK Ads
          </p>
        </div>
        <button
          type="button"
          onClick={handleConnect}
          disabled={isConnecting}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
            'bg-primary text-primary-foreground hover:bg-primary/90',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
          data-testid="connect-button"
        >
          {isConnecting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Подключение...
            </>
          ) : (
            <>
              <Plus className="w-4 h-4" />
              Подключить
            </>
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div
          className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm"
          data-testid="accounts-error"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          {error.includes('Переавторизуйтесь') && (
            <a
              href="/login"
              className="inline-flex items-center gap-1 ml-auto text-sm font-medium underline"
              data-testid="reauth-link"
            >
              <LogIn className="w-3 h-3" />
              Войти
            </a>
          )}
        </div>
      )}

      {/* Content */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Кабинеты VK Ads</CardTitle>
          <CardDescription>
            {isLoading
              ? 'Загрузка...'
              : accounts.length > 0
                ? `${accounts.length} ${accounts.length === 1 ? 'кабинет' : accounts.length < 5 ? 'кабинета' : 'кабинетов'} подключено`
                : 'Нет подключённых кабинетов'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : (
            <AccountList
              accounts={accounts.map((a: { _id: string; vkAccountId: string; name: string; status: 'active' | 'paused' | 'error'; lastSyncAt?: number; lastError?: string }) => ({
                _id: a._id as string,
                vkAccountId: a.vkAccountId,
                name: a.name,
                status: a.status,
                lastSyncAt: a.lastSyncAt,
                lastError: a.lastError,
              }))}
              onSync={handleSync}
              onDisconnect={handleDisconnect}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
