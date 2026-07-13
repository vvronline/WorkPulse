/**
 * Generate the mobile app launcher / splash / favicon assets from the SAME
 * source artwork the desktop .exe uses (`desktop/icons/icon-source.png`). This
 * keeps the Android APK launcher icon visually identical to the desktop build.
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
  const desktopSharp = path.join(
    __dirname,
    "..",
    "..",
    "desktop",
    "node_modules",
    "sharp",
  );
  sharp = require(desktopSharp);
}

const REPO_ROOT = path.join(__dirname, "..", "..");
const SOURCE_PATH = path.join(REPO_ROOT, "desktop", "icons", "icon-source.png");
const ASSETS_DIR = path.join(__dirname, "..", "assets");

// Background colour for the Android adaptive icon (matches app.config.ts).
const ADAPTIVE_BG = "#4e5257";

async function generate() {
  if (!fs.existsSync(SOURCE_PATH)) {
    throw new Error(`Source artwork not found: ${SOURCE_PATH}`);
  }
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }
  const svg = fs.readFileSync(SOURCE_PATH);

  // 1. Main app icon — 1024x1024 (Expo recommends ≥1024 for the launcher icon).
  await sharp(svg)
    .resize(1024, 1024, { fit: "cover" })
    .png()
    .toFile(path.join(ASSETS_DIR, "icon.png"));
  console.log("  ✓ icon.png (1024x1024)");

  // 2. Splash icon — 1024x1024 with transparent safe-zone padding. On Android
  //    12+ the system SplashScreen masks the animated icon into a CIRCLE
  //    (windowSplashScreenAnimatedIcon), so a full-bleed square logo gets its
  //    corners/edges clipped (reported as the bottom of the logo being cropped
  //    on launch). Render the artwork at ~62% scale centered on a transparent
  //    canvas — the same safe zone used for the adaptive launcher icon — so the
  //    whole logo stays inside the circular mask. The splash uses a solid
  //    background colour from app.config.ts, so the padding stays transparent.
  const SPLASH_SIZE = 1024;
  const SPLASH_ART = Math.round(SPLASH_SIZE * 0.62);
  const splashArt = await sharp(svg)
    .resize(SPLASH_ART, SPLASH_ART, { fit: "cover" })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: SPLASH_SIZE,
      height: SPLASH_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: splashArt, gravity: "center" }])
    .png()
    .toFile(path.join(ASSETS_DIR, "splash-icon.png"));
  console.log("  ✓ splash-icon.png (1024x1024, padded safe zone)");

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
  const artBuffer = await sharp(svg)
    .resize(ART_SIZE, ART_SIZE, { fit: "cover" })
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

  // 7. Android notification SMALL icon — a WHITE silhouette of the logo on a
  //    transparent, padded canvas. Android renders the status-bar small icon
  //    as a flat mask tinted from the ALPHA channel only, so we paint the
  //    logo shape solid white and keep its alpha (interior holes included).
  //    Replaces the previous hand-authored notification_icon.xml vector.
  const NOTIF_DIR = path.join(ASSETS_DIR, "notification");
  if (!fs.existsSync(NOTIF_DIR)) {
    fs.mkdirSync(NOTIF_DIR, { recursive: true });
  }
  const NOTIF_SIZE = 96; // xxxhdpi 24dp; Android downscales for lower densities
  const NOTIF_ART = Math.round(NOTIF_SIZE * 0.8); // padding inside the icon bounds
  // SIGNAL-STYLE BADGE: Android tints the small icon from its ALPHA channel only,
  // compositing it as a SMALL monochrome glyph in the corner of the big avatar
  // largeIcon. For that to look right (not a featureless tinted square) the
  // source MUST contribute real transparency. If the brand artwork is an OPAQUE
  // square the `dest-in` mask below would yield a solid white square. We THRESHOLD
  // the artwork to a hard alpha mask first (greyscale → normalise → threshold)
  // so only the logo's bright shape survives as opaque and the background drops
  // to transparent — producing a clean white-on-transparent silhouette glyph.
  const notifArtBuffer = await sharp(svg)
    .resize(NOTIF_ART, NOTIF_ART, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .greyscale()
    .normalise()
    // Hard alpha threshold: pixels brighter than ~50% become the silhouette,
    // everything else becomes transparent. This guarantees a crisp glyph even
    // from an opaque source square (the root cause of "the logo shows the same
    // size as the avatar instead of a small corner badge").
    .threshold(128)
    .png()
    .toBuffer();
  // Paint solid white, then mask by the logo's alpha via `dest-in`
  // (result = white × logoAlpha) to get a clean white silhouette.
  const silhouette = await sharp({
    create: {
      width: NOTIF_ART,
      height: NOTIF_ART,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: notifArtBuffer, blend: "dest-in" }])
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: NOTIF_SIZE,
      height: NOTIF_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: silhouette, gravity: "center" }])
    .png()
    .toFile(path.join(NOTIF_DIR, "notification_icon.png"));
  console.log(
    "  ✓ notification/notification_icon.png (96x96 white silhouette)",
  );

  console.log(
    "\nDone! Mobile icons regenerated from desktop/icons/icon-source.png",
  );
}

generate().catch((err) => {
  console.error("Mobile icon generation failed:", err);
  process.exit(1);
});
