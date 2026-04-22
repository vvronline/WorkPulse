const { autoUpdater } = require('electron-updater');
const { ipcMain, app, BrowserWindow } = require('electron');

autoUpdater.logger = console;

function setupUpdater(mainWindow) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    let pendingVersion = null;
    let reminderInterval = null;
    let checkInProgress = false;
    let checkInterval = null;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [10_000, 30_000, 60_000]; // 10s, 30s, 60s

    function sendToRenderer(channel, data) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, data);
        }
    }

    function clearReminder() {
        if (reminderInterval) {
            clearInterval(reminderInterval);
            reminderInterval = null;
        }
    }

    async function performCheck() {
        if (checkInProgress) return;
        checkInProgress = true;
        try {
            await autoUpdater.checkForUpdates();
            retryCount = 0; // reset on success
        } catch (err) {
            console.error('[updater] Check failed:', err?.message);
            // Retry with exponential backoff
            if (retryCount < MAX_RETRIES) {
                const delay = RETRY_DELAYS[retryCount] || 60_000;
                retryCount++;
                console.log(`[updater] Retrying in ${delay / 1000}s (attempt ${retryCount}/${MAX_RETRIES})`);
                setTimeout(() => performCheck(), delay);
            }
        } finally {
            checkInProgress = false;
        }
    }

    // ─── Auto-updater events ───
    autoUpdater.on('update-available', (info) => {
        pendingVersion = info.version;
        sendToRenderer('update-available', {
            version: info.version,
            releaseNotes: info.releaseNotes,
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        pendingVersion = info.version;
        sendToRenderer('update-downloaded', {
            version: info.version,
            releaseNotes: info.releaseNotes,
        });

        // Periodic reminder every 30 minutes if user dismisses
        clearReminder();
        reminderInterval = setInterval(() => {
            sendToRenderer('update-reminder', { version: pendingVersion });
        }, 30 * 60 * 1000);
    });

    autoUpdater.on('download-progress', (progress) => {
        sendToRenderer('download-progress', {
            percent: Math.round(progress.percent),
            transferred: progress.transferred,
            total: progress.total,
        });
    });

    autoUpdater.on('update-not-available', () => {
        sendToRenderer('update-not-available');
    });

    autoUpdater.on('error', (err) => {
        console.error('Auto-updater error:', err?.message);
        sendToRenderer('update-error', { message: err?.message });
    });

    // ─── Update IPC handlers ───
    ipcMain.on('install-update', () => {
        clearReminder();
        autoUpdater.quitAndInstall(false, true);
    });

    ipcMain.on('download-update', () => {
        autoUpdater.downloadUpdate().catch(() => { });
    });

    ipcMain.handle('check-for-update', async () => {
        if (checkInProgress) {
            return { available: false, reason: 'check-in-progress' };
        }
        checkInProgress = true;
        try {
            const result = await autoUpdater.checkForUpdates();
            if (!result || !result.updateInfo) return { available: false, reason: 'no-info' };
            const current = app.getVersion();
            const latest = result.updateInfo.version;
            console.log(`[updater] Current: ${current}, Latest: ${latest}`);
            if (latest === current) return { available: false, reason: 'up-to-date', version: current };
            return { available: true, version: latest };
        } catch (err) {
            console.error('[updater] Check failed:', err?.message);
            return { available: false, reason: 'error', error: err?.message };
        } finally {
            checkInProgress = false;
        }
    });

    ipcMain.handle('get-app-version', () => app.getVersion());

    // ─── Window management IPC handlers ───
    ipcMain.handle('is-maximized', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win ? win.isMaximized() : false;
    });

    ipcMain.on('window-minimize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.minimize();
    });

    ipcMain.on('window-maximize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.isMaximized() ? win.unmaximize() : win.maximize();
        }
    });

    ipcMain.on('window-close', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.close();
    });

    // ─── Scheduled update checks ───
    // Initial check after 5s (gives app time to fully load), then every 30 minutes
    setTimeout(() => performCheck(), 5000);
    checkInterval = setInterval(() => performCheck(), 30 * 60 * 1000);

    // Clean up intervals on app quit
    app.on('before-quit', () => {
        clearReminder();
        if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
        }
    });
}

module.exports = { setupUpdater };
