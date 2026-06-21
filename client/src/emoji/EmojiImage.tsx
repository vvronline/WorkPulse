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

let spriteCssInjected = false;
function ensureSpriteCss() {
    if (spriteCssInjected || !USING_BUNDLED) return;
    spriteCssInjected = true;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/emoji/sprite.css";
    document.head.appendChild(link);
}

interface EmojiImageProps {
    variant: EmojiVariant;
    size?: number; // px
    title?: string;
    className?: string;
}

export default function EmojiImage({ variant, size = 22, title, className }: EmojiImageProps) {
    const [useNative, setUseNative] = useState(!USING_BUNDLED);

    useEffect(() => {
        ensureSpriteCss();
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