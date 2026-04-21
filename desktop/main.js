const { app, BrowserWindow, protocol, net, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { setupTray } = require('./tray');
const { setupUpdater } = require('./updater');

// ─── Configuration ───
const RAILWAY_URL = process.env.API_SERVER || 'https://workpulse-prod.up.railway.app';
// In packaged build, client/dist is in extraResources; in dev, it's adjacent
const CLIENT_DIST = app.isPackaged
    ? path.join(process.resourcesPath, 'client', 'dist')
    : path.join(__dirname, '..', 'client', 'dist');
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

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

app.whenReady().then(() => {
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
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            return new Response(fs.readFileSync(filePath), {
                headers: { 'Content-Type': getMimeType(filePath) }
            });
        }

        // SPA fallback — serve index.html for all non-file routes
        const indexPath = path.join(CLIENT_DIST, 'index.html');
        if (fs.existsSync(indexPath)) {
            return new Response(fs.readFileSync(indexPath), {
                headers: { 'Content-Type': 'text/html' }
            });
        }

        return new Response('Not found', { status: 404 });
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
        icon: path.join(__dirname, 'icons', 'transparent.png'),
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

    // F12 toggles DevTools (local shortcut, only active when window is focused)
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

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

    // System tray
    tray = setupTray(mainWindow);

    // Auto-updater
    setupUpdater(mainWindow);
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
