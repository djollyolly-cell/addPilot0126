import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '@/lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import { Link } from 'react-router-dom';
import {
  Wand2,
  Plus,
  Loader2,
  AlertCircle,
  Trash2,
  ChevronRight,
  Building2,
  Pause,
  Play,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';

const statusLabels: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  draft: { label: 'Черновик', variant: 'secondary' },
  creating: { label: 'Создаётся...', variant: 'warning' },
  active: { label: 'Активна', variant: 'success' },
  paused: { label: 'На паузе', variant: 'warning' },
  error: { label: 'Ошибка', variant: 'destructive' },
};

export default function AICabinetPage() {
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Get active account from settings
  const settings = useQuery(
    api.userSettings.get,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );
  const accountId = settings?.activeAccountId;

  const accounts = useQuery(
    api.adAccounts.list,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );
  const setActiveAccount = useMutation(api.userSettings.setActiveAccount);

  // AI campaigns for selected account
  const campaigns = useQuery(
    api.aiCabinet.listCampaigns,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );

  // Today's metrics for AI campaigns
  const accountMetrics = useQuery(
    api.aiCabinet.getAccountMetrics,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );

  const deleteCampaign = useMutation(api.aiCabinet.deleteCampaign);
  const toggleCampaignStatus = useAction(api.aiCabinet.toggleCampaignStatus);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const isLoading = campaigns === undefined;

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить кампанию? Это действие нельзя отменить.')) return;
    setDeletingId(id);
    try {
      await deleteCampaign({ id: id as Id<"aiCampaigns">, userId: user!.userId as Id<"users"> });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggle = async (id: string) => {
    setTogglingId(id);
    try {
      await toggleCampaignStatus({ campaignId: id as Id<"aiCampaigns"> });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="space-y-6" data-testid="ai-cabinet-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Wand2 className="h-6 w-6 text-primary" />
          AI Кабинет
        </h1>
        <Link to="/ai-cabinet/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Создать кампанию
          </Button>
        </Link>
      </div>

      {/* Account selector */}
      {accounts && accounts.length > 1 && (
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <select
            value={accountId || ''}
            onChange={async (e) => {
              if (user?.userId && e.target.value) {
                await setActiveAccount({
                  userId: user.userId as Id<"users">,
                  accountId: e.target.value as Id<"adAccounts">,
                });
              }
            }}
            className="border border-border rounded-lg px-3 py-1.5 text-sm bg-background"
          >
            {accounts.map((acc) => (
              <option key={acc._id} value={acc._id}>
                {acc.name || acc.vkAccountId}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Today's metrics */}
      {accountMetrics && accountId && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs text-muted-foreground">Расход за сегодня</p>
              <p className="text-2xl font-bold">{formatCurrency(accountMetrics.spent)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs text-muted-foreground">Лиды за сегодня</p>
              <p className="text-2xl font-bold">{accountMetrics.leads}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs text-muted-foreground">Средний CPL</p>
              <p className="text-2xl font-bold">
                {accountMetrics.leads > 0 ? formatCurrency(accountMetrics.cpl) : '—'}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">Закрыть</button>
        </div>
      )}

      {/* No account selected */}
      {!accountId && !isLoading && (
        <div className="text-center py-12">
          <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">Выберите аккаунт</h3>
          <p className="text-muted-foreground mb-4">
            Подключите рекламный аккаунт в разделе "Кабинеты"
          </p>
          <Link to="/accounts">
            <Button variant="outline">Перейти к кабинетам</Button>
          </Link>
        </div>
      )}

      {/* Loading */}
      {isLoading && accountId && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty state */}
      {campaigns && campaigns.length === 0 && (
        <div className="text-center py-12">
          <Wand2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">Нет AI-кампаний</h3>
          <p className="text-muted-foreground mb-4">
            Создайте первую кампанию — AI сгенерирует объявления автоматически
          </p>
          <Link to="/ai-cabinet/new">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Создать кампанию
            </Button>
          </Link>
        </div>
      )}

      {/* Campaign list */}
      {campaigns && campaigns.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {campaigns.map((campaign: any) => {
            const status = statusLabels[campaign.status] || statusLabels.draft;
            return (
              <Card key={campaign._id} className="group hover:border-primary/50 transition-colors">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base truncate">{campaign.name}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-1 truncate">
                        {campaign.businessDirection} — {campaign.objective}
                      </p>
                    </div>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-2 text-center mb-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Бюджет</p>
                      <p className="text-sm font-medium">{formatCurrency(campaign.dailyBudget)}/д</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Регионы</p>
                      <p className="text-sm font-medium">{campaign.regions.length}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Возраст</p>
                      <p className="text-sm font-medium">{campaign.ageFrom}–{campaign.ageTo}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Link to={`/ai-cabinet/${campaign._id}`} className="flex-1">
                      <Button variant="outline" size="sm" className="w-full">
                        Подробнее
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                    </Link>
                    {(campaign.status === 'active' || campaign.status === 'paused') && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        onClick={() => handleToggle(campaign._id)}
                        disabled={togglingId === campaign._id}
                        title={campaign.status === 'active' ? 'Поставить на паузу' : 'Возобновить'}
                      >
                        {togglingId === campaign._id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : campaign.status === 'active' ? (
                          <Pause className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(campaign._id)}
                      disabled={deletingId === campaign._id}
                    >
                      {deletingId === campaign._id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
