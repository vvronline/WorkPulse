import React, { useRef, useEffect, useState, memo } from 'react';
import { MicOff, Hand } from 'lucide-react';

/**
 * VideoSDK-style participant tile.
 * Shows video when available, avatar initial when not.
 * Name overlay at bottom, mic indicator. Raised hand at top-right.
 * Highlights the tile (green ring) when the participant is speaking.
 */
const ParticipantTile = memo(function ParticipantTile({ participant, isLocal, quality, isMini }) {
    const videoRef = useRef(null);
    const { stream, name, muted: pMuted, videoOff: pVideoOff, raisedHand } = participant || {};
    const [speaking, setSpeaking] = useState(false);

    useEffect(() => {
        if (!videoRef.current) return;
        if (stream && !pVideoOff) {
            videoRef.current.srcObject = stream;
        } else {
            videoRef.current.srcObject = null;
        }
    }, [stream, pVideoOff]);

    // Speaking detection via Web Audio analyser on the participant's audio track.
    // Skipped when muted (no point measuring) and torn down on stream change/unmount.
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

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;

        let ctx;
        let source;
        let analyser;
        let rafId;
        let cancelled = false;
        const data = new Uint8Array(64);
        let lastSpeaking = false;
        let aboveSince = 0;
        let belowSince = 0;

        try {
            ctx = new AudioCtx();
            source = ctx.createMediaStreamSource(stream);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.6;
            source.connect(analyser);
        } catch {
            return;
        }

        const SPEAKING_THRESHOLD = 18;   // 0–255 average; tune as needed
        const ENTER_MS = 120;            // must be above threshold this long to turn on
        const EXIT_MS = 400;             // must be below threshold this long to turn off

        const tick = () => {
            if (cancelled) return;
            analyser.getByteFrequencyData(data);
            // Average low-mid band (voice range)
            let sum = 0;
            const len = data.length;
            for (let i = 0; i < len; i++) sum += data[i];
            const avg = sum / len;
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
            try { source && source.disconnect(); } catch { /* ignore */ }
            try { analyser && analyser.disconnect(); } catch { /* ignore */ }
            try { ctx && ctx.close(); } catch { /* ignore */ }
            setSpeaking(false);
        };
    }, [stream, pMuted]);

    const showVideo = stream && !pVideoOff;
    const initial = (name || '?').charAt(0).toUpperCase();
    const displayName = isLocal ? `${name || 'You'} (You)` : (name || 'Participant');

    return (
        <div className={`mr-tile ${isLocal ? 'mr-tile--local' : ''} ${speaking ? 'mr-tile--speaking' : ''}`}>
            {showVideo ? (
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted={isLocal}
                    style={isLocal ? { transform: 'scaleX(-1)' } : undefined}
                />
            ) : (
                <div className="mr-tile-avatar">{initial}</div>
            )}

            {/* Hidden video for srcObject attachment when not shown */}
            {!showVideo && <video ref={videoRef} style={{ display: 'none' }} />}

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
