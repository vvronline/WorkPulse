import { useEffect, useRef } from "react";
import { useRouter, usePathname } from "expo-router";
import { socket } from "./socket";
import { useAuth } from "../auth/AuthContext";

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
          },
        });
      } else if (
        msg.type === "call_ended" ||
        msg.type === "call_rejected" ||
        msg.type === "call_handled_elsewhere"
      ) {
        if (ringingRef.current === d.callId) ringingRef.current = null;
      }
    });
    return off;
  }, [user, pathname, router]);

  return null;
}