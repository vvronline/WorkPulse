import { useEffect, useState } from "react";
import { Dimensions, Keyboard, Platform } from "react-native";

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
 *
 * On Android we do NOT trust `endCoordinates.height` alone: some OEM keyboards
 * (notably Samsung / One UI) under-report it — the value can exclude the
 * gesture-nav bar and/or the predictive-text toolbar that only appears once
 * you start typing. That left the composer sitting flush against (or behind)
 * the keyboard with no gap on those devices. Instead we derive the truly
 * occluded height from the keyboard's ABSOLUTE top (`endCoordinates.screenY`)
 * relative to the window height, which is robust to those differences, and we
 * also react to `keyboardDidChangeFrame` so the composer re-lifts when the
 * suggestion toolbar grows the keyboard mid-typing.
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

    const onShow = (e: {
      endCoordinates?: { height?: number; screenY?: number };
    }) => {
      const co = e?.endCoordinates;
      const height = co?.height ?? 0;
      // Android: prefer the geometric occlusion (window bottom → keyboard top)
      // derived from the keyboard's absolute `screenY`. On Samsung/One UI the
      // reported `height` under-reports the covered region (gesture-nav bar +
      // predictive-text toolbar), so the composer collided with the keyboard.
      // Take the larger of the two so we never lift LESS than the reported
      // height (a safety net if `screenY` is missing/odd on a given OEM).
      if (Platform.OS === "android" && typeof co?.screenY === "number") {
        const winH = Dimensions.get("window").height;
        const occluded = Math.max(0, winH - co.screenY);
        setInset(Math.max(height, occluded));
        return;
      }
      setInset(height);
    };
    const onHide = () => setInset(0);

    // iOS reports the height ahead of the animation via `keyboardWillShow`;
    // Android fires the `did*` events. `keyboardDidChangeFrame` (Android) lets
    // us follow the keyboard growing when the suggestion toolbar appears while
    // typing, so the composer re-lifts instead of ending up behind it.
    const subs =
      Platform.OS === "ios"
        ? [
            Keyboard.addListener("keyboardWillShow", onShow),
            Keyboard.addListener("keyboardWillChangeFrame", onShow),
            Keyboard.addListener("keyboardWillHide", onHide),
          ]
        : [
            Keyboard.addListener("keyboardDidShow", onShow),
            Keyboard.addListener("keyboardDidChangeFrame", onShow),
            Keyboard.addListener("keyboardDidHide", onHide),
          ];
    return () => {
      subs.forEach((s) => s.remove());
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