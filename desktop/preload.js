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
});
