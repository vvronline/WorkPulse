// Regression guard for the emoji sprite grid geometry.
//
// The web client renders each emoji as a CSS slice of a square sprite sheet
// (see client/src/emoji/EmojiImage.tsx). The number of columns/rows in that
// sheet (SHEET_COLS) must match the largest sheet coordinate present in the
// generated dataset, otherwise background-size / background-position are
// computed with the wrong divisor and every emoji renders as a misaligned or
// blank slice — i.e. "the emoji picker shows no actual emoji preview".
//
// The emoji-datasource-apple grid size changed between major versions (57 in
// v14, 62 in v16). This test fails loudly if generated.ts and the derived
// SHEET_COLS constant ever drift apart again.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { GENERATED_EMOJI, SHEET_COLS, HAS_BUNDLED_ASSETS } from "../emoji/generated";
import EmojiImage from "../emoji/EmojiImage";

describe("emoji sprite geometry", () => {
    it("exports a bundled dataset", () => {
        expect(HAS_BUNDLED_ASSETS).toBe(true);
        expect(GENERATED_EMOJI.length).toBeGreaterThan(0);
        expect(SHEET_COLS).toBeGreaterThan(0);
    });

    it("SHEET_COLS matches the largest sheet coordinate in the dataset", () => {
        let maxIndex = 0;
        for (const e of GENERATED_EMOJI) {
            maxIndex = Math.max(maxIndex, e.base.sheetX, e.base.sheetY);
            if (e.skins) {
                for (const v of e.skins) {
                    maxIndex = Math.max(maxIndex, v.sheetX, v.sheetY);
                }
            }
        }
        // Indices are 0-based, so a grid of N columns has a max index of N-1.
        expect(SHEET_COLS).toBe(maxIndex + 1);
    });

    it("keeps every sheet coordinate within the declared grid", () => {
        for (const e of GENERATED_EMOJI) {
            expect(e.base.sheetX).toBeLessThan(SHEET_COLS);
            expect(e.base.sheetY).toBeLessThan(SHEET_COLS);
        }
    });

    it("renders a sprite cell using the current SHEET_COLS divisor", () => {
        const variant = GENERATED_EMOJI[0].base;
        const { container } = render(createElement(EmojiImage, { variant, size: 24 }));
        const span = container.querySelector("span.wp-emoji") as HTMLElement | null;
        // Only assert the geometry when the sprite path (not native fallback) is
        // in use — the jsdom environment reports the bundled sprite as usable.
        if (span) {
            const expectedX = (variant.sheetX / (SHEET_COLS - 1)) * 100;
            const expectedY = (variant.sheetY / (SHEET_COLS - 1)) * 100;
            expect(span.style.backgroundSize).toBe(
                `${SHEET_COLS * 100}% ${SHEET_COLS * 100}%`,
            );
            expect(span.style.backgroundPosition).toBe(`${expectedX}% ${expectedY}%`);
        }
    });
});
