/**
 * Extract key frames from a video Blob.
 * Uses blob URL with correct MIME type for reliable browser decoding.
 */
export async function extractFramesFromBlob(
  videoBlob: Blob,
  options: { intervalSec?: number; maxFrames?: number; quality?: number } = {}
): Promise<Blob[]> {
  const { intervalSec = 3, maxFrames = 10, quality = 0.7 } = options;

  const blobUrl = URL.createObjectURL(videoBlob);

  try {
    const frames = await new Promise<Blob[]>((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.playsInline = true;
      video.crossOrigin = 'anonymous';

      const timeout = setTimeout(() => {
        reject(new Error('Таймаут загрузки видео (30 сек)'));
      }, 30000);

      video.onloadedmetadata = async () => {
        clearTimeout(timeout);

        const duration = video.duration;
        if (!duration || !isFinite(duration) || duration <= 0) {
          reject(new Error(`Не удалось определить длительность видео: ${duration}`));
          return;
        }

        // Calculate frame timestamps
        const step = Math.max(intervalSec, duration / maxFrames);
        const timestamps: number[] = [];
        for (let t = 0.5; t < duration && timestamps.length < maxFrames; t += step) {
          timestamps.push(t);
        }
        if (timestamps.length === 0) {
          timestamps.push(0.1);
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas 2D context не доступен'));
          return;
        }

        // Wait for video to be ready to play
        if (video.readyState < 2) {
          await new Promise<void>((res) => {
            video.oncanplay = () => res();
          });
        }

        const scale = Math.min(1, 720 / (video.videoWidth || 1280));
        canvas.width = Math.round((video.videoWidth || 1280) * scale);
        canvas.height = Math.round((video.videoHeight || 720) * scale);

        const capturedFrames: Blob[] = [];

        for (const timestamp of timestamps) {
          try {
            const blob = await captureFrame(video, canvas, ctx, timestamp, quality);
            if (blob && blob.size > 0) {
              capturedFrames.push(blob);
            }
          } catch (err) {
            console.warn(`Кадр на ${timestamp}с не извлечён:`, err);
          }
        }

        video.src = '';
        video.load();
        resolve(capturedFrames);
      };

      video.onerror = (e) => {
        clearTimeout(timeout);
        const mediaError = video.error;
        reject(new Error(
          `Видео не поддерживается браузером (код: ${mediaError?.code}, ${mediaError?.message || e})`
        ));
      };

      video.src = blobUrl;
      video.load();
    });

    return frames;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function captureFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  timestamp: number,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Таймаут seek на ${timestamp}с`));
    }, 5000);

    video.onseeked = () => {
      clearTimeout(timeout);
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => resolve(blob),
          'image/jpeg',
          quality
        );
      } catch (err) {
        reject(err);
      }
    };

    video.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`Ошибка seek на ${timestamp}с`));
    };

    video.currentTime = timestamp;
  });
}

/**
 * Determine video MIME type from filename.
 * Critical for browser's <video> element to decode properly.
 */
export function getVideoMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const mimeMap: Record<string, string> = {
    'mp4': 'video/mp4',
    'm4v': 'video/mp4',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
    'webm': 'video/webm',
    'mkv': 'video/x-matroska',
    '3gp': 'video/3gpp',
    'flv': 'video/x-flv',
    'wmv': 'video/x-ms-wmv',
  };
  return mimeMap[ext] || 'video/mp4';
}
