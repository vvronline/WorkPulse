// EmojiImage — renders a single emoji as a bundled sprite image when the
// generated asset set is present, otherwise falls back to the native unicode
// glyph. Used everywhere emoji are displayed (picker, reactions, etc.).
//
// See docs/CHAT_DESIGN_SPEC.md §1.

import { useEffect, useState } from "react";
import type { EmojiVariant } from "./types";
import { USING_BUNDLED } from "./emojiStore";
import { SHEET_COLS } from "./generated";

// The Apple datasource sprite is a square SHEET_COLS×SHEET_COLS grid of cells.
// background-size is (SHEET_COLS*100)% so each cell maps to one emoji; position
// is sheetX/(SHEET_COLS-1) * 100%.
// SHEET_COLS is imported from ./generated (derived from the dataset at
// generation time) so background math always matches the actual sprite grid,
// even when the datasource changes its grid size between versions (57 in v14,
// 62 in v16).

// Whether the sprite PNG actually loaded. A CSS `background-image` failure on a
// <span> cannot fire React's onError, so in environments where the sprite asset
// doesn't resolve (notably the packaged Electron desktop served over the
// workpulse:// protocol) emoji would silently render as empty boxes with no
// fallback. We proactively probe the sprite once and, if it fails, flip every
// EmojiImage to the native unicode glyph (which renders correctly via the OS
// color-emoji font on Windows/macOS/Linux). Subscribers re-render on change.
type SpriteStatus = "pending" | "ok" | "failed";

// The packaged Electron desktop app serves the bundled sprite over the
// workpulse:// protocol where the sprite sheet renders misaligned/garbled
// (the cells don't map cleanly). The OS color-emoji font (Segoe UI Emoji /
// Apple Color Emoji) renders perfectly there, so on Electron we skip the
// sprite entirely and always use the native unicode glyph.
const IS_ELECTRON =
    typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent);

const BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "/");
const SPRITE_CSS_URL = `${BASE_URL}emoji/sprite.css`;
const SPRITE_PNG_URL = `${BASE_URL}emoji/sprite.png`;

let spriteStatus: SpriteStatus = USING_BUNDLED && !IS_ELECTRON ? "pending" : "failed";
const spriteListeners = new Set<(s: SpriteStatus) => void>();

function setSpriteStatus(s: SpriteStatus) {
    if (spriteStatus === s) return;
    // A late probe error can be transient (request cancelled/offline blip). If
    // we've already confirmed the sprite once, do not downgrade all emoji.
    if (spriteStatus === "ok" && s === "failed") return;
    spriteStatus = s;
    spriteListeners.forEach((fn) => fn(s));
}

let spriteCssInjected = false;
let spriteProbeStarted = false;
const PROBE_MAX_ATTEMPTS = 2;
function probeSprite(attempt: number) {
    const img = new Image();
    img.onload = () => setSpriteStatus("ok");
    img.onerror = () => {
        if (attempt < PROBE_MAX_ATTEMPTS) {
            probeSprite(attempt + 1);
            return;
        }
        setSpriteStatus("failed");
    };
    img.src = attempt > 1 ? `${SPRITE_PNG_URL}?v=${attempt}` : SPRITE_PNG_URL;
}
function ensureSpriteCss() {
    if (!USING_BUNDLED || typeof document === "undefined") return;
    if (!spriteCssInjected) {
        spriteCssInjected = true;
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = SPRITE_CSS_URL;
        document.head.appendChild(link);
    }
    // Probe the actual sprite image so we can detect a load failure (which the
    // CSS background can't report) and fall back to native glyphs.
    if (!spriteProbeStarted) {
        spriteProbeStarted = true;
        probeSprite(1);
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
                backgroundImage: `url(${SPRITE_PNG_URL})`,
                backgroundRepeat: "no-repeat",
                backgroundSize: `${SHEET_COLS * 100}% ${SHEET_COLS * 100}%`,
                backgroundPosition: `${x}% ${y}%`,
                display: "inline-block",
                verticalAlign: "-0.25em",
            }}
        />
    );
}