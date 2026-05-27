const { contextBridge, ipcRenderer } = require('electron');

// Helper: subscribe to an IPC channel and return an unsubscribe function
function createListener(channel, transform) {
    return (callback) => {
        const handler = (_e, ...args) => callback(transform ? transform(...args) : args[0]);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    };
}

contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    isElectron: true,
    getVersion: () => ipcRenderer.invoke('get-app-version'),
    isMaximized: () => ipcRenderer.invoke('is-maximized'),
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    onMaximizeChange: (callback) => {
        const handler = (_e, val) => callback(val);
        ipcRenderer.on('maximize-change', handler);
        if (!window.__maxChangeHandlers) window.__maxChangeHandlers = new Map();
        window.__maxChangeHandlers.set(callback, handler);
    },
    removeMaximizeChange: (callback) => {
        if (window.__maxChangeHandlers) {
            const handler = window.__maxChangeHandlers.get(callback);
            if (handler) {
                ipcRenderer.removeListener('maximize-change', handler);
                window.__maxChangeHandlers.delete(callback);
            }
        }
    },
    // Update listeners — each returns an unsubscribe function for cleanup
    onUpdateAvailable: createListener('update-available'),
    onDownloadProgress: createListener('download-progress'),
    onUpdateDownloaded: createListener('update-downloaded'),
    onUpdateReminder: createListener('update-reminder'),
    onUpdateNotAvailable: createListener('update-not-available', () => ({})),
    onUpdateError: createListener('update-error'),
    checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
    downloadUpdate: () => ipcRenderer.send('download-update'),
    installUpdate: () => ipcRenderer.send('install-update'),
    fetchReleaseNotes: (version) => ipcRenderer.invoke('fetch-release-notes', version),
    // Screen source picker
    onScreenSources: createListener('screen-sources'),
    selectScreenSource: (sourceId) => ipcRenderer.send('screen-source-selected', sourceId),
    // Incoming call: flash taskbar and show/focus window
    flashFrame: (flash) => ipcRenderer.send('flash-frame', flash),
    showAndFocus: () => ipcRenderer.send('show-and-focus'),

    // IP-based geolocation fallback for the attendance clock-in flow.
    // Resolves to { ok: true, latitude, longitude, accuracy } or
    // { ok: false, error }. The renderer only calls this when
    // navigator.geolocation has already failed (Chromium in Electron
    // requires a GOOGLE_API_KEY for its built-in geolocation, which we
    // can't ship publicly). See main.js → ipcMain.handle('get-ip-location').
    getIpLocation: () => ipcRenderer.invoke('get-ip-location'),
    getNativeLocation: () => ipcRenderer.invoke('get-native-location'),

    // Open the OS-level Location privacy settings page so users with a bad
    // geolocation fix (typical for packaged Electron builds) can flip on
    // Windows Location Services without leaving the app. No-op on platforms
    // that don't have a privacy-location URI scheme.
    openLocationSettings: () => ipcRenderer.invoke('open-location-settings'),

    // ─── Wi-Fi info reader (attendance clock-in Wi-Fi-first verification) ──
    // Returns { ok, bssid, ssid, signal } describing the AP the OS is
    // currently associated with. Used by ClockInVerifyModal to send the
    // BSSID alongside geolocation so the server can match against the org's
    // office Wi-Fi allow-list (more reliable than the geofence on laptops
    // where Chromium's geolocation is IP-based and wildly inaccurate).
    getWifiInfo: () => ipcRenderer.invoke('get-wifi-info'),

    // ─── Main window hide/show lifecycle (renderer subscribers) ────────
    // Fired whenever the main BrowserWindow is minimized / hidden to the
    // tray / restored / shown / focused. The in-call overlay uses these
    // to automatically open the always-on-top mini PiP when the user
    // leaves the app during a call, and to drop back to the full overlay
    // when the user reopens the app.
    onWindowHidden: (cb) => {
        const handler = (_e, payload) => cb(payload || {});
        ipcRenderer.on('window-hidden', handler);
        return () => ipcRenderer.removeListener('window-hidden', handler);
    },
    onWindowShown: (cb) => {
        const handler = (_e, payload) => cb(payload || {});
        ipcRenderer.on('window-shown', handler);
        return () => ipcRenderer.removeListener('window-shown', handler);
    },

    // ─── Always-on-top mini call window ("floatie") ─────────────────────
    // Used by the 1:1 call overlay to pop a small always-on-top window
    // that sits over other apps (Teams-style). The pip window itself
    // renders /pip-call which calls callPip.ready() once mounted, then
    // listens for state updates via onCallPipState and sends actions via
    // sendCallPipAction.
    callPip: {
        // ── Main window → main process ──
        open: (state) => ipcRenderer.send('call:pip-open', state),
        close: () => ipcRenderer.send('call:pip-close'),
        updateState: (partial) => ipcRenderer.send('call:pip-update-state', partial),
        // Subscribe to "user closed the floatie" — caller should restore
        // the in-app overlay. Returns an unsubscribe function.
        onWindowClosed: (cb) => {
            const handler = () => cb();
            ipcRenderer.on('call:pip-window-closed', handler);
            return () => ipcRenderer.removeListener('call:pip-window-closed', handler);
        },
        // Subscribe to actions the user took inside the pip window
        // (mute / unmute / restore / end). Returns an unsubscribe function.
        onAction: (cb) => {
            const handler = (_e, payload) => cb(payload || {});
            ipcRenderer.on('call:pip-action', handler);
            return () => ipcRenderer.removeListener('call:pip-action', handler);
        },

        // ── Pip window → main process ──
        ready: () => ipcRenderer.send('call:pip-ready'),
        sendAction: (action) => ipcRenderer.send('call:pip-action', { action }),
        // Subscribe to state pushes from the main window (avatar, name,
        // duration tick, muted flag, …). Returns an unsubscribe function.
        onState: (cb) => {
            const handler = (_e, state) => cb(state || {});
            ipcRenderer.on('call:pip-state', handler);
            return () => ipcRenderer.removeListener('call:pip-state', handler);
        },
    },
});
