import React, { useRef, useEffect, useState, memo } from "react";
import { MicOff, Hand, Loader2, WifiOff } from "lucide-react";

// A single shared AudioContext for all participant tiles. Browsers cap the
// number of concurrent contexts, and creating one per tile (especially with
// many remote participants) can interfere with WebRTC audio/video pipelines.
let sharedAudioCtx: AudioContext | null = null;
function getSharedAudioCtx(): AudioContext | null {
    if (sharedAudioCtx) return sharedAudioCtx;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    try {
        sharedAudioCtx = new AudioCtx();
    } catch {
        sharedAudioCtx = null;
    }
    return sharedAudioCtx;
}

interface ParticipantTileProps {
    participant: any;
    isLocal?: boolean;
    quality?: string;
    isMini?: boolean;
    isActiveSpeaker?: boolean;
    onVisibilityChange?: (q: "q" | "h") => void;
}

/**
 * VideoSDK-style participant tile.
 * Shows video when available, avatar initial when not.
 * Name overlay at bottom, mic indicator. Raised hand at top-right.
 * Highlights the tile (green ring) when the participant is speaking.
 */
const ParticipantTile = memo(function ParticipantTile({
    participant,
    isLocal,
    quality,
    isMini,
    /** Phase 5 — true when this participant is the loudest speaker. */
    isActiveSpeaker = false,
    /** Phase 5 — fired with ('q' | 'h') when this tile scrolls in/out
     *  of view. Sender flips its upstream bitrate accordingly. Pass
     *  undefined for local / mini tiles where there's nothing to ask. */
    onVisibilityChange,
}: ParticipantTileProps) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const tileRootRef = useRef<HTMLDivElement | null>(null);
    const {
        stream,
        name,
        muted: pMuted,
        videoOff: pVideoOff,
        raisedHand,
        connectionState,
        avatar,
    } = participant || {};
    const [avatarFailed, setAvatarFailed] = useState(false);

    // Resolve avatar to a full URL when the backend returns a relative path
    // (e.g. "/uploads/avatars/xyz.png"). Same logic as ProfileMenu.
    const avatarUrl = avatar
        ? avatar.startsWith("http")
            ? avatar
            : `${window.location.origin}${avatar.startsWith("/") ? "" : "/"}${avatar}`
        : null;
    const [speaking, setSpeaking] = useState(false);
    const [videoReady, setVideoReady] = useState(false);

    // Attach the MediaStream and aggressively try to start playback. Remote
    // <video> elements aren't `muted`, so some browsers (Safari, locked-down
    // Chrome contexts) silently block autoplay until we call play() ourselves
    // after the user-gesture that joined the meeting. Re-trying on
    // loadedmetadata / canplay covers the case where the video track arrives
    // a moment after audio (mesh re-negotiation) so the element initially has
    // no frame to paint.
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        if (stream && !pVideoOff) {
            if (video.srcObject !== stream) {
                video.srcObject = stream;
            }
            setVideoReady(false);

            const tryPlay = () => {
                const p = video.play();
                if (p && typeof p.catch === "function") {
                    p.catch(() => {
                        /* autoplay blocked — retry on next event */
                    });
                }
            };
            const markReady = () => {
                setVideoReady(true);
                tryPlay();
            };

            tryPlay();
            video.addEventListener("loadedmetadata", markReady);
            video.addEventListener("canplay", markReady);
            video.addEventListener("playing", markReady);

            return () => {
                video.removeEventListener("loadedmetadata", markReady);
                video.removeEventListener("canplay", markReady);
                video.removeEventListener("playing", markReady);
            };
        } else {
            if (video.srcObject) video.srcObject = null;
            setVideoReady(false);
        }
    }, [stream, pVideoOff]);

    // Speaking detection — uses a shared AudioContext + per-tile analyser on an
    // audio-only MediaStream containing just this participant's audio track.
    // Important: we build a *new* MediaStream wrapping only the audio track so
    // the analyser graph cannot interfere with the original stream's video
    // playback inside <video>. Skipped when muted or no audio track.
    useEffect(() => {
        if (!stream || pMuted) {
            setSpeaking(false);
            return;
        }
        const audioTracks = stream.getAudioTracks?.() || [];
        if (audioTracks.length === 0) {
            setSpeaking(false);
            return;
        }

        const ctx = getSharedAudioCtx();
        if (!ctx) return;

        let source: MediaStreamAudioSourceNode | undefined;
        let analyser: AnalyserNode | undefined;
        let rafId: number;
        let cancelled = false;
        const data = new Uint8Array(64);
        let lastSpeaking = false;
        let aboveSince = 0;
        let belowSince = 0;

        // Build an audio-only clone of the stream for the analyser. This
        // isolates the analyser graph from the original MediaStream that the
        // <video> element is rendering, and avoids browser quirks where
        // attaching a MediaStreamSource to a stream that also drives a media
        // element can disrupt playback.
        let audioOnlyStream: MediaStream;
        try {
            audioOnlyStream = new MediaStream([audioTracks[0]]);
            source = ctx.createMediaStreamSource(audioOnlyStream);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.6;
            source.connect(analyser);
        } catch {
            return;
        }

        // Resume context lazily (some browsers start it suspended)
        if (ctx.state === "suspended") {
            ctx.resume().catch(() => {
                /* ignore */
            });
        }

        const SPEAKING_THRESHOLD = 18;
        const ENTER_MS = 120;
        const EXIT_MS = 400;

        const tick = () => {
            if (cancelled) return;
            analyser!.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const avg = sum / data.length;
            const now = performance.now();

            if (avg > SPEAKING_THRESHOLD) {
                belowSince = 0;
                if (!aboveSince) aboveSince = now;
                if (!lastSpeaking && now - aboveSince > ENTER_MS) {
                    lastSpeaking = true;
                    setSpeaking(true);
                }
            } else {
                aboveSince = 0;
                if (!belowSince) belowSince = now;
                if (lastSpeaking && now - belowSince > EXIT_MS) {
                    lastSpeaking = false;
                    setSpeaking(false);
                }
            }
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);

        return () => {
            cancelled = true;
            if (rafId) cancelAnimationFrame(rafId);
            try {
                source && source.disconnect();
            } catch {
                /* ignore */
            }
            try {
                analyser && analyser.disconnect();
            } catch {
                /* ignore */
            }
            // Do NOT close the shared context — other tiles still use it.
            setSpeaking(false);
        };
    }, [stream, pMuted]);

    const hasVideoTrack =
        !!stream && !pVideoOff && stream.getVideoTracks?.().some((t: MediaStreamTrack) => t.readyState === "live");
    const showVideo = hasVideoTrack;
    const initial = (name || "?").charAt(0).toUpperCase();
    const displayName = isLocal ? `${name || "You"} (You)` : name || "Participant";

    // Determine the connection status label to show in the placeholder.
    // Local tile is always considered connected. Remote tiles use the
    // RTCPeerConnection state piped through from useMeetingState. We
    // intentionally collapse "new"/"connecting"/no-state into "Connecting…"
    // so users get clear feedback during the (sometimes multi-second) ICE
    // handshake instead of staring at a blank tile and assuming something
    // is broken.
    const isConnecting =
        !isLocal && (!connectionState || connectionState === "new" || connectionState === "connecting");
    const isReconnecting = !isLocal && (connectionState === "disconnected" || connectionState === "failed");
    const statusLabel = isConnecting ? "Connecting…" : isReconnecting ? "Reconnecting…" : null;

    // ─── Phase 5 — IntersectionObserver receiver-side bandwidth saving ────
    // Once a tile leaves the viewport (off-screen, hidden tab, collapsed
    // sidebar) ask the sender to drop to 'q' (150 kbps). When it comes
    // back into view, ask for 'h' (500 kbps). The active-speaker effect
    // in useMeetingState upgrades to 'f' on top of this.
    useEffect(() => {
        if (!onVisibilityChange || isLocal || isMini) return;
        const el = tileRootRef.current;
        if (!el || typeof IntersectionObserver !== "function") return;
        const obs = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    onVisibilityChange(entry.isIntersecting ? "h" : "q");
                }
            },
            { threshold: 0.1 }
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [onVisibilityChange, isLocal, isMini]);

    return (
        <div
            ref={tileRootRef}
            className={`mr-tile ${isLocal ? "mr-tile--local" : ""} ${speaking ? "mr-tile--speaking" : ""} ${
                isActiveSpeaker ? "mr-tile--active-speaker" : ""
            }`}
        >
            {/* Always-mounted video element. Keeping it in the tree (rather
                than conditionally rendering) means srcObject sticks around
                and the browser keeps the decoder warm — drastically reducing
                the "blank / takes-time-to-show" delay when a peer joins or
                toggles their camera. We just hide it via CSS when there is
                no live video track. */}
            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={isLocal}
                className={`mr-tile-video ${
                    showVideo && videoReady ? "mr-tile-video--visible" : "mr-tile-video--hidden"
                }`}
            />

            {/* Avatar placeholder — shown when there's no live video OR while
                the video element is still buffering its first frame. Sized
                proportionally to the tile so it doesn't look "tiny" in a
                large grid cell. Shows the user's profile picture if they have
                one, otherwise falls back to the first-letter initial. We also
                surface the WebRTC connection state here (Connecting… /
                Reconnecting…) so the user always knows what's going on
                instead of seeing a silent black box. */}
            {(!showVideo || !videoReady) && (
                <div className="mr-tile-placeholder">
                    <div className="mr-tile-avatar">
                        {avatarUrl && !avatarFailed ? (
                            <img
                                src={avatarUrl}
                                alt={name || "Participant"}
                                className="mr-tile-avatar-img"
                                onError={() => setAvatarFailed(true)}
                            />
                        ) : (
                            initial
                        )}
                    </div>
                    {statusLabel && (
                        <div className={`mr-tile-status ${isReconnecting ? "mr-tile-status--warn" : ""}`}>
                            {isReconnecting ? (
                                <WifiOff size={14} />
                            ) : (
                                <Loader2 size={14} className="mr-tile-status-spin" />
                            )}
                            <span>{statusLabel}</span>
                        </div>
                    )}
                </div>
            )}

            {/* Raised hand badge — top right corner */}
            {raisedHand && (
                <span className="mr-tile-hand" title="Hand raised">
                    <Hand size={16} />
                </span>
            )}

            {/* Name overlay */}
            <div className="mr-tile-overlay mr-tile-overlay--visible">
                <span className="mr-tile-name">{displayName}</span>
                <span className="mr-tile-icons">
                    {pMuted && (
                        <span className="mr-tile-icon mr-tile-icon--muted" title="Muted">
                            <MicOff size={12} />
                        </span>
                    )}
                </span>
            </div>

            {/* Quality dot */}
            {quality && !isMini && (
                <span className={`mr-quality mr-quality--${quality}`} title={`Connection: ${quality}`} />
            )}
        </div>
    );
});

export default ParticipantTile;