/**
 * Wires React Query's `onlineManager` and `focusManager` to React Native.
 *
 * React Query ships with BROWSER defaults: `onlineManager` listens for
 * `window.addEventListener("online")` and `focusManager` for
 * `visibilitychange`. Neither event exists in React Native, so out of the box:
 *
 *   • `onlineManager` reports "always online" — retries and refetches fire
 *     into a dead radio, burning battery and surfacing timeout errors instead
 *     of a clean offline state. Paused-on-offline mutations never pause.
 *   • `focusManager` never fires — `refetchOnWindowFocus` (on by default) is
 *     effectively DEAD, so returning from background shows stale data until
 *     something else triggers a refetch.
 *
 * `@react-native-community/netinfo` is already a dependency (it was only used
 * by the meeting mesh); this wires it into the query layer so the whole app
 * becomes network-aware. Call `installRNQueryBridge()` ONCE at startup.
 *
 * Docs: https://tanstack.com/query/latest/docs/framework/react/react-native
 */
import { AppState, type AppStateStatus } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { focusManager, onlineManager } from "@tanstack/query-core";

let installed = false;

/**
 * Install the RN online/focus bridges. Idempotent — safe to call from a
 * component effect that may re-run (e.g. Fast Refresh).
 *
 * Returns a teardown function that removes both subscriptions.
 */
export function installRNQueryBridge(): () => void {
  if (installed) return () => {};
  installed = true;

  // ── Online state ────────────────────────────────────────────────────────
  // `isInternetReachable` is tri-state: true / false / null (still probing).
  // Treat null as ONLINE: NetInfo reports null before its first reachability
  // probe completes, and defaulting to offline there would wrongly pause every
  // query during the first moments of a cold start.
  //
  // `onlineManager.setEventListener` returns void — it stores the subscriber
  // internally and calls the cleanup itself. We therefore capture NetInfo's
  // own unsubscribe separately so teardown can release it.
  let unsubscribeNetInfo: (() => void) | null = null;
  onlineManager.setEventListener((setOnline) => {
    unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      const reachable = state.isInternetReachable ?? state.isConnected ?? true;
      setOnline(Boolean(state.isConnected) && Boolean(reachable));
    });
    return unsubscribeNetInfo;
  });

  // ── Focus state ─────────────────────────────────────────────────────────
  // Only "active" counts as focused. "inactive" (iOS app switcher / incoming
  // call sheet) is deliberately NOT focused, so we don't kick off refetches
  // for a UI the user cannot see.
  const onAppStateChange = (status: AppStateStatus) => {
    focusManager.setFocused(status === "active");
  };
  const appStateSub = AppState.addEventListener("change", onAppStateChange);

  return () => {
    installed = false;
    try {
      const off: (() => void) | null = unsubscribeNetInfo;
      off?.();
    } catch {
      /* best-effort */
    }
    appStateSub.remove();
  };
}
