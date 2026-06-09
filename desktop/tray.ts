import { Tray, Menu, nativeImage, app, type BrowserWindow } from "electron";
import path from "path";

let tray: Tray | null = null;

function setupTray(mainWindow: BrowserWindow): Tray {
    const iconPath = path.join(__dirname, "icons", "icon.png");

    // Create a 16x16 / 22x22 tray icon from the app icon
    let trayIcon;
    try {
        trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } catch {
        // Fallback: empty icon if file doesn't exist yet
        trayIcon = nativeImage.createEmpty();
    }

    tray = new Tray(trayIcon);
    tray.setToolTip("WorkPulse");

    const contextMenu = Menu.buildFromTemplate([
        {
            label: "Show WorkPulse",
            click: () => {
                mainWindow.show();
                mainWindow.focus();
            },
        },
        { type: "separator" },
        {
            label: "Quit",
            click: () => {
                app.isQuitting = true;
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(contextMenu);

    // Click tray icon to show/hide window
    tray.on("click", () => {
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });

    return tray;
}

export { setupTray };