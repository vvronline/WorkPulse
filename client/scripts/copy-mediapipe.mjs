/**
 * Copy MediaPipe Selfie Segmentation static assets from node_modules into
 * `public/mediapipe/selfie_segmentation/` so Vite ships them as same-origin
 * static files (under `dist/mediapipe/...`).
 *
 * Why we don't just `import` MediaPipe:
 *  - The package is a non-ESM IIFE that registers `window.SelfieSegmentation`
 *    and uses `locateFile` to fetch its WASM/.tflite/.binarypb at runtime.
 *  - Bundling it through Vite would break those runtime fetches and bloat
 *    the JS chunk with binaries that should stream lazily.
 *
 * Why we don't commit the copied files:
 *  - They are ~12 MB of binaries. The npm package is the single source of
 *    truth; this script makes the copy reproducible from a clean checkout.
 *  - `client/public/mediapipe/` is git-ignored. Run `npm install` (which
 *    triggers `postinstall`) or `npm run build` (which triggers `prebuild`)
 *    to regenerate them.
 */
import { mkdir, copyFile, readdir, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', 'node_modules', '@mediapipe', 'selfie_segmentation');
const DEST = resolve(__dirname, '..', 'public', 'mediapipe', 'selfie_segmentation');

// Only the files MediaPipe actually loads at runtime. Skips README, .d.ts,
// and the package.json from the npm dist.
const RUNTIME_EXTS = new Set(['.js', '.wasm', '.data', '.tflite', '.binarypb']);

async function exists(p) {
    try { await access(p); return true; } catch { return false; }
}

async function main() {
    if (!(await exists(SRC))) {
        console.error(
            `[copy-mediapipe] @mediapipe/selfie_segmentation not found at ${SRC}.\n` +
            `Run \`npm install\` first.`
        );
        process.exit(1);
    }
    await mkdir(DEST, { recursive: true });
    const entries = await readdir(SRC, { withFileTypes: true });
    let copied = 0;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = entry.name.slice(entry.name.lastIndexOf('.'));
        if (!RUNTIME_EXTS.has(ext)) continue;
        await copyFile(join(SRC, entry.name), join(DEST, entry.name));
        copied++;
    }
    console.log(`[copy-mediapipe] Copied ${copied} runtime files to public/mediapipe/selfie_segmentation/`);
}

main().catch((err) => {
    console.error('[copy-mediapipe] Failed:', err);
    process.exit(1);
});