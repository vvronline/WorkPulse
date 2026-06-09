import React from "react";
import { useLocation } from "react-router-dom";
import { useMeeting } from "../../MeetingContext";
import MeetingRoom from "../../pages/MeetingRoom";

/**
 * Global wrapper that keeps a single <MeetingRoom /> instance mounted at the
 * app root for the entire lifetime of an active meeting session. By living
 * outside the <Routes> tree it survives route changes (e.g. when the user
 * clicks Minimize and navigates back to "/"), which means peer connections,
 * the participants Map, attached <video> elements, and the WebSocket all
 * stay intact. The PiP widget then handles the "minimized" UI while this
 * component is hidden via CSS.
 *
 * Visibility rules:
 *   - No active session       → render nothing.
 *   - URL matches /meeting/:code/room → show the room full-screen.
 *   - Any other URL           → keep MeetingRoom mounted but hidden
 *                               (display:none) so MeetingPiP can take over.
 */
export default function GlobalMeetingRoom() {
    const { session } = useMeeting() as any;
    const { pathname } = useLocation();

    if (!session) return null;

    const inRoom = /^\/meeting\/[^/]+\/room/.test(pathname);

    return (
        <div style={{ display: inRoom ? "block" : "none" }}>
            <MeetingRoom />
        </div>
    );
}