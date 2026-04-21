/**
 * Generate app icons from SVG source.
 * Run: node generate-icons.js
 * Requires: sharp (dev dependency)
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SVG_PATH = path.join(__dirname, 'icons', 'icon.svg');
const ICONS_DIR = path.join(__dirname, 'icons');

async function generate() {
    const svg = fs.readFileSync(SVG_PATH);

    // Generate PNG at multiple sizes (for Linux icon set + general use)
    const sizes = [16, 32, 48, 64, 128, 256, 512];
    for (const size of sizes) {
        await sharp(svg)
            .resize(size, size)
            .png()
            .toFile(path.join(ICONS_DIR, `${size}x${size}.png`));
        console.log(`  ✓ ${size}x${size}.png`);
    }

    // Main icon.png (256x256 — used by Electron + Linux)
    await sharp(svg)
        .resize(256, 256)
        .png()
        .toFile(path.join(ICONS_DIR, 'icon.png'));
    console.log('  ✓ icon.png (256x256)');

    // For Windows .ico — electron-builder can build from a 256x256 PNG
    // Just copy 256x256 as the base; electron-builder handles ico generation
    // Or provide a proper .ico via png-to-ico if needed

    console.log('\nDone! For Windows .ico and macOS .icns:');
    console.log('  electron-builder will auto-generate from icon.png if .ico/.icns are missing.');
    console.log('  For best results, provide icon.ico (256x256) and icon.icns manually.');
}

generate().catch(err => {
    console.error('Icon generation failed:', err);
    process.exit(1);
});
