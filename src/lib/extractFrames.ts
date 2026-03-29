/**
 * Extract key frames from a video file at regular intervals.
 * Returns an array of JPEG blobs suitable for Claude Vision API.
 */
export async function extractFramesFromVideo(
  videoUrl: string,
  options: { intervalSec?: number; maxFrames?: number; quality?: number } = {}
): Promise<Blob[]> {
  const { intervalSec = 3, maxFrames = 10, quality = 0.7 } = options;

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';

    video.onloadedmetadata = async () => {
      const duration = video.duration;
      if (!duration || duration === Infinity) {
        reject(new Error('Не удалось определить длительность видео'));
        return;
      }

      // Calculate frame timestamps
      const step = Math.max(intervalSec, duration / maxFrames);
      const timestamps: number[] = [];
      for (let t = 0.5; t < duration && timestamps.length < maxFrames; t += step) {
        timestamps.push(t);
      }
      // Always include a frame near the end
      if (timestamps.length > 0 && timestamps[timestamps.length - 1] < duration - 1) {
        timestamps.push(Math.max(duration - 0.5, 0));
      }

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas не поддерживается'));
        return;
      }

      // Scale down to max 720p width for efficiency
      const scale = Math.min(1, 720 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);

      const frames: Blob[] = [];

      for (const timestamp of timestamps) {
        try {
          const blob = await captureFrame(video, canvas, ctx, timestamp, quality);
          if (blob) frames.push(blob);
        } catch {
          // Skip frames that fail to capture
        }
      }

      // Cleanup
      video.src = '';
      video.load();

      resolve(frames);
    };

    video.onerror = () => reject(new Error('Ошибка загрузки видео для извлечения кадров'));
    video.src = videoUrl;
  });
}

function captureFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  timestamp: number,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    video.currentTime = timestamp;
    video.onseeked = () => {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => resolve(blob),
        'image/jpeg',
        quality
      );
    };
  });
}
