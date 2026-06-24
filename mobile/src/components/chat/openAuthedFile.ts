import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import * as IntentLauncher from "expo-intent-launcher";
import { getToken } from "../../auth/tokenStore";
import { uploadUrl } from "../../config";

/**
 * Download a protected `/uploads/...` file WITH the Bearer token and open it in
 * the OS viewer. The server's `/uploads` route is behind auth middleware, so a
 * bare `Linking.openURL` sends no credentials → 401 `{"error":"No token
 * provided"}` and the document never opens. This mirrors the web client, which
 * gets the JWT for free via an HttpOnly cookie; on mobile we must attach
 * `Authorization: Bearer <jwt>` to the download request.
 *
 * Flow: resolve absolute URL → download to the app cache with the auth header →
 * hand the local file to the platform's share/view sheet (Android uses
 * IntentLauncher with a content:// uri so external apps can read it).
 */
export async function openAuthedFile(
  fileUrl: string | null | undefined,
  fileName?: string | null,
  mimeType?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const remote = uploadUrl(fileUrl);
  if (!remote) return { ok: false, error: "No file to open." };

  // A local file (optimistic, not yet uploaded) can be opened directly.
  if (/^(file|content):/i.test(remote)) {
    return openLocalUri(remote, mimeType);
  }

  const token = await getToken();
  if (!token) return { ok: false, error: "Not signed in." };

  // Build a safe cache target name.
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
    return openLocalUri(dl.uri, mimeType);
  } catch (e: any) {
    return { ok: false, error: e?.message || "Could not open this file." };
  }
}

async function openLocalUri(
  uri: string,
  mimeType?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (Platform.OS === "android") {
    try {
      // Android needs a content:// uri (FileProvider) for other apps to read
      // the file. getContentUriAsync wraps the cache file appropriately.
      const contentUri = await FileSystem.getContentUriAsync(uri);
      await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
        data: contentUri,
        flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
        type: mimeType || undefined,
      });
      return { ok: true };
    } catch {
      // Fall through to the share sheet if no viewer handles the intent.
    }
  }
  try {
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(uri, {
        mimeType: mimeType || undefined,
        dialogTitle: "Open with",
      });
      return { ok: true };
    }
    return { ok: false, error: "No app available to open this file." };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Could not open this file." };
  }
}