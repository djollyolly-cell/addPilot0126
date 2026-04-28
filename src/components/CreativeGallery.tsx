import { Trash2, Loader2, AlertCircle, ImageIcon, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from '@/lib/utils';
import BannerCompositor from '@/components/BannerCompositor';

interface Creative {
  _id: string;
  offer: string;
  bullets: string;
  benefit: string;
  cta: string;
  adTitle?: string;
  adText?: string;
  imageUrl?: string;
  status: 'draft' | 'generating' | 'ready' | 'failed';
  errorMessage?: string;
  createdAt: number;
}

interface CreativeGalleryProps {
  creatives: Creative[];
  onDelete: (id: string) => void;
  deleting: string | null;
}

export function CreativeGallery({ creatives, onDelete, deleting }: CreativeGalleryProps) {
  const handleDownload = async (url: string, id: string) => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `creative-${id}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(url, '_blank');
    }
  };

  if (creatives.length === 0) {
    return (
      <div className="text-center py-12">
        <ImageIcon className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-lg font-medium mb-2">Нет креативов</h3>
        <p className="text-muted-foreground">
          Заполните поля и нажмите «Сгенерировать креатив»
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {creatives.map((creative) => (
        <Card key={creative._id} data-testid={`creative-card-${creative._id}`}>
          <CardContent className="p-4 space-y-3">
            {/* Banner preview with text overlay */}
            <div className="aspect-square rounded-md overflow-hidden bg-muted flex items-center justify-center relative">
              {creative.status === 'generating' ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Генерация...</span>
                </div>
              ) : creative.status === 'failed' ? (
                <div className="flex flex-col items-center gap-2 px-4 text-center">
                  <AlertCircle className="h-8 w-8 text-destructive" />
                  <span className="text-sm text-destructive">
                    {creative.errorMessage || 'Ошибка генерации'}
                  </span>
                </div>
              ) : creative.imageUrl ? (
                <BannerCompositor
                  imageUrl={creative.imageUrl}
                  headline={creative.offer}
                  subtitle={creative.benefit}
                  bullets={creative.bullets ? creative.bullets.split(' • ') : []}
                  size={1080}
                  className="w-full h-full"
                />
              ) : (
                <ImageIcon className="h-12 w-12 text-muted-foreground" />
              )}
            </div>

            {/* Ad text preview */}
            {(creative.adTitle || creative.adText) && (
              <div className="space-y-1 p-3 rounded-md bg-muted/50 border border-border">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Текст объявления</p>
                {creative.adTitle && (
                  <p className="text-sm font-semibold leading-tight">{creative.adTitle}</p>
                )}
                {creative.adText && (
                  <p className="text-xs text-muted-foreground leading-relaxed">{creative.adText}</p>
                )}
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusBadge status={creative.status} />
                <span className="text-xs text-muted-foreground">
                  {formatRelativeTime(creative.createdAt)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {creative.status === 'ready' && creative.imageUrl && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-primary"
                    onClick={() => handleDownload(creative.imageUrl!, creative._id)}
                    data-testid={`download-creative-${creative._id}`}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(creative._id)}
                  disabled={deleting === creative._id}
                >
                  {deleting === creative._id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'ready':
      return <Badge variant="success">Готов</Badge>;
    case 'generating':
      return <Badge variant="secondary">Генерация</Badge>;
    case 'failed':
      return <Badge variant="destructive">Ошибка</Badge>;
    default:
      return <Badge variant="outline">Черновик</Badge>;
  }
}
