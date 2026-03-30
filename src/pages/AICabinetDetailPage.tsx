import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '@/lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  Pause,
  Play,
  Trash2,
  Sparkles,
  Wand2,
  Eye,
  Target,
  CheckCircle,
  Clock,
  XCircle,
  RefreshCw,
  Edit3,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { BannerPreview } from '@/components/BannerPreview';

const statusLabels: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  draft: { label: 'Черновик', variant: 'secondary' },
  creating: { label: 'Создаётся...', variant: 'warning' },
  active: { label: 'Активна', variant: 'success' },
  paused: { label: 'На паузе', variant: 'warning' },
  error: { label: 'Ошибка', variant: 'destructive' },
};

const moderationLabels: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' | 'secondary'; icon: typeof CheckCircle }> = {
  allowed: { label: 'Одобрено', variant: 'success', icon: CheckCircle },
  new: { label: 'На модерации', variant: 'warning', icon: Clock },
  changed: { label: 'На модерации', variant: 'warning', icon: Clock },
  delayed: { label: 'На модерации', variant: 'warning', icon: Clock },
  banned: { label: 'Отклонено', variant: 'destructive', icon: XCircle },
};

const objectiveNames: Record<string, string> = {
  traffic: 'Трафик на сайт',
  social: 'Вступления в сообщество',
  messages: 'Сообщения (лиды)',
  video_views: 'Просмотры видео',
  engagement: 'Продвижение поста',
};

export default function AICabinetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const campaign = useQuery(
    api.aiCabinet.getCampaign,
    id ? { id: id as Id<"aiCampaigns"> } : 'skip'
  );

  const banners = useQuery(
    api.aiCabinet.listBanners,
    id ? { campaignId: id as Id<"aiCampaigns"> } : 'skip'
  );

  const recommendations = useQuery(
    api.aiCabinet.listRecommendations,
    id ? { campaignId: id as Id<"aiCampaigns"> } : 'skip'
  );

  const campaignMetrics = useQuery(
    api.aiCabinet.getCampaignMetrics,
    id ? { campaignId: id as Id<"aiCampaigns"> } : 'skip'
  );

  const deleteCampaign = useMutation(api.aiCabinet.deleteCampaign);
  const toggleBannerSelected = useMutation(api.aiCabinet.toggleBannerSelected);
  const toggleCampaignStatus = useAction(api.aiCabinet.toggleCampaignStatus);
  const launchCampaign = useAction(api.aiCabinet.launchCampaign);
  const applyRec = useMutation(api.aiRecommendations.applyRecommendationPublic);
  const rejectRec = useMutation(api.aiRecommendations.rejectRecommendationPublic);

  const isLoading = campaign === undefined;

  const handleToggleStatus = async () => {
    if (!campaign || !id) return;
    setToggling(true);
    try {
      await toggleCampaignStatus({
        campaignId: id as Id<"aiCampaigns">,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setToggling(false);
    }
  };

  const handleLaunch = async () => {
    if (!campaign || !id) return;
    setToggling(true);
    try {
      await launchCampaign({
        campaignId: id as Id<"aiCampaigns">,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запуска');
    } finally {
      setToggling(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Удалить кампанию? Это действие нельзя отменить.')) return;
    setDeleting(true);
    try {
      await deleteCampaign({ id: id as Id<"aiCampaigns">, userId: user!.userId as Id<"users"> });
      navigate('/ai-cabinet');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
      setDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-lg font-medium mb-2">Кампания не найдена</h3>
        <Link to="/ai-cabinet"><Button variant="outline">Назад</Button></Link>
      </div>
    );
  }

  const status = statusLabels[campaign.status] || statusLabels.draft;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectedBanners = banners?.filter((b: any) => b.isSelected) || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingRecs = recommendations?.filter((r: any) => r.status === 'pending') || [];

  return (
    <div className="space-y-6" data-testid="ai-cabinet-detail-page">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link to="/ai-cabinet">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              {campaign.name}
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={status.variant}>{status.label}</Badge>
              {campaign.vkCampaignId && (
                <span className="text-xs text-muted-foreground">
                  myTarget ID: {campaign.vkCampaignId}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {campaign.status === 'draft' && (
            <Button onClick={handleLaunch} disabled={toggling || selectedBanners.length === 0}>
              {toggling ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
              Запустить
            </Button>
          )}
          {(campaign.status === 'active' || campaign.status === 'paused') && (
            <Button
              variant={campaign.status === 'active' ? 'outline' : 'default'}
              onClick={handleToggleStatus}
              disabled={toggling}
            >
              {toggling ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : campaign.status === 'active' ? (
                <Pause className="h-4 w-4 mr-2" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              {campaign.status === 'active' ? 'Пауза' : 'Возобновить'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">Закрыть</button>
        </div>
      )}

      {campaign.errorMessage && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{campaign.errorMessage}</span>
        </div>
      )}

      {/* Metrics */}
      {campaignMetrics && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Расход</p>
              <p className="text-lg font-bold">{formatCurrency(campaignMetrics.spent)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Лиды</p>
              <p className="text-lg font-bold">{campaignMetrics.leads}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">CPL</p>
              <p className="text-lg font-bold">
                {campaignMetrics.leads > 0 ? formatCurrency(campaignMetrics.cpl) : '—'}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">CTR</p>
              <p className="text-lg font-bold">
                {campaignMetrics.impressions > 0 ? `${campaignMetrics.ctr.toFixed(2)}%` : '—'}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Показы</p>
              <p className="text-lg font-bold">{campaignMetrics.impressions.toLocaleString('ru-RU')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Клики</p>
              <p className="text-lg font-bold">{campaignMetrics.clicks.toLocaleString('ru-RU')}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left column */}
        <div className="space-y-6">
          {/* Campaign settings */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Target className="h-4 w-4" />
                Настройки кампании
              </CardTitle>
              {campaign.status === 'draft' && (
                <Link to={`/ai-cabinet/new?edit=${campaign._id}`}>
                  <Button variant="ghost" size="sm">Редактировать</Button>
                </Link>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Направление</span>
                <span className="font-medium">{campaign.businessDirection}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Цель</span>
                <span className="font-medium">{objectiveNames[campaign.objective] || campaign.objective}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Ссылка</span>
                <a href={campaign.targetUrl} target="_blank" rel="noreferrer" className="text-primary truncate max-w-[200px]">
                  {campaign.targetUrl}
                </a>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Регионы</span>
                <span className="font-medium">{campaign.regions.length} шт.</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Возраст</span>
                <span className="font-medium">{campaign.ageFrom}–{campaign.ageTo}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Пол</span>
                <span className="font-medium">
                  {campaign.sex === 'MF' ? 'Все' : campaign.sex === 'M' ? 'Мужчины' : 'Женщины'}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Дневной бюджет</span>
                <span className="font-medium">{formatCurrency(campaign.dailyBudget)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Moderation status */}
          {banners && banners.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Eye className="h-4 w-4" />
                  Модерация баннеров
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {banners.map((banner: any) => {
                  const modStatus = banner.moderationStatus
                    ? moderationLabels[banner.moderationStatus] || moderationLabels.new
                    : null;
                  const ModIcon = modStatus?.icon || Clock;
                  return (
                    <div key={banner._id} className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{banner.title}</p>
                        <p className="text-xs text-muted-foreground truncate">{banner.text}</p>
                      </div>
                      <div className="flex items-center gap-2 ml-3">
                        {modStatus ? (
                          <Badge variant={modStatus.variant} className="flex items-center gap-1">
                            <ModIcon className="h-3 w-3" />
                            {modStatus.label}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Черновик</Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
                {banners.some((b: any) => b.moderationStatus === 'banned') && (
                  <p className="text-xs text-destructive">
                    Отклонённые баннеры можно перегенерировать
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Events log */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4" />
                События
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {campaign.status !== 'draft' && (
                  <div className="flex items-center gap-2 text-sm">
                    <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
                    <span>Кампания запущена</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {new Date(campaign.createdAt).toLocaleString('ru-RU')}
                    </span>
                  </div>
                )}
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {banners?.filter((b: any) => b.moderationStatus === 'allowed').map((b: any) => (
                  <div key={`mod-${b._id}`} className="flex items-center gap-2 text-sm">
                    <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                    <span>Баннер "{b.title}" одобрен</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {new Date(b.updatedAt).toLocaleString('ru-RU')}
                    </span>
                  </div>
                ))}
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {banners?.filter((b: any) => b.moderationStatus === 'banned').map((b: any) => (
                  <div key={`ban-${b._id}`} className="flex items-center gap-2 text-sm">
                    <div className="w-2 h-2 rounded-full bg-destructive shrink-0" />
                    <span>Баннер "{b.title}" отклонён</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {new Date(b.updatedAt).toLocaleString('ru-RU')}
                    </span>
                  </div>
                ))}
                {campaign.status === 'draft' && (!banners || banners.length === 0) && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Нет событий
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* AI Recommendations */}
          {pendingRecs.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Wand2 className="h-4 w-4" />
                  AI рекомендации
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {pendingRecs.map((rec: any) => (
                  <div key={rec._id} className="p-3 rounded-lg bg-primary/5 border border-primary/20">
                    <p className="text-sm">{rec.message}</p>
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" variant="default" onClick={async () => {
                        try {
                          await applyRec({ id: rec._id, userId: user!.userId as Id<"users"> });
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Ошибка');
                        }
                      }}>Применить</Button>
                      <Button size="sm" variant="ghost" onClick={async () => {
                        try {
                          await rejectRec({ id: rec._id, userId: user!.userId as Id<"users"> });
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Ошибка');
                        }
                      }}>Отклонить</Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column — Banners */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                Баннеры ({selectedBanners.length} активных)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {banners && banners.length > 0 ? (
                /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                banners.map((banner: any) => (
                  <div key={banner._id}>
                    <BannerPreview
                      title={banner.title}
                      text={banner.text}
                      imageStorageId={banner.imageStorageId}
                      isSelected={banner.isSelected}
                      vkBannerId={banner.vkBannerId}
                      onToggleSelected={() => toggleBannerSelected({ id: banner._id })}
                    />
                    {campaign.status !== 'draft' && (
                      <div className="flex gap-2 mt-2 pl-4">
                        <Button variant="ghost" size="sm" className="text-xs h-7" disabled>
                          <RefreshCw className="h-3 w-3 mr-1" />
                          Перегенерировать
                        </Button>
                        <Button variant="ghost" size="sm" className="text-xs h-7" disabled>
                          <Edit3 className="h-3 w-3 mr-1" />
                          Редактировать
                        </Button>
                        {banner.status === 'active' && (
                          <Button variant="ghost" size="sm" className="text-xs h-7 text-destructive" disabled>
                            <Pause className="h-3 w-3 mr-1" />
                            Остановить
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  Нет баннеров
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
