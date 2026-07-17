export function normalizeMediaDimension(value: unknown): number | null {
  const dimension = Number(value);
  if (!Number.isFinite(dimension) || dimension <= 0) return null;
  return Math.round(dimension);
}

export function updateMediaDimensionIndex(
  currentEntries: readonly string[],
  touchedKey: string,
  maxEntries: number,
): { entries: string[]; evicted: string[] } {
  const safeMax = Math.max(0, Math.floor(maxEntries));
  const entries = currentEntries.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry !== touchedKey,
  );
  entries.push(touchedKey);

  const evicted: string[] = [];
  while (entries.length > safeMax) {
    const removed = entries.shift();
    if (removed) evicted.push(removed);
  }

  return { entries, evicted };
}