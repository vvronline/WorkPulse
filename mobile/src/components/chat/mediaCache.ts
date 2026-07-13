// Persistent on-device media cache (WhatsApp / Signal parity). Chat images and
// voice notes are served from the server's `/uploads` route behind Bearer auth;
// previously every render STREAMED the bytes fresh, so going offline left
// already-seen media blank/unplayable. This module mirrors what WhatsApp does:
// the first time a media file is shown it is downloaded ONCE to a persistent
// app directory, and from then on the local copy is used — which keeps working
// with no network at all.
//
// Scope: images + audio go through here. Video uses expo-video's built-in
// `useCaching` source flag instead (it streams + caches progressively and plays
// the cached portion offline), which is the platform-recommended path for video.
//
// The cache lives under documentDirectory (NOT cacheDirectory) so the OS does
// not purge it under storage pressure the way it can with the cache dir —
// "downloaded media should stay available offline" is the explicit requirement.
import * as FileSystem from "expo-file-system/legacy";
import { getToken } from "../../auth/tokenStore";
import { uploadUrl } from "../../config";

const DIR = `${FileSystem.documentDirectory}wp_media/`;

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = FileSystem.makeDirectoryAsync(DIR, { intermediates: true })
      .catch(() => {})
      .then(() => {});
  }
  return dirReady;
}

// Stable, collision-resistant key for a URL (FNV-1a 32-bit, hex). Good enough
// to derive a filename from an upload URL; the original extension is preserved
// so the OS / players can sniff the type.
function hashKey(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function extFromUrl(url: string): string {
  const clean = url.split("?")[0].split("#")[0];
  const m = clean.match(/\.([a-z0-9]{1,5})$/i);
  return m ? `.${m[1].toLowerCase()}` : "";
}

function localPathFor(remote: string): string {
  return `${DIR}${hashKey(remote)}${extFromUrl(remote)}`;
}

// remote url -> resolved local uri that is known to exist on disk.
const memo = new Map<string, string>();
// remote url -> in-flight download promise (dedupes concurrent requests for the
// same file, e.g. the same image mounted in several recycled list rows).
const inflight = new Map<string, Promise<string | null>>();

/**
 * Resolve `pathOrUrl` (an `/uploads/...` path, absolute URL, or already-local
 * uri) to a LOCAL uri IF it is already cached on disk — without touching the
 * network. Returns the local uri, the original uri when it is already local, or
 * null when nothing is cached yet. Safe to call on every render.
 */
export async function getCachedMedia(
  pathOrUrl?: string | null,
): Promise<string | null> {
  const remote = uploadUrl(pathOrUrl || "");
  if (!remote) return null;
  // Already a local/optimistic uri — nothing to cache, use as-is.
  if (/^(file|content|data):/i.test(remote)) return remote;
  const hit = memo.get(remote);
  if (hit) return hit;
  const local = localPathFor(remote);
  try {
    const info = await FileSystem.getInfoAsync(local);
    if (info.exists && (info.size ?? 0) > 0) {
      memo.set(remote, local);
      return local;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * SYNCHRONOUS variant of {@link getCachedMedia}: returns the local uri ONLY if
 * it's already known this session (in the in-memory `memo`, warmed by a prior
 * getCachedMedia/ensureCachedMedia), or the input is already a local uri.
 * Returns null otherwise — it never touches the filesystem or network, so it's
 * safe to call in a `useState` initializer.
 *
 * PERF (chat-open jank): AuthedImage seeds its `localUri` from this so an image
 * that resolved earlier in the session (e.g. a row recycled while scrolling, or
 * re-rendered on open) paints on the FIRST frame instead of flashing blank while
 * the async `getInfoAsync` re-resolves the same file.
 */
export function getCachedMediaSync(pathOrUrl?: string | null): string | null {
  const remote = uploadUrl(pathOrUrl || "");
  if (!remote) return null;
  if (/^(file|content|data):/i.test(remote)) return remote;
  return memo.get(remote) ?? null;
}

/**
 * Ensure `pathOrUrl` is cached locally, downloading it (with the Bearer token)
 * if needed, and return the local uri. Returns null on failure (e.g. offline
 * and not yet cached). Concurrent calls for the same url share one download.
 */
export async function ensureCachedMedia(
  pathOrUrl?: string | null,
): Promise<string | null> {
  const remote = uploadUrl(pathOrUrl || "");
  if (!remote) return null;
  if (/^(file|content|data):/i.test(remote)) return remote;

  const cached = await getCachedMedia(remote);
  if (cached) return cached;

  const existing = inflight.get(remote);
  if (existing) return existing;

  const job = (async (): Promise<string | null> => {
    await ensureDir();
    const local = localPathFor(remote);
    // Download to a temp path first, then move into place, so a half-finished
    // download (app killed / offline mid-stream) never leaves a corrupt file
    // that getCachedMedia would treat as valid.
    const tmp = `${local}.part-${Date.now()}`;
    try {
      const token = await getToken();
      const dl = await FileSystem.downloadAsync(remote, tmp, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (dl.status !== 200) {
        await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
        return null;
      }
      try {
        await FileSystem.moveAsync({ from: tmp, to: local });
      } catch {
        // A concurrent writer may have already produced `local`; drop the temp.
        await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
      }
      const info = await FileSystem.getInfoAsync(local);
      if (info.exists && (info.size ?? 0) > 0) {
        memo.set(remote, local);
        return local;
      }
      return null;
    } catch {
      await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
      return null;
    } finally {
      inflight.delete(remote);
    }
  })();

  inflight.set(remote, job);
  return job;
}

/**
 * Delete the entire on-device media cache and reset the in-memory lookup.
 *
 * Called on sign-out so downloaded chat images/voice notes from the previous
 * account (potentially a different tenant) are not left readable on a shared
 * device. Best-effort: failures must never block logout.
 */
export async function clearMediaCache(): Promise<void> {
  memo.clear();
  inflight.clear();
  dirReady = null;
  try {
    await FileSystem.deleteAsync(DIR, { idempotent: true });
  } catch {
    /* best-effort */
  }
}
