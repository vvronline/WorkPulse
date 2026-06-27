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

// Update delivery has two sources:
//   1. Cloudflare R2 (custom domain) — used when EXPO_PUBLIC_OTA_BASE_URL is
//      baked in at build time (see mobile-release.yml). Lets a PRIVATE GitHub
//      repo keep delivering OTA APK updates.
//   2. GitHub Releases — the fallback when R2 is not configured. The mobile
//      release workflow already attaches the APK to each `mobile-vX.Y.Z`
//      GitHub release, so this works out of the box for a public repo.
// If the OTA base URL is empty we go straight to the GitHub fallback.
const OTA_BASE_URL = (process.env.EXPO_PUBLIC_OTA_BASE_URL || "").replace(
  /\/+$/,
  "",
);
const MOBILE_LATEST_JSON_URL = OTA_BASE_URL
  ? `${OTA_BASE_URL}/mobile/latest.json`
  : "";

// GitHub repo that hosts the releases. Mobile releases are tagged
// `mobile-vX.Y.Z` (desktop uses `vX.Y.Z`), so we only ever look at mobile tags.
const GITHUB_OWNER = "vvronline";
const GITHUB_REPO = "WorkPulse";

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
 * Check for a newer mobile release. Returns `{ available: false }` with a
 * `reason` on any non-update outcome so callers can decide whether to surface
 * anything to the user.
 *
 * Tries the R2 manifest first (when configured), then falls back to the GitHub
 * releases API so updates keep working even when R2 is not set up.
 */
export async function checkForMobileUpdate(): Promise<MobileUpdateInfo> {
  const currentVersion = getCurrentVersion();

  // Updates are only deliverable on Android (APK sideload). iOS has no build.
  if (Platform.OS !== "android") {
    return { available: false, currentVersion, reason: "unsupported" };
  }

  // 1. Cloudflare R2 manifest (only when an OTA base URL was baked in).
  if (MOBILE_LATEST_JSON_URL) {
    const fromR2 = await checkR2ForMobileUpdate(currentVersion);
    // Only fall through to GitHub when R2 was unreachable / had no release.
    if (fromR2.reason !== "no-release" && fromR2.reason !== "error") {
      return fromR2;
    }
  }

  // 2. GitHub releases fallback (works for a public repo, no auth token).
  return checkGitHubForMobileUpdate(currentVersion);
}

/** Query the R2 `mobile/latest.json` manifest. */
async function checkR2ForMobileUpdate(
  currentVersion: string,
): Promise<MobileUpdateInfo> {
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

/** Minimal shape of the GitHub releases API response we rely on. */
interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}
interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubReleaseAsset[];
}

/**
 * Find the newest published `mobile-vX.Y.Z` GitHub release and compare it to the
 * running version. Picks the first `.apk` asset as the download URL.
 */
async function checkGitHubForMobileUpdate(
  currentVersion: string,
): Promise<MobileUpdateInfo> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=30`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "WorkPulse-Mobile",
        },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      return {
        available: false,
        currentVersion,
        reason: res.status === 404 ? "no-release" : "error",
      };
    }

    const releases = (await res.json()) as GitHubRelease[];
    const mobileReleases = (releases || [])
      .filter((r) => !r.draft && !r.prerelease && r.tag_name)
      .map((r) => ({ ...r, version: tagToVersion(r.tag_name as string) }))
      .filter((r) => r.version != null) as Array<
      GitHubRelease & { version: string }
    >;
    if (mobileReleases.length === 0) {
      return { available: false, currentVersion, reason: "no-release" };
    }
    mobileReleases.sort((a, b) => compareSemver(a.version, b.version));
    const latest = mobileReleases[mobileReleases.length - 1];

    if (compareSemver(latest.version, currentVersion) <= 0) {
      return {
        available: false,
        currentVersion,
        version: latest.version,
        reason: "up-to-date",
      };
    }

    const apkAsset = (latest.assets || []).find((a) =>
      (a.name || "").toLowerCase().endsWith(".apk"),
    );

    return {
      available: true,
      version: latest.version,
      currentVersion,
      notes: cleanReleaseNotes(latest.body || ""),
      apkUrl: apkAsset?.browser_download_url,
      releaseUrl: latest.html_url,
    };
  } catch {
    return { available: false, currentVersion, reason: "error" };
  }
}

/** Convert a `mobile-vX.Y.Z` tag to its `X.Y.Z` version; null if not a mobile tag. */
function tagToVersion(tag: string): string | null {
  const m = /^mobile-v(\d+\.\d+\.\d+)$/.exec(tag);
  return m ? m[1] : null;
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
