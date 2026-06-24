// EmojiImage — renders a single emoji as a bundled sprite image when the
// generated asset set is present, otherwise falls back to the native unicode
// glyph. Used everywhere emoji are displayed (picker, reactions, etc.).
//
// See docs/CHAT_DESIGN_SPEC.md §1.

import { useEffect, useState } from "react";
import type { EmojiVariant } from "./types";
import { USING_BUNDLED } from "./emojiStore";

// The Apple datasource sprite is a 57×57 grid of 64px cells (Unicode 15-era).
// background-size is set to (57*100)% so each cell maps to one emoji; position
// is sheetX/(57-1) * 100%.
const SHEET_COLS = 57;

// Whether the sprite PNG actually loaded. A CSS `background-image` failure on a
// <span> cannot fire React's onError, so in environments where the sprite asset
// doesn't resolve (notably the packaged Electron desktop served over the
// workpulse:// protocol) emoji would silently render as empty boxes with no
// fallback. We proactively probe the sprite once and, if it fails, flip every
// EmojiImage to the native unicode glyph (which renders correctly via the OS
// color-emoji font on Windows/macOS/Linux). Subscribers re-render on change.
type SpriteStatus = "pending" | "ok" | "failed";
let spriteStatus: SpriteStatus = USING_BUNDLED ? "pending" : "failed";
const spriteListeners = new Set<(s: SpriteStatus) => void>();

function setSpriteStatus(s: SpriteStatus) {
    if (spriteStatus === s) return;
    spriteStatus = s;
    spriteListeners.forEach((fn) => fn(s));
}

let spriteCssInjected = false;
let spriteProbeStarted = false;
function ensureSpriteCss() {
    if (!USING_BUNDLED || typeof document === "undefined") return;
    if (!spriteCssInjected) {
        spriteCssInjected = true;
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/emoji/sprite.css";
        document.head.appendChild(link);
    }
    // Probe the actual sprite image so we can detect a load failure (which the
    // CSS background can't report) and fall back to native glyphs.
    if (!spriteProbeStarted) {
        spriteProbeStarted = true;
        const img = new Image();
        img.onload = () => setSpriteStatus("ok");
        img.onerror = () => setSpriteStatus("failed");
        img.src = "/emoji/sprite.png";
    }
}

interface EmojiImageProps {
    variant: EmojiVariant;
    size?: number; // px
    title?: string;
    className?: string;
}

export default function EmojiImage({ variant, size = 22, title, className }: EmojiImageProps) {
    // Start native if we never bundled assets OR the sprite probe already failed
    // (so late-mounted instances after a failure don't flash a broken box).
    const [useNative, setUseNative] = useState(
        !USING_BUNDLED || spriteStatus === "failed",
    );

    useEffect(() => {
        ensureSpriteCss();
        if (!USING_BUNDLED) return;
        // React to the shared sprite-load probe result.
        if (spriteStatus === "failed") {
            setUseNative(true);
            return;
        }
        const listener = (s: SpriteStatus) => {
            if (s === "failed") setUseNative(true);
        };
        spriteListeners.add(listener);
        return () => {
            spriteListeners.delete(listener);
        };
    }, []);

    if (useNative) {
        return (
            <span
                className={className}
                title={title}
                style={{ fontSize: size, lineHeight: 1, display: "inline-block" }}
                role="img"
                aria-label={title}
            >
                {variant.native}
            </span>
        );
    }

    // Sprite cell positioning.
    const x = (variant.sheetX / (SHEET_COLS - 1)) * 100;
    const y = (variant.sheetY / (SHEET_COLS - 1)) * 100;

    return (
        <span
            className={`wp-emoji ${className || ""}`}
            title={title}
            role="img"
            aria-label={title}
            onError={() => setUseNative(true)}
            style={{
                width: size,
                height: size,
                backgroundImage: "url(/emoji/sprite.png)",
                backgroundRepeat: "no-repeat",
                backgroundSize: `${SHEET_COLS * 100}% ${SHEET_COLS * 100}%`,
                backgroundPosition: `${x}% ${y}%`,
                display: "inline-block",
                verticalAlign: "-0.25em",
            }}
        />
    );
}