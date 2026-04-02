import { useState, useCallback, useEffect } from 'react';
import { useQuery, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { ChevronDown, ChevronRight, Loader2, Monitor, Megaphone, ImageIcon } from 'lucide-react';
import { cn } from '../lib/utils';

export interface TargetSelection {
  accountIds: string[];
  campaignIds: string[];
  adIds: string[];
}

interface TargetTreeSelectorProps {
  userId: string;
  value: TargetSelection;
  onChange: (selection: TargetSelection) => void;
  ruleType?: string;
}

export function TargetTreeSelector({ userId, value, onChange, ruleType }: TargetTreeSelectorProps) {
  const accounts = useQuery(
    api.adAccounts.list,
    { userId: userId as Id<"users"> }
  );

  if (accounts === undefined) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-3 text-center">
        Нет подключённых кабинетов
      </p>
    );
  }

  // For uz_budget_manage — show only УЗ campaigns (package_id=960) from VK API
  if (ruleType === 'uz_budget_manage') {
    return (
      <div data-testid="target-tree" className="border rounded-lg p-3 space-y-1 max-h-72 overflow-y-auto">
        {accounts.map((account) => (
          <UzAccountNode
            key={account._id}
            account={account}
            value={value}
            onChange={onChange}
          />
        ))}
      </div>
    );
  }

  // All other rules — use VK API live data (campaigns + banners)
  return (
    <div data-testid="target-tree" className="border rounded-lg p-3 space-y-1 max-h-72 overflow-y-auto">
      {accounts.map((account) => (
        <LiveAccountNode
          key={account._id}
          account={account}
          value={value}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

// ─── УЗ Account node (VK API, package_id=960 only) ──

interface UzCampaign {
  id: string;
  name: string;
  status: string;
  budgetLimitDay: number;
}

function UzAccountNode({ account, value, onChange }: {
  account: { _id: string; name: string };
  value: TargetSelection;
  onChange: (selection: TargetSelection) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [campaigns, setCampaigns] = useState<UzCampaign[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchUz = useAction(api.vkApi.fetchUzCampaigns);

  const isAccountChecked = value.accountIds.includes(account._id);

  useEffect(() => {
    if (!expanded || campaigns !== null) return;
    setLoading(true);
    setError(null);
    fetchUz({ accountId: account._id as Id<"adAccounts"> })
      .then((result) => setCampaigns(result))
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка загрузки'))
      .finally(() => setLoading(false));
  }, [expanded, campaigns, fetchUz, account._id]);

  const handleAccountToggle = useCallback(() => {
    if (isAccountChecked) {
      const campaignIdsToRemove = new Set((campaigns || []).map((c) => c.id));
      onChange({
        accountIds: value.accountIds.filter((id) => id !== account._id),
        campaignIds: value.campaignIds.filter((id) => !campaignIdsToRemove.has(id)),
        adIds: [],
      });
    } else {
      onChange({ ...value, accountIds: [...value.accountIds, account._id] });
    }
  }, [isAccountChecked, account._id, campaigns, value, onChange]);

  const handleCampaignToggle = useCallback((campaignId: string) => {
    const isChecked = value.campaignIds.includes(campaignId);
    if (isChecked) {
      const remaining = value.campaignIds.filter((id) => id !== campaignId);
      // If no campaigns left in this account, auto-remove account too
      const accountCampaignIds = (campaigns || []).map((c) => c.id);
      const hasOtherSelected = remaining.some((id) => accountCampaignIds.includes(id));
      onChange({
        ...value,
        campaignIds: remaining,
        accountIds: hasOtherSelected || isAccountChecked
          ? value.accountIds
          : value.accountIds.filter((id) => id !== account._id),
      });
    } else {
      // Auto-add account when selecting a campaign
      const newAccountIds = value.accountIds.includes(account._id)
        ? value.accountIds
        : [...value.accountIds, account._id];
      onChange({
        ...value,
        accountIds: newAccountIds,
        campaignIds: [...value.campaignIds, campaignId],
      });
    }
  }, [value, onChange, account._id, campaigns, isAccountChecked]);

  return (
    <div>
      <div className="flex items-center gap-2 py-1.5 px-1 rounded hover:bg-muted/50">
        <button type="button" onClick={() => setExpanded(!expanded)} className="shrink-0 p-0.5">
          {expanded
            ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
            : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        </button>
        <input
          type="checkbox"
          checked={isAccountChecked}
          onChange={handleAccountToggle}
          className="rounded shrink-0"
        />
        <Monitor className="w-4 h-4 text-primary shrink-0" />
        <span className="text-sm truncate">{account.name}</span>
      </div>

      {expanded && (
        <div className="pl-6">
          {loading ? (
            <div className="flex items-center justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground ml-2">Загрузка кампаний из VK...</span>
            </div>
          ) : error ? (
            <p className="text-xs text-destructive py-1 pl-6">{error}</p>
          ) : campaigns && campaigns.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1 pl-6">Нет активных кампаний</p>
          ) : campaigns ? (
            campaigns.map((c) => {
              const isChecked = isAccountChecked || value.campaignIds.includes(c.id);
              return (
                <div key={c.id} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/50">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => handleCampaignToggle(c.id)}
                    disabled={isAccountChecked}
                    className={cn('rounded shrink-0 ml-5', isAccountChecked && 'opacity-50')}
                  />
                  <Megaphone className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="text-xs truncate">{c.name}</span>
                  {c.budgetLimitDay > 0 && (
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {c.budgetLimitDay}₽/день
                    </span>
                  )}
                  <StatusBadge status={c.status} />
                </div>
              );
            })
          ) : null}
        </div>
      )}
    </div>
  );
}

// ─── Status badge ───────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const label = status === 'active' ? 'Активна'
    : status === 'blocked' ? 'Приостановлена'
    : status;
  const color = status === 'active' ? 'text-green-600'
    : status === 'blocked' ? 'text-amber-500'
    : 'text-muted-foreground';
  return <span className={cn('text-[10px] shrink-0', color)}>{label}</span>;
}

// ─── Live Account node (VK API, all rules except uz_budget_manage) ──

interface LiveCampaign {
  id: number;
  name: string;
  status: string;
  objective: string;
  dailyLimit: number | null;
  allLimit: number | null;
  banners: LiveBanner[];
}

interface LiveBanner {
  id: number;
  name: string;
  status: string;
  moderationStatus: string;
}

function LiveAccountNode({ account, value, onChange }: {
  account: { _id: string; name: string };
  value: TargetSelection;
  onChange: (selection: TargetSelection) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [campaigns, setCampaigns] = useState<LiveCampaign[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchLive = useAction(api.adAccounts.fetchLiveCampaigns);

  const isAccountChecked = value.accountIds.includes(account._id);

  useEffect(() => {
    if (!expanded || campaigns !== null) return;
    setLoading(true);
    setError(null);
    fetchLive({ accountId: account._id as Id<"adAccounts"> })
      .then((result) => {
        // Filter: only active and blocked campaigns
        const filtered = result.campaigns.filter(
          (c) => c.status === 'active' || c.status === 'blocked'
        );
        setCampaigns(filtered);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка загрузки'))
      .finally(() => setLoading(false));
  }, [expanded, campaigns, fetchLive, account._id]);

  const handleAccountToggle = useCallback(() => {
    if (isAccountChecked) {
      const campaignIdsToRemove = new Set((campaigns || []).map((c) => String(c.id)));
      const bannerIdsToRemove = new Set(
        (campaigns || []).flatMap((c) => c.banners.map((b) => String(b.id)))
      );
      onChange({
        accountIds: value.accountIds.filter((id) => id !== account._id),
        campaignIds: value.campaignIds.filter((id) => !campaignIdsToRemove.has(id)),
        adIds: value.adIds.filter((id) => !bannerIdsToRemove.has(id)),
      });
    } else {
      onChange({ ...value, accountIds: [...value.accountIds, account._id] });
    }
  }, [isAccountChecked, account._id, campaigns, value, onChange]);

  return (
    <div>
      <div className="flex items-center gap-2 py-1.5 px-1 rounded hover:bg-muted/50">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 p-0.5"
          data-testid={`expand-account-${account._id}`}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
        </button>
        <input
          type="checkbox"
          checked={isAccountChecked}
          onChange={handleAccountToggle}
          className="rounded shrink-0"
          data-testid={`check-account-${account._id}`}
        />
        <Monitor className="w-4 h-4 text-primary shrink-0" />
        <span className="text-sm truncate">{account.name}</span>
      </div>

      {expanded && (
        <div className="pl-6">
          {loading ? (
            <div className="flex items-center justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground ml-2">Загрузка из VK...</span>
            </div>
          ) : error ? (
            <p className="text-xs text-destructive py-1 pl-6">{error}</p>
          ) : campaigns && campaigns.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1 pl-6">Нет активных кампаний</p>
          ) : campaigns ? (
            campaigns.map((campaign) => (
              <LiveCampaignNode
                key={campaign.id}
                campaign={campaign}
                accountId={account._id}
                isAccountChecked={isAccountChecked}
                value={value}
                onChange={onChange}
              />
            ))
          ) : null}
        </div>
      )}
    </div>
  );
}

// ─── Live Campaign node ─────────────────────────────

function LiveCampaignNode({ campaign, accountId, isAccountChecked, value, onChange }: {
  campaign: LiveCampaign;
  accountId: string;
  isAccountChecked: boolean;
  value: TargetSelection;
  onChange: (selection: TargetSelection) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const campaignId = String(campaign.id);
  const isChecked = value.campaignIds.includes(campaignId);
  const effectiveChecked = isAccountChecked || isChecked;

  // Filter banners: only active/blocked
  const activeBanners = campaign.banners.filter(
    (b) => b.status === 'active' || b.status === 'blocked'
  );

  const handleCampaignToggle = useCallback(() => {
    if (isChecked) {
      const bannerIdsToRemove = new Set(activeBanners.map((b) => String(b.id)));
      onChange({
        ...value,
        campaignIds: value.campaignIds.filter((id) => id !== campaignId),
        adIds: value.adIds.filter((id) => !bannerIdsToRemove.has(id)),
      });
    } else {
      // Auto-add account when selecting a campaign
      const newAccountIds = value.accountIds.includes(accountId)
        ? value.accountIds
        : [...value.accountIds, accountId];
      onChange({
        ...value,
        accountIds: newAccountIds,
        campaignIds: [...value.campaignIds, campaignId],
      });
    }
  }, [isChecked, campaignId, accountId, activeBanners, value, onChange]);

  return (
    <div>
      <div className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/50">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 p-0.5"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </button>
        <input
          type="checkbox"
          checked={effectiveChecked}
          onChange={handleCampaignToggle}
          disabled={isAccountChecked}
          className={cn('rounded shrink-0', isAccountChecked && 'opacity-50')}
        />
        <Megaphone className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-xs truncate">{campaign.name}</span>
        {campaign.dailyLimit && campaign.dailyLimit > 0 && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {campaign.dailyLimit}₽/день
          </span>
        )}
        <StatusBadge status={campaign.status} />
      </div>

      {expanded && (
        <div className="pl-6">
          {activeBanners.length === 0 ? (
            <p className="text-[10px] text-muted-foreground py-1 pl-6">Нет активных объявлений</p>
          ) : (
            activeBanners.map((banner) => (
              <LiveBannerNode
                key={banner.id}
                banner={banner}
                campaignId={campaignId}
                accountId={accountId}
                isParentChecked={effectiveChecked}
                value={value}
                onChange={onChange}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Live Banner (ad) node ──────────────────────────

function LiveBannerNode({ banner, campaignId, accountId, isParentChecked, value, onChange }: {
  banner: LiveBanner;
  campaignId: string;
  accountId: string;
  isParentChecked: boolean;
  value: TargetSelection;
  onChange: (selection: TargetSelection) => void;
}) {
  const bannerId = String(banner.id);
  const isChecked = value.adIds.includes(bannerId);
  const parentChecked =
    isParentChecked ||
    value.accountIds.includes(accountId) ||
    value.campaignIds.includes(campaignId);
  const effectiveChecked = parentChecked || isChecked;

  const handleToggle = useCallback(() => {
    if (isChecked) {
      onChange({
        ...value,
        adIds: value.adIds.filter((id) => id !== bannerId),
      });
    } else {
      // Auto-add account when selecting a banner
      const newAccountIds = value.accountIds.includes(accountId)
        ? value.accountIds
        : [...value.accountIds, accountId];
      onChange({
        ...value,
        accountIds: newAccountIds,
        adIds: [...value.adIds, bannerId],
      });
    }
  }, [isChecked, bannerId, accountId, value, onChange]);

  return (
    <div className="flex items-center gap-2 py-0.5 px-1 rounded hover:bg-muted/30">
      <input
        type="checkbox"
        checked={effectiveChecked}
        onChange={handleToggle}
        disabled={parentChecked}
        className={cn('rounded shrink-0 ml-5', parentChecked && 'opacity-50')}
      />
      <ImageIcon className="w-3 h-3 text-muted-foreground shrink-0" />
      <span className="text-[11px] truncate">{banner.name}</span>
      <StatusBadge status={banner.status} />
    </div>
  );
}
