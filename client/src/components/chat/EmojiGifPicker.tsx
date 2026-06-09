import React, { useState, useEffect, useRef, useMemo } from "react";
import s from "./EmojiGifPicker.module.css";

const RECENT_KEY = "wp_recent_emojis";
const MAX_RECENT = 24;

/* ─── Emoji name map for search ─── */
const EMOJI_NAMES: Record<string, string> = {
    "😀": "grinning", "😁": "beaming", "😂": "joy laugh", "🤣": "rofl rolling", "😃": "smiley", "😄": "smile", "😅": "sweat smile", "😆": "laughing", "😉": "wink", "😊": "blush", "😋": "yum", "😎": "sunglasses cool", "😍": "heart eyes", "🥰": "love", "😘": "kiss", "😗": "kissing", "😙": "kiss smile", "😚": "kiss closed", "🙂": "slight smile", "🤗": "hug", "🤩": "star struck", "🤔": "thinking", "🤨": "raised eyebrow", "😐": "neutral", "😑": "expressionless", "😶": "no mouth", "🙄": "eye roll", "😏": "smirk", "😣": "persevere", "😥": "disappointed relieved", "😮": "open mouth wow", "🤐": "zipper", "😯": "hushed", "😪": "sleepy", "😫": "tired", "😴": "sleeping zzz", "😌": "relieved", "😛": "tongue", "😜": "crazy tongue wink", "😝": "squinting tongue", "🤤": "drooling", "😒": "unamused", "😓": "cold sweat", "😔": "pensive", "😕": "confused", "🙃": "upside down", "🤑": "money", "😲": "astonished", "🤯": "mind blown exploding", "😬": "grimace", "🥵": "hot", "🥶": "cold freezing", "😱": "scream", "😨": "fearful", "😰": "anxious", "😢": "cry", "😭": "sobbing", "😤": "huff", "😠": "angry", "😡": "rage", "🤬": "swearing", "😈": "devil smiling", "👿": "devil angry", "💀": "skull dead", "☠️": "skull crossbones", "💩": "poop", "🤡": "clown", "👹": "ogre", "👺": "goblin", "👻": "ghost", "👽": "alien", "👾": "space invader", "🤖": "robot",
    "👋": "wave", "🤚": "raised back hand", "🖐️": "hand splayed", "✋": "raised hand stop", "🖖": "vulcan", "👌": "ok", "🤌": "pinched", "🤏": "pinching", "✌️": "peace victory", "🤞": "crossed fingers luck", "🤟": "love you", "🤘": "rock on", "🤙": "call me", "👈": "point left", "👉": "point right", "👆": "point up", "🖕": "middle finger", "👇": "point down", "☝️": "index up", "👍": "thumbs up like yes", "👎": "thumbs down dislike no", "✊": "fist", "👊": "fist bump", "🤛": "left fist", "🤜": "right fist", "👏": "clap", "🙌": "raising hands", "👐": "open hands", "🤲": "palms up", "🤝": "handshake", "🙏": "pray please thanks", "💪": "flex strong muscle", "🦾": "mechanical arm",
    "🖤": "black heart", "❤️": "red heart love", "🧡": "orange heart", "💛": "yellow heart", "💚": "green heart", "💙": "blue heart", "💜": "purple heart", "🤎": "brown heart", "🤍": "white heart", "💯": "hundred perfect", "💢": "anger", "💥": "boom collision", "💫": "dizzy", "💦": "sweat", "💨": "dash", "🕳️": "hole", "💣": "bomb", "💬": "speech bubble",
    "🎉": "party tada celebrate", "🎊": "confetti", "🎈": "balloon", "🎁": "gift present", "🏆": "trophy winner", "🥇": "gold medal first", "🥈": "silver medal second", "🥉": "bronze medal third", "⚽": "soccer", "🏀": "basketball", "🏈": "football", "⚾": "baseball", "🎾": "tennis", "🏐": "volleyball", "🎱": "billiards pool", "🏓": "ping pong", "🏸": "badminton", "⛳": "golf", "🏹": "archery", "🎣": "fishing", "🥊": "boxing", "🎯": "bullseye target", "🎮": "video game controller", "🕹️": "joystick", "🎲": "dice", "🧩": "puzzle", "♟️": "chess", "🎭": "theater drama", "🎨": "art palette", "🎼": "music", "🎹": "piano keyboard", "🥁": "drum", "🎷": "saxophone", "🎺": "trumpet", "🎸": "guitar", "🎻": "violin", "🎬": "clapperboard movie", "📷": "camera photo",
    "🍕": "pizza", "🍔": "hamburger burger", "🍟": "fries", "🌭": "hot dog", "🥪": "sandwich", "🌮": "taco", "🌯": "burrito", "🍳": "egg cooking", "🥘": "stew", "🍲": "pot food", "🥗": "salad", "🍿": "popcorn", "🍱": "bento", "🍣": "sushi", "🍤": "shrimp", "🦀": "crab", "🦞": "lobster", "🍦": "ice cream", "🍩": "donut", "🍪": "cookie", "🎂": "birthday cake", "🍰": "cake slice", "🧁": "cupcake", "🍫": "chocolate", "🍬": "candy", "🍭": "lollipop", "☕": "coffee", "🍵": "tea", "🥤": "cup straw", "🍺": "beer", "🍻": "cheers beers", "🥂": "champagne toast", "🍷": "wine",
    "🌍": "earth globe", "🏔️": "mountain snow", "🌋": "volcano", "🏖️": "beach", "🏜️": "desert", "🌅": "sunrise", "🌄": "sunrise mountains", "🌠": "shooting star", "🌈": "rainbow", "🐶": "dog", "🐱": "cat", "🐭": "mouse", "🐹": "hamster", "🐰": "rabbit bunny", "🦊": "fox", "🐻": "bear", "🐼": "panda", "🐨": "koala", "🐯": "tiger", "🦁": "lion", "🐮": "cow", "🐷": "pig", "🐸": "frog", "🐵": "monkey", "🐔": "chicken", "🐧": "penguin", "🐦": "bird", "🦅": "eagle", "🦉": "owl", "🐴": "horse", "🦄": "unicorn", "🐝": "bee", "🦋": "butterfly", "🌸": "cherry blossom", "🌹": "rose", "🌻": "sunflower", "🌷": "tulip", "🌲": "evergreen tree", "🌳": "tree", "🌵": "cactus", "☀️": "sun", "☁️": "cloud", "🌧️": "rain", "⛈️": "thunderstorm", "⭐": "star", "✨": "sparkles", "🔥": "fire flame hot", "💧": "water drop", "🌊": "wave ocean",
    "💼": "briefcase", "📁": "folder", "📄": "document page", "📋": "clipboard", "📊": "chart bar", "📈": "chart up trending", "📉": "chart down", "📌": "pin pushpin", "📎": "paperclip", "🔗": "link", "💻": "laptop computer", "🖥️": "desktop computer", "📱": "phone mobile", "📲": "phone arrow", "🔋": "battery", "💡": "light bulb idea", "📕": "book red", "📖": "book open", "📚": "books", "📝": "memo note", "✏️": "pencil", "🔍": "search magnify", "🔐": "lock key", "🔒": "locked", "🔓": "unlocked", "🔑": "key",
};

interface EmojiCategory {
    label: string;
    name: string;
    keywords: string;
    emojis: string[];
}

const EMOJI_CATEGORIES: EmojiCategory[] = [
    { label: "🕐", name: "Recent", keywords: "", emojis: [] },
    { label: "😀", name: "Smileys", keywords: "smile face happy laugh cry sad tears emotion mood", emojis: ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊", "😋", "😎", "😍", "🥰", "😘", "😗", "😙", "😚", "🙂", "🤗", "🤩", "🤔", "🤨", "😐", "😑", "😶", "🙄", "😏", "😣", "😥", "😮", "🤐", "😯", "😪", "😫", "😴", "😌", "😛", "😜", "😝", "🤤", "😒", "😓", "😔", "😕", "🙃", "🤑", "😲", "🤯", "😬", "🥵", "🥶", "😱", "😨", "😰", "😢", "😭", "😤", "😠", "😡", "🤬", "😈", "👿", "💀", "☠️", "💩", "🤡", "👹", "👺", "👻", "👽", "👾", "🤖"] },
    { label: "👋", name: "Gestures", keywords: "hand wave gesture thumb like dislike heart love ok clap prayer", emojis: ["👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "💪", "🦾", "🖤", "❤️", "🧡", "💛", "💚", "💙", "💜", "🤎", "🖤", "🤍", "💯", "💢", "💥", "💫", "💦", "💨", "🕳️", "💣", "💬"] },
    { label: "🎉", name: "Activities", keywords: "party celebrate sport trophy medal ball game music art film camera activity", emojis: ["🎉", "🎊", "🎈", "🎁", "🏆", "🥇", "🥈", "🥉", "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱", "🪀", "🏓", "🏸", "🥅", "⛳", "🪁", "🏹", "🎣", "🤿", "🥊", "🎯", "🎮", "🕹️", "🎲", "🧩", "♟️", "🎭", "🎨", "🎼", "🎹", "🥁", "🎷", "🎺", "🎸", "🪕", "🎻", "🎬", "📷"] },
    { label: "🍕", name: "Food", keywords: "eat drink food pizza burger coffee tea beer fruit meal snack dessert", emojis: ["🍕", "🍔", "🍟", "🌭", "🥪", "🌮", "🌯", "🥙", "🧆", "🥚", "🍳", "🥘", "🍲", "🥣", "🥗", "🍿", "🧈", "🧂", "🥫", "🍱", "🍘", "🍙", "🍚", "🍛", "🍜", "🍝", "🍠", "🍢", "🍣", "🍤", "🍥", "🥮", "🍡", "🥟", "🥠", "🥡", "🦀", "🦞", "🦐", "🦑", "🍦", "🍧", "🍨", "🍩", "🍪", "🎂", "🍰", "🧁", "🥧", "🍫", "🍬", "🍭", "☕", "🍵", "🥤", "🍺", "🍻", "🥂", "🍷"] },
    { label: "🌍", name: "Nature", keywords: "nature animal planet earth dog cat bird flower tree weather sun rain star fire water", emojis: ["🌍", "🌎", "🌏", "🌐", "🗺️", "🧭", "🏔️", "⛰️", "🌋", "🗻", "🏕️", "🏖️", "🏜️", "🏝️", "🏞️", "🌅", "🌄", "🌠", "🎇", "🎆", "🌇", "🌆", "🏙️", "🌃", "🌌", "🌉", "🌁", "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🦅", "🦆", "🦉", "🐺", "🐗", "🐴", "🦄", "🐝", "🐛", "🦋", "🐌", "🐞", "🐜", "🦟", "🌸", "🌹", "🌺", "🌻", "🌼", "🌷", "🌱", "🌲", "🌳", "🌴", "🌵", "☀️", "🌤️", "⛅", "🌥️", "☁️", "🌦️", "🌧️", "⛈️", "🌩️", "🌈", "⭐", "🌟", "💫", "✨", "🔥", "💧", "🌊"] },
    { label: "💼", name: "Objects", keywords: "work office tool book phone computer lock key file folder document money", emojis: ["💼", "📁", "📂", "📄", "📋", "📊", "📈", "📉", "📌", "📍", "📎", "🔗", "🖇️", "📐", "📏", "🗂️", "💻", "🖥️", "🖨️", "⌨️", "🖱️", "💾", "💿", "📀", "📱", "📲", "☎️", "📞", "📟", "📠", "🔋", "🔌", "💡", "🔦", "🕯️", "📔", "📕", "📖", "📗", "📘", "📙", "📚", "📓", "📒", "📝", "✏️", "🖊️", "🖋️", "✒️", "🔍", "🔎", "🔐", "🔒", "🔓", "🔑"] },
];

function getRecent(): string[] {
    try {
        return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, MAX_RECENT);
    } catch { return []; }
}

function addRecent(emoji: string) {
    try {
        const list = getRecent().filter(e => e !== emoji);
        list.unshift(emoji);
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    } catch { /* ignore */ }
}

interface EmojiGifPickerProps {
    onSelectEmoji: (emoji: string) => void;
    onClose: () => void;
    style?: React.CSSProperties;
}

export default function EmojiGifPicker({ onSelectEmoji, onClose, style }: EmojiGifPickerProps) {
    const [catIdx, setCatIdx] = useState(() => {
        const recent = getRecent();
        return recent.length > 0 ? 0 : 1; // Show Recent if available, else Smileys
    });
    const [emojiSearch, setEmojiSearch] = useState("");
    const [recentEmojis, setRecentEmojis] = useState<string[]>(getRecent);
    const ref = useRef<HTMLDivElement | null>(null);
    const gridRef = useRef<HTMLDivElement | null>(null);

    // Close on click outside
    useEffect(() => {
        const handler = (e: PointerEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", handler);
        return () => document.removeEventListener("pointerdown", handler);
    }, [onClose]);

    // Close on Escape
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [onClose]);

    // Build categories with recent emojis injected
    const categories = useMemo(() => {
        const cats = [...EMOJI_CATEGORIES];
        cats[0] = { ...cats[0], emojis: recentEmojis };
        return cats;
    }, [recentEmojis]);

    const filteredEmojis = useMemo(() => {
        if (!emojiSearch.trim()) return categories[catIdx].emojis;
        const q = emojiSearch.trim().toLowerCase();
        const results: string[] = [];
        const seen = new Set<string>();
        // Search by emoji name, category name, and keywords
        for (const cat of categories.slice(1)) { // skip Recent for search
            if (cat.name.toLowerCase().includes(q) || cat.keywords.toLowerCase().includes(q)) {
                for (const e of cat.emojis) {
                    if (!seen.has(e)) { seen.add(e); results.push(e); }
                }
            } else {
                for (const e of cat.emojis) {
                    const name = EMOJI_NAMES[e] || "";
                    if (name.includes(q) && !seen.has(e)) {
                        seen.add(e);
                        results.push(e);
                    }
                }
            }
        }
        return results;
    }, [emojiSearch, catIdx, categories]);

    const handleSelect = (emoji: string) => {
        addRecent(emoji);
        setRecentEmojis(getRecent());
        onSelectEmoji(emoji);
        onClose();
    };

    // Skip Recent tab if empty
    const visibleCategories = categories.filter((c, i) => i !== 0 || c.emojis.length > 0);

    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;

    return (
        <div className={s.picker} ref={ref} style={style}>
            <input
                className={s.search}
                placeholder="Search emoji..."
                value={emojiSearch}
                onChange={e => setEmojiSearch(e.target.value)}
                autoFocus={!isTouch}
            />
            {!emojiSearch && (
                <div className={s.catTabs}>
                    {visibleCategories.map((c) => {
                        const realIdx = categories.indexOf(c);
                        return (
                            <button
                                key={c.name}
                                className={`${s.catTab} ${realIdx === catIdx ? s.activeCat : ""}`}
                                onClick={() => { setCatIdx(realIdx); gridRef.current?.scrollTo(0, 0); }}
                                title={c.name}
                            >{c.label}</button>
                        );
                    })}
                </div>
            )}
            {emojiSearch && filteredEmojis.length === 0 ? (
                <div className={s.noResults}>
                    <span className={s.noResultsEmoji}>🔍</span>
                    <span>No emoji found for &ldquo;{emojiSearch}&rdquo;</span>
                </div>
            ) : (
                <div className={s.emojiGrid} ref={gridRef}>
                    {!emojiSearch && catIdx === 0 && recentEmojis.length > 0 && (
                        <div className={s.catLabel}>Recently Used</div>
                    )}
                    {!emojiSearch && catIdx !== 0 && (
                        <div className={s.catLabel}>{categories[catIdx].name}</div>
                    )}
                    {filteredEmojis.map((emoji, i) => (
                        <button
                            key={`${emoji}-${i}`}
                            className={s.emojiBtn}
                            onClick={() => handleSelect(emoji)}
                            title={EMOJI_NAMES[emoji] || ""}
                        >{emoji}</button>
                    ))}
                </div>
            )}
        </div>
    );
}