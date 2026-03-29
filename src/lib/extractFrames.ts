import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoading: Promise<FFmpeg> | null = null;

/**
 * Get or create a singleton FFmpeg instance.
 * Uses single-threaded core (no SharedArrayBuffer / COOP/COEP needed).
 * Downloads WASM from CDN on first use, then caches as blob URL.
 */
async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;

  ffmpegLoading = (async () => {
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  return ffmpegLoading;
}

/**
 * Extract key frames from a video Blob using ffmpeg.wasm.
 * Works with ANY codec (HEVC, H.264, VP9, etc.) — no browser codec dependency.
 */
export async function extractFramesFromBlob(
  videoBlob: Blob,
  options: { intervalSec?: number; maxFrames?: number; quality?: number } = {}
): Promise<Blob[]> {
  const { intervalSec = 3, maxFrames = 10, quality = 0.7 } = options;

  const ffmpeg = await getFFmpeg();

  const inputData = new Uint8Array(await videoBlob.arrayBuffer());
  await ffmpeg.writeFile('input.mp4', inputData);

  // ffmpeg quality: 2 (best) to 31 (worst)
  const jpegQuality = Math.round(31 - (quality * 29));
  const fps = 1 / intervalSec;

  await ffmpeg.exec([
    '-i', 'input.mp4',
    '-vf', `fps=${fps},scale='min(720\\,iw)':-2`,
    '-frames:v', String(maxFrames),
    '-q:v', String(jpegQuality),
    '-f', 'image2',
    'frame_%03d.jpg',
  ]);

  const frames: Blob[] = [];
  for (let i = 1; i <= maxFrames; i++) {
    const filename = `frame_${String(i).padStart(3, '0')}.jpg`;
    try {
      const data = await ffmpeg.readFile(filename);
      if (data instanceof Uint8Array && data.length > 0) {
        frames.push(new Blob([data], { type: 'image/jpeg' }));
      }
      await ffmpeg.deleteFile(filename);
    } catch {
      break;
    }
  }

  try { await ffmpeg.deleteFile('input.mp4'); } catch { /* ignore */ }

  return frames;
}

/**
 * Determine video MIME type from filename.
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
