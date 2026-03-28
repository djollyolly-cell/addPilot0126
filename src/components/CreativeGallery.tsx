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
                <>
                  <img
                    src={creative.imageUrl}
                    alt={creative.offer}
                    className="w-full h-full object-cover"
                  />
                  {/* Gradient overlays: top for headline, bottom for CTA */}
                  <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/50" />
                  {/* Z-pattern text layout: headline top → details middle → CTA bottom-right */}
                  <div className="absolute inset-0 flex flex-col justify-between p-4 text-white">
                    {/* Top: main offer headline — first thing the eye sees */}
                    <div>
                      <p className="text-lg font-extrabold leading-snug drop-shadow-lg line-clamp-2"
                         style={{ textShadow: '0 2px 8px rgba(0,0,0,0.8)' }}>
                        {creative.offer}
                      </p>
                    </div>
                    {/* Middle: bullets + benefit */}
                    <div className="space-y-1">
                      {creative.bullets && (
                        <p className="text-xs leading-snug drop-shadow line-clamp-2"
                           style={{ textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
                          {creative.bullets}
                        </p>
                      )}
                      {creative.benefit && (
                        <p className="text-sm font-semibold drop-shadow"
                           style={{ textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
                          {creative.benefit}
                        </p>
                      )}
                    </div>
                    {/* Bottom-right: CTA button — last point of Z-scan */}
                    {creative.cta && (
                      <div className="flex justify-end">
                        <span className="inline-block bg-primary text-primary-foreground text-sm font-bold px-4 py-2 rounded-lg shadow-lg">
                          {creative.cta}
                        </span>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <ImageIcon className="h-12 w-12 text-muted-foreground" />
              )}
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
