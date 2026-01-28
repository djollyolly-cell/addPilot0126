import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { LayoutDashboard, Loader2, Trash2, CheckCircle2, Building2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { Link } from 'react-router-dom';

export function DashboardPage() {
  const { user } = useAuth();
  const typedUserId = user?.userId as Id<"users"> | undefined;

  const accounts = useQuery(
    api.adAccounts.list,
    typedUserId ? { userId: typedUserId } : 'skip'
  );

  const settings = useQuery(
    api.userSettings.get,
    typedUserId ? { userId: typedUserId } : 'skip'
  );

  const setActiveAccount = useMutation(api.userSettings.setActiveAccount);
  const disconnectAccount = useMutation(api.adAccounts.disconnect);

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const isLoading = accounts === undefined || settings === undefined;
  const activeAccountId = settings?.activeAccountId;

  const handleSelectAccount = async (accountId: Id<"adAccounts">) => {
    if (!typedUserId) return;
    await setActiveAccount({ userId: typedUserId, accountId });
  };

  const handleDeleteAccount = async (accountId: Id<"adAccounts">) => {
    if (!typedUserId) return;
    await disconnectAccount({ accountId, userId: typedUserId });
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6" data-testid="dashboard-page">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <LayoutDashboard className="w-7 h-7" />
          Дашборд
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Выберите активный рекламный кабинет
        </p>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : accounts.length === 0 ? (
        /* Empty state */
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
            <Building2 className="w-12 h-12 text-muted-foreground" />
            <div className="text-center space-y-1">
              <p className="text-lg font-medium text-foreground">
                Нет подключённых кабинетов
              </p>
              <p className="text-sm text-muted-foreground">
                Подключите рекламный кабинет VK Ads, чтобы начать работу
              </p>
            </div>
            <Link
              to="/accounts"
              className={cn(
                'inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
                'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              Подключить кабинет
            </Link>
          </CardContent>
        </Card>
      ) : (
        /* Account cards */
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Рекламные кабинеты</CardTitle>
            <CardDescription>
              Нажмите на кабинет, чтобы сделать его активным
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {accounts.map((account) => {
              const isActive = activeAccountId === account._id;
              return (
                <div
                  key={account._id}
                  onClick={() => handleSelectAccount(account._id as Id<"adAccounts">)}
                  className={cn(
                    'flex items-center gap-3 p-4 rounded-lg border cursor-pointer transition-colors',
                    isActive
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50'
                  )}
                  data-testid={`account-card-${account._id}`}
                >
                  <Building2 className="w-5 h-5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{account.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {account.status === 'active' ? 'Активен' : account.status === 'paused' ? 'Приостановлен' : 'Ошибка'}
                    </p>
                  </div>
                  {isActive && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-primary text-primary-foreground shrink-0">
                      Выбран
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteAccount(account._id as Id<"adAccounts">);
                    }}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                    title="Удалить кабинет"
                    data-testid={`delete-account-${account._id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
