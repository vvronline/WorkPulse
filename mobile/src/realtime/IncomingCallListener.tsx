import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { socket } from "./socket";
import { useAuth } from "../auth/AuthContext";
import {
  beginCallNavigation,
  endCallNavigation,
  isCallActive,
} from "./callRouting";
import { claim, releaseIfClaimed } from "../calls/shared/claims";
import { classifyIncomingCall } from "../calls/shared/classifier";
import {
  GROUP_RING_PATHNAME,
  groupRingParams,
} from "../calls/group/navigation";
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

        // SINGLE-SOURCE classification (src/calls/shared/classifier): the
        // discriminated union decides p2p vs group ONCE, so this listener can
        // never route a group event into the 1:1 flow (or vice versa).
        const event = classifyIncomingCall(d);
        if (!event) return;

        // Group CALL (huddle): a `meetingCode` means the callee joins the n-way
        // meeting mesh, NOT the 1:1 p2p call screen.
        //
        // FOREGROUND: show the full-screen INCOMING GROUP-CALL ring screen
        // (Accept / Decline) — previously this auto-navigated straight into
        // the meeting room ("Joining…") with no chance to accept or decline.
        //
        // BACKGROUND: post the same full-screen-intent ringing notification
        // from the WS path too (Signal parity — "the socket is the source of
        // truth; push is only a wake-up"). Previously the group path relied
        // 100% on the FCM push: if push delivery failed (dev build without
        // FCM, permission revoked, Doze delay) the phone NEVER rang. The
        // notification id is derived from callId+conversationId so a later
        // FCM push REPLACES it rather than stacking, and cancelled-call
        // tombstones still suppress dead calls.
        if (event.kind === "group") {
          if (AppState.currentState !== "active") {
            void warmIceConfig();
            void notifeeService.displayIncomingCall({
              type: "call_incoming",
              callId: event.callId,
              conversationId: event.conversationId,
              callerId: d.callerId != null ? String(d.callerId) : undefined,
              callerName: event.callerName || undefined,
              callerAvatar: event.callerAvatar || undefined,
              callType: event.callType,
              isGroup: "1",
              groupName: event.groupName || undefined,
              meetingCode: event.meetingCode,
            });
            return;
          }
          if (pathname?.startsWith(`/meeting/${event.meetingCode}`)) return;
          if (pathname?.startsWith("/group-call/ring")) return;
          // GROUP calls claim the "groupRing" surface — SEPARATE from the 1:1
          // "p2p" slot, so a group ring can never block or clobber a live 1:1
          // call's navigation claim (the root of the earlier regressions).
          if (!claim("groupRing", event.callId, event.conversationId)) return;
          ringingRef.current = d.callId;
          void warmIceConfig();
          router.push({
            pathname: GROUP_RING_PATHNAME,
            params: groupRingParams(event),
          } as never);
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
            callId: event.callId,
            conversationId: event.conversationId,
            callerId: event.peerId || undefined,
            callerName: event.peerName || undefined,
            callerAvatar: event.peerAvatar || undefined,
            callType: event.callType,
            isGroup: event.isGroupConversation ? "1" : undefined,
          });
          return;
        }

        // Cross-path guard: the same call may also be surfaced via the push
        // notification path (PushNotificationListener / Notifee tap). Claim
        // navigation so only ONE path pushes the /call screen — a double push
        // crashes React Native Fabric ("child already has a parent").
        if (!beginCallNavigation(event.callId, event.conversationId)) return;
        ringingRef.current = d.callId;
        router.push({
          pathname: "/call/[conversationId]",
          params: {
            conversationId: event.conversationId,
            mode: "incoming",
            callType: event.callType,
            callId: event.callId,
            peerId: event.peerId,
            peerName: event.peerName,
            peerAvatar: event.peerAvatar,
            isGroup: event.isGroupConversation ? "1" : "0",
          },
        });
      } else if (
        msg.type === "call_ended" ||
        msg.type === "call_rejected" ||
        msg.type === "call_handled_elsewhere"
      ) {
        if (ringingRef.current === d.callId) ringingRef.current = null;
        // SCOPED teardown: only release the cross-path navigation claim when
        // this event refers to the SAME call that currently owns it. The
        // group-call overhaul made these events far more frequent (the server
        // echoes `call_handled_elsewhere` to the answerer's own devices on
        // every huddle join/decline) — an UNCONDITIONAL endCallNavigation()
        // here silently released the claim of a LIVE, unrelated 1:1 call.
        // With the claim gone: (a) the OngoingCallBanner ("Return to call")
        // re-appeared over the chat list while the call screen was still up,
        // and (b) a second navigation path could re-push the /call
        // fullScreenModal for the same call, double-mounting it and crashing
        // Fabric ("child already has a parent") — the "call UI disappears but
        // voice keeps going" symptom.
        if (
          d.callId != null &&
          d.conversationId != null &&
          isCallActive(d.callId, d.conversationId)
        ) {
          endCallNavigation();
        }
        // Also clear a matching GROUP ring claim (the ring screen's own
        // listener dismisses the UI; this covers a claim leaked before mount).
        releaseIfClaimed("groupRing", d.callId, d.conversationId);
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