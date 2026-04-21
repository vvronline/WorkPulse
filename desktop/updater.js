const { autoUpdater } = require('electron-updater');
const { ipcMain } = require('electron');

// Enable logging
autoUpdater.logger = console;

function setupUpdater(mainWindow) {
    // Disable auto-download — we'll prompt the user first
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-available', {
                version: info.version,
                releaseNotes: info.releaseNotes,
            });
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-downloaded', {
                version: info.version,
            });
        }
    });

    autoUpdater.on('error', (err) => {
        console.error('Auto-updater error:', err?.message);
    });

    // IPC handlers
    ipcMain.on('install-update', () => {
        autoUpdater.quitAndInstall(false, true);
    });

    ipcMain.handle('get-app-version', () => {
        const { app } = require('electron');
        return app.getVersion();
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

    // Check for updates after a short delay, then periodically
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(() => {});
    }, 5000);

    setInterval(() => {
        autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000); // Every 4 hours
}

module.exports = { setupUpdater };
