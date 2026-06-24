/**
 * GIPHY proxy endpoints for the chat GIF/Sticker picker.
 *
 * The GIPHY API key is kept server-side (GIPHY_API_KEY env var) so the web,
 * desktop, and mobile clients never embed a key — they all call these proxy
 * routes instead. This replaces the previous direct-to-Tenor integration
 * (Google discontinued the Tenor API: no new keys since Jan 2026, full
 * shutdown June 30 2026).
 *
 *   GET /api/giphy/search?q=<term>&type=gifs|stickers
 *   GET /api/giphy/trending?type=gifs|stickers
 *
 * Both return a normalized payload: { results: { id, previewUrl, mediaUrl }[] }
 */
import express from "express";
import type { Request, Response } from "express";
const auth = require("../middleware/auth");
const { loadUserContext } = require("../middleware/rbac");
const { requireTenant } = require("../middleware/tenant");

const router = express.Router();
router.use(auth, loadUserContext, requireTenant);

const GIPHY_API_KEY = process.env.GIPHY_API_KEY || "";
const GIPHY_BASE = "https://api.giphy.com/v1";
const LIMIT = 30;

type GiphyItem = {
    id: string;
    images?: {
        fixed_width_small?: { url?: string };
        fixed_width?: { url?: string };
        original?: { url?: string };
        preview_gif?: { url?: string };
        downsized?: { url?: string };
    };
};

type NormalizedItem = { id: string; previewUrl: string; mediaUrl: string };

function normalize(items: unknown): NormalizedItem[] {
    if (!Array.isArray(items)) return [];
    return items
        .map((raw): NormalizedItem | null => {
            const it = raw as GiphyItem;
            const imgs = it?.images;
            if (!it?.id || !imgs) return null;
            const previewUrl =
                imgs.fixed_width_small?.url ||
                imgs.preview_gif?.url ||
                imgs.fixed_width?.url ||
                imgs.downsized?.url ||
                imgs.original?.url;
            const mediaUrl =
                imgs.original?.url ||
                imgs.fixed_width?.url ||
                imgs.downsized?.url ||
                previewUrl;
            if (!previewUrl || !mediaUrl) return null;
            return { id: String(it.id), previewUrl, mediaUrl };
        })
        .filter((x): x is NormalizedItem => x !== null);
}

function resolveType(raw: unknown): "gifs" | "stickers" {
    return raw === "stickers" || raw === "sticker" ? "stickers" : "gifs";
}

async function fetchGiphy(url: string): Promise<NormalizedItem[]> {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`GIPHY API responded ${resp.status}`);
    }
    const data = (await resp.json()) as { data?: unknown };
    return normalize(data?.data);
}

/**
 * GET /api/giphy/search?q=<term>&type=gifs|stickers
 */
router.get("/search", async (req: Request, res: Response) => {
    if (!GIPHY_API_KEY) {
        return res.status(503).json({ error: "GIF search is not configured", results: [] });
    }
    try {
        const q = String((req.query.q as string) || "").trim().slice(0, 100);
        const type = resolveType(req.query.type);
        if (!q) {
            // Empty query → behave like trending for a friendlier picker default.
            const trendingUrl = `${GIPHY_BASE}/${type}/trending?api_key=${encodeURIComponent(
                GIPHY_API_KEY,
            )}&limit=${LIMIT}&rating=pg-13`;
            const results = await fetchGiphy(trendingUrl);
            return res.json({ results });
        }
        const url = `${GIPHY_BASE}/${type}/search?api_key=${encodeURIComponent(
            GIPHY_API_KEY,
        )}&q=${encodeURIComponent(q)}&limit=${LIMIT}&rating=pg-13&lang=en`;
        const results = await fetchGiphy(url);
        return res.json({ results });
    } catch {
        return res.status(502).json({ error: "Could not load GIFs", results: [] });
    }
});

/**
 * GET /api/giphy/trending?type=gifs|stickers
 */
router.get("/trending", async (req: Request, res: Response) => {
    if (!GIPHY_API_KEY) {
        return res.status(503).json({ error: "GIF search is not configured", results: [] });
    }
    try {
        const type = resolveType(req.query.type);
        const url = `${GIPHY_BASE}/${type}/trending?api_key=${encodeURIComponent(
            GIPHY_API_KEY,
        )}&limit=${LIMIT}&rating=pg-13`;
        const results = await fetchGiphy(url);
        return res.json({ results });
    } catch {
        return res.status(502).json({ error: "Could not load GIFs", results: [] });
    }
});

module.exports = router;