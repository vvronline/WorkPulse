const { contextBridge, ipcRenderer } = require('electron');

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
        // Store handler for cleanup
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
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_e, info) => callback(info)),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_e, info) => callback(info)),
    onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (_e, info) => callback(info)),
    downloadUpdate: () => ipcRenderer.send('download-update'),
    installUpdate: () => ipcRenderer.send('install-update'),
});
