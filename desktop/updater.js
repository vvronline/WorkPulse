const { autoUpdater } = require('electron-updater');
const { ipcMain } = require('electron');

// Enable logging
autoUpdater.logger = console;

function setupUpdater(mainWindow) {
    // Auto-download updates immediately when available
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    let pendingVersion = null;
    let reminderInterval = null;

    autoUpdater.on('update-available', (info) => {
        pendingVersion = info.version;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-available', {
                version: info.version,
                releaseNotes: info.releaseNotes,
            });
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        pendingVersion = info.version;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-downloaded', {
                version: info.version,
            });
        }

        // Start periodic reminder every 30 minutes if user dismisses
        if (reminderInterval) clearInterval(reminderInterval);
        reminderInterval = setInterval(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('update-reminder', {
                    version: pendingVersion,
                });
            }
        }, 30 * 60 * 1000);
    });

    autoUpdater.on('download-progress', (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-progress', {
                percent: Math.round(progress.percent),
                transferred: progress.transferred,
                total: progress.total,
            });
        }
    });

    autoUpdater.on('error', (err) => {
        console.error('Auto-updater error:', err?.message);
    });

    // IPC handlers
    ipcMain.on('install-update', () => {
        if (reminderInterval) clearInterval(reminderInterval);
        autoUpdater.quitAndInstall(false, true);
    });

    ipcMain.on('download-update', () => {
        autoUpdater.downloadUpdate().catch(() => { });
    });

    ipcMain.handle('get-app-version', () => {
        const { app } = require('electron');
        return app.getVersion();
    });

    ipcMain.handle('is-maximized', (event) => {
        const win = require('electron').BrowserWindow.fromWebContents(event.sender);
        return win ? win.isMaximized() : false;
    });

    ipcMain.on('window-minimize', (event) => {
        const win = require('electron').BrowserWindow.fromWebContents(event.sender);
        if (win) win.minimize();
    });

    ipcMain.on('window-maximize', (event) => {
        const win = require('electron').BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.isMaximized() ? win.unmaximize() : win.maximize();
        }
    });

    ipcMain.on('window-close', (event) => {
        const win = require('electron').BrowserWindow.fromWebContents(event.sender);
        if (win) win.close();
    });

    // Check for updates after a short delay, then every 30 minutes
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(() => { });
    }, 3000);

    setInterval(() => {
        autoUpdater.checkForUpdates().catch(() => { });
    }, 30 * 60 * 1000);
}

module.exports = { setupUpdater };
