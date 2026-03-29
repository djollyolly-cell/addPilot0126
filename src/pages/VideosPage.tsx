import { useState, useCallback } from 'react';
import { useQuery, useMutation, useAction, useConvex } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '@/lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import {
  Film,
  Loader2,
  AlertCircle,
  RefreshCw,
  Trash2,
  Building2,
  Info,
} from 'lucide-react';
import { extractAudioFromVideo } from '@/lib/extractAudio';
import { extractFramesFromVideo } from '@/lib/extractFrames';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { VideoItem } from '@/components/VideoItem';
import { VideoUploadQueue } from '@/components/VideoUploadQueue';

interface QueuedFile {
  file: File;
  status: 'queued' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
}

export function VideosPage() {
  const { user } = useAuth();

  const [direction, setDirection] = useState('');
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Get active account
  const settings = useQuery(
    api.userSettings.get,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );
  const accountId = settings?.activeAccountId;

  const accounts = useQuery(
    api.adAccounts.list,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );
  const setActiveAccount = useMutation(api.userSettings.setActiveAccount);

  // Business profile & directions
  const profile = useQuery(
    api.adAccounts.getBusinessProfile,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );
  const directions = useQuery(
    api.businessDirections.list,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );
  const activeDirections = directions?.filter((d: any) => d.isActive) || [];

  // Queries
  const videos = useQuery(
    api.videos.list,
    user?.userId && accountId
      ? { userId: user.userId as Id<"users">, accountId: accountId as Id<"adAccounts"> }
      : 'skip'
  );

  // Mutations & Actions
  const createVideo = useMutation(api.videos.create);
  const updateVideo = useMutation(api.videos.update);
  const deleteVideo = useMutation(api.videos.deleteVideo);
  const deleteAllVideos = useMutation(api.videos.deleteAll);
  const generateUploadUrl = useMutation(api.videos.generateUploadUrl);
  const convex = useConvex();
  const uploadToVk = useAction(api.videos.uploadToVk);
  const transcribeVideo = useAction(api.videos.transcribeVideo);
  const analyzeVideo = useAction(api.videos.analyzeVideo);
  const linkToAd = useMutation(api.videos.linkToAd);
  const ads = useQuery(
    api.videos.listAdsByAccount,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );

  const isLoading = videos === undefined;

  const handleAddFiles = useCallback((files: FileList) => {
    const newFiles: QueuedFile[] = Array.from(files).map((file) => ({
      file,
      status: 'queued' as const,
      progress: 0,
    }));
    setQueue((prev) => [...prev, ...newFiles]);
  }, []);

  const handleStartUpload = async () => {
    if (!user?.userId || !accountId || queue.length === 0) return;

    setUploading(true);
    setError(null);

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item.status !== 'queued') continue;

      // Update queue status
      setQueue((prev) =>
        prev.map((q, idx) => (idx === i ? { ...q, status: 'uploading' as const } : q))
      );

      try {
        // Create video record
        const videoId = await createVideo({
          userId: user.userId as Id<"users">,
          accountId: accountId as Id<"adAccounts">,
          filename: item.file.name,
          fileSize: item.file.size,
          direction: direction || undefined,
        });

        // Upload to Convex temp storage
        const uploadUrl = await generateUploadUrl({});
        const uploadResponse = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': item.file.type },
          body: item.file,
        });

        if (!uploadResponse.ok) throw new Error('Ошибка загрузки файла');

        const { storageId } = await uploadResponse.json();

        // Upload from Convex to VK via myTarget API
        await uploadToVk({
          videoId,
          storageId: storageId as Id<"_storage">,
          accountId: accountId as Id<"adAccounts">,
        });

        setQueue((prev) =>
          prev.map((q, idx) => (idx === i ? { ...q, status: 'done' as const, progress: 100 } : q))
        );
      } catch (err) {
        setQueue((prev) =>
          prev.map((q, idx) =>
            idx === i
              ? { ...q, status: 'error' as const, error: err instanceof Error ? err.message : 'Ошибка' }
              : q
          )
        );
      }
    }

    setUploading(false);
    setSuccess('Загрузка завершена');
    setTimeout(() => setSuccess(null), 3000);
  };

  const handleClearQueue = () => setQueue([]);

  const handleToggleActive = async (id: string, isActive: boolean) => {
    try {
      await updateVideo({ id: id as Id<"videos">, isActive });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка обновления');
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteVideo({ id: id as Id<"videos"> });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteAll = async () => {
    if (!user?.userId || !accountId) return;
    if (!confirm('Удалить все видео?')) return;
    try {
      await deleteAllVideos({
        userId: user.userId as Id<"users">,
        accountId: accountId as Id<"adAccounts">,
      });
      setSuccess('Все видео удалены');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    }
  };

  const handleTranscribe = async (id: string) => {
    if (!user?.userId) return;
    setTranscribingId(id);
    setError(null);
    try {
      const video = videos?.find((v: any) => v._id === id);
      const MAX_WHISPER_SIZE = 24 * 1024 * 1024;

      // Large files need client-side audio extraction
      if (video?.fileSize && video.fileSize > MAX_WHISPER_SIZE && video.storageId) {
        setSuccess('Извлекаем аудио из видео...');

        // Get storage URL for the video file
        const storageUrl = await convex.query(api.videos.getStorageUrl, { videoId: id as Id<"videos"> });
        if (!storageUrl) throw new Error('Файл видео не найден');

        // Extract audio on client (video ~25MB → audio ~1-3MB)
        const audioBlob = await extractAudioFromVideo(storageUrl);

        // Upload extracted audio to Convex storage
        const uploadUrl = await generateUploadUrl({});
        const uploadResponse = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: audioBlob,
        });
        if (!uploadResponse.ok) throw new Error('Ошибка загрузки аудио');
        const { storageId: audioStorageId } = await uploadResponse.json();

        setSuccess('Транскрибируем...');
        await transcribeVideo({
          videoId: id as Id<"videos">,
          userId: user.userId as Id<"users">,
          audioStorageId: audioStorageId as Id<"_storage">,
        });
      } else {
        await transcribeVideo({
          videoId: id as Id<"videos">,
          userId: user.userId as Id<"users">,
        });
      }

      setSuccess('Транскрибация завершена');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка транскрибации');
    } finally {
      setTranscribingId(null);
    }
  };

  const handleAnalyze = async (id: string) => {
    if (!user?.userId) return;
    setAnalyzingId(id);
    setError(null);
    try {
      const video = videos?.find((v: any) => v._id === id);

      // Extract frames from video for Vision analysis
      let frameStorageIds: Id<"_storage">[] = [];

      // Try to get video URL for frame extraction
      const storageUrl = video?.storageId
        ? await convex.query(api.videos.getStorageUrl, { videoId: id as Id<"videos"> })
        : null;

      if (storageUrl) {
        setSuccess('Извлекаем кадры из видео...');
        try {
          const frames = await extractFramesFromVideo(storageUrl, {
            intervalSec: 3,
            maxFrames: 8,
            quality: 0.7,
          });

          // Upload frames to Convex storage
          for (const frameBlob of frames) {
            const uploadUrl = await generateUploadUrl({});
            const uploadResponse = await fetch(uploadUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'image/jpeg' },
              body: frameBlob,
            });
            if (uploadResponse.ok) {
              const { storageId } = await uploadResponse.json();
              frameStorageIds.push(storageId as Id<"_storage">);
            }
          }
        } catch (frameErr) {
          console.warn('Не удалось извлечь кадры, анализ только по транскрипции:', frameErr);
        }
      }

      setSuccess('Анализируем видео...');
      await analyzeVideo({
        videoId: id as Id<"videos">,
        userId: user.userId as Id<"users">,
        frameStorageIds: frameStorageIds.length > 0 ? frameStorageIds : undefined,
      });

      setSuccess('Анализ завершён');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка анализа');
    } finally {
      setAnalyzingId(null);
    }
  };

  const handleLinkToAd = async (videoId: string, vkAdId: string) => {
    try {
      await linkToAd({ videoId: videoId as Id<"videos">, vkAdId });
      setSuccess('Видео привязано к объявлению');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка привязки');
    }
  };

  const totalProgress = queue.length === 0
    ? 0
    : Math.round(queue.reduce((sum, q) => sum + q.progress, 0) / queue.length);

  if (!accountId) {
    return (
      <div className="space-y-6" data-testid="videos-page">
        <div className="flex items-center gap-2">
          <Film className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Видео</h1>
        </div>
        <div className="text-center py-12">
          <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">Выберите аккаунт</h3>
          {accounts && accounts.length > 0 ? (
            <div className="max-w-xs mx-auto mt-4">
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                defaultValue=""
                onChange={async (e) => {
                  if (e.target.value && user?.userId) {
                    await setActiveAccount({
                      userId: user.userId as Id<"users">,
                      accountId: e.target.value as Id<"adAccounts">,
                    });
                  }
                }}
              >
                <option value="" disabled>Выберите рекламный аккаунт...</option>
                {accounts.map((acc) => (
                  <option key={acc._id} value={acc._id}>
                    {acc.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Подключите рекламный аккаунт в разделе Кабинеты
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="videos-page">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Film className="h-6 w-6 text-primary" />
          Видео
        </h1>
        <p className="text-muted-foreground mt-1">
          Загружайте и управляйте вашими видео креативами
        </p>
      </div>

      {/* Messages */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="p-3 rounded-lg bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
          {success}
        </div>
      )}

      {/* Business profile hint */}
      {profile !== undefined && directions !== undefined && (
        !profile?.companyName || !profile?.industry || activeDirections.length === 0
      ) && (
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm">
          <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-foreground">Заполните профиль бизнеса для точного анализа</p>
            <p className="text-muted-foreground mt-0.5">
              {!profile?.companyName || !profile?.industry
                ? 'Укажите название компании и нишу в '
                : 'Добавьте направления бизнеса в '}
              <a href="/accounts" className="text-primary hover:underline font-medium">
                разделе Кабинеты
              </a>
              {' '}→ Профиль бизнеса. Это улучшит AI-анализ ваших видео.
            </p>
          </div>
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Upload queue */}
        <Card>
          <CardHeader>
            <CardTitle>Очередь загрузок</CardTitle>
            <CardDescription>
              Добавляйте видео — загрузим по очереди
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VideoUploadQueue
              queue={queue}
              direction={direction}
              onDirectionChange={setDirection}
              onAddFiles={handleAddFiles}
              onStartUpload={handleStartUpload}
              onClearQueue={handleClearQueue}
              uploading={uploading}
              totalProgress={totalProgress}
              directions={directions as any}
            />
          </CardContent>
        </Card>

        {/* Right: Uploaded videos */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Загруженные креативы</CardTitle>
                <CardDescription>
                  Всего: {videos?.length || 0}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <RefreshCw className="h-4 w-4" />
                </Button>
                {videos && videos.length > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleDeleteAll}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Удалить все
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : !videos || videos.length === 0 ? (
              <div className="text-center py-12">
                <Film className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2">Нет видео</h3>
                <p className="text-muted-foreground">
                  Добавьте видео в очередь загрузок
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {videos.map((video: any) => (
                  <VideoItem
                    key={video._id}
                    video={video}
                    onToggleActive={handleToggleActive}
                    onDelete={handleDelete}
                    onTranscribe={handleTranscribe}
                    onAnalyze={handleAnalyze}
                    onLinkToAd={handleLinkToAd}
                    ads={ads || undefined}
                    deleting={deletingId === video._id}
                    transcribing={transcribingId === video._id}
                    analyzing={analyzingId === video._id}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
