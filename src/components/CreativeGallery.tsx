import { Trash2, Loader2, AlertCircle, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from '@/lib/utils';

interface Creative {
  _id: string;
  offer: string;
  bullets: string;
  benefit: string;
  cta: string;
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
            {/* Image preview */}
            <div className="aspect-square rounded-md overflow-hidden bg-muted flex items-center justify-center">
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
                <img
                  src={creative.imageUrl}
                  alt={creative.offer}
                  className="w-full h-full object-cover"
                />
              ) : (
                <ImageIcon className="h-12 w-12 text-muted-foreground" />
              )}
            </div>

            {/* Text preview */}
            <div className="space-y-1">
              <p className="text-sm font-medium line-clamp-1">{creative.offer || 'Без оффера'}</p>
              <p className="text-xs text-muted-foreground line-clamp-1">{creative.cta}</p>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusBadge status={creative.status} />
                <span className="text-xs text-muted-foreground">
                  {formatRelativeTime(creative.createdAt)}
                </span>
              </div>
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
