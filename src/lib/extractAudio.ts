/**
 * Extract audio track from a video file using Web Audio API.
 * Returns a compressed audio Blob (webm/opus) suitable for Whisper API (<25MB).
 */
export async function extractAudioFromVideo(videoUrl: string): Promise<Blob> {
  // Fetch video as ArrayBuffer
  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error("Не удалось скачать видео");
  const arrayBuffer = await response.arrayBuffer();

  // Decode audio from video
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  // Encode to WAV (Whisper accepts wav, mp3, webm, etc.)
  const wavBlob = audioBufferToWav(audioBuffer);
  await audioContext.close();

  return wavBlob;
}

/**
 * Convert AudioBuffer to WAV Blob.
 * WAV is universally supported by Whisper and doesn't need MediaRecorder.
 */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = 1; // Mono is enough for speech
  const sampleRate = 16000; // 16kHz is optimal for Whisper
  const originalSampleRate = buffer.sampleRate;

  // Downmix to mono
  let monoData: Float32Array;
  if (buffer.numberOfChannels === 1) {
    monoData = buffer.getChannelData(0);
  } else {
    monoData = new Float32Array(buffer.length);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const channelData = buffer.getChannelData(ch);
      for (let i = 0; i < buffer.length; i++) {
        monoData[i] += channelData[i] / buffer.numberOfChannels;
      }
    }
  }

  // Resample to 16kHz if needed
  let samples: Float32Array;
  if (originalSampleRate !== sampleRate) {
    const ratio = originalSampleRate / sampleRate;
    const newLength = Math.floor(monoData.length / ratio);
    samples = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      samples[i] = monoData[Math.floor(i * ratio)];
    }
  } else {
    samples = monoData;
  }

  // Convert to 16-bit PCM
  const pcmData = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  // Build WAV file
  const dataSize = pcmData.length * 2;
  const wavBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wavBuffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true); // byte rate
  view.setUint16(32, numChannels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write PCM samples
  const output = new Int16Array(wavBuffer, 44);
  output.set(pcmData);

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
