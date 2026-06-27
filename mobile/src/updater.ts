/**
 * In-app updater for the WorkPulse mobile (Android) app.
 *
 * Completely INDEPENDENT of the desktop updater. Both channels now serve their
 * assets + version manifest from Cloudflare R2 behind a public custom domain
 * (see docs/OTA_R2_MIGRATION_PLAN.md), which lets the GitHub repo stay private
 * while devices keep updating. Desktop reads `desktop/latest.json`; mobile reads
 * `mobile/latest.json`, so the two channels never collide.
 *
 * Flow:
 *   1. checkForMobileUpdate() → fetch `mobile/latest.json` from R2, compare its
 *      semver to the running app version.
 *   2. downloadAndInstallApk() → download the APK into app storage with live
 *      progress, then hand it to the Android package installer via a
 *      content:// URI (FileProvider) + ACTION_INSTALL_PACKAGE intent.
 */
import { Platform } from "react-native";
import Constants from "expo-constants";
// SDK 56 ships a new File/Directory API as the default export. The classic
// download-with-progress helpers (createDownloadResumable) live under /legacy.
import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";

// OTA base URL (Cloudflare R2 public custom domain). Baked at build time via
// EXPO_PUBLIC_OTA_BASE_URL (see mobile-release.yml); falls back to the
// production CDN for local/dev builds.
const OTA_BASE_URL = (
  process.env.EXPO_PUBLIC_OTA_BASE_URL || "https://cdn.workpulse.app"
).replace(/\/+$/, "");
const MOBILE_LATEST_JSON_URL = `${OTA_BASE_URL}/mobile/latest.json`;

export interface MobileUpdateInfo {
  available: boolean;
  /** Latest version available on the CDN, e.g. "1.0.29". */
  version?: string;
  /** Current running app version. */
  currentVersion?: string;
  /** Plain-text release notes (markdown body from the release manifest). */
  notes?: string;
  /** Direct download URL for the APK asset. */
  apkUrl?: string;
  /** Browser URL for the release folder (fallback). */
  releaseUrl?: string;
  /** Reason when unavailable: "up-to-date" | "no-release" | "error" | "unsupported". */
  reason?: string;
}

/** Shape of mobile/latest.json published by the mobile release workflow. */
interface MobileLatestManifest {
  version?: string;
  apkUrl?: string;
  notes?: string;
  releaseUrl?: string;
}

/** The running app version (from app.config.ts → extra.APP_VERSION). */
export function getCurrentVersion(): string {
  const extra = (Constants.expoConfig?.extra ?? {}) as { APP_VERSION?: string };
  return extra.APP_VERSION || Constants.expoConfig?.version || "0.0.0";
}

/** Compare two semver strings (a.b.c). Returns 1 if a>b, -1 if a<b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = b
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Check the CDN for a newer mobile release. Returns `{ available: false }` with
 * a `reason` on any non-update outcome so callers can decide whether to surface
 * anything to the user.
 */
export async function checkForMobileUpdate(): Promise<MobileUpdateInfo> {
  const currentVersion = getCurrentVersion();

  // Updates are only deliverable on Android (APK sideload). iOS has no build.
  if (Platform.OS !== "android") {
    return { available: false, currentVersion, reason: "unsupported" };
  }

  try {
    const res = await fetch(MOBILE_LATEST_JSON_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "WorkPulse-Mobile",
      },
      // The object is served no-cache, but be explicit so we never read a stale
      // cached manifest and miss a freshly-published version.
      cache: "no-store",
    });
    if (!res.ok) {
      // 404 = no release has been published to the CDN yet.
      return {
        available: false,
        currentVersion,
        reason: res.status === 404 ? "no-release" : "error",
      };
    }

    const latest = (await res.json()) as MobileLatestManifest;
    if (!latest.version) {
      return { available: false, currentVersion, reason: "no-release" };
    }

    if (compareSemver(latest.version, currentVersion) <= 0) {
      return {
        available: false,
        currentVersion,
        version: latest.version,
        reason: "up-to-date",
      };
    }

    return {
      available: true,
      version: latest.version,
      currentVersion,
      notes: cleanReleaseNotes(latest.notes || ""),
      apkUrl: latest.apkUrl,
      releaseUrl: latest.releaseUrl,
    };
  } catch {
    return { available: false, currentVersion, reason: "error" };
  }
}

/**
 * Download the APK with live progress, then trigger the Android system
 * installer. The caller's `onProgress` receives 0..1.
 *
 * Throws on failure so the UI can show an error and fall back to opening the
 * release page in a browser.
 */
export async function downloadAndInstallApk(
  apkUrl: string,
  version: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  if (Platform.OS !== "android") {
    throw new Error("APK install is only supported on Android");
  }

  const targetUri = `${FileSystem.cacheDirectory}WorkPulse-${version}.apk`;

  // Remove any stale partial download so we always fetch a clean APK.
  try {
    const info = await FileSystem.getInfoAsync(targetUri);
    if (info.exists) {
      await FileSystem.deleteAsync(targetUri, { idempotent: true });
    }
  } catch {
    /* ignore */
  }

  const downloadResumable = FileSystem.createDownloadResumable(
    apkUrl,
    targetUri,
    {},
    (progress) => {
      if (onProgress && progress.totalBytesExpectedToWrite > 0) {
        onProgress(
          progress.totalBytesWritten / progress.totalBytesExpectedToWrite,
        );
      }
    },
  );

  const result = await downloadResumable.downloadAsync();
  if (!result?.uri) {
    throw new Error("Download failed");
  }

  // Android 7+ forbids handing a file:// URI to another app. Convert to a
  // content:// URI backed by Expo's FileProvider, then launch the package
  // installer with read permission granted.
  const contentUri = await FileSystem.getContentUriAsync(result.uri);

  await IntentLauncher.startActivityAsync(
    "android.intent.action.INSTALL_PACKAGE",
    {
      data: contentUri,
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
      type: "application/vnd.android.package-archive",
    },
  );
}

/**
 * Strip markdown/HTML noise from a GitHub release body and drop the checksums
 * section so the in-app modal shows clean, readable notes.
 */
function cleanReleaseNotes(raw: string): string {
  if (!raw) return "";
  let text = raw;
  // Drop everything from a "Checksums" heading onward (noisy hashes).
  text = text.replace(/#+\s*.*Checksums[\s\S]*$/i, "");
  // Strip code fences and inline backticks.
  text = text.replace(/```[\s\S]*?```/g, "").replace(/`/g, "");
  // Strip markdown heading hashes and emphasis markers, keep the text.
  text = text
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}
