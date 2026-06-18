import { useEffect, useRef } from "react";
import { useRouter, usePathname } from "expo-router";
import { socket } from "./socket";
import { useAuth } from "../auth/AuthContext";
import { beginCallNavigation, endCallNavigation } from "./callRouting";
import { clearPersistedPendingCall } from "./pendingCall";
import { notifeeService } from "../services/notifeeService";

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
        clearPersistedPendingCall().catch(() => {});
      }
    });
    return off;
  }, [user, pathname, router]);

  return null;
}