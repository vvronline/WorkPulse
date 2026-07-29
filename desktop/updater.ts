import {
  autoUpdater,
  type UpdateInfo,
  type ProgressInfo,
} from "electron-updater";
import {
  ipcMain,
  app,
  BrowserWindow,
  nativeImage,
  type IpcMainInvokeEvent,
  type IpcMainEvent,
} from "electron";

autoUpdater.logger = console;

/**
 * Build a small red circular badge PNG (as a data URL) bearing the unread
 * count, used as the Windows taskbar overlay icon (Windows has no dock badge).
 * Rendered as a self-contained SVG so we don't ship extra image assets.
 */
function buildBadgeDataUrl(label: string, size: number): string {
  const fontSize =
    label.length >= 3 ? Math.round(size * 0.42) : Math.round(size * 0.56);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#ef4444"/>` +
    `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" ` +
    `font-family="Segoe UI, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// R2 is the shipped production update origin. Reading only an environment
// variable here is insufficient: this code runs on the end user's machine, not
// in GitHub Actions. Keep the override for local/staging diagnostics, but ensure
// every normal packaged build can discover R2 without machine configuration.
// GitHub release discovery remains a temporary fallback for the migration
// release and can be removed after R2-only updating has been verified.
const OTA_BASE_URL = (
  process.env.OTA_BASE_URL || "https://cdn.aino.org.in"
).replace(/\/+$/, "");

// Desktop and mobile releases share the bucket but live under separate prefixes
// (`desktop/` vs `mobile/`) with their own `latest.json`, so the two channels
// never collide — the desktop app only ever reads `desktop/latest.json`.
const DESKTOP_LATEST_JSON_URL = OTA_BASE_URL
  ? `${OTA_BASE_URL}/desktop/latest.json`
  : "";

// GitHub repo that hosts the releases. Desktop releases are tagged `vX.Y.Z`;
// mobile releases use `mobile-vX.Y.Z` and MUST be ignored here, otherwise
// electron-updater would try to read a non-existent `latest.yml` from a mobile
// release (the original cause of the 404 update error).
const GITHUB_OWNER = "vvronline";
const GITHUB_REPO = "WorkPulse";

interface DesktopLatestManifest {
  /** e.g. "1.6.95" */
  version?: string;
  /** e.g. "v1.6.95" — the folder name under desktop/releases/ */
  tag?: string;
}

interface DesktopFeed {
  /** Release tag, e.g. "v1.6.95". */
  tag: string;
  /** Feed URL whose `latest.yml` electron-updater should read. */
  url: string;
}

/** GET a URL and parse the body as JSON. Rejects on non-2xx / timeout. */
function httpGetJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const https = require("https");
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "WorkPulse-Desktop",
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
      },
      (res: import("http").IncomingMessage) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body) as T);
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/** GET a URL and return body text. Rejects on non-2xx / timeout. */
function httpGetText(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const https = require("https");
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "WorkPulse-Desktop",
          Accept: "text/html,application/xhtml+xml",
          "Cache-Control": "no-cache",
        },
      },
      (res: import("http").IncomingMessage) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/** Compare two semver strings (a.b.c). Returns 1 if a>b, -1 if a<b, 0 equal. */
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
 * Resolve the latest DESKTOP release tag (e.g. "v1.6.29") from the R2
 * `desktop/latest.json` manifest. Returns null on any failure so callers can
 * fall back to the GitHub releases API.
 */
async function resolveLatestDesktopTagFromR2(): Promise<string | null> {
  if (!DESKTOP_LATEST_JSON_URL) return null;
  try {
    const manifest = await httpGetJson<DesktopLatestManifest>(
      DESKTOP_LATEST_JSON_URL,
    );
    const tag =
      manifest.tag || (manifest.version ? `v${manifest.version}` : null);
    return tag || null;
  } catch (err) {
    console.error(
      "[updater] Failed to resolve latest desktop tag from R2:",
      (err as Error)?.message,
    );
    return null;
  }
}

interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * Resolve the latest DESKTOP release tag from the GitHub releases API. Considers
 * any published (non-draft) release whose tag is `vX.Y.Z` (desktop) — including
 * prereleases, so a stray prerelease flag never strands installed apps — and
 * explicitly skips `mobile-vX.Y.Z` releases. Works for a public repo without any
 * auth token. Returns null on failure.
 */
async function resolveLatestDesktopTagFromGitHub(): Promise<string | null> {
  try {
    const releases = await httpGetJson<GitHubRelease[]>(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=30`,
    );
    // NOTE: we intentionally do NOT filter out `prerelease` releases here. A
    // release accidentally flagged as a prerelease would otherwise be skipped,
    // silently stranding installed apps on an older version. We only skip drafts
    // (genuinely unpublished) and non-desktop tags below.
    const desktopTags = (releases || [])
      .filter((r) => !r.draft && r.tag_name)
      .map((r) => r.tag_name as string)
      // Desktop tags look like "v1.6.95"; ignore "mobile-v..." and anything else.
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
    if (desktopTags.length === 0) return null;
    desktopTags.sort(compareSemver);
    return desktopTags[desktopTags.length - 1];
  } catch (err) {
    console.error(
      "[updater] Failed to resolve latest desktop tag from GitHub:",
      (err as Error)?.message,
    );
    return null;
  }
}

/**
 * Fallback resolver for environments where api.github.com is blocked/intercepted
 * but github.com HTML pages are still reachable.
 */
async function resolveLatestDesktopTagFromGitHubHtml(): Promise<string | null> {
  try {
    const html = await httpGetText(
      `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
    );
    // First desktop-tag occurrence on the releases page usually corresponds to
    // the newest published desktop release.
    const match = html.match(
      new RegExp(
        `/` +
          `${GITHUB_OWNER}` +
          `/` +
          `${GITHUB_REPO}` +
          `/releases/tag/(v\\d+\\.\\d+\\.\\d+)`,
      ),
    );
    return match?.[1] || null;
  } catch (err) {
    console.error(
      "[updater] Failed to resolve latest desktop tag from GitHub HTML:",
      (err as Error)?.message,
    );
    return null;
  }
}

/**
 * Work out which release feed electron-updater should read from. Prefers R2
 * (when OTA_BASE_URL is configured) and falls back to GitHub Releases.
 */
async function resolveDesktopFeed(): Promise<DesktopFeed | null> {
  const r2Tag = await resolveLatestDesktopTagFromR2();
  if (r2Tag) {
    return { tag: r2Tag, url: `${OTA_BASE_URL}/desktop/releases/${r2Tag}/` };
  }
  const ghTag = await resolveLatestDesktopTagFromGitHub();
  if (ghTag) {
    return {
      tag: ghTag,
      url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${ghTag}/`,
    };
  }
  const ghHtmlTag = await resolveLatestDesktopTagFromGitHubHtml();
  if (ghHtmlTag) {
    return {
      tag: ghHtmlTag,
      url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${ghHtmlTag}/`,
    };
  }
  return null;
}

/**
 * Point electron-updater at a SPECIFIC desktop release's asset folder so it
 * fetches that release's latest.yml + installers. The `path:` entries inside
 * latest.yml resolve relative to this feed URL. We use a `generic` feed for
 * both R2 and GitHub so we never let electron-updater's default GitHub provider
 * auto-pick the newest release in the repo (which may be a mobile release).
 */
async function pointFeedAtLatestDesktopRelease(): Promise<void> {
  const feed = await resolveDesktopFeed();
  if (!feed) {
    throw new Error("Unable to resolve desktop release feed");
  }
  autoUpdater.setFeedURL({
    provider: "generic",
    url: feed.url,
  });
  console.log(`[updater] Feed pinned to desktop release ${feed.tag}`);
}

type ReleaseNoteEntry = string | { version?: string; note?: string | null };

/**
 * Extract plain-text release notes from electron-updater's releaseNotes.
 * releaseNotes can be a string (HTML), an array of {version, note}, or null.
 * We strip HTML tags and clean up to produce readable text lines.
 */
function cleanReleaseNotes(
  raw: string | ReleaseNoteEntry[] | null | undefined,
): string {
  if (!raw) return "";
  // If array of {version, note}, join the notes
  let html = "";
  if (Array.isArray(raw)) {
    html = raw
      .map((n) => (typeof n === "string" ? n : n?.note || ""))
      .join("\n");
  } else if (typeof raw === "string") {
    html = raw;
  } else {
    return "";
  }
  // Remove everything from "Checksums" onward (noisy)
  html = html.replace(/(<h[23][^>]*>.*?Checksums.*$)/is, "");
  // Strip HTML tags but keep text content
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function setupUpdater(mainWindow: BrowserWindow): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  let pendingVersion: string | null = null;
  let pendingReleaseNotes: string | null = null;
  let reminderInterval: ReturnType<typeof setInterval> | null = null;
  let checkInProgress = false;
  let checkInterval: ReturnType<typeof setInterval> | null = null;
  let retryCount = 0;
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [10_000, 30_000, 60_000]; // 10s, 30s, 60s

  function sendToRenderer(channel: string, data?: unknown): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }

  function clearReminder(): void {
    if (reminderInterval) {
      clearInterval(reminderInterval);
      reminderInterval = null;
    }
  }

  async function performCheck(): Promise<void> {
    if (checkInProgress) return;
    checkInProgress = true;
    try {
      // Pin the feed to the latest DESKTOP release before checking so we
      // never accidentally try to read latest.yml from a mobile release.
      await pointFeedAtLatestDesktopRelease();
      await autoUpdater.checkForUpdates();
      retryCount = 0; // reset on success
    } catch (err) {
      console.error("[updater] Check failed:", (err as Error)?.message);
      // Retry with exponential backoff
      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAYS[retryCount] || 60_000;
        retryCount++;
        console.log(
          `[updater] Retrying in ${delay / 1000}s (attempt ${retryCount}/${MAX_RETRIES})`,
        );
        setTimeout(() => performCheck(), delay);
      }
    } finally {
      checkInProgress = false;
    }
  }

  // ─── Auto-updater events ───
  autoUpdater.on("update-available", (info: UpdateInfo) => {
    pendingVersion = info.version;
    const notes = cleanReleaseNotes(info.releaseNotes);
    if (notes) pendingReleaseNotes = notes;
    sendToRenderer("update-available", {
      version: info.version,
      releaseNotes: notes || pendingReleaseNotes || "",
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    pendingVersion = info.version;
    const notes = cleanReleaseNotes(info.releaseNotes);
    if (notes) pendingReleaseNotes = notes;
    sendToRenderer("update-downloaded", {
      version: info.version,
      releaseNotes: notes || pendingReleaseNotes || "",
    });

    // Periodic reminder every 30 minutes if user dismisses
    clearReminder();
    reminderInterval = setInterval(
      () => {
        sendToRenderer("update-reminder", {
          version: pendingVersion,
          releaseNotes: pendingReleaseNotes || "",
        });
      },
      30 * 60 * 1000,
    );
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    sendToRenderer("download-progress", {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on("update-not-available", () => {
    sendToRenderer("update-not-available");
  });

  autoUpdater.on("error", (err: Error) => {
    console.error("Auto-updater error:", err?.message);
    sendToRenderer("update-error", { message: err?.message });
  });

  // ─── Update IPC handlers ───
  ipcMain.on("install-update", () => {
    clearReminder();
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.on("download-update", () => {
    autoUpdater.downloadUpdate().catch(() => {});
  });

  ipcMain.handle("check-for-update", async () => {
    if (checkInProgress) {
      return { available: false, reason: "check-in-progress" };
    }
    checkInProgress = true;
    try {
      // Pin the feed to the latest DESKTOP release before checking so we
      // never accidentally try to read latest.yml from a mobile release.
      await pointFeedAtLatestDesktopRelease();
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.updateInfo)
        return { available: false, reason: "no-info" };
      const current = app.getVersion();
      const latest = result.updateInfo.version;
      console.log(`[updater] Current: ${current}, Latest: ${latest}`);
      if (latest === current)
        return { available: false, reason: "up-to-date", version: current };
      return { available: true, version: latest };
    } catch (err) {
      console.error("[updater] Check failed:", (err as Error)?.message);
      return {
        available: false,
        reason: "error",
        error: (err as Error)?.message,
      };
    } finally {
      checkInProgress = false;
    }
  });

  ipcMain.handle("get-app-version", () => app.getVersion());

  // Preserve the renderer API without making an unauthenticated GitHub request.
  // Release notes now come from electron-updater's latest*.yml metadata; an
  // empty value is valid when a release does not include notes.
  ipcMain.handle("fetch-release-notes", () => pendingReleaseNotes || "");

  // ─── Window management IPC handlers ───
  ipcMain.handle("is-maximized", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.isMaximized() : false;
  });

  ipcMain.on("window-minimize", (event: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
  });

  ipcMain.on("window-maximize", (event: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });

  ipcMain.on("window-close", (event: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });

  // ─── Incoming call: flash taskbar and show/focus window ───
  ipcMain.on("flash-frame", (event: IpcMainEvent, flash: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.flashFrame(!!flash);
  });

  ipcMain.on("show-and-focus", (event: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  // ─── Unread badge: taskbar / dock count ───
  // The renderer forwards the combined unread total (chat + notifications).
  // macOS/Linux render it as a dock badge via app.setBadgeCount; Windows has
  // no dock badge, so we draw a small numeric overlay icon on the taskbar
  // button instead (cleared with null when the count is 0).
  ipcMain.on("set-badge-count", (event: IpcMainEvent, rawCount: number) => {
    const count = Math.max(0, Math.floor(Number(rawCount) || 0));
    try {
      if (typeof app.setBadgeCount === "function") {
        app.setBadgeCount(count);
      }
    } catch {
      /* setBadgeCount unsupported on this platform — ignore */
    }

    if (process.platform === "win32") {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      if (count <= 0) {
        win.setOverlayIcon(null, "");
        return;
      }
      try {
        const label = count > 99 ? "99+" : String(count);
        const size = 32;
        const dataUrl = buildBadgeDataUrl(label, size);
        const image = nativeImage.createFromDataURL(dataUrl);
        win.setOverlayIcon(image, `${count} unread`);
      } catch {
        /* overlay drawing failed — non-fatal */
      }
    }
  });

  // ─── Scheduled update checks ───
  // Initial check after 5s (gives app time to fully load), then every 30 minutes
  setTimeout(() => performCheck(), 5000);
  checkInterval = setInterval(() => performCheck(), 30 * 60 * 1000);

  // Clean up intervals on app quit
  app.on("before-quit", () => {
    clearReminder();
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  });
}

export { setupUpdater };
