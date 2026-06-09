import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "../../AuthContext";
import { getIceConfig, uploadChatFile, getMeetingMessages } from "../../api";
import {
    getCachedMessages,
    setCachedMessages,
    upsertCachedMessage,
    applyCachedMessages,
} from "./messagesCache";
import { retryWithBackoff } from "../../utils/retryWithBackoff";
import {
    STATES,
    nextState as fsmNext,
    describeState,
} from "./connectionStateMachine";
import type { MeetingState } from "./connectionStateMachine";
// ADR-008 — MeetingStore singleton. We mirror the highest-traffic state
// slices into the store on every change so future consumers can
// subscribe to one slice instead of importing the whole hook return.
// The hook's own `useState` values stay authoritative; the store is a
// read-only projection during this incremental migration window.
import { createMeetingStore, DEFAULT_MEETING_STATE } from "./meetingStore";
import type { AnyRecord } from "../../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Singleton store shared by every meeting view in the tab. We use a
 * module-scope instance (not a per-hook one) because the consumers we
 * want to migrate later — MeetingChat, ParticipantTile, MeetingBottomBar —
 * are siblings of the hook, not children, and React Context would mean
 * a render-cascade-back to the parent for every state change.
 */
export const meetingStore = createMeetingStore({ ...DEFAULT_MEETING_STATE });

type MeetingMessage = AnyRecord & {
    id?: number | string;
    clientMsgId?: string;
};

type Participant = AnyRecord & { userId: number | string };

/** Extended RTCPeerConnection with our custom bookkeeping props. */
type ExtendedPC = RTCPeerConnection & {
    _remoteStream?: MediaStream;
    _remoteScreenStream?: MediaStream;
    _screenTrackIds?: Set<string>;
    _reclassifyTracks?: () => void;
    _disconnectTimer?: ReturnType<typeof setTimeout> | null;
};

interface PendingSendEntry {
    payload: AnyRecord;
    firstSentAt: number;
    lastSentAt: number;
}

interface UseMeetingStateParams {
    meetingId: number | string;
    code?: string;
    ws: WebSocket | null;
    initialMuted?: boolean;
    initialVideoOff?: boolean;
    keepAliveOnUnmount?: boolean;
    existingStream?: MediaStream | null;
}

/**
 * Generate a stable, collision-resistant id for in-flight chat messages.
 */
function newClientMsgId(): string {
    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return crypto.randomUUID();
    }
    return `m_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}

/** How long an outgoing message can sit in the pending-send queue before we
 *  surface it as `_failed` in the UI. */
const PENDING_SEND_FAIL_AFTER_MS = 10_000;
/** Retry cadence for the pending-send queue when WS is OPEN. */
const PENDING_SEND_RETRY_EVERY_MS = 3_000;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    {
        urls: "turn:openrelay.metered.ca:443?transport=tcp",
        username: "openrelayproject",
        credential: "openrelayproject",
    },
];

function buildMeetingMediaProfiles(
    wantVideo: boolean,
): MediaStreamConstraints[] {
    const audio = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
    };
    if (!wantVideo) return [{ audio, video: false }];
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
        return [
            {
                audio,
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 24, max: 30 },
                },
            },
            { audio, video: true },
            { audio, video: false },
        ];
    }
    return [
        {
            audio,
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30, max: 30 },
            },
        },
        {
            audio,
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24, max: 30 },
            },
        },
        {
            audio,
            video: {
                width: { ideal: 320 },
                height: { ideal: 240 },
                frameRate: { ideal: 15, max: 24 },
            },
        },
        { audio, video: true },
        { audio, video: false },
    ];
}

async function acquireMeetingMedia(wantVideo: boolean): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("NoMediaDevices");
    const profiles = buildMeetingMediaProfiles(wantVideo);
    let lastError: unknown;
    for (let i = 0; i < profiles.length; i++) {
        try {
            const st = await navigator.mediaDevices.getUserMedia(profiles[i]);
            if (i > 0)
                console.warn(
                    "[meeting] media acquired with reduced profile #" + i,
                );
            return st;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

/**
 * Core meeting state hook — handles media, WebRTC mesh, signaling, and chat.
 * Optimized: no background effects, stable WS handler (no presenterId dep).
 */
export function useMeetingState({
    meetingId,
    code,
    ws,
    initialMuted = false,
    initialVideoOff = false,
    keepAliveOnUnmount = false,
    existingStream = null,
}: UseMeetingStateParams) {
    const { user } = useAuth();

    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
    const [muted, setMuted] = useState(initialMuted);
    const [videoOff, setVideoOff] = useState(initialVideoOff);
    const [screenSharing, setScreenSharing] = useState(false);
    const [participants, setParticipants] = useState<
        Map<number | string, Participant>
    >(new Map());
    const [presenterId, setPresenterId] = useState<number | string | null>(
        null,
    );
    // Phase 5 — Active speaker.
    const [activeSpeakerId, setActiveSpeakerId] = useState<
        number | string | null
    >(null);
    const audioLevelsRef = useRef<
        Map<number | string, { level: number; at: number }>
    >(new Map());
    const requestedQualityRef = useRef<Map<number | string, string>>(new Map());
    const lastRequestSentRef = useRef<Map<number | string, string>>(new Map());
    const [activePanel, setActivePanel] = useState<string | null>(null);
    const [messages, setMessages] = useState<MeetingMessage[]>(
        () => getCachedMessages(code || "") as MeetingMessage[],
    );
    const [status, setStatus] = useState("joining");
    const [fsmState, setFsmState] = useState<MeetingState>(STATES.IDLE);
    const fsmStateRef = useRef(fsmState);
    fsmStateRef.current = fsmState;
    const dispatchFsm = useCallback((event: string) => {
        const cur = fsmStateRef.current;
        const next = fsmNext(cur, event);
        if (next !== cur) {
            setFsmState(next);
            const legacy =
                next === STATES.RECONNECTING || next === STATES.DEGRADED
                    ? "connecting"
                    : next;
            setStatus(legacy);
        }
    }, []);
    const [raisedHand, setRaisedHand] = useState(false);
    const [connectionQualities, setConnectionQualities] = useState<
        Map<number | string, string>
    >(new Map());
    const [mediaReady, setMediaReady] = useState(!!existingStream);

    const localStreamRef = useRef<MediaStream | null>(null);
    const screenStreamRef = useRef<MediaStream | null>(null);
    const pcsRef = useRef<Map<number | string, ExtendedPC>>(new Map());
    const pendingSignals = useRef<Map<number | string, AnyRecord[]>>(new Map());
    const qualityTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const wsRef = useRef<WebSocket | null>(ws);
    wsRef.current = ws;
    const iceServersRef = useRef<RTCIceServer[]>(DEFAULT_ICE_SERVERS);
    const iceExpiresAtRef = useRef(0);
    const relayOnlyPeersRef = useRef<Set<number | string>>(new Set());
    const iceRestartCountsRef = useRef<Map<number | string, number>>(new Map());
    const presenterIdRef = useRef(presenterId);
    presenterIdRef.current = presenterId;
    const mutedRef = useRef(muted);
    mutedRef.current = muted;
    const videoOffRef = useRef(videoOff);
    videoOffRef.current = videoOff;
    const screenSharingRef = useRef(screenSharing);
    screenSharingRef.current = screenSharing;

    useEffect(() => {
        if (code) setCachedMessages(code, messages);
    }, [code, messages]);

    const pendingSendsRef = useRef<Map<string, PendingSendEntry>>(new Map());

    const markMessageStatus = useCallback(
        (clientMsgId: string | null | undefined, patch: AnyRecord) => {
            if (!clientMsgId) return;
            setMessages((prev) => {
                const idx = prev.findIndex(
                    (m) => m.clientMsgId === clientMsgId,
                );
                if (idx < 0) return prev;
                const next = prev.slice();
                next[idx] = { ...next[idx], ...patch };
                return next;
            });
        },
        [],
    );

    const replaceVideoTrackOnPeers = useCallback(
        async (newTrack: MediaStreamTrack | null) => {
            const tasks: Promise<void>[] = [];
            for (const [, pc] of pcsRef.current) {
                const sender = pc
                    .getSenders()
                    .find((s) => s.track?.kind === "video");
                if (sender)
                    tasks.push(
                        sender.replaceTrack(newTrack || null).catch(() => {}),
                    );
            }
            await Promise.all(tasks);
        },
        [],
    );

    const wsSend = useCallback((type: string, data?: unknown) => {
        if (wsRef.current && wsRef.current.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type, data }));
        }
    }, []);

    const applyQualityCapForPeer = useCallback((peerId: number | string) => {
        const pc = pcsRef.current.get(peerId);
        if (!pc) return;
        const level = requestedQualityRef.current.get(peerId) || "h";
        const maxBitrate =
            level === "q" ? 150_000 : level === "h" ? 500_000 : 1_200_000;
        for (const sender of pc.getSenders()) {
            if (!sender.track || sender.track.kind !== "video") continue;
            try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0)
                    params.encodings = [{}];
                params.encodings[0].maxBitrate = maxBitrate;
                sender.setParameters(params).catch(() => {});
            } catch {
                /* ignore */
            }
        }
    }, []);

    const requestPeerQuality = useCallback(
        (peerId: number | string, level: string) => {
            if (!peerId || !["q", "h", "f"].includes(level)) return;
            if (lastRequestSentRef.current.get(peerId) === level) return;
            lastRequestSentRef.current.set(peerId, level);
            wsSend("meeting_request_quality", {
                meetingId,
                targetUserId: peerId,
                level,
            });
        },
        [meetingId, wsSend],
    );

    // Acquire local media
    useEffect(() => {
        if (existingStream) {
            localStreamRef.current = existingStream;
            const audioEnabled = existingStream
                .getAudioTracks()
                .some((t) => t.enabled);
            const videoEnabled = existingStream
                .getVideoTracks()
                .some((t) => t.enabled);
            setMuted(!audioEnabled);
            setVideoOff(!videoEnabled);
            setLocalStream(existingStream);
            setMediaReady(true);
            return;
        }
        let stream: MediaStream | undefined;
        let cancelled = false;
        (async () => {
            try {
                const st = await acquireMeetingMedia(!initialVideoOff);
                if (cancelled) {
                    st.getTracks().forEach((t) => t.stop());
                    return;
                }
                stream = st;
                st.getAudioTracks().forEach((t) => {
                    t.enabled = !initialMuted;
                });
                if (st.getVideoTracks().length === 0) setVideoOff(true);
                localStreamRef.current = st;
                setLocalStream(st);
                setMediaReady(true);
            } catch {
                if (cancelled) return;
                setMuted(true);
                setVideoOff(true);
                setMediaReady(true);
            }
        })();
        return () => {
            cancelled = true;
            if (!keepAliveOnUnmount && stream)
                stream.getTracks().forEach((t) => t.stop());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fetch ICE config.
    useEffect(() => {
        let cancelled = false;
        const refresh = async () => {
            try {
                const { data } = await retryWithBackoff(() => getIceConfig(), {
                    maxAttempts: 4,
                    baseDelayMs: 300,
                    maxDelayMs: 4_000,
                });
                if (cancelled) return;
                const d = data as {
                    iceServers?: RTCIceServer[];
                    expiresAt?: number;
                };
                if (d?.iceServers?.length) {
                    iceServersRef.current = d.iceServers;
                    iceExpiresAtRef.current = d.expiresAt || 0;
                }
            } catch {
                /* keep defaults */
            }
        };
        refresh();
        const t = setInterval(() => {
            if (
                iceExpiresAtRef.current &&
                iceExpiresAtRef.current - Math.floor(Date.now() / 1000) < 300
            )
                refresh();
        }, 60_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    // ─── Devicechange listener ───
    useEffect(() => {
        if (!navigator.mediaDevices?.addEventListener) return;
        const onChange = async () => {
            try {
                const vt =
                    localStreamRef.current?.getVideoTracks?.()[0] || null;
                if (vt && vt.readyState === "ended") {
                    await replaceVideoTrackOnPeers(null);
                    setVideoOff(true);
                }
                wsSend("meeting_track_state", {
                    meetingId,
                    muted: mutedRef.current,
                    videoOff: videoOffRef.current,
                    screenSharing: screenSharingRef.current,
                });
            } catch {
                /* best-effort */
            }
        };
        navigator.mediaDevices.addEventListener("devicechange", onChange);
        return () => {
            try {
                navigator.mediaDevices.removeEventListener(
                    "devicechange",
                    onChange,
                );
            } catch {
                /* ignore */
            }
        };
    }, [meetingId, replaceVideoTrackOnPeers, wsSend]);

    // ─── Network online/offline → FSM ───
    useEffect(() => {
        const onOnline = () => dispatchFsm("network_online");
        const onOffline = () => dispatchFsm("network_offline");
        window.addEventListener("online", onOnline);
        window.addEventListener("offline", onOffline);
        return () => {
            window.removeEventListener("online", onOnline);
            window.removeEventListener("offline", onOffline);
        };
    }, [dispatchFsm]);

    // ─── WS open/close → FSM ───
    useEffect(() => {
        if (!ws) return;
        const onOpen = () => dispatchFsm("ws_open");
        const onClose = () => dispatchFsm("ws_close");
        ws.addEventListener("open", onOpen);
        ws.addEventListener("close", onClose);
        if (ws.readyState === 1) dispatchFsm("ws_open");
        else if (ws.readyState >= 2) dispatchFsm("ws_close");
        return () => {
            try {
                ws.removeEventListener("open", onOpen);
            } catch {
                /* ignore */
            }
            try {
                ws.removeEventListener("close", onClose);
            } catch {
                /* ignore */
            }
        };
    }, [ws, dispatchFsm]);

    // ─── Hydrate chat history ───
    useEffect(() => {
        if (!code) return;
        let cancelled = false;
        const hydrate = () => {
            getMeetingMessages(code)
                .then((res) => {
                    if (cancelled) return;
                    const history = (
                        Array.isArray(res.data) ? res.data : []
                    ) as MeetingMessage[];
                    if (!history.length) return;
                    setMessages((prev) => {
                        const seenIds = new Set(
                            prev
                                .filter((m) => m.id != null)
                                .map((m) => m.id),
                        );
                        const seenClientIds = new Set(
                            prev
                                .filter((m) => m.clientMsgId)
                                .map((m) => m.clientMsgId),
                        );
                        const merged: MeetingMessage[] = [
                            ...history
                                .filter(
                                    (m) =>
                                        (m.id == null ||
                                            !seenIds.has(m.id)) &&
                                        (!m.client_msg_id ||
                                            !seenClientIds.has(
                                                m.client_msg_id as string,
                                            )),
                                )
                                .map((m) => ({
                                    ...m,
                                    clientMsgId:
                                        (m.client_msg_id as string) ||
                                        m.clientMsgId,
                                })),
                            ...prev,
                        ];
                        merged.sort((a, b) =>
                            String(a.created_at || "").localeCompare(
                                String(b.created_at || ""),
                            ),
                        );
                        return merged;
                    });
                })
                .catch(() => {
                    /* silent */
                });
        };

        hydrate();

        if (ws) {
            const onOpen = () => hydrate();
            ws.addEventListener("open", onOpen);
            return () => {
                cancelled = true;
                try {
                    ws.removeEventListener("open", onOpen);
                } catch {
                    /* ignore */
                }
            };
        }
        return () => {
            cancelled = true;
        };
    }, [code, ws]);

    // Safety net: add tracks to peer connections
    useEffect(() => {
        if (!localStreamRef.current) return;
        const stream = localStreamRef.current;
        for (const [peerId, pc] of pcsRef.current) {
            const senders = pc.getSenders().filter((s) => s.track);
            if (senders.length === 0 && stream.getTracks().length > 0) {
                stream.getTracks().forEach((track) => {
                    pc.addTrack(track, stream);
                    if (track.kind === "video") {
                        try {
                            (track as any).contentHint = "motion";
                        } catch {
                            /* not supported */
                        }
                    }
                });
                if (pc.signalingState === "stable") {
                    pc.createOffer()
                        .then((offer) => pc.setLocalDescription(offer))
                        .then(() =>
                            wsSend("meeting_signal", {
                                meetingId,
                                targetUserId: peerId,
                                signal: {
                                    type: "offer",
                                    sdp: pc.localDescription,
                                },
                            }),
                        )
                        .catch(console.error);
                }
            }
        }
    }, [localStream, meetingId, wsSend]);

    // Quality monitoring (every 8s)
    useEffect(() => {
        qualityTimerRef.current = setInterval(async () => {
            const qMap = new Map<number | string, string>();
            for (const [userId, pc] of pcsRef.current) {
                try {
                    const stats = await pc.getStats();
                    let totalPacketLoss = 0,
                        rtt = 0,
                        count = 0;
                    stats.forEach((s: any) => {
                        if (s.type === "inbound-rtp") {
                            const total =
                                (s.packetsReceived || 0) +
                                (s.packetsLost || 0);
                            if (total > 0) {
                                totalPacketLoss += s.packetsLost / total;
                                count++;
                            }
                        }
                        if (
                            s.type === "candidate-pair" &&
                            s.state === "succeeded"
                        )
                            rtt = (s.currentRoundTripTime || 0) * 1000;
                    });
                    const avgLoss = count > 0 ? totalPacketLoss / count : 0;
                    qMap.set(
                        userId,
                        rtt < 100 && avgLoss < 0.02
                            ? "good"
                            : rtt < 250 && avgLoss < 0.08
                              ? "medium"
                              : "poor",
                    );
                } catch {
                    /* ignore */
                }
            }
            setConnectionQualities(new Map(qMap));
        }, 8000);
        return () => {
            if (qualityTimerRef.current)
                clearInterval(qualityTimerRef.current);
        };
    }, []);

    // Create peer connection
    const createPeerConnection = useCallback(
        (
            remoteUserId: number | string,
            isInitiator: boolean,
        ): ExtendedPC | null => {
            const existing = pcsRef.current.get(remoteUserId);
            if (
                existing &&
                existing.connectionState !== "closed" &&
                existing.connectionState !== "failed"
            )
                return existing;
            if (existing) {
                try {
                    existing.close();
                } catch {
                    /* ignore */
                }
            }

            const pcConfig: RTCConfiguration = {
                iceServers: iceServersRef.current,
                bundlePolicy: "max-bundle",
                rtcpMuxPolicy: "require",
                iceCandidatePoolSize: 4,
            };
            if (relayOnlyPeersRef.current.has(remoteUserId))
                pcConfig.iceTransportPolicy = "relay";

            let pc: ExtendedPC;
            try {
                pc = new RTCPeerConnection(pcConfig) as ExtendedPC;
            } catch {
                return null;
            }
            pcsRef.current.set(remoteUserId, pc);

            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach((track) => {
                    pc.addTrack(track, localStreamRef.current as MediaStream);
                    if (track.kind === "video") {
                        try {
                            (track as any).contentHint = "motion";
                        } catch {
                            /* not supported */
                        }
                    }
                });
            }

            setTimeout(() => {
                const peerCount = pcsRef.current.size;
                const videoBitrate =
                    peerCount <= 2
                        ? 1_200_000
                        : peerCount <= 4
                          ? 600_000
                          : 400_000;
                for (const sender of pc.getSenders()) {
                    if (!sender.track) continue;
                    try {
                        const params = sender.getParameters();
                        if (
                            !params.encodings ||
                            params.encodings.length === 0
                        )
                            params.encodings = [{}];
                        if (sender.track.kind === "video") {
                            params.encodings[0].maxBitrate = videoBitrate;
                            params.degradationPreference =
                                "maintain-framerate";
                        } else {
                            params.encodings[0].maxBitrate = 48_000;
                        }
                        sender.setParameters(params).catch(() => {});
                    } catch {
                        /* ignore */
                    }
                }
            }, 0);

            const remoteStream = new MediaStream();
            const remoteScreenStream = new MediaStream();
            pc._remoteStream = remoteStream;
            pc._remoteScreenStream = remoteScreenStream;
            pc._screenTrackIds = new Set();

            const reclassifyTracks = () => {
                for (const t of [...remoteStream.getTracks()]) {
                    if (pc._screenTrackIds!.has(t.id)) {
                        try {
                            remoteStream.removeTrack(t);
                        } catch {
                            /* ignore */
                        }
                        if (
                            !remoteScreenStream
                                .getTracks()
                                .some((x) => x.id === t.id)
                        ) {
                            remoteScreenStream.addTrack(t);
                        }
                    }
                }
                for (const t of [...remoteScreenStream.getTracks()]) {
                    if (!pc._screenTrackIds!.has(t.id)) {
                        try {
                            remoteScreenStream.removeTrack(t);
                        } catch {
                            /* ignore */
                        }
                        if (
                            !remoteStream
                                .getTracks()
                                .some((x) => x.id === t.id)
                        ) {
                            remoteStream.addTrack(t);
                        }
                    }
                }
            };
            pc._reclassifyTracks = reclassifyTracks;

            pc.ontrack = (e) => {
                if (
                    !remoteStream
                        .getTracks()
                        .some((t) => t.id === e.track.id) &&
                    !remoteScreenStream
                        .getTracks()
                        .some((t) => t.id === e.track.id)
                ) {
                    remoteStream.addTrack(e.track);
                }
                reclassifyTracks();

                e.track.onended = () => {
                    try {
                        remoteStream.removeTrack(e.track);
                    } catch {
                        /* ignore */
                    }
                    try {
                        remoteScreenStream.removeTrack(e.track);
                    } catch {
                        /* ignore */
                    }
                    pc._screenTrackIds!.delete(e.track.id);
                    setParticipants((prev) => {
                        const next = new Map(prev);
                        const ex = next.get(remoteUserId);
                        if (ex)
                            next.set(remoteUserId, {
                                ...ex,
                                stream: remoteStream,
                                screenStream: remoteScreenStream,
                            });
                        return next;
                    });
                };

                const hasVideo = remoteStream
                    .getVideoTracks()
                    .some((t) => t.readyState === "live");
                setParticipants((prev) => {
                    const next = new Map(prev);
                    const ex = next.get(remoteUserId) || {
                        userId: remoteUserId,
                    };
                    next.set(remoteUserId, {
                        ...ex,
                        stream: remoteStream,
                        screenStream: remoteScreenStream,
                        ...(hasVideo ? { videoOff: false } : {}),
                    });
                    return next;
                });
            };

            pc.onicecandidate = (e) => {
                if (e.candidate)
                    wsSend("meeting_signal", {
                        meetingId,
                        targetUserId: remoteUserId,
                        signal: { type: "candidate", candidate: e.candidate },
                    });
            };

            pc.oniceconnectionstatechange = () => {
                if (pc.iceConnectionState === "disconnected") {
                    setTimeout(() => {
                        if (
                            pc.iceConnectionState === "disconnected" &&
                            pc.signalingState === "stable"
                        ) {
                            const cnt =
                                iceRestartCountsRef.current.get(
                                    remoteUserId,
                                ) || 0;
                            if (cnt < 3) {
                                iceRestartCountsRef.current.set(
                                    remoteUserId,
                                    cnt + 1,
                                );
                                pc.createOffer({ iceRestart: true })
                                    .then((o) => pc.setLocalDescription(o))
                                    .then(() =>
                                        wsSend("meeting_signal", {
                                            meetingId,
                                            targetUserId: remoteUserId,
                                            signal: {
                                                type: "offer",
                                                sdp: pc.localDescription,
                                            },
                                        }),
                                    )
                                    .catch(() => {});
                            }
                        }
                    }, 2000);
                }
            };

            pc.onconnectionstatechange = () => {
                const state = pc.connectionState;
                setParticipants((prev) => {
                    const next = new Map(prev);
                    const ex = next.get(remoteUserId);
                    if (ex && ex.connectionState !== state) {
                        next.set(remoteUserId, {
                            ...ex,
                            connectionState: state,
                        });
                        return next;
                    }
                    return prev;
                });

                if (pc.connectionState === "connected") {
                    setStatus("connected");
                    dispatchFsm("peer_connected");
                    iceRestartCountsRef.current.delete(remoteUserId);
                    if (pc._disconnectTimer) {
                        clearTimeout(pc._disconnectTimer);
                        pc._disconnectTimer = null;
                    }
                    wsSend("meeting_track_state", {
                        meetingId,
                        muted: mutedRef.current,
                        videoOff: videoOffRef.current,
                        screenSharing: screenSharingRef.current,
                    });
                } else if (pc.connectionState === "failed") {
                    dispatchFsm("peer_failed");
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        const p = n.get(remoteUserId);
                        if (p) {
                            if (p.stream)
                                (p.stream as MediaStream)
                                    .getTracks()
                                    .forEach((t) => t.stop());
                            n.set(remoteUserId, { ...p, stream: null });
                        }
                        return n;
                    });
                    if (!relayOnlyPeersRef.current.has(remoteUserId)) {
                        relayOnlyPeersRef.current.add(remoteUserId);
                        try {
                            pc.close();
                        } catch {
                            /* ignore */
                        }
                        pcsRef.current.delete(remoteUserId);
                        setTimeout(
                            () => createPeerConnection(remoteUserId, true),
                            500,
                        );
                    }
                } else if (pc.connectionState === "disconnected") {
                    dispatchFsm("peer_disconnected");
                    pc._disconnectTimer = setTimeout(() => {
                        if (
                            pc.connectionState === "disconnected" ||
                            pc.connectionState === "failed"
                        ) {
                            setParticipants((prev) => {
                                const n = new Map(prev);
                                const p = n.get(remoteUserId);
                                if (p) {
                                    if (p.stream)
                                        (p.stream as MediaStream)
                                            .getTracks()
                                            .forEach((t) => t.stop());
                                    n.set(remoteUserId, {
                                        ...p,
                                        stream: null,
                                    });
                                }
                                return n;
                            });
                        }
                    }, 5000);
                }
            };

            if (isInitiator) {
                pc.createOffer()
                    .then((offer) => pc.setLocalDescription(offer))
                    .then(() =>
                        wsSend("meeting_signal", {
                            meetingId,
                            targetUserId: remoteUserId,
                            signal: {
                                type: "offer",
                                sdp: pc.localDescription,
                            },
                        }),
                    )
                    .catch(console.error);
            }
            return pc;
        },
        [meetingId, wsSend, dispatchFsm, user?.id],
    );

    // Network change → ICE restart
    useEffect(() => {
        const restartAll = () => {
            for (const [peerId, pc] of pcsRef.current) {
                if (pc.signalingState !== "stable") continue;
                pc.createOffer({ iceRestart: true })
                    .then((o) => pc.setLocalDescription(o))
                    .then(() =>
                        wsSend("meeting_signal", {
                            meetingId,
                            targetUserId: peerId,
                            signal: {
                                type: "offer",
                                sdp: pc.localDescription,
                            },
                        }),
                    )
                    .catch(() => {});
            }
        };
        window.addEventListener("online", restartAll);
        const conn =
            (navigator as any).connection ||
            (navigator as any).mozConnection ||
            (navigator as any).webkitConnection;
        conn?.addEventListener?.("change", restartAll);
        return () => {
            window.removeEventListener("online", restartAll);
            conn?.removeEventListener?.("change", restartAll);
        };
    }, [meetingId, wsSend]);

    const flushPendingSignals = useCallback(
        async (userId: number | string, pc: ExtendedPC) => {
            const pending = pendingSignals.current.get(userId) || [];
            pendingSignals.current.delete(userId);
            for (const sig of pending) {
                try {
                    await handleSignal(userId, pc, sig);
                } catch {
                    /* ignore */
                }
            }
        },
        [], // eslint-disable-line react-hooks/exhaustive-deps
    );

    const handleSignal = useCallback(
        async (
            fromUserId: number | string,
            pc: ExtendedPC,
            signal: AnyRecord,
        ) => {
            if (!pc) return;
            if (signal.type === "offer") {
                await pc.setRemoteDescription(
                    new RTCSessionDescription(
                        signal.sdp as RTCSessionDescriptionInit,
                    ),
                );
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                wsSend("meeting_signal", {
                    meetingId,
                    targetUserId: fromUserId,
                    signal: { type: "answer", sdp: pc.localDescription },
                });
                await flushPendingSignals(fromUserId, pc);
            } else if (signal.type === "answer") {
                if (pc.signalingState === "have-local-offer") {
                    await pc.setRemoteDescription(
                        new RTCSessionDescription(
                            signal.sdp as RTCSessionDescriptionInit,
                        ),
                    );
                    await flushPendingSignals(fromUserId, pc);
                }
            } else if (signal.type === "candidate") {
                if (pc.remoteDescription)
                    await pc.addIceCandidate(
                        new RTCIceCandidate(
                            signal.candidate as RTCIceCandidateInit,
                        ),
                    );
                else {
                    const q = pendingSignals.current.get(fromUserId) || [];
                    q.push(signal);
                    pendingSignals.current.set(fromUserId, q);
                }
            }
        },
        [meetingId, wsSend, flushPendingSignals],
    );

    // STABLE WS handler
    const handleWsMessage = useCallback(
        (msg: { type: string; data: AnyRecord }) => {
            const { type, data } = msg;
            if (!data) return;
            switch (type) {
                case "meeting_participant_joined": {
                    let hasPeersToConnect = false;
                    if (
                        data.existingPeers &&
                        Array.isArray(data.existingPeers)
                    ) {
                        (data.existingPeers as AnyRecord[]).forEach((peer) => {
                            if (!peer?.userId) return;
                            const oldPc = pcsRef.current.get(
                                peer.userId as number | string,
                            );
                            if (oldPc) {
                                try {
                                    oldPc.close();
                                } catch {
                                    /* ignore */
                                }
                                pcsRef.current.delete(
                                    peer.userId as number | string,
                                );
                            }
                            const pc = createPeerConnection(
                                peer.userId as number | string,
                                false,
                            );
                            if (pc)
                                pcsRef.current.set(
                                    peer.userId as number | string,
                                    pc,
                                );
                            if (peer.userId !== user?.id) {
                                hasPeersToConnect = true;
                                setParticipants((prev) => {
                                    const next = new Map(prev);
                                    next.set(peer.userId as number | string, {
                                        userId: peer.userId as number | string,
                                        stream: null,
                                        muted: false,
                                        videoOff: false,
                                        raisedHand: false,
                                        role: "participant",
                                        screenSharing: false,
                                        ...(next.get(
                                            peer.userId as number | string,
                                        ) || {}),
                                        name:
                                            (peer.fullName as string) ||
                                            (peer.username as string) ||
                                            "Participant",
                                        avatar:
                                            (peer.avatar as string) || null,
                                    });
                                    return next;
                                });
                            }
                        });
                    }
                    if (data.userId !== user?.id) {
                        setParticipants((prev) => {
                            const next = new Map(prev);
                            next.set(data.userId as number | string, {
                                userId: data.userId as number | string,
                                stream: null,
                                muted: false,
                                videoOff: false,
                                raisedHand: false,
                                role:
                                    (data.role as string) || "participant",
                                screenSharing: false,
                                ...(next.get(
                                    data.userId as number | string,
                                ) || {}),
                                name:
                                    (data.fullName as string) ||
                                    (data.username as string) ||
                                    "Participant",
                                avatar: (data.avatar as string) || null,
                            });
                            return next;
                        });
                        if (!data.existingPeers) {
                            const oldPc = pcsRef.current.get(
                                data.userId as number | string,
                            );
                            if (oldPc) {
                                try {
                                    oldPc.close();
                                } catch {
                                    /* ignore */
                                }
                                pcsRef.current.delete(
                                    data.userId as number | string,
                                );
                            }
                            const pc = createPeerConnection(
                                data.userId as number | string,
                                true,
                            );
                            if (pc)
                                pcsRef.current.set(
                                    data.userId as number | string,
                                    pc,
                                );
                            wsSend("meeting_track_state", {
                                meetingId,
                                muted: mutedRef.current,
                                videoOff: videoOffRef.current,
                                screenSharing: screenSharingRef.current,
                            });
                        }
                    }
                    setStatus((prev) =>
                        hasPeersToConnect
                            ? prev === "connected"
                                ? prev
                                : "connecting"
                            : "connected",
                    );

                    const peerCount = pcsRef.current.size;
                    if (peerCount > 1) {
                        const videoBitrate =
                            peerCount <= 2
                                ? 1_200_000
                                : peerCount <= 4
                                  ? 600_000
                                  : 400_000;
                        for (const [, existingPc] of pcsRef.current) {
                            for (const sender of existingPc.getSenders()) {
                                if (
                                    !sender.track ||
                                    sender.track.kind !== "video"
                                )
                                    continue;
                                try {
                                    const params = sender.getParameters();
                                    if (
                                        !params.encodings ||
                                        params.encodings.length === 0
                                    )
                                        continue;
                                    params.encodings[0].maxBitrate =
                                        videoBitrate;
                                    sender
                                        .setParameters(params)
                                        .catch(() => {});
                                } catch {
                                    /* ignore */
                                }
                            }
                        }
                    }
                    break;
                }
                case "meeting_signal": {
                    const { fromUserId, signal } = data as {
                        fromUserId: number | string;
                        signal: AnyRecord;
                    };
                    let pc = pcsRef.current.get(fromUserId);
                    if (!pc) {
                        const created = createPeerConnection(
                            fromUserId,
                            false,
                        );
                        if (!created) break;
                        pc = created;
                        pcsRef.current.set(fromUserId, pc);
                    }
                    handleSignal(fromUserId, pc, signal).catch(console.error);
                    break;
                }
                case "meeting_participant_left": {
                    const { userId } = data as { userId: number | string };
                    pcsRef.current.get(userId)?.close();
                    pcsRef.current.delete(userId);
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        n.delete(userId);
                        return n;
                    });
                    if (presenterIdRef.current === userId)
                        setPresenterId(null);
                    break;
                }
                case "meeting_ended": {
                    if (screenStreamRef.current) {
                        screenStreamRef.current
                            .getTracks()
                            .forEach((t) => t.stop());
                        screenStreamRef.current = null;
                    }
                    if (localStreamRef.current) {
                        localStreamRef.current
                            .getTracks()
                            .forEach((t) => t.stop());
                        localStreamRef.current = null;
                    }
                    pcsRef.current.forEach((pc) => {
                        try {
                            pc.close();
                        } catch {
                            /* ignore */
                        }
                    });
                    pcsRef.current.clear();
                    if (qualityTimerRef.current) {
                        clearInterval(qualityTimerRef.current);
                        qualityTimerRef.current = null;
                    }
                    setStatus("ended");
                    break;
                }
                case "meeting_muted": {
                    const shouldMute = data.muted !== false;
                    setMuted(shouldMute);
                    if (localStreamRef.current)
                        localStreamRef.current
                            .getAudioTracks()
                            .forEach((t) => {
                                t.enabled = !shouldMute;
                            });
                    wsSend("meeting_track_state", {
                        meetingId,
                        muted: shouldMute,
                        videoOff: videoOffRef.current,
                        screenSharing: screenSharingRef.current,
                    });
                    break;
                }
                case "meeting_hand_raised": {
                    const { userId, raised } = data as {
                        userId: number | string;
                        raised: boolean;
                    };
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        const p = n.get(userId);
                        if (p) n.set(userId, { ...p, raisedHand: raised });
                        return n;
                    });
                    break;
                }
                case "meeting_track_state": {
                    const {
                        userId,
                        muted: m,
                        videoOff: v,
                        screenSharing: s,
                    } = data as {
                        userId: number | string;
                        muted?: boolean;
                        videoOff?: boolean;
                        screenSharing?: boolean;
                    };
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        const p = n.get(userId) || {
                            userId,
                            stream: null,
                            name: "Participant",
                            raisedHand: false,
                            role: "participant",
                        };
                        n.set(userId, {
                            ...p,
                            ...(m != null ? { muted: m } : {}),
                            ...(v != null ? { videoOff: v } : {}),
                            ...(s != null ? { screenSharing: s } : {}),
                        });
                        return n;
                    });
                    if (s) setPresenterId(userId);
                    else if (
                        s === false &&
                        presenterIdRef.current === userId
                    )
                        setPresenterId(null);
                    break;
                }
                case "meeting_screen_track_id": {
                    const { fromUserId, trackId, sharing } = data as {
                        fromUserId: number | string;
                        trackId?: string;
                        sharing?: boolean;
                    };
                    const pc = pcsRef.current.get(fromUserId);
                    if (!pc) break;
                    if (sharing && trackId) {
                        pc._screenTrackIds!.add(trackId);
                    } else if (!sharing) {
                        pc._screenTrackIds!.clear();
                    }
                    pc._reclassifyTracks && pc._reclassifyTracks();
                    setParticipants((prev) => {
                        const n = new Map(prev);
                        const ex = n.get(fromUserId);
                        if (ex)
                            n.set(fromUserId, {
                                ...ex,
                                stream: pc._remoteStream,
                                screenStream: pc._remoteScreenStream,
                            });
                        return n;
                    });
                    break;
                }
                case "meeting_message": {
                    const incoming = data.message as MeetingMessage;
                    if (!incoming) break;
                    const incClientId =
                        incoming.clientMsgId ||
                        (incoming.client_msg_id as string) ||
                        null;
                    if (
                        incClientId &&
                        pendingSendsRef.current.has(incClientId)
                    ) {
                        pendingSendsRef.current.delete(incClientId);
                    }
                    setMessages((prev) => {
                        if (incClientId) {
                            const idx = prev.findIndex(
                                (m) => m.clientMsgId === incClientId,
                            );
                            if (idx >= 0) {
                                const next = prev.slice();
                                next[idx] = {
                                    ...next[idx],
                                    ...incoming,
                                    clientMsgId: incClientId,
                                    _optimistic: false,
                                    _failed: false,
                                };
                                return next;
                            }
                        }
                        if (incoming.sender_id === user?.id) {
                            const idx = prev.findIndex(
                                (m) =>
                                    m._optimistic &&
                                    m.sender_id === incoming.sender_id &&
                                    m.text === incoming.text &&
                                    !m.clientMsgId,
                            );
                            if (idx >= 0) {
                                const next = prev.slice();
                                next[idx] = incoming;
                                return next;
                            }
                        }
                        if (
                            incoming.id != null &&
                            prev.some((m) => m.id === incoming.id)
                        ) {
                            return prev;
                        }
                        return [...prev, incoming];
                    });
                    break;
                }
                case "meeting_message_ack": {
                    const { clientMsgId, id, createdAt } = data as {
                        clientMsgId?: string;
                        id?: number | string;
                        createdAt?: string;
                    };
                    if (clientMsgId) {
                        pendingSendsRef.current.delete(clientMsgId);
                        markMessageStatus(clientMsgId, {
                            _optimistic: false,
                            _failed: false,
                            ...(id != null ? { id } : {}),
                            ...(createdAt ? { created_at: createdAt } : {}),
                        });
                    }
                    break;
                }
                case "meeting_message_error": {
                    const { clientMsgId, reason } = data as {
                        clientMsgId?: string;
                        reason?: string;
                    };
                    if (clientMsgId) {
                        markMessageStatus(clientMsgId, {
                            _failed: true,
                            _failureReason: reason || "unknown",
                        });
                    }
                    break;
                }
                case "meeting_request_quality": {
                    const { fromUserId, level } = data as {
                        fromUserId: number | string;
                        level: string;
                    };
                    if (
                        !fromUserId ||
                        !["q", "h", "f"].includes(level)
                    )
                        break;
                    requestedQualityRef.current.set(fromUserId, level);
                    applyQualityCapForPeer(fromUserId);
                    break;
                }
                case "meeting_audio_level": {
                    const { userId, level } = data as {
                        userId: number | string;
                        level: number;
                    };
                    if (typeof level !== "number") break;
                    audioLevelsRef.current.set(userId, {
                        level,
                        at: performance.now(),
                    });
                    break;
                }
                default:
                    break;
            }
        },
        [
            user,
            createPeerConnection,
            handleSignal,
            meetingId,
            wsSend,
            applyQualityCapForPeer,
        ],
    );

    // Register WS message handler
    const handleWsMessageRef = useRef(handleWsMessage);
    handleWsMessageRef.current = handleWsMessage;

    useEffect(() => {
        if (!ws) return;
        const onMessage = (e: MessageEvent) => {
            try {
                handleWsMessageRef.current(JSON.parse(e.data));
            } catch {
                /* ignore */
            }
        };
        ws.addEventListener("message", onMessage);
        return () => ws.removeEventListener("message", onMessage);
    }, [ws]);

    // Send WS join
    useEffect(() => {
        if (!ws || !meetingId) return;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let retryTimer2: ReturnType<typeof setTimeout> | null = null;
        let joined = false;

        if (pcsRef.current.size > 0) {
            pcsRef.current.forEach((pc) => {
                try {
                    pc.close();
                } catch {
                    /* ignore */
                }
            });
            pcsRef.current.clear();
            iceRestartCountsRef.current.clear();
            relayOnlyPeersRef.current.clear();
        }

        const sendJoin = () => {
            if (joined) return;
            joined = true;
            wsSend("meeting_join", { meetingId });
            setTimeout(
                () =>
                    wsSend("meeting_track_state", {
                        meetingId,
                        muted: mutedRef.current,
                        videoOff: videoOffRef.current,
                        screenSharing: screenSharingRef.current,
                    }),
                300,
            );
        };

        const onOpen = () => sendJoin();

        if (ws.readyState === WebSocket.OPEN) sendJoin();
        else if (ws.readyState === WebSocket.CONNECTING)
            ws.addEventListener("open", onOpen, { once: true });

        retryTimer = setTimeout(() => {
            if (!joined && ws.readyState === WebSocket.OPEN) {
                sendJoin();
            }
        }, 1000);

        retryTimer2 = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                wsSend("meeting_join", { meetingId });
            }
        }, 2500);

        return () => {
            if (retryTimer) clearTimeout(retryTimer);
            if (retryTimer2) clearTimeout(retryTimer2);
            try {
                ws.removeEventListener("open", onOpen);
            } catch {
                /* ignore */
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ws, meetingId]);

    // Meeting-level cleanup
    useEffect(() => {
        if (!meetingId) return;
        const onBeforeUnload = () => {
            const w = wsRef.current;
            if (w && w.readyState === WebSocket.OPEN) {
                try {
                    w.send(
                        JSON.stringify({
                            type: "meeting_leave",
                            data: { meetingId },
                        }),
                    );
                } catch {
                    /* ignore */
                }
            }
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => {
            window.removeEventListener("beforeunload", onBeforeUnload);
            if (!keepAliveOnUnmount) {
                wsSend("meeting_leave", { meetingId });
                pcsRef.current.forEach((pc) => {
                    try {
                        pc.close();
                    } catch {
                        /* ignore */
                    }
                });
                pcsRef.current.clear();
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meetingId]);

    // Actions
    const toggleMute = useCallback(() => {
        setMuted((v) => {
            const next = !v;
            if (localStreamRef.current)
                localStreamRef.current.getAudioTracks().forEach((t) => {
                    t.enabled = !next;
                });
            wsSend("meeting_track_state", {
                meetingId,
                muted: next,
                videoOff: videoOffRef.current,
                screenSharing: screenSharingRef.current,
            });
            return next;
        });
    }, [meetingId, wsSend]);

    const videoToggleInFlightRef = useRef(false);
    const toggleVideo = useCallback(async () => {
        if (videoToggleInFlightRef.current) return;
        videoToggleInFlightRef.current = true;
        try {
            const next = !videoOffRef.current;
            if (next) {
                for (const [, pc] of pcsRef.current) {
                    const videoSenders = pc
                        .getSenders()
                        .filter(
                            (s) => s.track && s.track.kind === "video",
                        );
                    for (const vs of videoSenders) {
                        try {
                            await vs.replaceTrack(null);
                        } catch {
                            /* ignore */
                        }
                    }
                }
                if (localStreamRef.current) {
                    const vts = localStreamRef.current.getVideoTracks();
                    vts.forEach((t) => {
                        try {
                            t.stop();
                        } catch {
                            /* ignore */
                        }
                        try {
                            localStreamRef.current!.removeTrack(t);
                        } catch {
                            /* ignore */
                        }
                    });
                    setLocalStream(
                        new MediaStream(
                            localStreamRef.current.getTracks(),
                        ),
                    );
                }
            } else {
                if (!localStreamRef.current) {
                    try {
                        const ns =
                            await navigator.mediaDevices.getUserMedia({
                                audio: true,
                                video: true,
                            });
                        localStreamRef.current = ns;
                        ns.getAudioTracks().forEach((t) => {
                            t.enabled = !mutedRef.current;
                        });
                        for (const [peerId, pc] of pcsRef.current) {
                            ns.getTracks().forEach((track) =>
                                pc.addTrack(track, ns),
                            );
                            try {
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                wsSend("meeting_signal", {
                                    meetingId,
                                    targetUserId: peerId,
                                    signal: {
                                        type: "offer",
                                        sdp: pc.localDescription,
                                    },
                                });
                            } catch {
                                /* ignore */
                            }
                        }
                        setLocalStream(ns);
                    } catch {
                        return;
                    }
                } else {
                    let ns: MediaStream;
                    try {
                        ns = await navigator.mediaDevices.getUserMedia({
                            video: true,
                            audio: false,
                        });
                    } catch (err) {
                        console.error(
                            "[meeting] re-acquire camera failed:",
                            err,
                        );
                        return;
                    }
                    const nt = ns.getVideoTracks()[0];
                    if (!nt) return;
                    try {
                        (nt as any).contentHint = "motion";
                    } catch {
                        /* ignore */
                    }
                    localStreamRef.current.addTrack(nt);

                    for (const [peerId, pc] of pcsRef.current) {
                        const vs =
                            pc
                                .getSenders()
                                .find(
                                    (s) =>
                                        s.track &&
                                        s.track.kind === "video",
                                ) ||
                            pc.getSenders().find((s) => !s.track);
                        if (vs) {
                            try {
                                await vs.replaceTrack(nt);
                            } catch (err) {
                                console.warn(
                                    "[meeting] replaceTrack failed, addTrack fallback:",
                                    (err as Error)?.message || err,
                                );
                                try {
                                    pc.addTrack(
                                        nt,
                                        localStreamRef.current as MediaStream,
                                    );
                                } catch {
                                    /* ignore */
                                }
                                try {
                                    const offer = await pc.createOffer();
                                    await pc.setLocalDescription(offer);
                                    wsSend("meeting_signal", {
                                        meetingId,
                                        targetUserId: peerId,
                                        signal: {
                                            type: "offer",
                                            sdp: pc.localDescription,
                                        },
                                    });
                                } catch {
                                    /* ignore */
                                }
                            }
                        } else {
                            try {
                                pc.addTrack(
                                    nt,
                                    localStreamRef.current as MediaStream,
                                );
                            } catch {
                                /* ignore */
                            }
                            try {
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                wsSend("meeting_signal", {
                                    meetingId,
                                    targetUserId: peerId,
                                    signal: {
                                        type: "offer",
                                        sdp: pc.localDescription,
                                    },
                                });
                            } catch {
                                /* ignore */
                            }
                        }
                    }
                    setLocalStream(
                        new MediaStream(
                            localStreamRef.current.getTracks(),
                        ),
                    );
                }
            }
            setVideoOff(next);
            wsSend("meeting_track_state", {
                meetingId,
                muted: mutedRef.current,
                videoOff: next,
                screenSharing: screenSharingRef.current,
            });
        } finally {
            videoToggleInFlightRef.current = false;
        }
    }, [meetingId, wsSend]);

    const screenSendersRef = useRef<
        Map<number | string, RTCRtpSender[]>
    >(new Map());

    const toggleScreenShare = useCallback(async () => {
        if (screenSharing) {
            if (screenStreamRef.current) {
                screenStreamRef.current
                    .getTracks()
                    .forEach((t) => t.stop());
                screenStreamRef.current = null;
            }
            for (const [peerId, senders] of screenSendersRef.current) {
                const pc = pcsRef.current.get(peerId);
                if (!pc) continue;
                for (const sender of senders) {
                    try {
                        pc.removeTrack(sender);
                    } catch {
                        /* ignore */
                    }
                }
                if (pc.signalingState === "stable") {
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        wsSend("meeting_signal", {
                            meetingId,
                            targetUserId: peerId,
                            signal: {
                                type: "offer",
                                sdp: pc.localDescription,
                            },
                        });
                    } catch {
                        /* ignore */
                    }
                }
                wsSend("meeting_screen_track_id", {
                    meetingId,
                    targetUserId: peerId,
                    sharing: false,
                });
            }
            screenSendersRef.current.clear();

            setScreenSharing(false);
            setScreenStream(null);
            if (presenterIdRef.current === user?.id) setPresenterId(null);
            wsSend("meeting_track_state", {
                meetingId,
                muted: mutedRef.current,
                videoOff: videoOffRef.current,
                screenSharing: false,
            });
        } else {
            let ss: MediaStream;
            try {
                ss = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true,
                });
            } catch {
                return;
            }
            screenStreamRef.current = ss;
            setScreenStream(ss);
            setScreenSharing(true);
            setPresenterId(user?.id ?? null);

            const screenVideoTrack = ss.getVideoTracks()[0];
            const screenAudioTrack = ss.getAudioTracks()[0];

            for (const [peerId, pc] of pcsRef.current) {
                const senders: RTCRtpSender[] = [];
                try {
                    senders.push(pc.addTrack(screenVideoTrack, ss));
                } catch {
                    /* ignore */
                }
                if (screenAudioTrack) {
                    try {
                        senders.push(pc.addTrack(screenAudioTrack, ss));
                    } catch {
                        /* ignore */
                    }
                }
                screenSendersRef.current.set(peerId, senders);

                if (pc.signalingState === "stable") {
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        wsSend("meeting_signal", {
                            meetingId,
                            targetUserId: peerId,
                            signal: {
                                type: "offer",
                                sdp: pc.localDescription,
                            },
                        });
                    } catch {
                        /* ignore */
                    }
                }

                wsSend("meeting_screen_track_id", {
                    meetingId,
                    targetUserId: peerId,
                    sharing: true,
                    trackId: screenVideoTrack.id,
                });
            }

            screenVideoTrack.onended = () => {
                if (screenSharingRef.current) toggleScreenShare();
            };

            wsSend("meeting_track_state", {
                meetingId,
                muted: mutedRef.current,
                videoOff: videoOffRef.current,
                screenSharing: true,
            });
        }
    }, [screenSharing, meetingId, wsSend, user?.id]);

    const raiseHand = useCallback(() => {
        const next = !raisedHand;
        setRaisedHand(next);
        wsSend("meeting_raise_hand", {
            meetingId,
            raised: next,
            clientMsgId: newClientMsgId(),
        });
    }, [raisedHand, meetingId, wsSend]);

    const enqueueChatSend = useCallback(
        (payload: AnyRecord, optimisticPatch: AnyRecord) => {
            const clientMsgId =
                (payload.clientMsgId as string) || newClientMsgId();
            const fullPayload = { ...payload, clientMsgId, meetingId };
            const now = Date.now();
            pendingSendsRef.current.set(clientMsgId, {
                payload: fullPayload,
                firstSentAt: now,
                lastSentAt: now,
            });
            setMessages((prev) => [
                ...prev,
                {
                    clientMsgId,
                    sender_id: user?.id,
                    sender_name:
                        user?.full_name || user?.username || "You",
                    created_at: new Date(now).toISOString(),
                    _optimistic: true,
                    ...optimisticPatch,
                },
            ]);
            wsSend("meeting_chat", fullPayload);
            return clientMsgId;
        },
        [meetingId, wsSend, user],
    );

    const sendChatMessage = useCallback(
        (text: string) => {
            if (!text || !text.trim()) return;
            const trimmed = text.trim();
            enqueueChatSend({ text: trimmed }, { text: trimmed });
        },
        [enqueueChatSend],
    );

    const sendChatFile = useCallback(
        async (file: File) => {
            if (!file) return;
            const formData = new FormData();
            formData.append("file", file);
            const previewUrl = URL.createObjectURL(file);
            const clientMsgId = newClientMsgId();

            setMessages((prev) => [
                ...prev,
                {
                    clientMsgId,
                    sender_id: user?.id,
                    sender_name:
                        user?.full_name || user?.username || "You",
                    file_name: file.name,
                    file_size: file.size,
                    file_url: previewUrl,
                    created_at: new Date().toISOString(),
                    _optimistic: true,
                    _uploading: true,
                },
            ]);

            try {
                const convId = sessionStorage.getItem("meeting_conv_id");
                if (convId) {
                    const res = await uploadChatFile(convId, formData);
                    const rdata = res.data as {
                        fileUrl: string;
                        fileName: string;
                        fileSize: number;
                    };
                    enqueueChatSend(
                        {
                            clientMsgId,
                            file_url: rdata.fileUrl,
                            file_name: rdata.fileName,
                            file_size: rdata.fileSize,
                        },
                        {
                            file_name: rdata.fileName,
                            file_size: rdata.fileSize,
                            file_url: rdata.fileUrl,
                            _uploading: false,
                        },
                    );
                    setMessages((prev) => {
                        const idx = prev.findIndex(
                            (m, i) =>
                                m.clientMsgId === clientMsgId &&
                                i !== prev.length - 1,
                        );
                        if (idx < 0) return prev;
                        const next = prev.slice();
                        next.splice(idx, 1);
                        return next;
                    });
                } else {
                    enqueueChatSend(
                        {
                            clientMsgId,
                            text: `📎 ${file.name}`,
                            file_name: file.name,
                            file_size: file.size,
                        },
                        {
                            text: `📎 ${file.name}`,
                            file_name: file.name,
                            file_size: file.size,
                            _uploading: false,
                        },
                    );
                    setMessages((prev) => {
                        const idx = prev.findIndex(
                            (m, i) =>
                                m.clientMsgId === clientMsgId &&
                                i !== prev.length - 1,
                        );
                        if (idx < 0) return prev;
                        const next = prev.slice();
                        next.splice(idx, 1);
                        return next;
                    });
                }
            } catch {
                markMessageStatus(clientMsgId, {
                    _failed: true,
                    _uploading: false,
                    _failureReason: "upload-failed",
                });
            }
            setTimeout(() => URL.revokeObjectURL(previewUrl), 60_000);
        },
        [enqueueChatSend, markMessageStatus, user],
    );

    const retryMessage = useCallback(
        (clientMsgId: string) => {
            if (!clientMsgId) return;
            const entry = pendingSendsRef.current.get(clientMsgId);
            if (!entry) {
                markMessageStatus(clientMsgId, { _failed: false });
                return;
            }
            entry.firstSentAt = Date.now();
            entry.lastSentAt = Date.now();
            markMessageStatus(clientMsgId, {
                _failed: false,
                _failureReason: null,
                _optimistic: true,
            });
            wsSend("meeting_chat", entry.payload);
        },
        [markMessageStatus, wsSend],
    );

    // Periodic pending-send retry loop
    useEffect(() => {
        const t = setInterval(() => {
            const now = Date.now();
            const w = wsRef.current;
            const wsOpen = w && w.readyState === 1;
            for (const [clientMsgId, entry] of pendingSendsRef.current) {
                const age = now - entry.firstSentAt;
                const sinceLast = now - entry.lastSentAt;
                if (age > PENDING_SEND_FAIL_AFTER_MS) {
                    markMessageStatus(clientMsgId, {
                        _failed: true,
                        _failureReason: "timeout",
                    });
                }
                if (
                    wsOpen &&
                    sinceLast > PENDING_SEND_RETRY_EVERY_MS &&
                    w
                ) {
                    entry.lastSentAt = now;
                    try {
                        w.send(
                            JSON.stringify({
                                type: "meeting_chat",
                                data: entry.payload,
                            }),
                        );
                    } catch {
                        /* ignore */
                    }
                }
            }
        }, 1500);
        return () => clearInterval(t);
    }, [markMessageStatus]);

    // On every WS open: flush + replay
    useEffect(() => {
        if (!ws) return;
        const flushAndReplay = () => {
            const now = Date.now();
            for (const [, entry] of pendingSendsRef.current) {
                entry.lastSentAt = now;
                try {
                    ws.send(
                        JSON.stringify({
                            type: "meeting_chat",
                            data: entry.payload,
                        }),
                    );
                } catch {
                    /* ignore */
                }
            }
            if (meetingId) {
                let highest = 0;
                for (const m of messages) {
                    if (typeof m.id === "number" && m.id > highest)
                        highest = m.id;
                }
                try {
                    ws.send(
                        JSON.stringify({
                            type: "meeting_chat_replay",
                            data: { meetingId, sinceMessageId: highest },
                        }),
                    );
                } catch {
                    /* ignore */
                }
            }
        };
        if (ws.readyState === 1) {
            flushAndReplay();
        }
        ws.addEventListener("open", flushAndReplay);
        return () => {
            try {
                ws.removeEventListener("open", flushAndReplay);
            } catch {
                /* ignore */
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ws, meetingId]);

    const cleanupMedia = useCallback(() => {
        if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach((t) => t.stop());
            screenStreamRef.current = null;
            setScreenStream(null);
        }
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
            setLocalStream(null);
        }
        pcsRef.current.forEach((pc) => {
            try {
                pc.close();
            } catch {
                /* ignore */
            }
        });
        pcsRef.current.clear();
        if (qualityTimerRef.current) {
            clearInterval(qualityTimerRef.current);
            qualityTimerRef.current = null;
        }
    }, []);

    const endMeeting = useCallback(() => {
        wsSend("meeting_end", { meetingId });
        cleanupMedia();
        setStatus("ended");
    }, [meetingId, wsSend, cleanupMedia]);
    const leaveMeeting = useCallback(() => {
        wsSend("meeting_leave", { meetingId });
        cleanupMedia();
        setStatus("left");
    }, [meetingId, wsSend, cleanupMedia]);
    const muteParticipant = useCallback(
        (targetUserId: number | string, muted = true) => {
            wsSend("meeting_mute_participant", {
                meetingId,
                targetUserId,
                muted,
                clientMsgId: newClientMsgId(),
            });
        },
        [meetingId, wsSend],
    );
    const addParticipant = useCallback(
        (targetUserId: number | string) => {
            wsSend("meeting_add_participant", { meetingId, targetUserId });
        },
        [meetingId, wsSend],
    );

    const switchAudioDevice = useCallback(async (deviceId: string) => {
        try {
            const ns = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: deviceId } },
            });
            const nt = ns.getAudioTracks()[0];
            if (!nt || !localStreamRef.current) return;
            const old = localStreamRef.current.getAudioTracks()[0];
            if (old) {
                localStreamRef.current.removeTrack(old);
                old.stop();
            }
            localStreamRef.current.addTrack(nt);
            nt.enabled = !mutedRef.current;
            for (const [, pc] of pcsRef.current) {
                const s = pc
                    .getSenders()
                    .find((s) => s.track?.kind === "audio");
                if (s) await s.replaceTrack(nt).catch(() => {});
            }
            setLocalStream(
                new MediaStream(localStreamRef.current.getTracks()),
            );
        } catch {
            /* ignore */
        }
    }, []);

    const switchVideoDevice = useCallback(async (deviceId: string) => {
        try {
            const ns = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: deviceId } },
            });
            const nt = ns.getVideoTracks()[0];
            if (!nt || !localStreamRef.current) return;
            const old = localStreamRef.current.getVideoTracks()[0];
            if (old) {
                localStreamRef.current.removeTrack(old);
                old.stop();
            }
            localStreamRef.current.addTrack(nt);
            nt.enabled = !videoOffRef.current;
            for (const [, pc] of pcsRef.current) {
                const s = pc
                    .getSenders()
                    .find((s) => s.track?.kind === "video");
                if (s) await s.replaceTrack(nt).catch(() => {});
            }
            setLocalStream(
                new MediaStream(localStreamRef.current.getTracks()),
            );
        } catch {
            /* ignore */
        }
    }, []);

    // ─── Phase 5 — Local audio-level publisher ───
    useEffect(() => {
        if (!localStream || muted) return;
        const audioTrack = localStream.getAudioTracks?.()[0];
        if (!audioTrack) return;
        const AudioCtx =
            window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) return;
        let ctx: AudioContext;
        try {
            ctx = new AudioCtx();
        } catch {
            return;
        }
        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        let source: MediaStreamAudioSourceNode;
        let analyser: AnalyserNode;
        try {
            const audioOnly = new MediaStream([audioTrack]);
            source = ctx.createMediaStreamSource(audioOnly);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.7;
            source.connect(analyser);
        } catch {
            try {
                ctx.close();
            } catch {
                /* ignore */
            }
            return;
        }
        if (ctx.state === "suspended")
            ctx.resume().catch(() => {
                /* ignore */
            });
        const data = new Uint8Array(analyser.frequencyBinCount);
        let lastSent = 0;
        const tick = () => {
            if (cancelled) return;
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const level = Math.min(1, sum / data.length / 128);
            audioLevelsRef.current.set(user?.id ?? -1, {
                level,
                at: performance.now(),
            });
            const now = Date.now();
            if (level > 0.05 && now - lastSent > 500) {
                lastSent = now;
                wsSend("meeting_audio_level", {
                    meetingId,
                    level: +level.toFixed(3),
                });
            }
        };
        timer = setInterval(tick, 200);
        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
            try {
                source.disconnect();
            } catch {
                /* ignore */
            }
            try {
                analyser.disconnect();
            } catch {
                /* ignore */
            }
            try {
                ctx.close();
            } catch {
                /* ignore */
            }
        };
    }, [localStream, muted, meetingId, wsSend, user?.id]);

    // ─── Phase 5 — Active-speaker selector ───
    useEffect(() => {
        const t = setInterval(() => {
            const now = performance.now();
            let bestId: number | string | null = null;
            let bestLevel = 0;
            for (const [uid, { level, at }] of audioLevelsRef.current) {
                if (now - at > 2_000) continue;
                if (level < 0.08) continue;
                if (level > bestLevel) {
                    bestLevel = level;
                    bestId = uid;
                }
            }
            setActiveSpeakerId((prev) => (prev === bestId ? prev : bestId));
        }, 350);
        return () => clearInterval(t);
    }, []);

    // ─── Phase 5 — Adaptive bitrate from active speaker + presenter ───
    useEffect(() => {
        if (participants.size === 0) return;
        for (const [peerId] of participants) {
            if (peerId === user?.id) continue;
            const isPresenterPeer = peerId === presenterId;
            const isSpeaker = peerId === activeSpeakerId;
            const level = isPresenterPeer || isSpeaker ? "f" : "h";
            requestPeerQuality(peerId, level);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeSpeakerId, presenterId, participants.size]);

    const connectionBanner = describeState(fsmState);

    useEffect(() => {
        meetingStore.setState({
            muted,
            videoOff,
            screenSharing,
            raisedHand,
            status,
            fsmState,
            connectionBanner,
            activeSpeakerId,
            presenterId,
            messages,
        });
    }, [
        muted,
        videoOff,
        screenSharing,
        raisedHand,
        status,
        fsmState,
        connectionBanner,
        activeSpeakerId,
        presenterId,
        messages,
    ]);

    return {
        localStream,
        screenStream,
        muted,
        videoOff,
        screenSharing,
        participants,
        status,
        raisedHand,
        messages,
        activePanel,
        setActivePanel,
        connectionQualities,
        presenterId,
        mediaReady,
        toggleMute,
        toggleVideo,
        toggleScreenShare,
        raiseHand,
        sendChatMessage,
        sendChatFile,
        retryMessage,
        endMeeting,
        leaveMeeting,
        muteParticipant,
        addParticipant,
        switchAudioDevice,
        switchVideoDevice,
        handleWsMessage,
        // Phase 1 — Resilience Pack additions:
        fsmState,
        connectionBanner,
        // Phase 5 — Mesh quality additions:
        activeSpeakerId,
        requestPeerQuality,
    };
}

// Silence the unused-warning for these helpers — they're exported for tests
void upsertCachedMessage;
void applyCachedMessages;