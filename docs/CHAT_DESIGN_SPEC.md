# WorkPulse Chat — Unified Signal-Style Design Spec

This is the **single source of truth** for the chat message input box, emoji
picker, keyboard/emoji switching, and message bubble format across all three
WorkPulse clients:

| Client      | Location            | Notes                                                            |
| ----------- | ------------------- | --------------------------------------------------------------- |
| **Web**     | `client/src`        | React + CSS Modules                                             |
| **Desktop** | `desktop/`          | Electron — loads `client/dist` over `workpulse://`. **= Web.**  |
| **Mobile**  | `mobile/src`        | Expo / React Native                                             |

Because the desktop app renders the bundled web client, **any change to the web
chat UI ships to desktop automatically**. There are only two codebases to keep
in sync: web (`client`) and mobile.

The design is modelled on
[Signal-Android](https://github.com/signalapp/Signal-Android): an inline
emoji/keyboard toggle inside the input field, an image-based (bundled) emoji
set with categories/search/recents/skin-tones, and grouped message bubbles with
a compact footer.

---

## 1. Bundled emoji assets

Signal renders emoji from its own bundled image set rather than relying on the
OS emoji font, so emoji look identical on every platform. We replicate this with
the open **`emoji-datasource-apple`** set (the standard freely-distributable
equivalent of Signal's proprietary art).

### Pipeline

```
scripts/generate-emoji.mjs
  ├─ reads node_modules/emoji-datasource-apple/emoji.json + img/apple/64/*.png
  ├─ writes client/src/emoji/emojiData.ts      (shared dataset, web copy)
  ├─ writes client/public/emoji/sprite.png     (web sprite sheet)
  ├─ writes client/public/emoji/sprite.css     (web sprite background positions)
  ├─ writes mobile/src/emoji/emojiData.ts      (shared dataset, mobile copy)
  └─ writes mobile/assets/emoji/*.png          (mobile per-emoji PNGs)
```

The dataset shape (identical on both platforms):

```ts
export interface EmojiVariant {
  unified: string;        // "1F44D-1F3FB"
  native: string;         // "👍🏻"
  sheetX: number;         // sprite column (web)
  sheetY: number;         // sprite row (web)
  image: string;          // png filename (mobile)
}

export interface Emoji {
  id: string;             // "thumbsup"
  name: string;           // "Thumbs Up Sign"
  native: string;         // "👍"
  keywords: string[];     // ["+1", "approve", "ok", "yes"]
  category: EmojiCategory;
  sortOrder: number;
  base: EmojiVariant;     // default (no skin tone)
  skins?: EmojiVariant[]; // 5 Fitzpatrick tones when supported
}

export type EmojiCategory =
  | "recent" | "smileys" | "people" | "nature" | "food"
  | "activity" | "travel" | "objects" | "symbols" | "flags";
```

### Rendering

- **Web/Desktop** — `<EmojiImage>` renders a `<span>` with the sprite as a CSS
  `background-image` and `background-position` from `sheetX/sheetY`. All assets
  are same-origin under `workpulse://`, satisfying the Electron CSP (no CDN).
- **Mobile** — `<EmojiImage>` renders an `<Image>` from the bundled PNG asset
  map. Packaged with the app; works fully offline.

If the generator has not run (assets missing), both renderers **fall back to the
native unicode glyph** so the UI never breaks.

---

## 2. Message input box (composer)

Signal layout, left → right, inside a single rounded "pill":

```
┌─────────────────────────────────────────────────────────┐
│ [😀/⌨]  Type a message…                      [＋] [🎤/➤] │
└─────────────────────────────────────────────────────────┘
```

| Element            | Behavior                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| **Emoji toggle**   | Inline, **left inside the pill**. Toggles between the system keyboard and the in-app emoji keyboard. Icon flips 😀 ⇄ ⌨. |
| **Text field**     | Multiline, grows up to ~6 lines then scrolls. Keeps focus + draft when the emoji keyboard opens. |
| **Plus (＋)**      | Opens the attachment/more menu (Photo, File, Voice, Poll).                                 |
| **Send / Mic**     | Mic when the field is empty; morphs to Send (➤) when there is text or while editing.       |

### Keyboard ⇄ emoji switch (the key Signal behavior)

- **Web/Desktop**: clicking the emoji toggle docks the `EmojiPicker` directly
  above the input (not a floating popover) and keeps the caret in the field, so
  inserted emoji land at the cursor. Clicking again hides the picker.
- **Mobile**: tapping the toggle **dismisses the system keyboard** and shows the
  in-app emoji keyboard pinned to the bottom at the **same height** as the
  system keyboard (measured once and remembered), so the message list does not
  jump. Tapping again re-opens the system keyboard. The draft and selection are
  preserved throughout.

---

## 3. Emoji picker / keyboard

Identical feature set on web and mobile. Modelled on Signal's
`EmojiKeyboardPageFragment` — ONE continuously-scrolling grid with sticky
section headers, **not** tab-replaced pages.

1. **Search bar** — filters by name + keywords (e.g. "joy", "ok", "fire").
   On mobile a trailing "✕" clears the query and returns to the sectioned grid.
2. **Single sectioned grid** — one scroll view (mobile: `SectionList` of
   8-column chunked rows) with sticky per-category headers: Recent · Smileys &
   Emotion · People & Body · Animals & Nature · Food & Drink · Activities ·
   Travel & Places · Objects · Symbols · Flags.
3. **Bottom category strip** — Signal-style, pinned at the bottom. The active
   icon tracks **scroll position** (`onViewableItemsChanged`); tapping an icon
   `scrollToLocation`s that section. The docked keyboard's strip also hosts the
   backspace key at its right edge.
4. **Recents** — most-recently + frequently used, persisted
   (web: `localStorage`, mobile: `expo-secure-store` / async store). Max 36.
   Rendered as the first section when non-empty.
5. **Skin-tone selector** — a tone swatch in the corner sets a global preferred
   Fitzpatrick tone applied to all tone-supporting emoji.
6. **Backspace** key (mobile keyboard mode only) to delete the last char.

The shared sectioning logic lives in `mobile/src/components/chat/emojiSections.ts`
(`buildEmojiSections`), reused by both `EmojiKeyboard` (docked composer panel)
and `EmojiPicker` (the reaction / compose sheet).

---

## 4. Message bubble format

```
            ┌───────────────────────────────┐
            │ Sender Name (groups/incoming)  │   ← only first in a group
            │ ┌── reply quote (if any) ──┐   │
            │ │ Original sender · snippet │   │
            │ └───────────────────────────┘   │
            │ Message text / media …          │
            │                 10:42  ✓✓        │   ← compact footer
            └───────────────────────────────┘
              😀 3   ❤️ 1                         ← reaction chips (below)
```

### Long-press reaction + context overlay

Modelled on Signal-Android's `ConversationReactionOverlay`. Long-pressing a
bubble:

- **Dims the whole screen** and **lifts the pressed bubble** out — a clone of
  the bubble is rendered at its measured window rect and scales/fades in above
  the scrim (`mobile/src/components/chat/ReactionOverlay.tsx`).
- Floats a rounded **reaction pill** just above the bubble with the six quick
  emoji (`👍 ❤️ 😂 😮 😢 🙏`, Signal's set) + a trailing **"+"** that opens the
  full sectioned emoji picker. The user's existing reaction is highlighted.
- Shows a **vertical context-action menu** below the bubble: Reply · Forward ·
  Copy (text messages) · Save · Pin · Edit (own) · Delete (own).
- The pill flips below / the menu clamps to the safe area when the bubble is
  near a screen edge. Tapping the scrim or any action dismisses the overlay.

On web/desktop the equivalent is the hover `MessageToolbar` (same quick-emoji
set) + the context menu.

### Grouping rules (all platforms)

- Consecutive messages from the **same sender within 5 minutes** form a *group*.
- Sender name (incoming / group chats) shows on the **first** message only.
- The bubble **tail** renders on the **last** message of the group only;
  in-group messages use fully-rounded corners and tighter vertical spacing
  (2px between, 8px between groups).
- Avatar (incoming, group chats) shows next to the **last** message only.

### Footer

- Inline bottom-right: `edited?` · `time` · delivery ticks (own messages).
- Pinned / starred markers sit before the time.

### Colors / radii (tokens)

| Token             | Own bubble        | Incoming bubble    |
| ----------------- | ----------------- | ------------------ |
| Background        | `chatOutBg`       | `chatInBg`         |
| Border            | `chatBubbleBorder`| `chatBubbleBorder` |
| Radius (grouped)  | 16px              | 16px               |
| Radius (tail corner) | 4px            | 4px                |

---

## 5. Improvements over the current implementation

Tracked checklist applied across this work:

- [x] Inline emoji/keyboard switch inside the input (web + mobile).
- [x] Bundled image emoji set (web sprite + mobile PNGs) with native fallback.
- [x] Emoji categories + search + recents on **mobile** (was a flat grid).
- [x] Skin-tone / variation selector (both platforms; new).
- [x] Frequently-used + recent persistence on mobile (SecureStore).
- [x] Consecutive-message grouping + compact footer (both platforms).
- [x] Long-press react → opens full emoji search (reaction bar → All Emoji).
- [ ] Jump-to-bottom / unread divider polish (follow-up).
- [~] Typing indicator on mobile already present; rich mentions input is a follow-up.

## 6. Running the emoji generator

To switch from the curated native-glyph fallback to the bundled image emoji
set (identical look on every platform):

```bash
# from the repo root
npm i -D emoji-datasource-apple
node scripts/generate-emoji.mjs
# then rebuild the web client (desktop inherits it) and the mobile app
```

The generator overwrites `client/src/emoji/generated.ts`,
`client/public/emoji/*`, `mobile/src/emoji/generated.ts`,
`mobile/src/emoji/assetMap.ts`, and `mobile/assets/emoji/*`. Until it runs, the
UI works with native unicode glyphs, so the feature degrades gracefully.
