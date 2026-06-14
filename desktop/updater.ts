import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import { ipcMain, app, BrowserWindow, type IpcMainInvokeEvent, type IpcMainEvent } from "electron";

autoUpdater.logger = console;

const GITHUB_OWNER = "vvronline";
const GITHUB_REPO = "WorkPulse";

// Desktop release tags look like `v1.6.29`. Mobile releases live in the SAME
// repo but use `mobile-v1.0.x` tags and DO NOT ship a `latest.yml`. The default
// electron-updater GitHub provider picks the newest release of ANY kind, so a
// freshly-published `mobile-v*` release makes it try to fetch latest.yml from a
// mobile release → 404. This regex isolates desktop-only release tags.
const DESKTOP_TAG_RE = /^v\d+\.\d+\.\d+$/;

interface GitHubRelease {
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
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
 * Resolve the latest DESKTOP release tag (e.g. "v1.6.29") by querying the
 * GitHub releases API and ignoring drafts, prereleases, and mobile (`mobile-v*`)
 * releases. Returns null on any failure so callers can fall back gracefully.
 */
async function resolveLatestDesktopTag(): Promise<string | null> {
    try {
        const https = require("https");
        const releases = await new Promise<GitHubRelease[]>((resolve, reject) => {
            const req = https.get(
                `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=100`,
                {
                    headers: {
                        "User-Agent": "WorkPulse-Desktop",
                        Accept: "application/vnd.github.v3+json",
                    },
                },
                (res: import("http").IncomingMessage) => {
                    let body = "";
                    res.on("data", (c: Buffer) => (body += c));
                    res.on("end", () => {
                        if (res.statusCode === 200) {
                            try {
                                resolve(JSON.parse(body));
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new Error(`GitHub ${res.statusCode}`));
                        }
                    });
                }
            );
            req.on("error", reject);
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error("timeout"));
            });
        });

        const desktopTags = releases
            .filter((r) => !r.draft && !r.prerelease && r.tag_name && DESKTOP_TAG_RE.test(r.tag_name))
            .map((r) => r.tag_name as string)
            .sort((a, b) => compareSemver(b, a));

        return desktopTags[0] || null;
    } catch (err) {
        console.error("[updater] Failed to resolve latest desktop tag:", (err as Error)?.message);
        return null;
    }
}

/**
 * Point electron-updater at a SPECIFIC desktop release's asset folder so it
 * fetches that release's latest.yml (instead of auto-picking the newest release
 * of any kind, which may be a mobile release without a latest.yml).
 */
async function pointFeedAtLatestDesktopRelease(): Promise<void> {
    const tag = await resolveLatestDesktopTag();
    if (!tag) {
        // Could not resolve — leave electron-updater on its configured GitHub
        // provider. We'll still surface a clean error if the check fails.
        return;
    }
    autoUpdater.setFeedURL({
        provider: "generic",
        url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}`,
    });
    console.log(`[updater] Feed pinned to desktop release ${tag}`);
}

type ReleaseNoteEntry = string | { version?: string; note?: string | null };

/**
 * Extract plain-text release notes from electron-updater's releaseNotes.
 * releaseNotes can be a string (HTML), an array of {version, note}, or null.
 * We strip HTML tags and clean up to produce readable text lines.
 */
function cleanReleaseNotes(raw: string | ReleaseNoteEntry[] | null | undefined): string {
    if (!raw) return "";
    // If array of {version, note}, join the notes
    let html = "";
    if (Array.isArray(raw)) {
        html = raw.map((n) => (typeof n === "string" ? n : n?.note || "")).join("\n");
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
                console.log(`[updater] Retrying in ${delay / 1000}s (attempt ${retryCount}/${MAX_RETRIES})`);
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
        reminderInterval = setInterval(() => {
            sendToRenderer("update-reminder", {
                version: pendingVersion,
                releaseNotes: pendingReleaseNotes || "",
            });
        }, 30 * 60 * 1000);
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
            if (!result || !result.updateInfo) return { available: false, reason: "no-info" };
            const current = app.getVersion();
            const latest = result.updateInfo.version;
            console.log(`[updater] Current: ${current}, Latest: ${latest}`);
            if (latest === current) return { available: false, reason: "up-to-date", version: current };
            return { available: true, version: latest };
        } catch (err) {
            console.error("[updater] Check failed:", (err as Error)?.message);
            return { available: false, reason: "error", error: (err as Error)?.message };
        } finally {
            checkInProgress = false;
        }
    });

    ipcMain.handle("get-app-version", () => app.getVersion());

    // Fetch release notes from GitHub API (fallback when electron-updater omits them)
    ipcMain.handle("fetch-release-notes", async (_event: IpcMainInvokeEvent, version: string) => {
        try {
            const tag = version.startsWith("v") ? version : `v${version}`;
            const https = require("https");
            const data = await new Promise<{ body?: string }>((resolve, reject) => {
                const req = https.get(
                    `https://api.github.com/repos/vvronline/WorkPulse/releases/tags/${tag}`,
                    { headers: { "User-Agent": "WorkPulse-Desktop", Accept: "application/vnd.github.v3+json" } },
                    (res: import("http").IncomingMessage) => {
                        let body = "";
                        res.on("data", (c: Buffer) => (body += c));
                        res.on("end", () => {
                            if (res.statusCode === 200) resolve(JSON.parse(body));
                            else reject(new Error(`GitHub ${res.statusCode}`));
                        });
                    }
                );
                req.on("error", reject);
                req.setTimeout(10000, () => {
                    req.destroy();
                    reject(new Error("timeout"));
                });
            });
            const notes = cleanReleaseNotes(data.body || "");
            if (notes) pendingReleaseNotes = notes;
            return notes || data.body || "";
        } catch (err) {
            console.error("[updater] Failed to fetch release notes:", (err as Error)?.message);
            return "";
        }
    });

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