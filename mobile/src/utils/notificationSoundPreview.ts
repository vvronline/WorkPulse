export type NotificationSoundCategory =
  | "ringtone"
  | "outgoing"
  | "message"
  | "mention"
  | "reaction";

const PREVIEW_NOTES: Record<string, number[]> = {
  classic: [440, 440],
  calm: [392, 523, 659],
  dynamic: [523, 659, 784, 659],
  urgent: [880, 880, 988],
  boop: [330, 247],
  marimba: [523, 659, 784, 1046],
  crystal: [659, 988, 1318],
  vapor: [392, 523, 659, 784],
  ringback: [440, 480],
  pulse: [523],
  soft: [659, 523],
  echo: [587, 587],
  drift: [740, 622],
  ding: [880, 1175],
  pop: [180, 80],
  chime: [784, 988, 1175],
  knock: [220, 220],
  subtle: [1046],
  glassy: [1046, 1318],
  ripple: [660, 880, 1175],
  mention: [784, 988, 1175],
  spark: [1175, 1568],
  click: [1200],
};

const FALLBACK_TONE: Record<NotificationSoundCategory, string> = {
  ringtone: "classic",
  outgoing: "ringback",
  message: "ding",
  mention: "mention",
  reaction: "subtle",
};

const previewCache = new Map<string, string>();
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >> 18) & 63];
    out += BASE64_ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return out;
}

function encodeWavPcm16(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataLength = samples.length * 2;
  const totalLength = 44 + dataLength;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x52494646, false); // RIFF
  view.setUint32(4, totalLength - 8, true);
  view.setUint32(8, 0x57415645, false); // WAVE
  view.setUint32(12, 0x666d7420, false); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  view.setUint32(36, 0x64617461, false); // data
  view.setUint32(40, dataLength, true);

  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, samples[i], true);
  }
  return bytes;
}

function synthesizePreviewPcm(notes: number[]): Int16Array {
  const sampleRate = 22050;
  const durationSec = 0.38;
  const noteSpacing = 0.07;
  const noteDuration = 0.16;
  const sampleCount = Math.floor(sampleRate * durationSec);
  const pcm = new Int16Array(sampleCount);

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    let value = 0;

    for (let n = 0; n < notes.length; n += 1) {
      const start = n * noteSpacing;
      const end = Math.min(durationSec, start + noteDuration);
      if (t < start || t > end) continue;
      const localT = t - start;
      const envelope = Math.exp(-18 * localT);
      value += Math.sin(2 * Math.PI * notes[n] * localT) * envelope * (0.6 / (n + 1));
    }

    const clamped = Math.max(-1, Math.min(1, value));
    pcm[i] = Math.round(clamped * 32767);
  }

  return pcm;
}

export function getNotificationPreviewDataUri(
  category: NotificationSoundCategory,
  toneId: string,
): string | null {
  if (!toneId || toneId === "none") return null;
  const key = `${category}:${toneId}`;
  const cached = previewCache.get(key);
  if (cached) return cached;

  const notes = PREVIEW_NOTES[toneId] ?? PREVIEW_NOTES[FALLBACK_TONE[category]];
  if (!notes?.length) return null;

  const pcm = synthesizePreviewPcm(notes);
  const wav = encodeWavPcm16(pcm, 22050);
  const uri = `data:audio/wav;base64,${toBase64(wav)}`;
  previewCache.set(key, uri);
  return uri;
}
