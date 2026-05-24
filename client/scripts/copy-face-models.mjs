/**
 * Download the face-api.js model weights into `public/models/` so they
 * can be served as same-origin static files at runtime.
 *
 * Models used:
 *  - tiny_face_detector   (small/fast detector — ~190 KB)
 *  - face_landmark_68     (68-point landmark net — ~350 KB)
 *  - face_recognition     (128-D descriptor net — ~6.2 MB)
 *
 * These ship with the face-api.js GitHub repo under /weights/ but are NOT
 * included in the npm package, so we fetch them from the official CDN
 * (jsDelivr → GitHub). The download is idempotent: existing files are
 * skipped.
 *
 * `client/public/models/` is git-ignored. Run `npm install` (which
 * triggers `postinstall` via `predev` / `prebuild`) to regenerate them.
 */
/**
 * Copy face-api.js model weights from node_modules into `public/models/`
 * so they can be served as same-origin static files at runtime.
 *
 * Source of truth: `node_modules/@vladmandic/face-api/model/` — these are
 * the EXACT manifests + binaries the runtime package was built against,
 * so they always match each other. (The jsDelivr CDN occasionally serves
 * a manifest from one release alongside a binary from another, which
 * produces "tensor should have N values but has M" errors at load time.
 * Copying locally avoids that entire class of bug.)
 *
 * Idempotent — already-present files are left alone.
 */
import { mkdir, access, copyFile, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEST = resolve(__dirname, '..', 'public', 'models');
const SRC = resolve(__dirname, '..', 'node_modules', '@vladmandic', 'face-api', 'model');

// face-api.js loads three nets at runtime. Each net is a manifest JSON +
// one binary file (the published npm package uses single .bin files, NOT
// the sharded -shard1/-shard2 layout you'll see on some CDN mirrors).
const FILES = [
    'tiny_face_detector_model-weights_manifest.json',
    'tiny_face_detector_model.bin',
    'face_landmark_68_model-weights_manifest.json',
    'face_landmark_68_model.bin',
    'face_recognition_model-weights_manifest.json',
    'face_recognition_model.bin',
];

async function exists(p) {
    try { await access(p); return true; } catch { return false; }
}

async function copyOne(name) {
    const dest = join(DEST, name);
    if (await exists(dest)) {
        return { name, skipped: true };
    }
    const src = join(SRC, name);
    if (!(await exists(src))) {
        throw new Error(`Source file missing: ${src}. Did you run \`npm install\` in client/?`);
    }
    await copyFile(src, dest);
    const s = await stat(dest);
    return { name, size: s.size };
}

async function main() {
    await mkdir(DEST, { recursive: true });
    let copied = 0, skipped = 0;
    for (const name of FILES) {
        try {
            const r = await copyOne(name);
            if (r.skipped) {
                skipped++;
            } else {
                copied++;
                console.log(`[copy-face-models] Copied ${name} (${(r.size / 1024).toFixed(1)} KB)`);
            }
        } catch (err) {
            console.error(`[copy-face-models] Failed to copy ${name}: ${err.message}`);
            process.exit(1);
        }
    }
    console.log(`[copy-face-models] ${copied} copied, ${skipped} already present (in public/models/)`);
}

main().catch((err) => {
    console.error('[copy-face-models] Failed:', err);
    process.exit(1);
});
