import { useState, useCallback } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import {
  FileBarChart,
  Loader2,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  Search,
  ChevronsDownUp,
  ChevronsUpDown,
  Building2,
  Target,
} from 'lucide-react';
import { cn } from '../lib/utils';

// ─── Types (match backend) ──────────────────────────────────────────

interface BannerReport {
  id: number;
  name: string;
  status: string;
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  ctr: number;
  cpl: number;
}

interface GroupReport {
  id: number;
  name: string;
  status: string;
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  ctr: number;
  cpl: number;
  banners: BannerReport[];
}

interface CampaignReport {
  objective: string;
  objectiveLabel: string;
  groups: GroupReport[];
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  ctr: number;
  cpl: number;
}

interface AccountReport {
  id: number;
  name: string;
  campaigns: CampaignReport[];
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  ctr: number;
  cpl: number;
}

interface ReportData {
  accounts: AccountReport[];
  dateFrom: string;
  dateTo: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekAgoStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return d.toISOString().slice(0, 10);
}

function formatCurrency(value: number): string {
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' \u20BD';
}

function formatNumber(value: number): string {
  return value.toLocaleString('ru-RU');
}

function formatPercent(value: number): string {
  return value.toFixed(2) + '%';
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; className: string }> = {
    active: { label: 'Активна', className: 'bg-green-500/10 text-green-700' },
    blocked: { label: 'Остановлена', className: 'bg-red-500/10 text-red-600' },
    deleted: { label: 'Удалена', className: 'bg-muted text-muted-foreground' },
  };
  const info = map[status] || { label: status, className: 'bg-muted text-muted-foreground' };
  return (
    <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', info.className)}>
      {info.label}
    </span>
  );
}

// ─── Stat row (reusable) ────────────────────────────────────────────

function StatCells({ impressions, clicks, ctr, spent, leads, cpl, muted }: {
  impressions: number; clicks: number; ctr: number;
  spent: number; leads: number; cpl: number; muted?: boolean;
}) {
  const cls = muted ? 'text-muted-foreground' : '';
  return (
    <>
      <td className={cn('py-2 text-right tabular-nums', cls)}>{formatNumber(impressions)}</td>
      <td className={cn('py-2 text-right tabular-nums', cls)}>{formatNumber(clicks)}</td>
      <td className={cn('py-2 text-right tabular-nums', cls)}>{formatPercent(ctr)}</td>
      <td className={cn('py-2 text-right tabular-nums', cls)}>{formatCurrency(spent)}</td>
      <td className={cn('py-2 text-right tabular-nums', cls)}>{formatNumber(leads)}</td>
      <td className={cn('py-2 text-right tabular-nums', cls)}>{cpl > 0 ? formatCurrency(cpl) : '—'}</td>
    </>
  );
}

// ─── Main component ─────────────────────────────────────────────────

export function ReportsPage() {
  const { user } = useAuth();
  const userId = user?.userId as Id<'users'> | undefined;

  const [dateFrom, setDateFrom] = useState(weekAgoStr());
  const [dateTo, setDateTo] = useState(todayStr());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);

  // Expanded state per level
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(new Set());
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());

  const fetchReport = useAction(api.reports.fetchReport);

  const handleFetch = useCallback(async () => {
    if (!userId) return;
    if (!dateFrom || !dateTo) { setError('Выберите даты'); return; }
    if (dateFrom > dateTo) { setError('Дата начала не может быть позже даты окончания'); return; }

    setError(null);
    setLoading(true);
    try {
      const data = await fetchReport({ userId, dateFrom, dateTo });
      const rd = data as ReportData;
      setReport(rd);
      // Default: accounts + campaigns expanded, groups collapsed
      setExpandedAccounts(new Set(rd.accounts.map((a) => a.id)));
      setExpandedCampaigns(new Set(
        rd.accounts.flatMap((a) => a.campaigns.map((c) => `${a.id}:${c.objective}`))
      ));
      setExpandedGroups(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [userId, dateFrom, dateTo, fetchReport]);

  const toggle = <T,>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, id: T) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Totals
  const totals = report
    ? report.accounts.reduce(
        (acc, a) => ({
          groups: acc.groups + a.campaigns.reduce((s, c) => s + c.groups.length, 0),
          impressions: acc.impressions + a.impressions,
          clicks: acc.clicks + a.clicks,
          spent: acc.spent + a.spent,
          leads: acc.leads + a.leads,
        }),
        { groups: 0, impressions: 0, clicks: 0, spent: 0, leads: 0 }
      )
    : null;

  // IDs for expand/collapse all
  const allAccountIds = report ? report.accounts.map((a) => a.id) : [];
  const allCampaignKeys = report
    ? report.accounts.flatMap((a) => a.campaigns.map((c) => `${a.id}:${c.objective}`))
    : [];
  const allGroupIds = report
    ? report.accounts.flatMap((a) => a.campaigns.flatMap((c) => c.groups.map((g) => g.id)))
    : [];

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6" data-testid="reports-page">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <FileBarChart className="w-7 h-7" />
          Отчёты VK Ads
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Кабинет → Кампания → Группа → Объявление
        </p>
      </div>

      {/* Date picker */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Дата начала</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                max={todayStr()}
                className="block px-3 py-2 border border-border rounded-lg text-sm bg-background"
                data-testid="report-date-from"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Дата окончания</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                max={todayStr()}
                className="block px-3 py-2 border border-border rounded-lg text-sm bg-background"
                data-testid="report-date-to"
              />
            </div>
            <Button onClick={handleFetch} disabled={loading} className="gap-2" data-testid="report-fetch">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Загрузить
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Summary cards */}
      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <SummaryCard label="Групп" value={String(totals.groups)} />
          <SummaryCard label="Показы" value={formatNumber(totals.impressions)} />
          <SummaryCard label="Клики" value={formatNumber(totals.clicks)} />
          <SummaryCard label="Расход" value={formatCurrency(totals.spent)} />
          <SummaryCard label="Результаты" value={formatNumber(totals.leads)} />
        </div>
      )}

      {/* Report table */}
      {report && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">
                Статистика за {report.dateFrom} — {report.dateTo}
              </CardTitle>
              <div className="flex gap-1">
                <Button
                  variant="ghost" size="sm"
                  className="text-xs gap-1 text-muted-foreground"
                  onClick={() => {
                    setExpandedAccounts(new Set(allAccountIds));
                    setExpandedCampaigns(new Set(allCampaignKeys));
                    setExpandedGroups(new Set(allGroupIds));
                  }}
                  data-testid="expand-all"
                >
                  <ChevronsUpDown className="w-3.5 h-3.5" />
                  Все
                </Button>
                <Button
                  variant="ghost" size="sm"
                  className="text-xs gap-1 text-muted-foreground"
                  onClick={() => {
                    setExpandedAccounts(new Set());
                    setExpandedCampaigns(new Set());
                    setExpandedGroups(new Set());
                  }}
                  data-testid="collapse-all"
                >
                  <ChevronsDownUp className="w-3.5 h-3.5" />
                  Свернуть
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {report.accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Нет данных за выбранный период
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 font-medium pl-4">Название</th>
                      <th className="pb-2 font-medium">Статус</th>
                      <th className="pb-2 font-medium text-right">Показы</th>
                      <th className="pb-2 font-medium text-right">Клики</th>
                      <th className="pb-2 font-medium text-right">CTR</th>
                      <th className="pb-2 font-medium text-right">Расход</th>
                      <th className="pb-2 font-medium text-right">Результаты</th>
                      <th className="pb-2 font-medium text-right">CPL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.accounts.map((account) => (
                      <AccountSection
                        key={account.id}
                        account={account}
                        expandedAccounts={expandedAccounts}
                        expandedCampaigns={expandedCampaigns}
                        expandedGroups={expandedGroups}
                        onToggleAccount={() => toggle(setExpandedAccounts, account.id)}
                        onToggleCampaign={(key: string) => toggle(setExpandedCampaigns, key)}
                        onToggleGroup={(id: number) => toggle(setExpandedGroups, id)}
                      />
                    ))}
                    {/* Totals */}
                    {totals && (
                      <tr className="border-t-2 font-semibold">
                        <td className="py-3 pl-4">Итого</td>
                        <td />
                        <td className="py-3 text-right">{formatNumber(totals.impressions)}</td>
                        <td className="py-3 text-right">{formatNumber(totals.clicks)}</td>
                        <td className="py-3 text-right">
                          {totals.impressions > 0 ? formatPercent((totals.clicks / totals.impressions) * 100) : '—'}
                        </td>
                        <td className="py-3 text-right">{formatCurrency(totals.spent)}</td>
                        <td className="py-3 text-right">{formatNumber(totals.leads)}</td>
                        <td className="py-3 text-right">
                          {totals.leads > 0 ? formatCurrency(totals.spent / totals.leads) : '—'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {loading && !report && (
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

// ─── Summary card ───────────────────────────────────────────────────

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

// ─── Level 1: Кабинет (Account) ─────────────────────────────────────

function AccountSection({
  account, expandedAccounts, expandedCampaigns, expandedGroups,
  onToggleAccount, onToggleCampaign, onToggleGroup,
}: {
  account: AccountReport;
  expandedAccounts: Set<number>;
  expandedCampaigns: Set<string>;
  expandedGroups: Set<number>;
  onToggleAccount: () => void;
  onToggleCampaign: (key: string) => void;
  onToggleGroup: (id: number) => void;
}) {
  const isExpanded = expandedAccounts.has(account.id);
  return (
    <>
      <tr
        className="border-b cursor-pointer hover:bg-primary/5 transition-colors bg-muted/20"
        onClick={onToggleAccount}
        data-testid={`account-row-${account.id}`}
      >
        <td className="py-3 font-semibold">
          <div className="flex items-center gap-2 pl-1">
            {isExpanded
              ? <ChevronDown className="w-4 h-4 text-primary shrink-0" />
              : <ChevronRight className="w-4 h-4 text-primary shrink-0" />}
            <Building2 className="w-4 h-4 text-primary shrink-0" />
            <span className="truncate max-w-[220px]">{account.name}</span>
            <span className="text-xs text-muted-foreground font-normal ml-1">
              ({account.campaigns.length} кампаний)
            </span>
          </div>
        </td>
        <td className="py-3" />
        <StatCells {...account} />
      </tr>
      {isExpanded && account.campaigns.map((campaign) => (
        <CampaignSection
          key={campaign.objective}
          accountId={account.id}
          campaign={campaign}
          expandedCampaigns={expandedCampaigns}
          expandedGroups={expandedGroups}
          onToggleCampaign={onToggleCampaign}
          onToggleGroup={onToggleGroup}
        />
      ))}
    </>
  );
}

// ─── Level 2: Кампания (by objective) ───────────────────────────────

function CampaignSection({
  accountId, campaign, expandedCampaigns, expandedGroups,
  onToggleCampaign, onToggleGroup,
}: {
  accountId: number;
  campaign: CampaignReport;
  expandedCampaigns: Set<string>;
  expandedGroups: Set<number>;
  onToggleCampaign: (key: string) => void;
  onToggleGroup: (id: number) => void;
}) {
  const key = `${accountId}:${campaign.objective}`;
  const isExpanded = expandedCampaigns.has(key);
  return (
    <>
      <tr
        className="border-b cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => onToggleCampaign(key)}
        data-testid={`campaign-row-${campaign.objective}`}
      >
        <td className="py-2.5 font-medium">
          <div className="flex items-center gap-1.5 pl-6">
            {isExpanded
              ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
            <Target className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span>{campaign.objectiveLabel}</span>
            <span className="text-xs text-muted-foreground font-normal">
              ({campaign.groups.length} групп)
            </span>
          </div>
        </td>
        <td className="py-2.5" />
        <StatCells {...campaign} />
      </tr>
      {isExpanded && campaign.groups.map((group) => (
        <GroupSection
          key={group.id}
          group={group}
          expandedGroups={expandedGroups}
          onToggleGroup={onToggleGroup}
        />
      ))}
    </>
  );
}

// ─── Level 3: Группа объявлений (myTarget campaign) ─────────────────

function GroupSection({
  group, expandedGroups, onToggleGroup,
}: {
  group: GroupReport;
  expandedGroups: Set<number>;
  onToggleGroup: (id: number) => void;
}) {
  const isExpanded = expandedGroups.has(group.id);
  return (
    <>
      <tr
        className="border-b cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => onToggleGroup(group.id)}
        data-testid={`group-row-${group.id}`}
      >
        <td className="py-2">
          <div className="flex items-center gap-1 pl-12">
            {isExpanded
              ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
            <span className="truncate max-w-[200px]">{group.name}</span>
          </div>
        </td>
        <td className="py-2">{statusBadge(group.status)}</td>
        <StatCells {...group} />
      </tr>
      {isExpanded && group.banners.map((banner) => (
        <tr
          key={banner.id}
          className="border-b bg-muted/20"
          data-testid={`banner-row-${banner.id}`}
        >
          <td className="py-1.5 pl-20 text-muted-foreground">
            <span className="truncate max-w-[180px] inline-block text-xs">{banner.name}</span>
          </td>
          <td className="py-1.5">{statusBadge(banner.status)}</td>
          <StatCells {...banner} muted />
        </tr>
      ))}
    </>
  );
}
