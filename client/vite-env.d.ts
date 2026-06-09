/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly [key: string]: string | boolean | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Electron preload bridge exposed via contextBridge in desktop/preload.
// Permissive by design — the desktop app injects this at runtime; web builds
// leave it undefined. Components guard with optional chaining.
interface ElectronAPI {
  isElectron?: boolean;
  platform?: string;
  [key: string]: any;
}

interface Window {
  electronAPI?: ElectronAPI;
}

// CSS Modules
declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Static asset imports
declare module "*.css";
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.jpg" {
  const src: string;
  export default src;
}