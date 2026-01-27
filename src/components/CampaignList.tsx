import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Megaphone, ChevronDown, ChevronRight, Loader2, ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/utils';

const campaignStatusLabels: Record<string, { label: string; color: string }> = {
  active: { label: 'Активна', color: 'text-green-600' },
  blocked: { label: 'Заблокирована', color: 'text-red-600' },
  deleted: { label: 'Удалена', color: 'text-muted-foreground' },
};

function formatBudget(value?: number): string {
  if (!value || value === 0) return '—';
  return `${value.toLocaleString('ru-RU')} \u20BD`;
}

function AdsList({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const ads = useQuery(api.adAccounts.listAds, { campaignId });

  if (ads === undefined) {
    return (
      <div className="flex items-center justify-center py-3">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (ads.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-2 pl-8">Нет объявлений</p>
    );
  }

  return (
    <div className="space-y-1 pl-8">
      {ads.map((ad) => {
        const modStatus = ad.approved === 'allowed' ? 'Одобрено' :
          ad.approved === 'banned' ? 'Отклонено' :
          ad.approved === 'moderation' ? 'На модерации' :
          ad.approved || '—';

        return (
          <div key={ad._id} className="flex items-center gap-2 py-1.5 px-2 rounded text-xs bg-muted/30">
            <ImageIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="truncate flex-1">{ad.name}</span>
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

export function CampaignList({ accountId }: CampaignListProps) {
  const campaigns = useQuery(api.adAccounts.listCampaigns, {
    accountId: accountId as Id<"adAccounts">,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (campaigns === undefined) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (campaigns.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-3 text-center">
        Нет кампаний. Нажмите «Синхронизировать».
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {campaigns.map((campaign) => {
        const isExpanded = expandedId === campaign._id;
        const statusInfo = campaignStatusLabels[campaign.status] || {
          label: campaign.status,
          color: 'text-muted-foreground',
        };

        return (
          <div key={campaign._id}>
            <button
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : campaign._id)}
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
                <AdsList campaignId={campaign._id} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
