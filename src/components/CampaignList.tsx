import { useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Megaphone, ChevronDown, ChevronRight, Loader2, ImageIcon, RefreshCw, AlertCircle } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { cn } from '../lib/utils';

const campaignStatusLabels: Record<string, { label: string; color: string }> = {
  active: { label: 'Активна', color: 'text-green-600' },
  blocked: { label: 'Заблокирована', color: 'text-red-600' },
  deleted: { label: 'Удалена', color: 'text-muted-foreground' },
};

function formatBudget(value?: number | null): string {
  if (!value || value === 0) return '—';
  // VK API returns budget in kopecks, convert to rubles
  const rubles = value / 100;
  return `${rubles.toLocaleString('ru-RU')} \u20BD`;
}

interface LiveCampaign {
  id: number;
  name: string;
  status: string;
  objective: string;
  dailyLimit: number | null;
  allLimit: number | null;
  banners: {
    id: number;
    name: string;
    status: string;
    moderationStatus: string;
  }[];
}

function BannersList({ banners }: { banners: LiveCampaign['banners'] }) {
  if (banners.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-2 pl-8">Нет объявлений</p>
    );
  }

  return (
    <div className="space-y-1 pl-8">
      {banners.map((banner) => {
        const modStatus = banner.moderationStatus === 'allowed' ? 'Одобрено' :
          banner.moderationStatus === 'banned' ? 'Отклонено' :
          banner.moderationStatus === 'moderation' ? 'На модерации' :
          banner.moderationStatus || '—';

        return (
          <div key={banner.id} className="flex items-center gap-2 py-1.5 px-2 rounded text-xs bg-muted/30">
            <ImageIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="truncate flex-1">{banner.name}</span>
            <span className="text-muted-foreground shrink-0">{modStatus}</span>
          </div>
        );
      })}
    </div>
  );
}

interface CampaignListProps {
  accountId: string;
}

const statusFilterOptions = [
  { value: 'all', label: 'Все' },
  { value: 'active', label: 'Активные' },
  { value: 'blocked', label: 'Заблокированные' },
  { value: 'deleted', label: 'Удалённые' },
];

export function CampaignList({ accountId }: CampaignListProps) {
  const fetchLive = useAction(api.adAccounts.fetchLiveCampaigns);
  const [campaigns, setCampaigns] = useState<LiveCampaign[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchLive({
        accountId: accountId as Id<"adAccounts">,
      });
      setCampaigns(result.campaigns);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [fetchLive, accountId]);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground ml-2">Загрузка из VK API...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-3 px-2 space-y-2">
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
        <button
          type="button"
          onClick={loadCampaigns}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <RefreshCw className="w-3 h-3" />
          Повторить
        </button>
      </div>
    );
  }

  if (!campaigns || campaigns.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-3 text-center">
        Нет кампаний в этом аккаунте.
      </p>
    );
  }

  const filtered = statusFilter === 'all'
    ? campaigns
    : campaigns.filter((c) => c.status === statusFilter);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 px-2 pb-1">
        {statusFilterOptions.map((opt) => {
          const count = opt.value === 'all'
            ? campaigns.length
            : campaigns.filter((c) => c.status === opt.value).length;
          if (count === 0 && opt.value !== 'all') return null;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatusFilter(opt.value)}
              className={cn(
                'text-xs px-2 py-0.5 rounded-full transition-colors',
                statusFilter === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              {opt.label} ({count})
            </button>
          );
        })}
        <button
          type="button"
          onClick={loadCampaigns}
          className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
          title="Обновить"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2 text-center">
          Нет кампаний с таким статусом
        </p>
      ) : null}
      {filtered.map((campaign) => {
        const isExpanded = expandedId === campaign.id;
        const statusInfo = campaignStatusLabels[campaign.status] || {
          label: campaign.status,
          color: 'text-muted-foreground',
        };

        return (
          <div key={campaign.id}>
            <button
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : campaign.id)}
              className="w-full flex items-center gap-2 py-2 px-2 rounded-md hover:bg-muted/50 transition-colors text-left"
            >
              {isExpanded ? (
                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
              <Megaphone className="w-4 h-4 text-primary shrink-0" />
              <span className="text-sm truncate flex-1">{campaign.name}</span>
              <span className={cn('text-xs shrink-0', statusInfo.color)}>
                {statusInfo.label}
              </span>
              {(campaign.dailyLimit || campaign.allLimit) && (
                <span className="text-xs text-muted-foreground shrink-0">
                  {campaign.dailyLimit ? `${formatBudget(campaign.dailyLimit)}/день` : formatBudget(campaign.allLimit)}
                </span>
              )}
            </button>
            {isExpanded && (
              <div className="pb-2">
                <BannersList banners={campaign.banners} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
