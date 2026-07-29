/** R2-backed binary updater for direct-distribution Android builds. */
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";

const OTA_BASE_URL = (process.env.EXPO_PUBLIC_OTA_BASE_URL || "").replace(/\/+$/, "");
const MOBILE_MANIFEST_URL = OTA_BASE_URL ? `${OTA_BASE_URL}/mobile/latest.json` : "";
const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/vvronline/WorkPulse/releases?per_page=30";

export type UpdateReason = "up-to-date" | "no-release" | "error" | "unsupported";

export interface MobileUpdateInfo {
  available: boolean;
  version?: string;
  currentVersion: string;
  notes?: string;
  apkUrl?: string;
  releaseUrl?: string;
  reason?: UpdateReason;
  errorMessage?: string;
}

interface MobileManifest {
  version?: string;
  apkUrl?: string;
  notes?: string;
  releaseUrl?: string;
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

export function getCurrentVersion(): string {
  const extra = (Constants.expoConfig?.extra ?? {}) as { APP_VERSION?: string };
  return extra.APP_VERSION || Constants.expoConfig?.version || "0.0.0";
}

/** Compare numeric semver core values, ignoring a leading v and prerelease suffix. */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string) => {
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`Invalid version comparison: "${a}" and "${b}"`);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function evaluateManifest(
  manifest: MobileManifest,
  currentVersion: string,
): MobileUpdateInfo {
  if (!manifest.version || !/^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version)) {
    return {
      available: false,
      currentVersion,
      reason: "no-release",
      errorMessage: "The update server returned an invalid release manifest.",
    };
  }
  const version = manifest.version.replace(/^v/, "");
  if (compareSemver(version, currentVersion) <= 0) {
    return { available: false, currentVersion, version, reason: "up-to-date" };
  }
  if (!manifest.apkUrl) {
    return {
      available: false,
      currentVersion,
      version,
      releaseUrl: manifest.releaseUrl,
      reason: "no-release",
      errorMessage: `Version ${version} is published, but its APK is missing.`,
    };
  }
  return {
    available: true,
    currentVersion,
    version,
    notes: cleanReleaseNotes(manifest.notes || ""),
    apkUrl: manifest.apkUrl,
    releaseUrl: manifest.releaseUrl,
  };
}

async function checkR2(currentVersion: string): Promise<MobileUpdateInfo | null> {
  if (!MOBILE_MANIFEST_URL) return null;
  try {
    const separator = MOBILE_MANIFEST_URL.includes("?") ? "&" : "?";
    const response = await fetch(`${MOBILE_MANIFEST_URL}${separator}t=${Date.now()}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    return evaluateManifest((await response.json()) as MobileManifest, currentVersion);
  } catch {
    return null;
  }
}

async function checkGithub(currentVersion: string): Promise<MobileUpdateInfo> {
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "AINO-Mobile" },
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const releases = (await response.json()) as GithubRelease[];
    const release = releases.find(
      (item) => !item.draft && !item.prerelease && /^mobile-v\d+\.\d+\.\d+$/.test(item.tag_name || ""),
    );
    if (!release) return { available: false, currentVersion, reason: "no-release" };
    const version = release.tag_name!.replace(/^mobile-v/, "");
    const apk = release.assets?.find((asset) => asset.name?.toLowerCase().endsWith(".apk"));
    return evaluateManifest(
      {
        version,
        apkUrl: apk?.browser_download_url,
        notes: release.body,
        releaseUrl: release.html_url,
      },
      currentVersion,
    );
  } catch (error) {
    return {
      available: false,
      currentVersion,
      reason: "error",
      errorMessage:
        error instanceof Error ? error.message : "Could not reach the update server.",
    };
  }
}

export async function checkForMobileUpdate(): Promise<MobileUpdateInfo> {
  const currentVersion = getCurrentVersion();
  if (Platform.OS !== "android") {
    return { available: false, currentVersion, reason: "unsupported" };
  }
  const r2Result = await checkR2(currentVersion);
  // A valid R2 response is authoritative, including an up-to-date result.
  if (r2Result) return r2Result;
  return checkGithub(currentVersion);
}

export async function downloadAndInstallApk(
  apkUrl: string,
  version: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  if (Platform.OS !== "android") throw new Error("APK installation is only supported on Android.");
  if (!FileSystem.cacheDirectory) throw new Error("App download storage is unavailable.");

  const targetUri = `${FileSystem.cacheDirectory}AINO-${version}.apk`;
  const existing = await FileSystem.getInfoAsync(targetUri).catch(() => null);
  if (existing?.exists) await FileSystem.deleteAsync(targetUri, { idempotent: true });

  const download = FileSystem.createDownloadResumable(apkUrl, targetUri, {}, (progress) => {
    if (progress.totalBytesExpectedToWrite > 0) {
      onProgress?.(progress.totalBytesWritten / progress.totalBytesExpectedToWrite);
    }
  });
  const result = await download.downloadAsync();
  if (!result?.uri) throw new Error("The APK download did not complete.");

  const contentUri = await FileSystem.getContentUriAsync(result.uri);
  try {
    await IntentLauncher.startActivityAsync("android.intent.action.INSTALL_PACKAGE", {
      data: contentUri,
      flags: 1,
      type: "application/vnd.android.package-archive",
    });
  } catch {
    throw new Error(
      'Android could not open the installer. Enable "Install unknown apps" for AINO and try again.',
    );
  }
}

function cleanReleaseNotes(raw: string): string {
  return raw
    .replace(/#+\s*.*Checksums[\s\S]*$/i, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`|\*\*/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}