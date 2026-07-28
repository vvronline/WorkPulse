// expo-file-system v56 moved the classic downloadAsync/cacheDirectory API to
// the /legacy entrypoint.
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { API_BASE_URL } from "../../config";
import { getToken } from "../../auth/tokenStore";

/**
 * Download the personal analytics export (CSV or PDF) from the server and open
 * the OS share sheet. The web client hits GET /export/my-analytics?from&to&
 * format — we do the same here with the bearer token attached, then hand the
 * downloaded file to expo-sharing.
 *
 * Returns nothing; throws on failure so the caller can surface a themed error.
 */
export async function exportMyAnalytics(
  from: string,
  to: string,
  format: "csv" | "pdf",
): Promise<void> {
  const token = await getToken();
  const ext = format === "pdf" ? "pdf" : "csv";
  const url =
    `${API_BASE_URL}/export/my-analytics` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=${format}`;

  const target = `${FileSystem.cacheDirectory}analytics_${from}_${to}.${ext}`;

  const res = await FileSystem.downloadAsync(url, target, {
    headers: {
      Authorization: token ? `Bearer ${token}` : "",
      "X-Requested-With": "WorkPulse",
      "x-timezone-offset": String(new Date().getTimezoneOffset()),
    },
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Export failed (HTTP ${res.status})`);
  }

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    throw new Error("Sharing is not available on this device.");
  }

  await Sharing.shareAsync(res.uri, {
    mimeType: format === "pdf" ? "application/pdf" : "text/csv",
    dialogTitle: `Export Analytics (${format.toUpperCase()})`,
    UTI: format === "pdf" ? "com.adobe.pdf" : "public.comma-separated-values-text",
  });
}