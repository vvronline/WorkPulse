/** Mirrors client/src/utils/time.ts formatting helpers. */

/** Format minutes as "Xh Ym" (or "Ym" under an hour). */
export function formatTime(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(m / 60);
  const mins = m % 60;
  if (h === 0) return `${mins}m`;
  return `${h}h ${mins}m`;
}

/** Format seconds as H:MM:SS (or M:SS under an hour). */
export function formatTimeSec(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}
