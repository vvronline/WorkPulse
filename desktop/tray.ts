import { Tray, Menu, nativeImage, app, type BrowserWindow } from "electron";
import path from "path";

let tray: Tray | null = null;

function setupTray(mainWindow: BrowserWindow): Tray {
  // Pre-rendered, sharpened 16px tray bitmap (with a 32px `@2x` sibling that
  // nativeImage.createFromPath auto-loads on HiDPI displays). This avoids
  // Electron's low-quality runtime downscale of the 256px icon, which made
  // the tray icon look blurry.
  const iconPath = path.join(__dirname, "icons", "tray.png");

  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      throw new Error("tray icon failed to load");
    }
  } catch {
    // Fallback: empty icon if file doesn't exist yet
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip("AINO");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show AINO",
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
