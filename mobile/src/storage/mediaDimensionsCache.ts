import { uploadUrl } from "../config";
import { scopedChatStorageKey } from "./chatStorageScope";
import { storage } from "./mmkv";
import {
  normalizeMediaDimension,
  updateMediaDimensionIndex,
} from "./mediaDimensionsPolicy";

export type MediaDimensions = {
  width: number;
  height: number;
};

const DIMENSION_PREFIX = "chat:media-dim:";
const DIMENSION_INDEX_KEY = "chat:media-dim:index";
const MAX_PERSISTED_DIMENSIONS = 300;

function canonicalMediaUri(pathOrUrl?: string | null): string | null {
  const uri = uploadUrl(pathOrUrl || "");
  return uri || null;
}

// FNV-1a gives each canonical media URI a compact, stable MMKV key. The full URI
// remains in the stored payload so a theoretical hash collision cannot return
// dimensions belonging to another attachment.
function hashKey(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function storageKey(uri: string): string | null {
  return scopedChatStorageKey(`${DIMENSION_PREFIX}${hashKey(uri)}`);
}

function dimensionIndexKey(): string | null {
  return scopedChatStorageKey(DIMENSION_INDEX_KEY);
}

function readDimensionIndex(key: string): string[] {
  try {
    const parsed = JSON.parse(storage.getString(key) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function touchDimensionIndex(entryKey: string): void {
  const indexKey = dimensionIndexKey();
  if (!indexKey) return;

  const { entries, evicted } = updateMediaDimensionIndex(
    readDimensionIndex(indexKey),
    entryKey,
    MAX_PERSISTED_DIMENSIONS,
  );
  for (const evictedKey of evicted) storage.remove(evictedKey);
  storage.set(indexKey, JSON.stringify(entries));
}

/**
 * Read intrinsic media dimensions synchronously during render.
 *
 * This keeps recycled/cached chat rows at their final aspect ratio on the first
 * frame, including legacy messages whose server metadata predates dimensions.
 */
export function getCachedMediaDimensions(
  pathOrUrl?: string | null,
): MediaDimensions | null {
  const uri = canonicalMediaUri(pathOrUrl);
  if (!uri) return null;
  const key = storageKey(uri);
  if (!key) return null;

  try {
    const raw = storage.getString(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      uri?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (parsed.uri !== uri) return null;
    const width = normalizeMediaDimension(parsed.width);
    const height = normalizeMediaDimension(parsed.height);
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

/**
 * Persist dimensions learned from picker metadata, image decoding, or a video
 * poster. Invalid values are ignored so malformed server data cannot poison
 * future layout.
 */
export function setCachedMediaDimensions(
  pathOrUrl: string | null | undefined,
  widthValue: unknown,
  heightValue: unknown,
): void {
  const uri = canonicalMediaUri(pathOrUrl);
  const width = normalizeMediaDimension(widthValue);
  const height = normalizeMediaDimension(heightValue);
  if (!uri || !width || !height) return;

  const key = storageKey(uri);
  if (!key) return;

  try {
    storage.set(key, JSON.stringify({ uri, width, height }));
    touchDimensionIndex(key);
  } catch {
    /* Best-effort cache writes must never interrupt chat rendering. */
  }
}