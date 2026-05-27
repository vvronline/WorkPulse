const { app, BrowserWindow, protocol, net, session, Menu, nativeImage, desktopCapturer, systemPreferences, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const { setupTray } = require('./tray');
const { setupUpdater } = require('./updater');
const { setupCallPipWindow } = require('./callPipWindow');

// Set app identity for Windows notifications and taskbar
app.setAppUserModelId('com.workpulse.desktop');
app.name = 'WorkPulse';

// ─── Chromium geolocation API key ─────────────────────────────────────────
// Chromium's network-based geolocation (used by navigator.geolocation when
// the renderer can't reach the OS location service) calls Google's
// Geolocation API and **requires** an API key. Without one, every call
// fails with POSITION_UNAVAILABLE, which surfaces in the UI as
// "Location is required to clock in from office. Please allow location
// access." even after the user clicks "Allow".
//
// We expose two ways to supply the key:
//   1. Set GOOGLE_API_KEY in the environment (or in your shell before
//      launching the packaged app).
//   2. Drop a `google-api-key.txt` file next to main.js (dev) or in
//      resources/ (packaged) containing only the raw key string.
//
// If neither is provided, Chromium will fall back to whatever the OS
// location service returns (Windows 10/11 ships one when the user has
// "Location" turned on in Windows Settings → Privacy → Location), but
// in most office environments that still works because Wi-Fi based
// positioning is available.
// Track the api key we actually loaded so the post-ready startup probe can
// independently verify with Google that the key is accepted. We deliberately
// don't print the full key anywhere, only its length and first 4 chars, so
// the desktop log can be shared without leaking the secret.
let LOADED_GOOGLE_API_KEY = '';

(() => {
    let apiKey = process.env.GOOGLE_API_KEY || '';
    console.log('[WorkPulse] GOOGLE_API_KEY from env:', apiKey ? `set (${apiKey.length} chars)` : 'not set');
    if (!apiKey) {
        const candidates = [
            path.join(__dirname, 'google-api-key.txt'),
            app.isPackaged ? path.join(process.resourcesPath, 'google-api-key.txt') : null,
        ].filter(Boolean);
        console.log('[WorkPulse] Checking API key file candidates:', candidates);
        for (const f of candidates) {
            try {
                if (fs.existsSync(f)) {
                    const raw = fs.readFileSync(f, 'utf-8');
                    // .trim() strips trailing \n / \r\n that `echo > file` adds.
                    // We log both the raw and trimmed lengths so a future CI
                    // regression that re-introduces a stray newline is visible.
                    apiKey = raw.trim();
                    console.log(
                        `[WorkPulse] Found API key in ${f} ` +
                        `(raw=${raw.length} bytes, trimmed=${apiKey.length} chars, ` +
                        `prefix='${apiKey.slice(0, 4)}…')`
                    );
                    if (apiKey) break;
                } else {
                    console.log(`[WorkPulse] File not found: ${f}`);
                }
            } catch (err) {
                console.warn(`[WorkPulse] Error reading ${f}:`, err?.message);
            }
        }
    }
    if (apiKey) {
        app.commandLine.appendSwitch('google-api-key', apiKey);
        process.env.GOOGLE_API_KEY = apiKey;
        LOADED_GOOGLE_API_KEY = apiKey;
        // Confirm Chromium actually accepted the switch — `appendSwitch` is
        // silent on validation errors, but `getSwitchValue` round-trips so
        // we can verify the value is in the command line as expected.
        const registered = app.commandLine.getSwitchValue('google-api-key');
        console.log(
            `[WorkPulse] Geolocation API key configured ` +
            `(switch length=${registered.length}, matches=${registered === apiKey})`
        );
    } else {
        console.log('[WorkPulse] No GOOGLE_API_KEY found — relying on OS location service for geolocation');
    }
})();

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

    // Grant media + geolocation permissions.
    //   - media / display-capture / mediaKeySystem → camera, mic, screen share
    //   - geolocation → required by the "clock-in from office" geofence flow
    //                    (client/src/utils/geolocation.js → navigator.geolocation)
    // Without geolocation in this list the renderer's getCurrentPosition()
    // fires its error callback with PERMISSION_DENIED, the desktop client
    // skips sending latitude/longitude, and the server responds 403
    // "Location is required to clock in from office. Please allow location
    // access." — which looks like the user can't "enable" location even
    // though the Windows OS-level location toggle is on.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = ['media', 'display-capture', 'mediaKeySystem', 'geolocation'];
        const granted = allowed.includes(permission);
        console.log(`[WorkPulse] Permission request: ${permission} → ${granted ? 'GRANTED' : 'DENIED'}`);
        callback(granted);
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
        const allowed = ['media', 'display-capture', 'mediaKeySystem', 'geolocation'];
        const granted = allowed.includes(permission);
        console.log(`[WorkPulse] Permission check: ${permission} → ${granted ? 'GRANTED' : 'DENIED'}`);
        return granted;
    });

    // macOS: request camera/mic access at OS level
    if (process.platform === 'darwin') {
        systemPreferences.askForMediaAccess('camera').catch(() => { });
        systemPreferences.askForMediaAccess('microphone').catch(() => { });
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

    // ─── IP-based geolocation fallback ─────────────────────────────────
    // Chromium's navigator.geolocation in Electron always routes through
    // Google's Geolocation API and requires a GOOGLE_API_KEY to actually
    // resolve a fix. When no key is configured (the default for our
    // packaged desktop app), every getCurrentPosition() call fails with
    // POSITION_UNAVAILABLE → the user sees
    //    "Couldn't determine your location. Check your GPS / Wi-Fi …"
    // and is blocked from clocking in.
    //
    // To unblock those users we expose a renderer-callable IPC
    // (`get-ip-location`) that asks a free IP-geolocation service
    // (ip-api.com) for an approximate {latitude, longitude, accuracy}.
    // The renderer's geolocation util uses this as a last-resort
    // fallback only when navigator.geolocation has already failed.
    //
    // Caveats (documented in the renderer): IP-based geolocation is
    // typically city-level accurate (a few km), can be wildly off when
    // the user is on a corporate VPN, and counts as "best effort". The
    // accuracy value returned reflects this so the server-side geofence
    // radius is the real source of truth.
    // ─── Wi-Fi BSSID reader (Stage 7: Wi-Fi-first attendance) ──────────
    // Returns `{ ok, bssid, ssid, signal }` describing the access point the
    // OS is currently associated with. The attendance clock-in flow sends
    // the BSSID alongside the geolocation; the server prefers BSSID match
    // (against the org's allow-list) over geofence, which works around the
    // inaccurate IP-based geolocation we get on packaged Electron builds.
    //
    // Privacy: we never persist any of this in the desktop app — the
    // renderer reads it on demand at clock-in time only. BSSID lookup
    // requires Windows Location Services to be ON; without it `netsh`
    // returns `(blank)` for the BSSID and we surface `{ ok: false }`.
    ipcMain.handle('get-wifi-info', async () => {
        console.log('[WorkPulse] get-wifi-info: reading Wi-Fi interface...');
        try {
            if (process.platform === 'win32') {
                const { stdout } = await execFileP('netsh', ['wlan', 'show', 'interfaces']);
                console.log('[WorkPulse] get-wifi-info: netsh output length =', stdout.length);
                const bssidM = /^\s*BSSID\s*:\s*([0-9A-Fa-f:]{17})\s*$/m.exec(stdout);
                const ssidM = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(stdout);
                const sigM = /^\s*Signal\s*:\s*(\d+)\s*%/m.exec(stdout);
                const stateM = /^\s*State\s*:\s*(.+?)\s*$/m.exec(stdout);
                console.log('[WorkPulse] get-wifi-info: parsed →', {
                    bssid: bssidM?.[1] || null,
                    ssid: ssidM?.[1] || null,
                    signal: sigM?.[1] || null,
                    state: stateM?.[1] || null,
                });
                if (!bssidM) {
                    const error = stateM && /disconnected/i.test(stateM[1])
                        ? 'wifi_disconnected'
                        : 'bssid_unavailable';
                    console.warn('[WorkPulse] get-wifi-info: no BSSID →', error);
                    return { ok: false, error };
                }
                const result = {
                    ok: true,
                    bssid: bssidM[1].toUpperCase(),
                    ssid: ssidM ? ssidM[1] : null,
                    signal: sigM ? Number(sigM[1]) : null,
                };
                console.log('[WorkPulse] get-wifi-info: success →', result);
                return result;
            }
            if (process.platform === 'darwin') {
                const airport = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';
                const { stdout } = await execFileP(airport, ['-I']);
                const bssidM = /\bBSSID:\s*([0-9a-fA-F:]{11,17})/.exec(stdout);
                const ssidM = /\bSSID:\s*(.+)/.exec(stdout);
                const rssiM = /\bagrCtlRSSI:\s*(-?\d+)/.exec(stdout);
                if (!bssidM) return { ok: false, error: 'bssid_unavailable' };
                // Pad single-digit hex octets — macOS reports `1:2:3:4:5:6`.
                const padded = bssidM[1].split(':').map(s => s.padStart(2, '0')).join(':').toUpperCase();
                return {
                    ok: true,
                    bssid: padded,
                    ssid: ssidM ? ssidM[1].trim() : null,
                    signal: rssiM ? Number(rssiM[1]) : null,
                };
            }
            if (process.platform === 'linux') {
                try {
                    const { stdout: bssidOut } = await execFileP('iwgetid', ['-ra']);
                    const bssid = bssidOut.trim().toUpperCase();
                    if (!bssid) return { ok: false, error: 'bssid_unavailable' };
                    let ssid = null;
                    try {
                        const { stdout: ssidOut } = await execFileP('iwgetid', ['-r']);
                        ssid = ssidOut.trim() || null;
                    } catch { /* ignore */ }
                    return { ok: true, bssid, ssid, signal: null };
                } catch (err) {
                    return { ok: false, error: 'iwgetid_missing' };
                }
            }
            return { ok: false, error: 'unsupported_platform' };
        } catch (err) {
            console.warn('[WorkPulse] get-wifi-info failed:', err?.message);
            return { ok: false, error: err?.message || 'wifi_lookup_failed' };
        }
    });

    // ─── Native Windows geolocation via .NET Location API ──────────────
    // Bypasses Chromium entirely and uses the OS location service (GPS /
    // Wi-Fi triangulation). Much more accurate than IP-based geolocation.
    ipcMain.handle('get-native-location', async () => {
        if (process.platform !== 'win32') {
            return { ok: false, error: 'unsupported_platform' };
        }
        console.log('[WorkPulse] get-native-location: querying Windows Location API...');
        try {
            const script = `
Add-Type -AssemblyName System.Device
$w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
$w.Start()
$timeout = [DateTime]::Now.AddSeconds(15)
while ($w.Status -ne 'Ready' -and [DateTime]::Now -lt $timeout) { Start-Sleep -Milliseconds 250 }
if ($w.Status -eq 'Ready') {
    $p = $w.Position.Location
    if ($p.Latitude -ne [Double]::NaN) {
        Write-Output "$($p.Latitude)|$($p.Longitude)|$($p.HorizontalAccuracy)"
    } else { Write-Output "ERROR|NoFix" }
} else { Write-Output "ERROR|$($w.Status)" }
$w.Stop()
`.trim();
            const { stdout } = await execFileP('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command', script,
            ], { timeout: 20000 });
            const line = stdout.trim();
            console.log('[WorkPulse] get-native-location: raw output:', line);
            if (line.startsWith('ERROR|')) {
                const reason = line.split('|')[1] || 'unknown';
                console.warn('[WorkPulse] get-native-location: failed →', reason);
                return { ok: false, error: reason };
            }
            const parts = line.split('|');
            const latitude = parseFloat(parts[0]);
            const longitude = parseFloat(parts[1]);
            const accuracy = parseFloat(parts[2]);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                console.warn('[WorkPulse] get-native-location: parse failed →', line);
                return { ok: false, error: 'parse_failed' };
            }
            const result = {
                ok: true,
                latitude,
                longitude,
                accuracy: Number.isFinite(accuracy) ? accuracy : 100,
            };
            console.log('[WorkPulse] get-native-location: success →', result);
            return result;
        } catch (err) {
            console.warn('[WorkPulse] get-native-location failed:', err?.message);
            return { ok: false, error: err?.message || 'native_location_failed' };
        }
    });

    // ─── Open OS-level Location settings ─────────────────────────────────
    // The renderer surfaces this as a "Open Windows Location Settings" button
    // when a clock-in fails because the geolocation fix is too coarse — the
    // root cause is almost always that the user has Windows Location Services
    // turned off, which is a fix the user has to make themselves in Settings.
    ipcMain.handle('open-location-settings', async () => {
        try {
            const { shell } = require('electron');
            if (process.platform === 'win32') {
                await shell.openExternal('ms-settings:privacy-location');
                return { ok: true };
            }
            if (process.platform === 'darwin') {
                await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices');
                return { ok: true };
            }
            // Linux desktops don't have a unified privacy-location URI;
            // just open a help URL so the user can find the right toggle.
            await shell.openExternal('https://www.google.com/search?q=enable+location+services+linux');
            return { ok: true };
        } catch (err) {
            console.warn('[WorkPulse] open-location-settings failed:', err?.message);
            return { ok: false, error: err?.message || 'open_failed' };
        }
    });

    ipcMain.handle('get-ip-location', async () => {
        console.log('[WorkPulse] get-ip-location: attempting IP geolocation...');
        // Try a couple of providers for resilience; both are free / no key.
        const providers = [
            {
                url: 'http://ip-api.com/json/?fields=status,lat,lon,city,regionName,country,query',
                parse: (j) => (j && j.status === 'success')
                    ? { latitude: j.lat, longitude: j.lon, accuracy: 5000 }
                    : null,
            },
            {
                url: 'https://ipapi.co/json/',
                parse: (j) => (j && typeof j.latitude === 'number' && typeof j.longitude === 'number')
                    ? { latitude: j.latitude, longitude: j.longitude, accuracy: 5000 }
                    : null,
            },
        ];
        for (const p of providers) {
            try {
                console.log(`[WorkPulse] get-ip-location: trying ${p.url}...`);
                const resp = await net.fetch(p.url, { method: 'GET' });
                console.log(`[WorkPulse] get-ip-location: ${p.url} responded ${resp.status}`);
                if (!resp.ok) continue;
                const json = await resp.json();
                console.log(`[WorkPulse] get-ip-location: ${p.url} body:`, JSON.stringify(json));
                const coords = p.parse(json);
                if (coords) {
                    console.log(`[WorkPulse] IP geolocation via ${p.url} → ${coords.latitude},${coords.longitude}`);
                    return { ok: true, ...coords };
                }
                console.warn(`[WorkPulse] get-ip-location: ${p.url} returned data but parse failed`);
            } catch (err) {
                console.warn(`[WorkPulse] IP geolocation provider failed (${p.url}):`, err?.message);
            }
        }
        console.error('[WorkPulse] get-ip-location: ALL providers failed');
        return { ok: false, error: 'All IP geolocation providers failed' };
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
                    // OpenStreetMap tile servers (a/b/c.tile.openstreetmap.org)
                    // are needed by the Leaflet map used in Organization →
                    // Attendance Settings to pick an office location. We also
                    // allow unpkg.com so Leaflet's default marker icons load
                    // (they're served from the npm package's CDN copy).
                    `connect-src 'self' workpulse://app ${RAILWAY_URL} wss://${new URL(RAILWAY_URL).host} https://embed.diagrams.net https://*.tile.openstreetmap.org https://nominatim.openstreetmap.org https://unpkg.com; ` +
                    "img-src 'self' workpulse://app data: blob: https://embed.diagrams.net https://*.tile.openstreetmap.org https://unpkg.com; " +
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

    // ─── Notify renderer when the main window is hidden / shown ───
    // Used by the in-call overlay to auto-open the always-on-top mini PiP
    // when the user minimises or sends the app to the tray during a call,
    // and to drop back to the full overlay when the user reopens the app.
    const notifyHidden = (reason) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try { mainWindow.webContents.send('window-hidden', { reason }); } catch { /* ignore */ }
        }
    };
    const notifyShown = (reason) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try { mainWindow.webContents.send('window-shown', { reason }); } catch { /* ignore */ }
        }
    };
    mainWindow.on('minimize', () => notifyHidden('minimize'));
    mainWindow.on('hide', () => notifyHidden('hide'));
    mainWindow.on('restore', () => notifyShown('restore'));
    mainWindow.on('show', () => notifyShown('show'));
    mainWindow.on('focus', () => notifyShown('focus'));

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

    // ─── One-time startup probe of Google Geolocation API ──────────────
    // Chromium's navigator.geolocation calls into this same endpoint, but
    // silently swallows any HTTP error and falls back to a *very* coarse
    // built-in fix. That makes "the key isn't working" indistinguishable
    // from "the user is in a poor-signal area" in user-facing symptoms.
    //
    // To convert that silent failure into a loud one, we explicitly hit
    // the endpoint at startup with the same key. The result is logged
    // (lat/lng truncated to 2 decimals so we don't leak the user's exact
    // location into shareable logs) so you can tell at a glance from the
    // desktop log whether the key is accepted by Google:
    //
    //   OK     → "GeoProbe: Google accepted key, accuracy ≈ X m at LAT,LNG"
    //   FAIL   → "GeoProbe: HTTP 403 — REQUEST_DENIED — API has not been
    //             used in project ..."
    //
    // Cost: 1 Geolocation API request per app start (~$0.005). Negligible.
    if (LOADED_GOOGLE_API_KEY) {
        (async () => {
            try {
                const url = `https://www.googleapis.com/geolocation/v1/geolocate?key=${encodeURIComponent(LOADED_GOOGLE_API_KEY)}`;
                const resp = await net.fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ considerIp: true }),
                });
                const body = await resp.text();
                if (!resp.ok) {
                    console.warn(`[WorkPulse] GeoProbe: Google rejected the API key — HTTP ${resp.status}: ${body.slice(0, 500)}`);
                    return;
                }
                let parsed;
                try { parsed = JSON.parse(body); } catch { parsed = null; }
                if (parsed && parsed.location) {
                    const lat = Number(parsed.location.lat).toFixed(2);
                    const lng = Number(parsed.location.lng).toFixed(2);
                    console.log(`[WorkPulse] GeoProbe: Google accepted key, accuracy ≈ ${parsed.accuracy} m at ${lat},${lng} (IP-only, Chromium will do better with Wi-Fi scan)`);
                } else {
                    console.warn('[WorkPulse] GeoProbe: unexpected response shape:', body.slice(0, 500));
                }
            } catch (err) {
                console.warn('[WorkPulse] GeoProbe: failed to reach Google Geolocation API:', err?.message);
            }
        })();
    } else {
        console.log('[WorkPulse] GeoProbe: skipped (no GOOGLE_API_KEY loaded)');
    }
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
