/**
 * In-app updater for the WorkPulse mobile (Android) app.
 *
 * Completely INDEPENDENT of the desktop updater. Desktop releases use `vX.Y.Z`
 * tags + electron-updater + latest.yml; mobile releases use `mobile-vX.Y.Z`
 * tags and ship a single `WorkPulse-<version>.apk` asset (see
 * .github/workflows/mobile-release.yml). This module only ever looks at
 * `mobile-v*` releases so the two channels never collide.
 *
 * Flow:
 *   1. checkForMobileUpdate() → query GitHub releases, find the latest
 *      `mobile-v*` release, compare semver to the running app version.
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

const GITHUB_OWNER = "vvronline";
const GITHUB_REPO = "WorkPulse";

// Mobile release tags look like `mobile-v1.0.28`. This regex isolates them so
// we never pick up a desktop `vX.Y.Z` release.
const MOBILE_TAG_RE = /^mobile-v(\d+\.\d+\.\d+)$/;

export interface MobileUpdateInfo {
  available: boolean;
  /** Latest version available on GitHub, e.g. "1.0.29". */
  version?: string;
  /** Current running app version. */
  currentVersion?: string;
  /** Plain-text release notes (markdown body from the GitHub release). */
  notes?: string;
  /** Direct download URL for the APK asset. */
  apkUrl?: string;
  /** Browser URL for the release page (fallback). */
  releaseUrl?: string;
  /** Reason when unavailable: "up-to-date" | "no-release" | "error" | "unsupported". */
  reason?: string;
}

interface GitHubAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubAsset[];
}

/** The running app version (from app.config.ts → extra.APP_VERSION). */
export function getCurrentVersion(): string {
  const extra = (Constants.expoConfig?.extra ?? {}) as { APP_VERSION?: string };
  return extra.APP_VERSION || Constants.expoConfig?.version || "0.0.0";
}

/** Compare two semver strings (a.b.c). Returns 1 if a>b, -1 if a<b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Check GitHub for a newer mobile release. Returns `{ available: false }` with
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
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=100`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "WorkPulse-Mobile",
        },
      },
    );
    if (!res.ok) {
      return { available: false, currentVersion, reason: "error" };
    }
    const releases = (await res.json()) as GitHubRelease[];

    // Filter to published mobile releases and pick the highest semver.
    const mobileReleases = releases
      .filter((r) => !r.draft && !r.prerelease && r.tag_name && MOBILE_TAG_RE.test(r.tag_name))
      .map((r) => ({
        release: r,
        version: (r.tag_name as string).match(MOBILE_TAG_RE)![1],
      }))
      .sort((a, b) => compareSemver(b.version, a.version));

    if (mobileReleases.length === 0) {
      return { available: false, currentVersion, reason: "no-release" };
    }

    const latest = mobileReleases[0];
    if (compareSemver(latest.version, currentVersion) <= 0) {
      return { available: false, currentVersion, version: latest.version, reason: "up-to-date" };
    }

    // Find the APK asset on the latest release.
    const apkAsset = (latest.release.assets || []).find((a) =>
      a.name?.toLowerCase().endsWith(".apk"),
    );

    return {
      available: true,
      version: latest.version,
      currentVersion,
      notes: cleanReleaseNotes(latest.release.body || ""),
      apkUrl: apkAsset?.browser_download_url,
      releaseUrl: latest.release.html_url,
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
        onProgress(progress.totalBytesWritten / progress.totalBytesExpectedToWrite);
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

  await IntentLauncher.startActivityAsync("android.intent.action.INSTALL_PACKAGE", {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: "application/vnd.android.package-archive",
  });
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