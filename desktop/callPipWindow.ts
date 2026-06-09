import { BrowserWindow, ipcMain, app, screen, nativeImage, type IpcMainEvent } from "electron";
import path from "path";
import fs from "fs";

/**
 * Always-on-top mini call window (Teams-style "floatie").
 *
 * The renderer in the MAIN window keeps full control of the WebRTC peer
 * connection, microphone capture, and remote audio/video. This module just
 * hosts a tiny secondary BrowserWindow that:
 *   1. Shows the caller's avatar + name + duration + mute state
 *   2. Exposes mute / restore / end buttons
 *   3. Stays visible above other apps (alwaysOnTop = 'screen-saver')
 *
 * IPC contract (between main window renderer and this module):
 *   ── from main window ──
 *     'call:pip-open'         (state)   → create / show the pip window
 *     'call:pip-close'        ()        → close the pip window
 *     'call:pip-update-state' (partial) → push partial state to pip window
 *
 *   ── from pip window ──
 *     'call:pip-action'       ({ action })   → relayed to main window as
 *                                              'call:pip-action' so the
 *                                              CallOverlay can react.
 *     'call:pip-ready'        ()             → pip window has mounted &
 *                                              wants the latest state.
 *
 *   ── from main module to main window ──
 *     'call:pip-window-closed'              → the user closed the floatie;
 *                                              the overlay should restore.
 *     'call:pip-action'       ({ action })  → forwarded user action.
 *     'call:pip-state-request'              → pip window needs current state.
 */

type PipState = Record<string, unknown>;
type PipBounds = { width: number; height: number; x: number; y: number };

const STATE_FILE = (): string => path.join(app.getPath("userData"), "call-pip-window-state.json");

function loadPipState(): Partial<PipBounds> | null {
    try {
        if (fs.existsSync(STATE_FILE())) {
            return JSON.parse(fs.readFileSync(STATE_FILE(), "utf-8"));
        }
    } catch {
        /* ignore */
    }
    return null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function savePipState(bounds: PipBounds): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(STATE_FILE(), JSON.stringify(bounds));
        } catch {
            /* ignore */
        }
    }, 500);
}

interface CallPipController {
    closeCallPipWindow: () => void;
    isCallPipOpen: () => boolean;
}

function setupCallPipWindow(mainWindow: BrowserWindow): CallPipController {
    if (!mainWindow) throw new Error("setupCallPipWindow requires mainWindow");

    let pipWindow: BrowserWindow | null = null;
    // Cache the latest call state so we can replay it when the pip window
    // signals 'call:pip-ready' (the renderer mounts after the BrowserWindow
    // has finished navigating; pushing state before that is lost).
    let lastState: PipState | null = null;

    const closePip = (silent = false): void => {
        if (!pipWindow || pipWindow.isDestroyed()) {
            pipWindow = null;
            return;
        }
        try {
            // Mark as silent so the 'closed' handler doesn't notify the main
            // window — we're closing it programmatically (e.g. end of call).
            pipWindow.__silentClose = silent;
            pipWindow.close();
        } catch {
            /* ignore */
        }
        pipWindow = null;
    };

    const openPip = (state?: PipState): void => {
        lastState = { ...(lastState || {}), ...(state || {}) };

        if (pipWindow && !pipWindow.isDestroyed()) {
            // Already open — just push the latest state through.
            try {
                pipWindow.webContents.send("call:pip-state", lastState);
            } catch {
                /* ignore */
            }
            try {
                pipWindow.show();
                pipWindow.focus();
            } catch {
                /* ignore */
            }
            return;
        }

        const saved = loadPipState();
        // Compute a sensible default: bottom-right of the primary display
        const primary = screen.getPrimaryDisplay().workArea;
        const defaultBounds: PipBounds = {
            width: 320,
            height: 220,
            x: primary.x + primary.width - 320 - 24,
            y: primary.y + primary.height - 220 - 24,
        };
        const bounds =
            saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
                ? { ...defaultBounds, ...saved }
                : defaultBounds;

        pipWindow = new BrowserWindow({
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            minWidth: 260,
            minHeight: 180,
            maxWidth: 460,
            maxHeight: 320,
            frame: false,
            resizable: true,
            movable: true,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            show: false,
            backgroundColor: "#111827",
            title: "WorkPulse Call",
            icon: (() => {
                try {
                    return nativeImage.createFromPath(path.join(__dirname, "icons", "icon.png"));
                } catch {
                    return undefined;
                }
            })(),
            webPreferences: {
                preload: path.join(__dirname, "preload.js"),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });

        // Float above EVERY normal window (incl. maximised + fullscreen on macOS)
        try {
            pipWindow.setAlwaysOnTop(true, "screen-saver");
            if (process.platform === "darwin") {
                pipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            }
        } catch {
            /* ignore — older Electron */
        }

        pipWindow.loadURL("workpulse://app/pip-call");

        pipWindow.once("ready-to-show", () => {
            if (!pipWindow || pipWindow.isDestroyed()) return;
            pipWindow.show();
        });

        // Persist position / size
        const persist = (): void => {
            if (!pipWindow || pipWindow.isDestroyed()) return;
            savePipState(pipWindow.getBounds());
        };
        pipWindow.on("move", persist);
        pipWindow.on("resize", persist);

        pipWindow.on("closed", () => {
            const wasSilent = pipWindow?.__silentClose;
            pipWindow = null;
            lastState = null;
            // Only notify the main window if the USER closed it (so the
            // overlay restores itself). End-of-call / restore-in-progress
            // closes set __silentClose to avoid the bounce.
            if (!wasSilent && mainWindow && !mainWindow.isDestroyed()) {
                try {
                    mainWindow.webContents.send("call:pip-window-closed");
                } catch {
                    /* ignore */
                }
            }
        });
    };

    // ── IPC: from main window ──
    ipcMain.on("call:pip-open", (event: IpcMainEvent, state?: PipState) => {
        // Only the main window may open a pip window
        if (event.sender !== mainWindow.webContents) return;
        openPip(state);
    });

    ipcMain.on("call:pip-close", (event: IpcMainEvent) => {
        if (event.sender !== mainWindow.webContents) return;
        closePip(true);
    });

    ipcMain.on("call:pip-update-state", (event: IpcMainEvent, partial?: PipState) => {
        if (event.sender !== mainWindow.webContents) return;
        lastState = { ...(lastState || {}), ...(partial || {}) };
        if (pipWindow && !pipWindow.isDestroyed()) {
            try {
                pipWindow.webContents.send("call:pip-state", lastState);
            } catch {
                /* ignore */
            }
        }
    });

    // ── IPC: from pip window ──
    ipcMain.on("call:pip-ready", (event: IpcMainEvent) => {
        if (!pipWindow || event.sender !== pipWindow.webContents) return;
        if (lastState) {
            try {
                pipWindow.webContents.send("call:pip-state", lastState);
            } catch {
                /* ignore */
            }
        }
    });

    ipcMain.on("call:pip-action", (event: IpcMainEvent, payload?: { action?: string }) => {
        if (!pipWindow || event.sender !== pipWindow.webContents) return;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        // Restore actions should also bring the main window forward.
        if (payload?.action === "restore") {
            try {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            } catch {
                /* ignore */
            }
        }
        try {
            mainWindow.webContents.send("call:pip-action", payload || {});
        } catch {
            /* ignore */
        }
    });

    // Close the pip if the main window is destroyed
    mainWindow.on("closed", () => closePip(true));

    // Expose a small helper for the main process if needed
    return {
        closeCallPipWindow: () => closePip(true),
        isCallPipOpen: () => !!(pipWindow && !pipWindow.isDestroyed()),
    };
}

export { setupCallPipWindow };