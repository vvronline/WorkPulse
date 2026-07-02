import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { socket } from "./socket";
import { useAuth } from "../auth/AuthContext";
import { beginCallNavigation, endCallNavigation } from "./callRouting";
import { clearPersistedPendingCall } from "./pendingCall";
import { notifeeService } from "../services/notifeeService";
import { nativeCallService } from "../services/nativeCallService";
import { warmIceConfig } from "../features";

/**
 * App-wide listener for inbound calls. When a `call_incoming` frame arrives it
 * navigates to the full-screen call UI in "incoming" mode so the user can
 * accept/reject — regardless of which screen they're currently on. Mirrors the
 * web CallContext's global incoming-call PiP behaviour.
 */
export default function IncomingCallListener() {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const ringingRef = useRef<number | null>(null);

  useEffect(() => {
    if (!user) return;
    const off = socket.subscribe((msg) => {
      const d = msg.data || {};
      if (msg.type === "call_incoming") {
        // Avoid double-navigating if we're already showing this call.
        if (ringingRef.current === d.callId) return;
        if (pathname?.startsWith("/call/")) return;

        // Group CALL (huddle): a `meetingCode` means the callee joins the n-way
        // meeting mesh, NOT the 1:1 p2p call screen. When the app is active we
        // navigate straight to the meeting room (Signal-style "join group
        // call"); when backgrounded the FCM→Notifee full-screen-intent owns the
        // surface and its tap deep-links into the meeting. We ring/warm here.
        if (d.meetingCode) {
          if (AppState.currentState !== "active") {
            void warmIceConfig();
            return;
          }
          if (pathname?.startsWith(`/meeting/${d.meetingCode}`)) return;
          ringingRef.current = d.callId;
          // Huddle auto-join (no meeting lobby) + audio-only for a voice call.
          const ct = d.callType === "video" ? "video" : "voice";
          router.push(
            `/meeting/${d.meetingCode}?huddle=1&callType=${ct}` as never,
          );
          return;
        }

        // SIGNAL-ANDROID MODEL — the full-screen-intent CallStyle notification
        // is the SINGLE authoritative incoming-call surface whenever the app is
        // NOT visibly foregrounded. If we ALSO `router.push` the call screen
        // here while the app is backgrounded/locked, the screen mounts
        // INVISIBLY in the background: its in-app ringtone plays (the "sound")
        // but the user sees NO actionable status-bar/lock-screen notification
        // and has to open the app to find the call — the exact "sound but no
        // notification" bug. So when the app is not active we do not navigate;
        // the Notifee/native CallRinger full-screen-intent CallStyle
        // notification owns the surface. Its Answer / body-tap deep link opens
        // this same call screen on demand. We also warm the ICE config so
        // Cloudflare TURN creds are ready BEFORE the user answers
        // (deterministic first-connection).
        //
        // WS RING FALLBACK (Signal parity — "the socket is the source of
        // truth; push is only a wake-up"): previously this path did NOTHING
        // when backgrounded and trusted the FCM push to surface the call. If
        // push delivery failed (dev build without FCM, registration failure,
        // notification permission revoked, Doze delays), the receiver NEVER
        // rang even though the `call_incoming` WS frame was sitting right
        // here. Now we post the same full-screen-intent ringing notification
        // from the WS path too. This is safe against double-ring: the
        // notification id is derived from callId+conversationId (a later FCM
        // push REPLACES it rather than stacking), and cancelled-call
        // tombstones still suppress dead calls.
        const appActive = AppState.currentState === "active";
        if (!appActive) {
          void warmIceConfig();
          void notifeeService.displayIncomingCall({
            type: "call_incoming",
            callId: String(d.callId),
            conversationId: String(d.conversationId),
            callerId: d.callerId != null ? String(d.callerId) : undefined,
            callerName: d.callerName || undefined,
            callerAvatar: d.callerAvatar || undefined,
            callType: d.callType === "video" ? "video" : "voice",
            isGroup: d.isGroup ? "1" : undefined,
          });
          return;
        }

        // Cross-path guard: the same call may also be surfaced via the push
        // notification path (PushNotificationListener / Notifee tap). Claim
        // navigation so only ONE path pushes the /call screen — a double push
        // crashes React Native Fabric ("child already has a parent").
        if (!beginCallNavigation(d.callId, d.conversationId)) return;
        ringingRef.current = d.callId;
        router.push({
          pathname: "/call/[conversationId]",
          params: {
            conversationId: String(d.conversationId),
            mode: "incoming",
            callType: d.callType === "video" ? "video" : "voice",
            callId: String(d.callId),
            peerId: String(d.callerId),
            peerName: d.callerName || "Incoming call",
            peerAvatar: d.callerAvatar || "",
            isGroup: d.isGroup ? "1" : "0",
          },
        });
      } else if (
        msg.type === "call_ended" ||
        msg.type === "call_rejected" ||
        msg.type === "call_handled_elsewhere"
      ) {
        if (ringingRef.current === d.callId) ringingRef.current = null;
        endCallNavigation();
        // Tear down any ringing call notification AND drop the persisted route
        // so a later cold start never re-opens this now-dead call. cancelCall
        // also clears the persisted entry internally; the explicit clear covers
        // events that arrive without callId/conversationId.
        notifeeService.cancelCall(
          d.callId != null ? String(d.callId) : undefined,
          d.conversationId != null ? String(d.conversationId) : undefined,
        );
        // Also dismiss the native CallKeep incoming-call UI when call ends
        // (T048: ring TTL expiry or other call termination). Safe to call even if
        // native UI was never shown or already dismissed.
        if (d.callId != null && d.conversationId != null) {
          nativeCallService.dismissIncomingCall(d.callId, d.conversationId).catch(() => {});
        }
        clearPersistedPendingCall().catch(() => {});
      }
    });
    return off;
  }, [user, pathname, router]);

  return null;
}