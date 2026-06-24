// Signal-style emoji picker — categories, search, recents, and skin-tone
// selection, rendering the bundled image emoji set (with native fallback).
// Keeps the original props (onSelectEmoji / onClose / style) so every existing
// caller (composer, reactions) works unchanged.
//
// See docs/CHAT_DESIGN_SPEC.md §3.

import React, { useEffect, useMemo, useRef, useState } from "react";
import s from "./EmojiGifPicker.module.css";
import EmojiImage from "../../emoji/EmojiImage";
import { CATEGORY_ORDER, SKIN_TONES } from "../../emoji/types";
import type { Emoji, EmojiCategory } from "../../emoji/types";
import {
    emojiByCategory,
    getRecentEmoji,
    getSkinTone,
    nativeForTone,
    recordRecent,
    searchEmoji,
    setSkinTone,
    variantForTone,
} from "../../emoji/emojiStore";

interface EmojiGifPickerProps {
    onSelectEmoji: (emoji: string) => void;
    onSelectMediaFile?: (file: File) => void;
    onClose: () => void;
    style?: React.CSSProperties;
}

type PickerMode = "emoji" | "gif" | "sticker";
type TenorItem = { id: string; previewUrl: string; mediaUrl: string };

const TENOR_API_KEY = import.meta.env.VITE_TENOR_API_KEY as string | undefined;
const TENOR_CLIENT_KEY =
    (import.meta.env.VITE_TENOR_CLIENT_KEY as string | undefined) || "workpulse-chat";

export default function EmojiGifPicker({
    onSelectEmoji,
    onSelectMediaFile,
    onClose,
    style,
}: EmojiGifPickerProps) {
    const ref = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const gifInputRef = useRef<HTMLInputElement | null>(null);
    const stickerInputRef = useRef<HTMLInputElement | null>(null);

    const [query, setQuery] = useState("");
    const [mode, setMode] = useState<PickerMode>("emoji");
    const [tone, setTone] = useState(getSkinTone);
    const [toneOpen, setToneOpen] = useState(false);
    const [activeCat, setActiveCat] = useState<EmojiCategory>("smileys");
    const [recents, setRecents] = useState<Emoji[]>(getRecentEmoji);
    const [emojiTone, setEmojiTone] = useState<{ emoji: Emoji; x: number; y: number } | null>(null);
    const [tenorItems, setTenorItems] = useState<TenorItem[]>([]);
    const [tenorLoading, setTenorLoading] = useState(false);

    const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

    // Close on outside click + Escape.
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [onClose]);

    const results = useMemo(() => (query.trim() ? searchEmoji(query) : []), [query]);

    // Categories that actually have content (Recent only when non-empty).
    const sections = useMemo(() => {
        return CATEGORY_ORDER.filter((c) => (c.key === "recent" ? recents.length > 0 : true));
    }, [recents]);

    const handleSelect = (e: Emoji) => {
        recordRecent(e.id);
        setRecents(getRecentEmoji());
        onSelectEmoji(nativeForTone(e, tone));
        onClose();
    };

    const handleToneSelect = (t: number) => {
        setTone(t);
        setSkinTone(t);
        setToneOpen(false);
    };

    const handleEmojiContext = (e: React.MouseEvent, emoji: Emoji) => {
        if (!emoji.skins?.length) return;
        e.preventDefault();
        setEmojiTone({ emoji, x: e.clientX, y: e.clientY });
    };

    // Scroll active-category highlight as the user scrolls through sections.
    const onScroll = () => {
        const scroll = scrollRef.current;
        if (!scroll || query.trim()) return;
        const top = scroll.scrollTop;
        let current: EmojiCategory = sections[0]?.key || "smileys";
        for (const sec of sections) {
            const node = sectionRefs.current[sec.key];
            if (node && node.offsetTop - 12 <= top) current = sec.key;
        }
        setActiveCat(current);
    };

    const jumpToCategory = (cat: EmojiCategory) => {
        const node = sectionRefs.current[cat];
        const scroll = scrollRef.current;
        if (node && scroll) {
            scroll.scrollTo({ top: node.offsetTop - 4, behavior: "smooth" });
            setActiveCat(cat);
        }
    };

    useEffect(() => {
        if (mode === "emoji" || !TENOR_API_KEY) return;
        const ctl = new AbortController();
        const q = query.trim();
        const endpoint = q.length
            ? "search"
            : "featured";
        const searchParams = new URLSearchParams({
            key: TENOR_API_KEY,
            client_key: TENOR_CLIENT_KEY,
            limit: "30",
            media_filter: "tinygif,gif",
            contentfilter: "medium",
            locale: "en_US",
            ...(q.length ? { q } : {}),
            ...(mode === "sticker" ? { searchfilter: "sticker,-static" } : {}),
        });
        setTenorLoading(true);
        fetch(`https://tenor.googleapis.com/v2/${endpoint}?${searchParams.toString()}`, {
            signal: ctl.signal,
        })
            .then((r) => r.json())
            .then((data) => {
                const items = Array.isArray(data?.results) ? data.results : [];
                const normalized: TenorItem[] = items
                    .map((it: any) => {
                        const tiny = it?.media_formats?.tinygif?.url;
                        const full = it?.media_formats?.gif?.url || tiny;
                        if (!tiny || !full || !it?.id) return null;
                        return { id: String(it.id), previewUrl: tiny, mediaUrl: full };
                    })
                    .filter(Boolean);
                setTenorItems(normalized);
            })
            .catch(() => setTenorItems([]))
            .finally(() => setTenorLoading(false));
        return () => ctl.abort();
    }, [mode, query]);

    const selectTenorItem = async (item: TenorItem) => {
        if (!onSelectMediaFile) return;
        try {
            const res = await fetch(item.mediaUrl);
            const blob = await res.blob();
            const ext = blob.type.includes("webp") ? "webp" : "gif";
            const file = new File([blob], `${mode}-${Date.now()}.${ext}`, {
                type: blob.type || (ext === "webp" ? "image/webp" : "image/gif"),
            });
            onSelectMediaFile(file);
            onClose();
        } catch {
            // ignore network conversion errors
        }
    };

    return (
        <div ref={ref} className={s.picker} style={style}>
            <div className={s.modeTabs}>
                <button
                    type="button"
                    className={`${s.modeTab} ${mode === "emoji" ? s.modeTabActive : ""}`}
                    onClick={() => setMode("emoji")}
                >
                    Emoji
                </button>
                <button
                    type="button"
                    className={`${s.modeTab} ${mode === "gif" ? s.modeTabActive : ""}`}
                    onClick={() => setMode("gif")}
                >
                    GIF
                </button>
                <button
                    type="button"
                    className={`${s.modeTab} ${mode === "sticker" ? s.modeTabActive : ""}`}
                    onClick={() => setMode("sticker")}
                >
                    Sticker
                </button>
            </div>
            <div className={s.topRow}>
                <input
                    className={s.search}
                    placeholder={
                        mode === "emoji"
                            ? "Search emoji..."
                            : mode === "gif"
                              ? "Search GIFs..."
                              : "Search stickers..."
                    }
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus={!isTouch}
                />
                {mode === "emoji" ? (
                    <>
                        <button
                            type="button"
                            className={s.toneBtn}
                            title="Default skin tone"
                            onClick={() => setToneOpen((v) => !v)}
                        >
                            {SKIN_TONES[tone].swatch}
                        </button>
                        {toneOpen && (
                            <div className={s.tonePopup}>
                                {SKIN_TONES.map((t) => (
                                    <button
                                        key={t.key}
                                        type="button"
                                        className={`${s.toneSwatch} ${t.key === tone ? s.toneSwatchActive : ""}`}
                                        title={t.label}
                                        onClick={() => handleToneSelect(t.key)}
                                    >
                                        {t.swatch}
                                    </button>
                                ))}
                            </div>
                        )}
                    </>
                ) : null}
            </div>
            {mode === "emoji" && onSelectMediaFile && (
                <div className={s.mediaRow}>
                    <button
                        type="button"
                        className={s.mediaBtn}
                        onClick={() => gifInputRef.current?.click()}
                    >
                        Local GIF
                    </button>
                    <button
                        type="button"
                        className={s.mediaBtn}
                        onClick={() => stickerInputRef.current?.click()}
                    >
                        Local Sticker
                    </button>
                    <input
                        ref={gifInputRef}
                        type="file"
                        accept="image/gif"
                        className={s.fileInput}
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                                onSelectMediaFile(file);
                                onClose();
                            }
                            e.target.value = "";
                        }}
                    />
                    <input
                        ref={stickerInputRef}
                        type="file"
                        accept="image/webp,image/png,image/jpeg"
                        className={s.fileInput}
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                                onSelectMediaFile(file);
                                onClose();
                            }
                            e.target.value = "";
                        }}
                    />
                </div>
            )}

            {mode === "emoji" && !query.trim() && (
                <div className={s.catTabs}>
                    {sections.map((c) => (
                        <button
                            key={c.key}
                            type="button"
                            className={`${s.catTab} ${activeCat === c.key ? s.activeCat : ""}`}
                            title={c.label}
                            onClick={() => jumpToCategory(c.key)}
                        >
                            {c.icon}
                        </button>
                    ))}
                </div>
            )}

            {mode !== "emoji" ? (
                !TENOR_API_KEY ? (
                    <div className={s.noResults}>
                        <span>Set VITE_TENOR_API_KEY to enable GIF/Sticker search.</span>
                    </div>
                ) : tenorLoading ? (
                    <div className={s.noResults}>
                        <span>Loading...</span>
                    </div>
                ) : tenorItems.length === 0 ? (
                    <div className={s.noResults}>
                        <span className={s.noResultsEmoji}>🔎</span>
                        <span>No {mode === "gif" ? "GIFs" : "stickers"} found</span>
                    </div>
                ) : (
                    <div className={s.scroll}>
                        <div className={s.tenorGrid}>
                            {tenorItems.map((item) => (
                                <button
                                    key={item.id}
                                    type="button"
                                    className={s.tenorItem}
                                    onClick={() => selectTenorItem(item)}
                                >
                                    <img src={item.previewUrl} alt="" className={s.tenorImg} loading="lazy" />
                                </button>
                            ))}
                        </div>
                    </div>
                )
            ) : query.trim() ? (
                results.length === 0 ? (
                    <div className={s.noResults}>
                        <span className={s.noResultsEmoji}>🔍</span>
                        <span>No emoji found for &ldquo;{query}&rdquo;</span>
                    </div>
                ) : (
                    <div className={s.scroll}>
                        <div className={s.section}>
                            <div className={s.catLabel}>Search Results</div>
                            <div className={s.emojiGrid}>
                                {results.map((e) => (
                                    <EmojiCell
                                        key={e.id}
                                        emoji={e}
                                        tone={tone}
                                        onSelect={handleSelect}
                                        onContext={handleEmojiContext}
                                    />
                                ))}
                            </div>
                        </div>
                    </div>
                )
            ) : (
                <div className={s.scroll} ref={scrollRef} onScroll={onScroll}>
                    {sections.map((c) => {
                        const list = c.key === "recent" ? recents : emojiByCategory(c.key);
                        if (!list.length) return null;
                        return (
                            <div
                                key={c.key}
                                className={s.section}
                                ref={(n) => {
                                    sectionRefs.current[c.key] = n;
                                }}
                            >
                                <div className={s.catLabel}>{c.label}</div>
                                <div className={s.emojiGrid}>
                                    {list.map((e) => (
                                        <EmojiCell
                                            key={`${c.key}-${e.id}`}
                                            emoji={e}
                                            tone={tone}
                                            onSelect={handleSelect}
                                            onContext={handleEmojiContext}
                                        />
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Per-emoji skin-tone popup (right-click / long-press) */}
            {emojiTone && (
                <div
                    className={s.emojiTonePopup}
                    style={{ left: emojiTone.x, top: emojiTone.y }}
                    onMouseLeave={() => setEmojiTone(null)}
                >
                    {[0, 1, 2, 3, 4, 5].map((t) => {
                        const variant = variantForTone(emojiTone.emoji, t);
                        return (
                            <button
                                key={t}
                                type="button"
                                className={s.toneSwatch}
                                title={SKIN_TONES[t].label}
                                onClick={() => {
                                    recordRecent(emojiTone.emoji.id);
                                    setRecents(getRecentEmoji());
                                    onSelectEmoji(variant.native);
                                    setEmojiTone(null);
                                    onClose();
                                }}
                            >
                                <EmojiImage variant={variant} size={22} />
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function EmojiCell({
    emoji,
    tone,
    onSelect,
    onContext,
}: {
    emoji: Emoji;
    tone: number;
    onSelect: (e: Emoji) => void;
    onContext: (ev: React.MouseEvent, e: Emoji) => void;
}) {
    const variant = variantForTone(emoji, tone);
    return (
        <button
            type="button"
            className={`${s.emojiBtn} ${emoji.skins?.length ? s.hasSkins : ""}`}
            title={emoji.name}
            onClick={() => onSelect(emoji)}
            onContextMenu={(ev) => onContext(ev, emoji)}
        >
            <EmojiImage variant={variant} size={24} title={emoji.name} />
        </button>
    );
}