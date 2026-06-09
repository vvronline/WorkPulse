import {
    createContext,
    useContext,
    useState,
    useRef,
    useCallback,
    useEffect,
    useMemo,
    type MutableRefObject,
    type Dispatch,
    type SetStateAction,
    type ReactNode,
} from "react";
// NOTE (status v2): client no longer broadcasts auto-status for meetings.
// The server side sets/clears per-session `in_meeting` activity on
// `meeting_join` / `meeting_leave` / `meeting_end` (see server/utils/ws.js).

interface MeetingSession {
    meetingId: string | number;
    code: string;
    meeting: Record<string, unknown> | unknown;
    initialMuted: boolean;
    initialVideoOff: boolean;
}

interface JoinMeetingArgs {
    meetingId: string | number;
    code: string;
    meeting: Record<string, unknown> | unknown;
    initialMuted?: boolean;
    initialVideoOff?: boolean;
}

interface MeetingContextValue {
    session: MeetingSession | null;
    ws: WebSocket | null;
    minimized: boolean;
    setMinimized: Dispatch<SetStateAction<boolean>>;
    joinedAt: number | null;
    joinMeeting: (args: JoinMeetingArgs) => void;
    leaveMeeting: () => void;
    setLocalStream: (stream: MediaStream | null) => void;
    localStreamRef: MutableRefObject<MediaStream | null>;
    wsRef: MutableRefObject<WebSocket | null>;
}

const MeetingCtx = createContext<MeetingContextValue | null>(null);

export function useMeeting() {
    return useContext(MeetingCtx);
}

/**
 * Global meeting provider — keeps an active meeting alive across page navigations.
 * The WebSocket, local media stream, peer connections, and state survive route changes.
 * When the user navigates away from the meeting room, a PiP overlay is shown.
 */
export function MeetingProvider({ children }: { children: ReactNode }) {
    // Active meeting session state
    const [session, setSession] = useState<MeetingSession | null>(null);
    // session shape: { meetingId, code, meeting, initialMuted, initialVideoOff }

    // Timestamp when the user joined the meeting — used for elapsed timer
    const [joinedAt, setJoinedAt] = useState<number | null>(null);

    // When true, the meeting room UI is hidden (display:none) and the PiP
    // floating widget takes over. The MeetingRoom component STAYS MOUNTED
    // so peer connections, participants Map, etc. survive minimize/maximize.
    const [minimized, setMinimized] = useState(false);

    const wsRef = useRef<WebSocket | null>(null);
    const [ws, setWs] = useState<WebSocket | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);

    const leaveMeetingRef = useRef<(() => void) | null>(null);

    const joinMeeting = useCallback(
        ({
            meetingId,
            code,
            meeting,
            initialMuted,
            initialVideoOff,
        }: JoinMeetingArgs) => {
            // If we already have a WS for this meeting, reuse it
            if (wsRef.current && wsRef.current.readyState <= 1) {
                setSession((prev) =>
                    prev?.meetingId === meetingId
                        ? prev
                        : {
                              meetingId,
                              code,
                              meeting,
                              initialMuted: initialMuted ?? false,
                              initialVideoOff: initialVideoOff ?? false,
                          },
                );
                return;
            }

            // Close stale WebSocket before creating a new one
            if (wsRef.current) {
                try {
                    wsRef.current.close();
                } catch {
                    /* ignore */
                }
                wsRef.current = null;
                setWs(null);
            }

            // Create WebSocket for this meeting session
            let wsUrl: string;
            if (import.meta.env.VITE_WS_URL) {
                wsUrl = import.meta.env.VITE_WS_URL;
            } else {
                const proto =
                    window.location.protocol === "https:" ? "wss" : "ws";
                const host = window.location.host;
                wsUrl = `${proto}://${host}/ws`;
            }

            let reconnectAttempts = 0;
            const maxReconnects = 5;

            const createWs = () => {
                const newWs = new WebSocket(wsUrl);
                wsRef.current = newWs;
                setWs(newWs);

                newWs.addEventListener("open", () => {
                    reconnectAttempts = 0;
                });

                newWs.addEventListener("error", () => {
                    console.warn("Meeting WebSocket connection error");
                });

                newWs.addEventListener("close", (e) => {
                    if (e.code === 4001 || e.code === 4029) return;
                    if (
                        reconnectAttempts < maxReconnects &&
                        wsRef.current === newWs
                    ) {
                        reconnectAttempts++;
                        const delay = Math.min(
                            1000 * Math.pow(2, reconnectAttempts - 1),
                            10000,
                        );
                        setTimeout(() => {
                            if (
                                wsRef.current === newWs ||
                                wsRef.current === null
                            ) {
                                createWs();
                            }
                        }, delay);
                    }
                });

                // Listen for meeting_ended while in PiP / away from room
                // NOTE: The actual meeting_ended handling (cleanup + navigation) is done
                // by useMeetingState inside MeetingRoom (which stays mounted via
                // GlobalMeetingRoom). We do NOT call leaveMeeting() here because that
                // would set session=null and unmount MeetingRoom before its navigate('/')
                // effect fires, leaving participants on a blank screen.
            };

            createWs();

            setJoinedAt(Date.now());
            setSession({
                meetingId,
                code,
                meeting,
                initialMuted: initialMuted ?? false,
                initialVideoOff: initialVideoOff ?? false,
            });
        },
        [],
    );

    const leaveMeeting = useCallback(() => {
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        setWs(null);
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
        }
        setSession(null);
        setJoinedAt(null);
        setMinimized(false);
    }, []);

    leaveMeetingRef.current = leaveMeeting;

    // Store ref to localStream so PiP can access it
    const setLocalStream = useCallback((stream: MediaStream | null) => {
        localStreamRef.current = stream;
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (wsRef.current) wsRef.current.close();
            if (localStreamRef.current)
                localStreamRef.current.getTracks().forEach((t) => t.stop());
        };
    }, []);

    const value = useMemo(
        () => ({
            session,
            ws,
            minimized,
            setMinimized,
            joinedAt,
            joinMeeting,
            leaveMeeting,
            setLocalStream,
            localStreamRef,
            wsRef,
        }),
        [
            session,
            ws,
            minimized,
            joinedAt,
            joinMeeting,
            leaveMeeting,
            setLocalStream,
        ],
    );

    return <MeetingCtx.Provider value={value}>{children}</MeetingCtx.Provider>;
}