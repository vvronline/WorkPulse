import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { getToken } from "../../auth/tokenStore";
import { uploadUrl } from "../../config";

/**
 * Shared-media file actions (share / save to device) for the multi-select
 * action bar in {@link SharedMediaGallery}. The `/uploads` route is behind
 * Bearer auth, so every remote file must be downloaded WITH the token before it
 * can be handed to the OS share sheet or the media library — mirrors
 * {@link openAuthedFile}, which does the same for the "open in viewer" path.
 */

type Result = { ok: boolean; error?: string };

/**
 * Resolve a protected `/uploads/...` file to a local cache uri, attaching the
 * Bearer token. Local (optimistic) files are returned as-is.
 */
export async function downloadAuthedToCache(
  fileUrl: string | null | undefined,
  fileName?: string | null,
): Promise<{ ok: boolean; uri?: string; error?: string }> {
  const remote = uploadUrl(fileUrl);
  if (!remote) return { ok: false, error: "No file to download." };

  // Already-local (not yet uploaded) files need no download.
  if (/^(file|content):/i.test(remote)) return { ok: true, uri: remote };

  const token = await getToken();
  if (!token) return { ok: false, error: "Not signed in." };

  const safeName =
    (fileName || remote.split("/").pop() || `file-${Date.now()}`).replace(
      /[^\w.\-]+/g,
      "_",
    ) || `file-${Date.now()}`;
  const target = `${FileSystem.cacheDirectory}${Date.now()}-${safeName}`;

  try {
    const dl = await FileSystem.downloadAsync(remote, target, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (dl.status !== 200) {
      return { ok: false, error: `Download failed (${dl.status}).` };
    }
    return { ok: true, uri: dl.uri };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Could not download this file." };
  }
}

async function shareLocalFile(
  uri: string,
  mimeType: string | null | undefined,
  dialogTitle: string,
): Promise<Result> {
  try {
    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) return { ok: false, error: "Sharing is not available." };
    await Sharing.shareAsync(uri, {
      mimeType: mimeType || undefined,
      dialogTitle,
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Could not share this file." };
  }
}

/** Download (with auth) then present the OS share sheet for a single file. */
export async function shareAuthedFile(
  fileUrl: string | null | undefined,
  fileName?: string | null,
  mimeType?: string | null,
): Promise<Result> {
  const res = await downloadAuthedToCache(fileUrl, fileName);
  if (!res.ok || !res.uri) return { ok: false, error: res.error };
  return shareLocalFile(res.uri, mimeType, "Share");
}

/**
 * Download (with auth) then hand the file to the OS "save/export" sheet.
 * Used for non-media attachments where MediaLibrary is not the right target.
 */
export async function exportAuthedFile(
  fileUrl: string | null | undefined,
  fileName?: string | null,
  mimeType?: string | null,
): Promise<Result> {
  const res = await downloadAuthedToCache(fileUrl, fileName);
  if (!res.ok || !res.uri) return { ok: false, error: res.error };
  return shareLocalFile(res.uri, mimeType, "Save file");
}

// expo-file-system v56 moved the classic API to `/legacy`; expo-media-library
// did the same. Resolve whichever is present (and tolerate it being absent).
function getMediaLibrary(): any {
  try {
    return require("expo-media-library/legacy");
  } catch {
    try {
      return require("expo-media-library");
    } catch {
      return null;
    }
  }
}

/**
 * Save an image/video to the device's media library (camera roll). Downloads
 * the protected file with the Bearer token first, then writes it via
 * `MediaLibrary.saveToLibraryAsync`.
 */
export async function saveAuthedFileToLibrary(
  fileUrl: string | null | undefined,
  fileName?: string | null,
): Promise<Result> {
  const res = await downloadAuthedToCache(fileUrl, fileName);
  if (!res.ok || !res.uri) return { ok: false, error: res.error };

  const MediaLibrary = getMediaLibrary();
  if (!MediaLibrary) {
    return { ok: false, error: "Media library is unavailable on this device." };
  }
  try {
    // writeOnly = true → only request the add-to-library grant (Android 13+
    // and iOS limited-access friendly).
    const perm = await MediaLibrary.requestPermissionsAsync(true);
    const granted = perm?.granted || perm?.status === "granted";
    if (!granted) return { ok: false, error: "Permission to save was denied." };
    await MediaLibrary.saveToLibraryAsync(res.uri);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Could not save this file." };
  }
}
