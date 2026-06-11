import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Returns the number of pixels at the bottom of the screen currently covered
 * by the on-screen keyboard.
 *
 * On **web** (Expo web / mobile browser) React Native's `KeyboardAvoidingView`
 * is a no-op, so fixed bottom bars and bottom-anchored form fields end up
 * hidden underneath the virtual keyboard. We use the `visualViewport` API to
 * measure how much the layout viewport has shrunk and return that as an inset
 * the caller can apply (e.g. `paddingBottom` / `translateY`).
 *
 * On **native** we listen to the `Keyboard` events directly and return the
 * keyboard's height. This is required under Expo's edge-to-edge mode on
 * Android, where the window does NOT resize on keyboard show and
 * `KeyboardAvoidingView` (with `behavior=undefined`) is effectively a no-op,
 * leaving bottom-anchored composers hidden behind the keyboard. Callers can
 * apply the returned value as `paddingBottom` / `marginBottom` to lift the
 * composer above the keyboard.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  // ── Web: measure via visualViewport ──────────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      // Height hidden below the visual viewport = layout height - (viewport
      // height + how far it's been offset up). Clamp to >= 0.
      const covered = Math.max(
        0,
        window.innerHeight - vv.height - vv.offsetTop,
      );
      // Ignore tiny deltas (browser chrome jitter).
      setInset(covered > 80 ? covered : 0);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // ── Native (iOS/Android): measure via Keyboard events ─────────────────────
  useEffect(() => {
    if (Platform.OS === "web") return;

    // iOS reports the height ahead of the animation via `keyboardWillChangeFrame`;
    // Android only fires the `did*` events.
    const showEvt =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const onShow = (e: { endCoordinates?: { height?: number } }) => {
      setInset(e?.endCoordinates?.height ?? 0);
    };
    const onHide = () => setInset(0);

    const showSub = Keyboard.addListener(showEvt, onShow);
    const hideSub = Keyboard.addListener(hideEvt, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return inset;
}

/**
 * Ensures a just-focused input on web is scrolled into the visible region
 * above the keyboard. No-op on native. Call from a TextInput `onFocus`.
 */
export function scrollFocusedIntoView() {
  if (Platform.OS !== "web") return;
  if (typeof document === "undefined") return;
  // Defer to the next frame so the keyboard/viewport has resized first.
  setTimeout(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, 250);
}