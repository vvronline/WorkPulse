import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getMeeting } from "../api";
import { useMeeting } from "../MeetingContext";

/**
 * HuddleAutoJoin — instant group CALL entry point.
 *
 * A "huddle" is a group voice/video CALL that reuses the meeting mesh as its
 * transport but is decoupled from the user-visible "Meeting" concept (Slack
 * huddle / Teams call parity). Unlike `MeetingJoin` (the lobby pre-screen),
 * this component:
 *
 *   • Shows NO lobby / "Join now" pre-screen — the caller already chose to
 *     start the call and the callee already tapped Answer; making them click
 *     "Join" again is the bug we are fixing.
 *   • Reads the call modality (`settings.callType`) from the meeting and joins
 *     audio-only for a VOICE call (so a voice call never lights up the camera).
 *   • Immediately joins the mesh and redirects to the in-call room.
 *
 * Caller and callee both land here (caller via startGroupCall navigation,
 * callee via accepting the incoming-call ring), so the experience is identical
 * to a 1:1 call: tap → you're in the call, no meeting artifacts.
 */
export default function HuddleAutoJoin() {
    const { code } = useParams<{ code: string }>();
    const navigate = useNavigate();
    const { joinMeeting } = useMeeting() as any;
    const [error, setError] = useState("");
    const joinedRef = useRef(false);

    useEffect(() => {
        if (!code || joinedRef.current) return;
        let cancelled = false;

        (async () => {
            try {
                const { data: meeting } = await getMeeting(code);
                if (cancelled) return;

                // Determine the call modality. A voice huddle MUST NOT request
                // the camera, so we join with video off (avatar-tile UI).
                const callType =
                    (meeting?.settings && meeting.settings.callType) === "video"
                        ? "video"
                        : "voice";
                const initialVideoOff = callType !== "video";

                joinedRef.current = true;
                joinMeeting({
                    meetingId: meeting.id,
                    code,
                    meeting,
                    initialMuted: false,
                    initialVideoOff,
                });
                // Replace (not push) so the auto-join URL doesn't linger in
                // history — pressing Back should leave the call cleanly.
                navigate(`/meeting/${code}/room`, { replace: true });
            } catch {
                if (!cancelled)
                    setError(
                        "Couldn't join the call. It may have ended or you may not be invited.",
                    );
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [code, joinMeeting, navigate]);

    if (error) {
        return (
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100vh",
                    gap: 16,
                    color: "#374151",
                    background: "#0b0f17",
                }}
            >
                <p style={{ color: "#fca5a5", fontSize: 15 }}>{error}</p>
                <button
                    onClick={() => navigate("/chat")}
                    style={{
                        padding: "8px 18px",
                        borderRadius: 8,
                        border: "none",
                        background: "#2563eb",
                        color: "#fff",
                        cursor: "pointer",
                    }}
                >
                    Back to chat
                </button>
            </div>
        );
    }

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100vh",
                gap: 16,
                color: "#e5e7eb",
                background: "#0b0f17",
            }}
        >
            <div
                style={{
                    width: 38,
                    height: 38,
                    border: "3px solid rgba(255,255,255,0.2)",
                    borderTopColor: "#fff",
                    borderRadius: "50%",
                    animation: "huddle-spin 0.8s linear infinite",
                }}
            />
            <p style={{ fontSize: 14, opacity: 0.8 }}>Connecting to call…</p>
            <style>{`@keyframes huddle-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
}