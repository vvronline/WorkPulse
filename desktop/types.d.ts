// Ambient type augmentations for the WorkPulse desktop (Electron) main &
// preload processes. These add the small number of custom properties the
// codebase attaches to Electron/DOM objects so the strict TypeScript build
// type-checks cleanly without resorting to `any`.
//
// NOTE: This file deliberately has NO top-level import/export so it stays an
// ambient (global) script. Electron declares a global `Electron` namespace,
// so augmenting `Electron.App` / `Electron.BrowserWindow` here merges with
// the real interfaces used throughout the main process.

declare namespace Electron {
    interface App {
        // Set by the tray "Quit" action and `before-quit` so the main
        // window's `close` handler knows to actually quit instead of
        // hiding to the tray.
        isQuitting?: boolean;
    }

    interface BrowserWindow {
        // Marks a programmatic (end-of-call / restore) close so the pip
        // window's `closed` handler doesn't bounce a "user closed" event
        // back to the main window.
        __silentClose?: boolean;
    }
}

interface Window {
    // preload.js stores maximize-change listeners keyed by the caller's
    // callback so `removeMaximizeChange` can detach the right handler.
    __maxChangeHandlers?: Map<unknown, (...args: unknown[]) => void>;
}