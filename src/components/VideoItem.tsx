import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Trash2,
  Loader2,
  Sparkles,
  FileText,
  Link2,
  Eye,
  EyeOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AiScoreBadge } from './AiScoreBadge';
import { WatchRateChart } from './WatchRateChart';
import { cn } from '@/lib/utils';

interface VideoData {
  _id: string;
  filename: string;
  direction?: string;
  isActive: boolean;
  uploadStatus: string;
  transcription?: string;
  aiScore?: number;
  aiScoreLabel?: string;
  aiAnalysis?: {
    watchRates?: { p25?: number; p50?: number; p75?: number; p95?: number };
    avgWatchTime?: number;
    totalViews?: number;
    recommendations?: Array<{
      field: string;
      original: string;
      suggested: string;
      reason?: string;
    }>;
    transcriptMatch?: string;
  };
  createdAt: number;
  vkAdId?: string;
}

interface VideoItemProps {
  video: VideoData;
  onToggleActive: (id: string, isActive: boolean) => void;
  onDelete: (id: string) => void;
  onTranscribe: (id: string) => void;
  onAnalyze: (id: string) => void;
  deleting: boolean;
  transcribing: boolean;
  analyzing: boolean;
  onLinkToAd: (videoId: string, vkAdId: string) => void;
  ads?: Array<{ _id: string; vkAdId: string; name: string; status: string }>;
}

export function VideoItem({
  video,
  onToggleActive,
  onDelete,
  onTranscribe,
  onAnalyze,
  deleting,
  transcribing,
  analyzing,
  onLinkToAd,
  ads,
}: VideoItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [transcriptionExpanded, setTranscriptionExpanded] = useState(false);

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleDateString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  };

  return (
    <div className="border border-border rounded-lg" data-testid={`video-item-${video._id}`}>
      {/* Collapsed header */}
      <div
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        )}

        <span className="text-sm font-medium truncate flex-1">{video.filename}</span>

        {video.direction && (
          <Badge variant="secondary" className="shrink-0">
            {video.direction}
          </Badge>
        )}

        {video.aiScore !== undefined && video.aiScore >= 0 && (
          <div className="shrink-0 hidden sm:block">
            <div
              className={cn(
                'w-2 h-2 rounded-full',
                video.aiScore >= 61 ? 'bg-green-500' : video.aiScore >= 41 ? 'bg-amber-500' : 'bg-destructive'
              )}
            />
          </div>
        )}

        <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
          {formatDate(video.createdAt)}
        </span>

        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => onToggleActive(video._id, !video.isActive)}
            className={cn(
              'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
              video.isActive ? 'bg-primary' : 'bg-muted'
            )}
          >
            <span
              className={cn(
                'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
                video.isActive ? 'translate-x-4.5' : 'translate-x-0.5'
              )}
            />
          </button>
        </div>

        <span className="text-xs text-muted-foreground shrink-0">
          {video.isActive ? 'Активен' : 'Неактивен'}
        </span>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(video._id);
          }}
          disabled={deleting}
        >
          {deleting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border p-4 space-y-4">
          {/* Ad linking */}
          {!video.vkAdId ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-primary" />
                <h4 className="font-medium text-sm">Привязка к объявлению</h4>
              </div>
              {ads && ads.length > 0 ? (
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      onLinkToAd(video._id, e.target.value);
                    }
                  }}
                >
                  <option value="" disabled>Выберите объявление...</option>
                  {ads.map((ad) => (
                    <option key={ad._id} value={ad.vkAdId}>
                      {ad.name} ({ad.status})
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Нет объявлений. Видео привяжется автоматически при следующей синхронизации.
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Привязано к объявлению</span>
              <Badge variant="secondary">{video.vkAdId}</Badge>
            </div>
          )}

          {/* Transcription */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              <h4 className="font-medium text-sm">Транскрибация видео</h4>
              <span className="text-xs text-muted-foreground">(аудио + видеоряд)</span>
            </div>
            {video.transcription ? (
              <div className="space-y-2">
                <div
                  className={cn(
                    "bg-muted rounded-lg p-3 text-sm whitespace-pre-wrap",
                    !transcriptionExpanded && "max-h-20 overflow-hidden relative"
                  )}
                >
                  {video.transcription}
                  {!transcriptionExpanded && video.transcription.length > 200 && (
                    <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-muted to-transparent" />
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => setTranscriptionExpanded(!transcriptionExpanded)}
                >
                  {transcriptionExpanded ? (
                    <><EyeOff className="h-3 w-3 mr-1" /> Свернуть</>
                  ) : (
                    <><Eye className="h-3 w-3 mr-1" /> Показать полностью</>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onTranscribe(video._id)}
                  disabled={transcribing || video.uploadStatus !== 'ready'}
                >
                  {transcribing ? (
                    <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Обновляем...</>
                  ) : (
                    <><FileText className="h-4 w-4 mr-2" /> Обновить транскрибацию</>
                  )}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onTranscribe(video._id)}
                  disabled={transcribing || video.uploadStatus !== 'ready'}
                >
                  {transcribing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Извлекаем аудио и кадры...
                    </>
                  ) : (
                    <>
                      <FileText className="h-4 w-4 mr-2" />
                      Транскрибировать
                    </>
                  )}
                </Button>
                {video.uploadStatus !== 'ready' && (
                  <span className="text-xs text-muted-foreground">
                    Сначала загрузите видео
                  </span>
                )}
              </div>
            )}
          </div>

          {/* AI Analysis */}
          {video.aiScore !== undefined ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <h4 className="font-medium text-sm">AI Анализ</h4>
              </div>

              <AiScoreBadge
                score={video.aiScore}
                label={video.aiScoreLabel}
              />

              {/* Watch rates funnel */}
              {video.aiAnalysis?.watchRates && video.aiAnalysis?.totalViews && (
                <WatchRateChart
                  videoStarted={video.aiAnalysis.totalViews}
                  p25={video.aiAnalysis.watchRates.p25 || 0}
                  p50={video.aiAnalysis.watchRates.p50 || 0}
                  p75={video.aiAnalysis.watchRates.p75 || 0}
                  p100={video.aiAnalysis.watchRates.p95 || 0}
                />
              )}

              {/* Transcript match */}
              {video.aiAnalysis?.transcriptMatch && (
                <p className="text-sm">
                  <span className="text-muted-foreground">Соответствие транскрипта: </span>
                  <span className="font-medium">{video.aiAnalysis.transcriptMatch}</span>
                </p>
              )}

              {/* Recommendations */}
              {video.aiAnalysis?.recommendations && video.aiAnalysis.recommendations.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Предложения по тексту</p>
                  {video.aiAnalysis.recommendations.map((rec, i) => (
                    <div key={i} className="bg-muted rounded-lg p-3 space-y-1">
                      <div className="text-xs text-muted-foreground">Исходный текст</div>
                      <p className="text-sm">"{rec.original}"</p>
                      <div className="text-xs text-muted-foreground mt-2">Новый текст</div>
                      <p className="text-sm font-medium text-primary">"{rec.suggested}"</p>
                      {rec.reason && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Почему: {rec.reason}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Watch score */}
              {video.aiAnalysis?.watchRates && video.aiScore !== undefined && (
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-sm">
                    <span className="text-muted-foreground">Оценка удержания: </span>
                    <span className={cn(
                      'font-bold',
                      video.aiScore >= 61 ? 'text-green-600' :
                      video.aiScore >= 41 ? 'text-amber-600' : 'text-destructive'
                    )}>
                      {video.aiScore}/100 — {video.aiScoreLabel}
                    </span>
                  </p>
                </div>
              )}
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAnalyze(video._id)}
              disabled={analyzing || !video.transcription}
            >
              {analyzing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Анализ...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Быстрый тест
                </>
              )}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
