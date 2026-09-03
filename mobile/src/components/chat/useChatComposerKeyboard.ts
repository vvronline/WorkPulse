import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  InteractionManager,
  Keyboard,
  type TextInput,
} from "react-native";
import { hydrateEmojiStore } from "../../emoji/emojiStore";

type UseChatComposerKeyboardOptions = {
  setText: Dispatch<SetStateAction<string>>;
  kbInset: number;
  windowHeight: number;
};

/**
 * Owns the composer's keyboard surfaces: the system keyboard ↔ docked in-app
 * emoji keyboard transition, the measured keyboard height the emoji panel is
 * rendered at, and the TextInput handle the thread focuses after modal
 * dismissals. Behavior-preserving extraction from useChatThread.
 */
export default function useChatComposerKeyboard({
  setText,
  kbInset,
  windowHeight,
}: UseChatComposerKeyboardOptions) {
  // Docked in-app emoji keyboard (Signal-style). When open we hide the system
  // keyboard and show EmojiKeyboard at the last-measured keyboard height so the
  // message list doesn't jump.
  const [emojiKeyboardOpen, setEmojiKeyboardOpen] = useState(false);
  // TextInput handle so we can blur/focus when switching between the system
  // keyboard and the in-app emoji keyboard.
  const inputRef = useRef<TextInput>(null);
  const emojiKeyboardOpenRef = useRef(false);
  const emojiKeyboardFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // One-shot guard so the "system keyboard appeared → close emoji" safety
  // effect below ignores the STALE keyboard height reported while the OS
  // keyboard is still animating away after we deliberately switched to the
  // in-app emoji keyboard. Without it, tapping the emoji toggle WHILE typing
  // immediately re-closed the emoji panel (the dismiss is async, so kbInset
  // was still > 100 on the render that opened it). Re-armed once the system
  // keyboard is genuinely hidden (kbInset back to 0). Mirrors Signal-Android's
  // transition-based InputAwareLayout (it tracks the keyboard transition, not a
  // momentary height value).
  const ignoreKbForEmoji = useRef(false);
  // True while the emoji keyboard's search field has focus so the system
  // keyboard is intentionally visible — suppresses the safety effect that
  // auto-closes the emoji panel when kbInset rises.
  const emojiSearchFocused = useRef(false);
  // Last-measured system keyboard height — the in-app emoji keyboard is shown
  // at this height so toggling between them doesn't shift the message list.
  // Seeded from ~40 % of the screen height (a reliable cross-device estimate)
  // so the panel is correctly sized even before the system keyboard has ever
  // appeared this session.
  const lastKbHeight = useRef(Math.round(windowHeight * 0.4));
  if (kbInset > 100) lastKbHeight.current = kbInset;

  useEffect(() => {
    emojiKeyboardOpenRef.current = emojiKeyboardOpen;
  }, [emojiKeyboardOpen]);

  useEffect(
    () => () => {
      if (emojiKeyboardFocusTimer.current) {
        clearTimeout(emojiKeyboardFocusTimer.current);
      }
    },
    [],
  );

  // Hydrate emoji recents + skin-tone preference once — but DEFER it past the
  // open transition. It's only needed when the emoji panel/picker is first
  // opened, so running it eagerly on mount just added JS-thread work competing
  // with the screen's slide-in animation (part of the laggy open). Running it
  // after interactions keeps the open snappy without any user-visible delay.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      hydrateEmojiStore();
    });
    return () => task.cancel();
  }, []);

  // If the system keyboard GENUINELY appears (user tapped the field), close the
  // in-app emoji keyboard so the two never stack. We must ignore the STALE
  // keyboard height reported while the OS keyboard is still animating away
  // right after we deliberately switched to the emoji keyboard — otherwise
  // tapping the emoji toggle WHILE typing instantly re-closed the panel that
  // had just opened (the dismiss is async, so kbInset was momentarily still
  // > 100 on the render that set emojiKeyboardOpen=true). Once the keyboard is
  // fully hidden (kbInset back to 0) we re-arm the guard so a real later
  // keyboard appearance still closes the emoji panel.
  useEffect(() => {
    if (kbInset > 100) {
      if (ignoreKbForEmoji.current) return; // stale height from the dismissing keyboard
      // Emoji search field is focused → system keyboard is intentional; keep
      // the emoji panel open so the user can see search results above the keyboard.
      if (emojiSearchFocused.current) return;
      if (emojiKeyboardOpen) setEmojiKeyboardOpen(false);
    } else {
      ignoreKbForEmoji.current = false; // keyboard fully hidden → re-arm
      emojiSearchFocused.current = false;
    }
  }, [kbInset, emojiKeyboardOpen]);

  // ── Inline emoji keyboard (Signal-style composer toggle) ──────────────────
  // Toggle between the system keyboard and the docked in-app emoji keyboard.
  function toggleEmojiKeyboard() {
    if (emojiKeyboardFocusTimer.current) {
      clearTimeout(emojiKeyboardFocusTimer.current);
      emojiKeyboardFocusTimer.current = null;
    }
    if (emojiKeyboardOpen) {
      // Emoji → system keyboard. This transition fights TWO Android quirks at
      // once, so it needs BOTH a blur AND a long-enough delayed focus:
      //
      //  1. No-op focus: the native EditText KEEPS its focus after a
      //     `Keyboard.dismiss()` (which is how the emoji panel was opened). On
      //     Android, calling `.focus()` on an already-focused field does NOT
      //     re-raise the soft keyboard — it's a no-op. So we must `blur()`
      //     first to force a real focus *change* on the later focus() call.
      //     (No keyboard is visible here — the emoji panel is — so the blur
      //     can't "collapse" anything.)
      //
      //  2. Prop-commit race: closing the panel flips the TextInput's
      //     `showSoftInputOnFocus` false → true, and Android can still see the
      //     stale native prop for a frame or two. If focus() fires too early the
      //     keyboard is suppressed and the transition feels "stuck". Keeping the
      //     emoji panel mounted removes the heavy unmount cost, so a short delay
      //     is now enough — and we cancel it on rapid re-taps so old focus
      //     requests cannot fight a newer emoji transition.
      //
      // Mirrors Signal-Android's InputAwareLayout, which requests the soft
      // input on its edit text only after the emoji page has been torn down,
      // treating keyboard↔emoji as an explicit transition.
      emojiSearchFocused.current = false;
      setEmojiKeyboardOpen(false);
      inputRef.current?.blur();
      emojiKeyboardFocusTimer.current = setTimeout(() => {
        emojiKeyboardFocusTimer.current = null;
        if (!emojiKeyboardOpenRef.current) inputRef.current?.focus();
      }, 90);
    } else {
      // System → emoji: dismiss the OS keyboard, then dock the emoji keyboard.
      // Arm the guard FIRST so the safety effect ignores the system keyboard's
      // still-animating (stale) height — otherwise the emoji panel we open on
      // the next line would be instantly closed again (the dismiss is async).
      ignoreKbForEmoji.current = true;
      emojiSearchFocused.current = false;
      // BLUR the field before dismissing. With the input still focused, RN
      // re-evaluates showSoftInputOnFocus and on Android re-shows the system
      // keyboard mid-transition — collapsing the docked panel and forcing the
      // user to tap the toggle/field again. Blurring first commits the keyboard
      // dismissal so the emoji panel mounts cleanly (Signal blurs before its
      // InputAwareLayout swaps to the emoji page).
      inputRef.current?.blur();
      Keyboard.dismiss();
      setEmojiKeyboardOpen(true);
    }
  }

  // Called from the docked emoji keyboard — insert at the end of the draft.
  function insertEmoji(native: string) {
    setText((t) => t + native);
  }

  // Backspace key on the docked emoji keyboard (mobile keyboard mode).
  function emojiBackspace() {
    setText((t) => Array.from(t).slice(0, -1).join(""));
  }

  // When the field gains focus via a tap, ensure the emoji keyboard is closed.
  function onComposerInputFocus() {
    if (emojiKeyboardOpen) setEmojiKeyboardOpen(false);
  }

  function onEmojiSearchFocus() {
    emojiSearchFocused.current = true;
  }

  function onEmojiSearchBlur() {
    emojiSearchFocused.current = false;
  }

  return {
    inputRef,
    emojiKeyboardOpen,
    emojiKeyboardHeight: lastKbHeight.current,
    toggleEmojiKeyboard,
    insertEmoji,
    emojiBackspace,
    onComposerInputFocus,
    onEmojiSearchFocus,
    onEmojiSearchBlur,
  };
}
