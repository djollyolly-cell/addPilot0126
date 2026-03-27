import { useRef } from 'react';
import { Upload, Play, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface QueuedFile {
  file: File;
  status: 'queued' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
}

interface VideoUploadQueueProps {
  queue: QueuedFile[];
  direction: string;
  onDirectionChange: (value: string) => void;
  onAddFiles: (files: FileList) => void;
  onStartUpload: () => void;
  onClearQueue: () => void;
  uploading: boolean;
  totalProgress: number;
}

export function VideoUploadQueue({
  queue,
  direction,
  onDirectionChange,
  onAddFiles,
  onStartUpload,
  onClearQueue,
  uploading,
  totalProgress,
}: VideoUploadQueueProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-4" data-testid="video-upload-queue">
      <div>
        <Label className="text-sm font-medium">Направление бизнеса</Label>
        <select
          className={cn(
            'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-ring'
          )}
          value={direction}
          onChange={(e) => onDirectionChange(e.target.value)}
        >
          <option value="">Выберите направление</option>
          <option value="AI-таргетолог">AI-таргетолог</option>
          <option value="Цифровой менеджер">Цифровой менеджер</option>
          <option value="Маркетолог">Маркетолог</option>
        </select>
        <p className="text-xs text-muted-foreground mt-1">
          Все загружаемые креативы будут привязаны к этому направлению
        </p>
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) onAddFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          <Upload className="h-4 w-4 mr-2" />
          Добавить файл
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onStartUpload}
          disabled={uploading || queue.length === 0}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Play className="h-4 w-4 mr-2" />
          )}
          Начать
        </Button>
        {queue.length > 0 && !uploading && (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={onClearQueue}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Progress */}
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          Общий прогресс: {totalProgress}%
        </div>
        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${totalProgress}%` }}
          />
        </div>
      </div>

      {/* Queue list */}
      {queue.length > 0 && (
        <div className="space-y-2">
          {queue.map((item, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 p-2 rounded-md bg-muted/50"
            >
              <span className="text-sm truncate flex-1">{item.file.name}</span>
              <QueueStatusBadge status={item.status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QueueStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'uploading':
      return (
        <Badge variant="secondary">
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
          Загрузка
        </Badge>
      );
    case 'done':
      return <Badge variant="success">Готово</Badge>;
    case 'error':
      return <Badge variant="destructive">Ошибка</Badge>;
    default:
      return <Badge variant="outline">В очереди</Badge>;
  }
}
