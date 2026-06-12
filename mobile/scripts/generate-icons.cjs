/**
 * Generate the mobile app launcher / splash / favicon assets from the SAME
 * source artwork the desktop .exe uses (`desktop/icons/icon.svg`). This keeps
 * the Android APK launcher icon visually identical to the desktop build.
 *
 * Run from the repo root or from mobile/:
 *   node mobile/scripts/generate-icons.cjs
 *
 * Requires `sharp`. It is already installed in the desktop workspace, so we
 * resolve it from there (falling back to a local install) to avoid adding a
 * heavyweight native dependency to the mobile package.
 */
const path = require("path");
const fs = require("fs");

// Resolve sharp from the desktop workspace (where it is a dev dependency) or
// from a local install if present.
let sharp;
try {
    sharp = require("sharp");
} catch {
    const desktopSharp = path.join(__dirname, "..", "..", "desktop", "node_modules", "sharp");
    sharp = require(desktopSharp);
}

const REPO_ROOT = path.join(__dirname, "..", "..");
const SVG_PATH = path.join(REPO_ROOT, "desktop", "icons", "icon.svg");
const ASSETS_DIR = path.join(__dirname, "..", "assets");

// Background colour for the Android adaptive icon (matches app.config.ts).
const ADAPTIVE_BG = "#0a0e1c";

async function generate() {
    if (!fs.existsSync(SVG_PATH)) {
        throw new Error(`Source SVG not found: ${SVG_PATH}`);
    }
    if (!fs.existsSync(ASSETS_DIR)) {
        fs.mkdirSync(ASSETS_DIR, { recursive: true });
    }
    const svg = fs.readFileSync(SVG_PATH);

    // 1. Main app icon — 1024x1024 (Expo recommends ≥1024 for the launcher icon).
    await sharp(svg)
        .resize(1024, 1024, { fit: "cover" })
        .png()
        .toFile(path.join(ASSETS_DIR, "icon.png"));
    console.log("  ✓ icon.png (1024x1024)");

    // 2. Splash icon — 1024x1024 transparent-friendly (the splash uses a solid
    //    background from app config, so we just render the artwork centered).
    await sharp(svg)
        .resize(1024, 1024, { fit: "cover" })
        .png()
        .toFile(path.join(ASSETS_DIR, "splash-icon.png"));
    console.log("  ✓ splash-icon.png (1024x1024)");

    // 3. Favicon — 48x48 for the (rarely used) web target.
    await sharp(svg)
        .resize(48, 48, { fit: "cover" })
        .png()
        .toFile(path.join(ASSETS_DIR, "favicon.png"));
    console.log("  ✓ favicon.png (48x48)");

    // 4. Android adaptive icon foreground — 1024x1024 with safe padding.
    //    Android masks the adaptive icon and only the inner ~66% is guaranteed
    //    visible, so we render the artwork at ~62% scale centered on a
    //    transparent canvas to avoid the round/squircle mask clipping content.
    const FG_SIZE = 1024;
    const ART_SIZE = Math.round(FG_SIZE * 0.62); // ~635px artwork, padded
    const artBuffer = await sharp(svg).resize(ART_SIZE, ART_SIZE, { fit: "cover" }).png().toBuffer();
    await sharp({
        create: {
            width: FG_SIZE,
            height: FG_SIZE,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([{ input: artBuffer, gravity: "center" }])
        .png()
        .toFile(path.join(ASSETS_DIR, "android-icon-foreground.png"));
    console.log("  ✓ android-icon-foreground.png (1024x1024, padded)");

    // 5. Android adaptive icon background — solid colour fill (1024x1024).
    await sharp({
        create: {
            width: FG_SIZE,
            height: FG_SIZE,
            channels: 4,
            background: ADAPTIVE_BG,
        },
    })
        .png()
        .toFile(path.join(ASSETS_DIR, "android-icon-background.png"));
    console.log("  ✓ android-icon-background.png (1024x1024, solid)");

    // 6. Android monochrome icon — white silhouette on transparent (Android 13+
    //    themed icons). We desaturate + threshold the artwork to a flat white.
    const monoArt = await sharp(svg)
        .resize(ART_SIZE, ART_SIZE, { fit: "cover" })
        .greyscale()
        .normalise()
        .png()
        .toBuffer();
    await sharp({
        create: {
            width: FG_SIZE,
            height: FG_SIZE,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([{ input: monoArt, gravity: "center" }])
        .png()
        .toFile(path.join(ASSETS_DIR, "android-icon-monochrome.png"));
    console.log("  ✓ android-icon-monochrome.png (1024x1024)");

    console.log("\nDone! Mobile icons regenerated from desktop/icons/icon.svg");
}

generate().catch((err) => {
    console.error("Mobile icon generation failed:", err);
    process.exit(1);
});