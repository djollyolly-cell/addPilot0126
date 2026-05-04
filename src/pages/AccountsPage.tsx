import { useState, useEffect, useRef } from 'react';
import { useQuery, useAction, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { AccountList } from '../components/AccountList';
import { VkAdsConnectWizard } from '../components/VkAdsConnectWizard';
import { AgencyConnectModal } from '../components/AgencyConnectModal';
import { UpgradeModal } from '../components/UpgradeModal';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Building2, Loader2, AlertCircle, RefreshCw, Link, KeyRound, MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '../lib/utils';
import { Id } from '../../convex/_generated/dataModel';

export function AccountsPage() {
  const { user, isAdmin } = useAuth();
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [showAgencyModal, setShowAgencyModal] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  const accounts = useQuery(
    api.adAccounts.list,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  const limits = useQuery(
    api.users.getLimits,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  const telegramStatus = useQuery(
    api.telegram.getConnectionStatus,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  const fetchAndConnect = useAction(api.adAccounts.fetchAndConnect);
  const disconnectAccount = useMutation(api.adAccounts.disconnect);
  const syncNow = useAction(api.adAccounts.syncNow);
  const navigate = useNavigate();

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

  const handleAgencyClick = () => {
    if (!canAddAccount) {
      setShowUpgradeModal(true);
      return;
    }
    setShowAgencyModal(true);
  };

  const handleUpgrade = () => {
    setShowUpgradeModal(false);
    navigate('/pricing');
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
    ? `${limits.usage.accounts} / ${limits.limits.accounts}`
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
            onClick={handleAgencyClick}
            disabled={isConnecting}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
              'border-2 border-primary text-primary hover:bg-primary/5',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            data-testid="connect-agency-button"
          >
            <KeyRound className="w-4 h-4" />
            Агентский кабинет
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

      {/* Telegram banner — show when accounts exist but Telegram not connected */}
      {accounts && accounts.length > 0 && telegramStatus && !telegramStatus.connected && (
        <div className="flex items-center gap-3 p-4 rounded-xl border border-primary/20 bg-primary/5">
          <div className="p-2 rounded-lg bg-primary/10 shrink-0">
            <MessageCircle className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium">Подключите Telegram-бота</p>
            <p className="text-xs text-muted-foreground">
              Получайте мгновенные оповещения об остановке объявлений и срабатывании правил
            </p>
          </div>
          <button
            onClick={() => navigate('/settings', { state: { tab: 'telegram' } })}
            className="shrink-0 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Подключить
          </button>
        </div>
      )}

      {/* Token recovery warnings */}
      {accounts && accounts.filter(a => a.status === "error" && a.tokenErrorSince).map(acc => {
        const daysPassed = Math.floor((Date.now() - (acc.tokenErrorSince ?? 0)) / (24 * 60 * 60 * 1000));
        const daysLeft = Math.max(0, 7 - daysPassed);
        return (
          <div key={acc._id} className="flex items-start gap-3 p-4 rounded-lg bg-warning/10 border border-warning/20">
            <AlertCircle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                Кабинет «{acc.name}» — токен недействителен
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {daysLeft > 0
                  ? `Автовосстановление: попытка ${acc.tokenRecoveryAttempts ?? 1}, осталось ${daysLeft} дн.`
                  : "Автовосстановление не удалось. Переподключите кабинет."}
              </p>
            </div>
          </div>
        );
      })}

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
              accounts={accounts.map((a: any) => ({
                _id: a._id as string,
                vkAccountId: a.vkAccountId,
                name: a.name,
                status: a.status,
                lastSyncAt: a.lastSyncAt,
                lastError: a.lastError,
                mtAdvertiserId: a.mtAdvertiserId,
              }))}
              userId={user.userId}
              onSync={handleSync}
              onDisconnect={handleDisconnect}
              onActivated={(msg) => {
                setError(null);
                setSuccess(msg);
                setTimeout(() => setSuccess(null), 5000);
              }}
              onActivationError={(msg) => {
                setSuccess(null);
                setError(msg);
              }}
              isAdmin={isAdmin}
              sessionToken={isAdmin ? (localStorage.getItem('adpilot_session') || undefined) : undefined}
            />
          )}
        </CardContent>
      </Card>

      {/* Admin: problem accounts from all users */}
      {isAdmin && <AdminProblemAccounts sessionToken={localStorage.getItem('adpilot_session') || ''} />}

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

      {/* Agency connect modal */}
      {showAgencyModal && (
        <AgencyConnectModal
          userId={user.userId}
          onClose={() => setShowAgencyModal(false)}
          onConnected={() => {
            setShowAgencyModal(false);
            setSuccess('Агентский кабинет успешно подключён!');
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

/** Admin-only section: all error + abandoned accounts across all users */
function AdminProblemAccounts({ sessionToken }: { sessionToken: string }) {
  const problemAccounts = useQuery(api.admin.listProblemAccounts, { sessionToken });
  const abandonAccount = useMutation(api.admin.abandonAccount);
  const reactivateAccount = useMutation(api.admin.reactivateAccount);
  const [loading, setLoading] = useState<string | null>(null);

  if (!problemAccounts || problemAccounts.length === 0) return null;

  const formatTime = (ts?: number) =>
    ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-destructive" />
          Проблемные кабинеты (все пользователи)
        </CardTitle>
        <CardDescription>
          {problemAccounts.length} {problemAccounts.length === 1 ? 'кабинет' : 'кабинетов'} в error/abandoned
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {problemAccounts.map((a) => (
            <div
              key={a._id}
              className={cn(
                'flex items-center justify-between gap-3 p-3 rounded-lg border',
                a.status === 'abandoned' ? 'bg-muted/50 border-muted' : 'bg-destructive/5 border-destructive/20'
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{a.name}</span>
                  <span className={cn(
                    'text-xs px-1.5 py-0.5 rounded',
                    a.status === 'abandoned' ? 'bg-muted text-muted-foreground' : 'bg-destructive/10 text-destructive'
                  )}>
                    {a.status}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {a.userName} &middot; ID: {a.vkAccountId} &middot; sync: {formatTime(a.lastSyncAt)}
                </p>
                {a.lastError && (
                  <p className="text-xs text-destructive/80 mt-0.5 truncate">{a.lastError}</p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {a.status === 'error' && (
                  <button
                    type="button"
                    disabled={loading === a._id}
                    onClick={async () => {
                      setLoading(a._id);
                      try { await abandonAccount({ sessionToken, accountId: a._id as Id<"adAccounts"> }); }
                      finally { setLoading(null); }
                    }}
                    className="px-2 py-1 text-xs rounded bg-muted hover:bg-orange-100 text-muted-foreground hover:text-orange-700 transition-colors disabled:opacity-50"
                    title="Заглушить"
                  >
                    Заглушить
                  </button>
                )}
                {a.status === 'abandoned' && (
                  <button
                    type="button"
                    disabled={loading === a._id}
                    onClick={async () => {
                      setLoading(a._id);
                      try { await reactivateAccount({ sessionToken, accountId: a._id as Id<"adAccounts"> }); }
                      finally { setLoading(null); }
                    }}
                    className="px-2 py-1 text-xs rounded bg-muted hover:bg-green-100 text-muted-foreground hover:text-green-700 transition-colors disabled:opacity-50"
                    title="Вернуть в error"
                  >
                    Вернуть
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
