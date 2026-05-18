const { app, BrowserWindow, protocol, net, session, Menu, nativeImage, desktopCapturer, systemPreferences, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { setupTray } = require('./tray');
const { setupUpdater } = require('./updater');
const { setupCallPipWindow } = require('./callPipWindow');

// Set app identity for Windows notifications and taskbar
app.setAppUserModelId('com.workpulse.desktop');
app.name = 'WorkPulse';

// Safety net: log uncaught errors instead of letting Electron show the
// fatal "A JavaScript error occurred in the main process" dialog and exit.
process.on('uncaughtException', (err) => {
    console.error('[WorkPulse] Uncaught exception in main process:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[WorkPulse] Unhandled promise rejection in main process:', reason);
});

// ─── Configuration ───
const RAILWAY_URL = process.env.API_SERVER || 'https://workpulse-prod.up.railway.app';
// In packaged build, client/dist is in extraResources; in dev, it's adjacent
const CLIENT_DIST = app.isPackaged
    ? path.join(process.resourcesPath, 'client', 'dist')
    : path.join(__dirname, '..', 'client', 'dist');
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const VERSION_FILE = path.join(app.getPath('userData'), 'last-version.txt');

// ─── Cache clearing on version change ───
function clearCacheIfVersionChanged() {
    const currentVersion = app.getVersion();
    let lastVersion = null;
    try {
        lastVersion = fs.readFileSync(VERSION_FILE, 'utf-8').trim();
    } catch { /* first run or missing file */ }
    if (lastVersion !== currentVersion) {
        console.log(`[WorkPulse] Version changed: ${lastVersion || 'none'} → ${currentVersion}, will clear cache`);
        // Write new version immediately so we don't repeat on crash
        try { fs.writeFileSync(VERSION_FILE, currentVersion); } catch { /* ignore */ }
        return true; // Signal that cache should be cleared after session is ready
    }
    return false;
}

const shouldClearCache = clearCacheIfVersionChanged();

// ─── Custom protocol registration (must happen before app.ready) ───
protocol.registerSchemesAsPrivileged([{
    scheme: 'workpulse',
    privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        allowServiceWorkers: false,
    }
}]);

// ─── Window state persistence ───
function loadWindowState() {
    try {
        if (fs.existsSync(WINDOW_STATE_FILE)) {
            return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf-8'));
        }
    } catch { /* ignore corrupt state */ }
    return { width: 1280, height: 800 };
}

let saveTimeout = null;
function saveWindowState(win) {
    if (!win || win.isDestroyed()) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        const bounds = win.getBounds();
        const isMaximized = win.isMaximized();
        fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ ...bounds, isMaximized }));
    }, 500);
}

// ─── MIME type lookup ───
const MIME_TYPES = {
    '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject', '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav', '.webm': 'video/webm', '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
};

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

// ─── Main ───
let mainWindow = null;
let tray = null;

app.whenReady().then(async () => {
    // Clear stale caches from previous version
    if (shouldClearCache) {
        try {
            await session.defaultSession.clearCache();
            await session.defaultSession.clearStorageData({
                storages: ['cachestorage', 'serviceworkers'],
            });
            console.log('[WorkPulse] Cleared cache after version update');
        } catch (err) {
            console.error('[WorkPulse] Cache clear failed:', err?.message);
        }
    }

    // ─── Screen sharing: show picker so user can choose which screen/window ───
    let pendingSourceSelection = null;

    // Safely invoke the displayMedia callback. Recent Electron versions throw
    // "Video was requested, but no video stream was provided" if you call
    // callback({}) to cancel — wrap in try/catch so a user cancel doesn't
    // crash the main process.
    const safeInvokeCallback = (callback, streams) => {
        try {
            callback(streams);
        } catch (err) {
            console.warn('[WorkPulse] displayMedia callback error (likely user cancel):', err?.message);
        }
    };

    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        try {
            const sources = await desktopCapturer.getSources({
                types: ['screen', 'window'],
                thumbnailSize: { width: 320, height: 180 },
                fetchWindowIcons: true,
            });
            // Send source list to renderer for user selection
            const serialized = sources.map(s => ({
                id: s.id,
                name: s.name,
                thumbnail: s.thumbnail.toDataURL(),
                appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
            }));
            mainWindow.webContents.send('screen-sources', serialized);

            // Wait for user to pick a source or cancel
            pendingSourceSelection = { sources, callback };
        } catch {
            safeInvokeCallback(callback, {});
        }
    });

    ipcMain.on('screen-source-selected', (_e, sourceId) => {
        if (!pendingSourceSelection) return;
        const { sources, callback } = pendingSourceSelection;
        pendingSourceSelection = null;
        if (!sourceId) {
            safeInvokeCallback(callback, {}); // user cancelled
            return;
        }
        const selected = sources.find(s => s.id === sourceId);
        if (selected) {
            safeInvokeCallback(callback, { video: selected, audio: 'loopback' });
        } else {
            safeInvokeCallback(callback, {});
        }
    });

    // Content Security Policy — restrict what can run in the renderer.
    // NOTE: `frame-src` must allow https://embed.diagrams.net so the
    // draw.io diagram editor (loaded as an <iframe> inside the notes
    // editor) can render. Without it the iframe is silently blocked
    // and the spinner appears to "load forever".
    //
    // We only apply CSP to top-level documents served by our own
    // workpulse:// protocol. Sub-resources fetched by the embed
    // iframe (which is on https://embed.diagrams.net) bring their
    // own CSP from diagrams.net and should NOT have ours injected
    // — doing so would break their script loading and make the
    // editor either fail or load very slowly while it retries.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const isAppDocument =
            details.resourceType === 'mainFrame' &&
            typeof details.url === 'string' &&
            details.url.startsWith('workpulse://');

        if (!isAppDocument) {
            callback({ responseHeaders: details.responseHeaders });
            return;
        }

        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    "default-src 'self' workpulse://app; " +
                    // 'wasm-unsafe-eval' lets MediaPipe Selfie Segmentation
                    // compile its WebAssembly module (used by background
                    // blur/virtual backgrounds). MediaPipe is bundled as a
                    // same-origin asset under /mediapipe/ so no CDN is
                    // needed in script-src/connect-src.
                    "script-src 'self' workpulse://app 'unsafe-inline' 'wasm-unsafe-eval'; " +
                    "style-src 'self' workpulse://app 'unsafe-inline'; " +
                    `connect-src 'self' workpulse://app ${RAILWAY_URL} wss://${new URL(RAILWAY_URL).host} https://embed.diagrams.net; ` +
                    "img-src 'self' workpulse://app data: blob: https://embed.diagrams.net; " +
                    "media-src 'self' workpulse://app blob:; " +
                    "font-src 'self' workpulse://app; " +
                    // MediaPipe spawns helper workers from blob: URLs.
                    "worker-src 'self' workpulse://app blob:; " +
                    "frame-src https://embed.diagrams.net; " +
                    "object-src 'none';"
                ],
            },
        });
    });

    // Handle the custom protocol — serve bundled React files + proxy /uploads to Railway
    protocol.handle('workpulse', async (request) => {
        const url = new URL(request.url);
        const pathname = decodeURIComponent(url.pathname);

        // Proxy /uploads/* requests to server (cookies managed by Electron session)
        if (pathname.startsWith('/uploads/') || pathname.startsWith('/uploads\\')) {
            try {
                const headers = {};
                for (const [key, value] of request.headers.entries()) {
                    if (key.toLowerCase() === 'host') continue;
                    headers[key] = value;
                }
                headers['origin'] = 'workpulse://app';
                headers['x-requested-with'] = 'WorkPulse';
                return await net.fetch(`${RAILWAY_URL}${pathname}`, {
                    method: request.method,
                    headers,
                    credentials: 'include',
                    bypassCustomProtocolHandlers: true,
                });
            } catch {
                return new Response('File not found', { status: 404 });
            }
        }

        // Proxy /api/* requests to server (cookies managed by Electron session)
        if (pathname.startsWith('/api/') || pathname.startsWith('/api\\')) {
            const targetUrl = `${RAILWAY_URL}${pathname}${url.search || ''}`;
            try {
                const headers = {};
                // Copy all incoming headers into a plain object
                for (const [key, value] of request.headers.entries()) {
                    if (key.toLowerCase() === 'host') continue; // skip host
                    headers[key] = value;
                }
                headers['origin'] = 'workpulse://app';
                headers['x-requested-with'] = 'WorkPulse';

                const fetchOpts = {
                    method: request.method,
                    headers,
                    credentials: 'include',
                    cache: 'no-store',
                    bypassCustomProtocolHandlers: true,
                };

                // Buffer the body for methods that have one
                if (!['GET', 'HEAD'].includes(request.method)) {
                    try {
                        const buf = await request.arrayBuffer();
                        if (buf.byteLength > 0) {
                            fetchOpts.body = Buffer.from(buf);
                        }
                    } catch { /* no body */ }
                }

                const resp = await net.fetch(targetUrl, fetchOpts);
                console.log(`[proxy] ${request.method} ${targetUrl} -> ${resp.status}`);
                return resp;
            } catch (err) {
                console.error('[proxy] FETCH ERROR:', err);
                return new Response(JSON.stringify({ error: 'Desktop proxy error' }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        // Serve static files from client/dist
        let filePath = path.join(CLIENT_DIST, pathname === '/' ? 'index.html' : pathname);
        filePath = path.normalize(filePath);

        // Security: prevent path traversal
        if (!filePath.startsWith(CLIENT_DIST)) {
            return new Response('Forbidden', { status: 403 });
        }

        // Serve file if it exists, otherwise SPA fallback to index.html
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.isFile()) {
                const data = await fs.promises.readFile(filePath);
                return new Response(data, {
                    headers: { 'Content-Type': getMimeType(filePath) }
                });
            }
        } catch { /* file doesn't exist — fall through to SPA fallback */ }

        // SPA fallback — serve index.html for all non-file routes
        const indexPath = path.join(CLIENT_DIST, 'index.html');
        try {
            const data = await fs.promises.readFile(indexPath);
            return new Response(data, {
                headers: { 'Content-Type': 'text/html' }
            });
        } catch {
            return new Response('Not found', { status: 404 });
        }
    });

    // Remove default menu bar
    Menu.setApplicationMenu(null);

    // Create main window
    const state = loadWindowState();
    mainWindow = new BrowserWindow({
        width: state.width,
        height: state.height,
        x: state.x,
        y: state.y,
        minWidth: 800,
        minHeight: 600,
        title: '',
        icon: nativeImage.createFromPath(path.join(__dirname, 'icons', 'icon.png')),
        frame: process.platform === 'darwin',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
        show: false,
    });

    if (state.isMaximized) mainWindow.maximize();

    mainWindow.loadURL('workpulse://app/');

    // F12 toggles DevTools (only in development builds)
    if (!app.isPackaged) {
        mainWindow.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'F12' && input.type === 'keyDown') {
                mainWindow.webContents.toggleDevTools();
                event.preventDefault();
            }
        });
    }

    console.log(`[WorkPulse] API server: ${RAILWAY_URL}`);

    // Override the HTML <title> tag so the title bar stays blank
    mainWindow.on('page-title-updated', (e) => e.preventDefault());

    mainWindow.once('ready-to-show', () => mainWindow.show());

    // Persist window state on move/resize
    mainWindow.on('resize', () => saveWindowState(mainWindow));
    mainWindow.on('move', () => saveWindowState(mainWindow));

    // Notify renderer of maximize state changes (for window control icons)
    mainWindow.on('maximize', () => mainWindow.webContents.send('maximize-change', true));
    mainWindow.on('unmaximize', () => mainWindow.webContents.send('maximize-change', false));

    // Minimize to tray on close instead of quitting
    mainWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    // Open external links in the default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            require('electron').shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    // Prevent renderer from navigating to arbitrary origins (XSS protection)
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('workpulse://app/')) {
            event.preventDefault();
        }
    });

    // System tray
    tray = setupTray(mainWindow);

    // Auto-updater
    setupUpdater(mainWindow);

    // Always-on-top mini call window (Teams-style "floatie") — opens via
    // IPC from the renderer when the user clicks the in-call PiP button.
    setupCallPipWindow(mainWindow);
});

// macOS: re-create window when dock icon is clicked
app.on('activate', () => {
    if (mainWindow) {
        mainWindow.show();
    }
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// Quit flag for tray close vs window close
app.on('before-quit', () => {
    app.isQuitting = true;
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
