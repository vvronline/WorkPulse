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
