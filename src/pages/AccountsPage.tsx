import { useState, useEffect, useRef } from 'react';
import { useQuery, useAction, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { AccountList } from '../components/AccountList';
import { VkAdsConnectWizard } from '../components/VkAdsConnectWizard';
import { UpgradeModal } from '../components/UpgradeModal';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Building2, Loader2, AlertCircle, RefreshCw, Link } from 'lucide-react';
import { cn } from '../lib/utils';
import { Id } from '../../convex/_generated/dataModel';

export function AccountsPage() {
  const { user } = useAuth();
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  const accounts = useQuery(
    api.adAccounts.list,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  const limits = useQuery(
    api.users.getLimits,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  const fetchAndConnect = useAction(api.adAccounts.fetchAndConnect);
  const disconnectAccount = useMutation(api.adAccounts.disconnect);
  const syncNow = useAction(api.adAccounts.syncNow);

  const autoFetchedRef = useRef(false);

  // Auto-fetch VK Ads accounts on page load
  useEffect(() => {
    if (!user?.userId || autoFetchedRef.current) return;
    autoFetchedRef.current = true;

    setIsConnecting(true);
    fetchAndConnect({ userId: user.userId as Id<"users"> })
      .then(() => {
        if (success) setSuccess(null);
      })
      .catch((err) => {
        if (err instanceof Error && err.message.includes('Подключите VK Ads')) {
          // Token not available — user needs to connect VK Ads first
        } else if (err instanceof Error && err.message.includes('заново')) {
          setError('Токен истёк. Подключите VK Ads заново.');
        }
        // Silently ignore other errors on auto-fetch
      })
      .finally(() => {
        setIsConnecting(false);
      });
  }, [user?.userId, fetchAndConnect, success]);

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const canAddAccount = limits?.canAddAccount ?? true;

  const handleConnectClick = () => {
    if (!canAddAccount) {
      setShowUpgradeModal(true);
      return;
    }
    setShowWizard(true);
  };

  const handleUpgrade = (_tier: 'start' | 'pro') => {
    // TODO: integrate with billing in Sprint 24
    setShowUpgradeModal(false);
    setSuccess('Функция оплаты будет доступна в ближайшее время.');
  };

  const handleRefresh = async () => {
    setIsConnecting(true);
    setError(null);

    try {
      const result = await fetchAndConnect({
        userId: user.userId as Id<"users">,
      });

      if (result.connected === 0 && result.accounts.length === 0) {
        setError('Нет доступных кабинетов VK Ads');
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('Подключите VK Ads')) {
          setError('Сначала подключите VK Ads (кнопка выше).');
        } else {
          setError(err.message);
        }
      } else {
        setError('Ошибка VK Ads API');
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

  // Format usage/limit label
  const usageLabel = limits
    ? limits.limits.accounts === Infinity
      ? `${limits.usage.accounts} / ∞`
      : `${limits.usage.accounts} / ${limits.limits.accounts}`
    : null;

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
        <div className="flex items-center gap-2">
          {/* Usage badge */}
          {usageLabel && (
            <span
              className={cn(
                'px-2.5 py-1 rounded-full text-xs font-medium',
                canAddAccount
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-warning/10 text-warning'
              )}
              data-testid="usage-badge"
            >
              {usageLabel}
            </span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isConnecting}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
              'bg-secondary text-secondary-foreground hover:bg-secondary/80',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            data-testid="refresh-button"
          >
            {isConnecting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Загрузка...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                Обновить
              </>
            )}
          </button>
          <button
            type="button"
            onClick={handleConnectClick}
            disabled={isConnecting}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
              'bg-primary text-primary-foreground hover:bg-primary/90',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            data-testid="connect-vk-ads-button"
          >
            <Link className="w-4 h-4" />
            Подключить VK Ads
          </button>
        </div>
      </div>

      {/* Success */}
      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
          <span>{success}</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm"
          data-testid="accounts-error"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
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
                : 'Нет подключённых кабинетов. Нажмите «Подключить VK Ads».'}
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

      {/* Wizard modal */}
      {showWizard && (
        <VkAdsConnectWizard
          userId={user.userId}
          onClose={() => setShowWizard(false)}
          onConnected={() => {
            setShowWizard(false);
            setSuccess('Кабинеты VK Ads успешно подключены!');
          }}
        />
      )}

      {/* Upgrade modal */}
      {showUpgradeModal && limits && (
        <UpgradeModal
          currentTier={limits.tier}
          limitType="accounts"
          currentUsage={limits.usage.accounts}
          limit={limits.limits.accounts}
          onClose={() => setShowUpgradeModal(false)}
          onUpgrade={handleUpgrade}
        />
      )}
    </div>
  );
}
