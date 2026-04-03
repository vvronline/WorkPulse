import React, { useRef, useEffect, useState } from 'react';
import './MeetingRoom.css';

/**
 * Single participant video tile in the meeting grid.
 * Now supports remote muted/videoOff state from track state sync.
 */
export default function ParticipantTile({ participant, isLocal, localStream, screenStream, screenSharing, quality, userName, muted: localMuted, videoOff: localVideoOff }) {
    const videoRef = useRef(null);
    const [audioLevel, setAudioLevel] = useState(0);

    const stream = isLocal
        ? (screenSharing && screenStream ? screenStream : localStream)
        : participant?.stream;

    useEffect(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream || null;
        if (stream) videoRef.current.play().catch(() => {});
    }, [stream]);

    // Audio level indicator (visual only)
    useEffect(() => {
        if (!stream) return;
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) return;
        let ctx, analyser, source, animId;
        try {
            ctx = new AudioContext();
            analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source = ctx.createMediaStreamSource(stream);
            source.connect(analyser);
            const data = new Uint8Array(analyser.frequencyBinCount);
            const tick = () => {
                analyser.getByteFrequencyData(data);
                const avg = data.reduce((a, b) => a + b, 0) / data.length;
                setAudioLevel(Math.min(avg / 128, 1));
                animId = requestAnimationFrame(tick);
            };
            tick();
        } catch { /* ignore */ }
        return () => {
            cancelAnimationFrame(animId);
            ctx?.close().catch(() => {});
        };
    }, [stream]);

    const name = isLocal ? (userName || 'You') : (participant?.name || 'Participant');
    const videoOff = isLocal
        ? (localVideoOff !== undefined ? localVideoOff : !localStream?.getVideoTracks().some(t => t.enabled))
        : (participant?.videoOff || !participant?.stream?.getVideoTracks().some(t => t.enabled));
    const muted = isLocal
        ? (localMuted !== undefined ? localMuted : !localStream?.getAudioTracks().some(t => t.enabled))
        : participant?.muted;
    const raisedHand = participant?.raisedHand;
    const isScreenSharing = !isLocal && participant?.screenSharing;

    const qualityColor = { good: '#10b981', medium: '#f59e0b', poor: '#ef4444' };
    const borderGlow = audioLevel > 0.15 && !muted ? `0 0 0 2px rgba(99, 102, 241, ${Math.min(audioLevel, 0.8)})` : 'none';

    return (
        <div className={`pt-tile ${isLocal ? 'pt-local' : ''}`} style={{ boxShadow: borderGlow }}>
            {videoOff ? (
                <div className="pt-avatar-wrap">
                    <span className="pt-avatar">{name[0].toUpperCase()}</span>
                </div>
            ) : (
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted={isLocal}
                    className={`pt-video ${isLocal && !screenSharing ? 'pt-mirror' : ''}`}
                />
            )}

            <div className="pt-overlay">
                <div className="pt-name-row">
                    {raisedHand && <span className="pt-hand">✋</span>}
                    {isScreenSharing && <span className="pt-screen-icon" title="Screen sharing">🖥️</span>}
                    <span className="pt-name">{name}{isLocal ? ' (You)' : ''}</span>
                    {muted && <span className="pt-muted-icon">🔇</span>}
                    {!muted && audioLevel > 0.1 && (
                        <span className="pt-speaking-icon" title="Speaking">🔊</span>
                    )}
                    {quality && (
                        <span className="pt-quality-dot" style={{ background: qualityColor[quality] || '#6366f1' }} title={`Connection: ${quality}`} />
                    )}
                </div>
            </div>
        </div>
    );
}
