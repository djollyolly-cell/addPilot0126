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
} from 'lucide-react';
import { cn } from '../lib/utils';

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

interface CampaignReport {
  id: number;
  name: string;
  status: string;
  objective: string;
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  ctr: number;
  cpl: number;
  banners: BannerReport[];
}

interface ReportData {
  campaigns: CampaignReport[];
  dateFrom: string;
  dateTo: string;
}

function todayStr(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
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

export function ReportsPage() {
  const { user } = useAuth();
  const userId = user?.userId as Id<'users'> | undefined;

  const [dateFrom, setDateFrom] = useState(weekAgoStr());
  const [dateTo, setDateTo] = useState(todayStr());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<number>>(new Set());

  const fetchReport = useAction(api.reports.fetchReport);

  const handleFetch = useCallback(async () => {
    if (!userId) return;
    if (!dateFrom || !dateTo) {
      setError('Выберите даты');
      return;
    }
    if (dateFrom > dateTo) {
      setError('Дата начала не может быть позже даты окончания');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const data = await fetchReport({ userId, dateFrom, dateTo });
      setReport(data as ReportData);
      // Default: campaign-level view (collapsed)
      setExpandedCampaigns(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [userId, dateFrom, dateTo, fetchReport]);

  const toggleCampaign = (id: number) => {
    setExpandedCampaigns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Totals
  const totals = report
    ? report.campaigns.reduce(
        (acc, c) => ({
          impressions: acc.impressions + c.impressions,
          clicks: acc.clicks + c.clicks,
          spent: acc.spent + c.spent,
          leads: acc.leads + c.leads,
        }),
        { impressions: 0, clicks: 0, spent: 0, leads: 0 }
      )
    : null;

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
          Реальная статистика из рекламного кабинета VK
        </p>
      </div>

      {/* Date picker + fetch button */}
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
            <Button
              onClick={handleFetch}
              disabled={loading}
              className="gap-2"
              data-testid="report-fetch"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
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
          <SummaryCard label="Кампаний" value={String(report!.campaigns.length)} />
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
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1 text-muted-foreground"
                  onClick={() => setExpandedCampaigns(new Set(report.campaigns.map((c) => c.id)))}
                  data-testid="expand-all"
                >
                  <ChevronsUpDown className="w-3.5 h-3.5" />
                  Все
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1 text-muted-foreground"
                  onClick={() => setExpandedCampaigns(new Set())}
                  data-testid="collapse-all"
                >
                  <ChevronsDownUp className="w-3.5 h-3.5" />
                  Свернуть
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {report.campaigns.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Нет данных за выбранный период
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 font-medium pl-8">Название</th>
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
                    {report.campaigns.map((campaign) => {
                      const isExpanded = expandedCampaigns.has(campaign.id);
                      return (
                        <CampaignRow
                          key={campaign.id}
                          campaign={campaign}
                          isExpanded={isExpanded}
                          onToggle={() => toggleCampaign(campaign.id)}
                        />
                      );
                    })}
                    {/* Totals row */}
                    {totals && (
                      <tr className="border-t-2 font-semibold">
                        <td className="py-3 pl-8">Итого</td>
                        <td />
                        <td className="py-3 text-right">{formatNumber(totals.impressions)}</td>
                        <td className="py-3 text-right">{formatNumber(totals.clicks)}</td>
                        <td className="py-3 text-right">
                          {totals.impressions > 0
                            ? formatPercent((totals.clicks / totals.impressions) * 100)
                            : '—'}
                        </td>
                        <td className="py-3 text-right">{formatCurrency(totals.spent)}</td>
                        <td className="py-3 text-right">{formatNumber(totals.leads)}</td>
                        <td className="py-3 text-right">
                          {totals.leads > 0
                            ? formatCurrency(totals.spent / totals.leads)
                            : '—'}
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

      {/* Loading overlay */}
      {loading && !report && (
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

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

function CampaignRow({
  campaign,
  isExpanded,
  onToggle,
}: {
  campaign: CampaignReport;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      {/* Campaign row */}
      <tr
        className="border-b cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onToggle}
        data-testid={`campaign-row-${campaign.id}`}
      >
        <td className="py-2.5 font-medium">
          <div className="flex items-center gap-1">
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
            )}
            <span className="truncate max-w-[250px]">{campaign.name}</span>
          </div>
        </td>
        <td className="py-2.5">{statusBadge(campaign.status)}</td>
        <td className="py-2.5 text-right tabular-nums">{formatNumber(campaign.impressions)}</td>
        <td className="py-2.5 text-right tabular-nums">{formatNumber(campaign.clicks)}</td>
        <td className="py-2.5 text-right tabular-nums">{formatPercent(campaign.ctr)}</td>
        <td className="py-2.5 text-right tabular-nums">{formatCurrency(campaign.spent)}</td>
        <td className="py-2.5 text-right tabular-nums">{formatNumber(campaign.leads)}</td>
        <td className="py-2.5 text-right tabular-nums">
          {campaign.cpl > 0 ? formatCurrency(campaign.cpl) : '—'}
        </td>
      </tr>
      {/* Banner rows */}
      {isExpanded &&
        campaign.banners.map((banner) => (
          <tr
            key={banner.id}
            className="border-b bg-muted/30"
            data-testid={`banner-row-${banner.id}`}
          >
            <td className="py-2 pl-12 text-muted-foreground">
              <span className="truncate max-w-[220px] inline-block">{banner.name}</span>
            </td>
            <td className="py-2">{statusBadge(banner.status)}</td>
            <td className="py-2 text-right tabular-nums text-muted-foreground">
              {formatNumber(banner.impressions)}
            </td>
            <td className="py-2 text-right tabular-nums text-muted-foreground">
              {formatNumber(banner.clicks)}
            </td>
            <td className="py-2 text-right tabular-nums text-muted-foreground">
              {formatPercent(banner.ctr)}
            </td>
            <td className="py-2 text-right tabular-nums text-muted-foreground">
              {formatCurrency(banner.spent)}
            </td>
            <td className="py-2 text-right tabular-nums text-muted-foreground">
              {formatNumber(banner.leads)}
            </td>
            <td className="py-2 text-right tabular-nums text-muted-foreground">
              {banner.cpl > 0 ? formatCurrency(banner.cpl) : '—'}
            </td>
          </tr>
        ))}
    </>
  );
}
