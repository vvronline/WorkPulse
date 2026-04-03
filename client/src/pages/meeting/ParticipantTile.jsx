import React, { useRef, useEffect } from 'react';
import './MeetingRoom.css';

/**
 * Single participant video tile in the meeting grid.
 */
export default function ParticipantTile({ participant, isLocal, localStream, screenStream, screenSharing, quality }) {
    const videoRef = useRef(null);

    const stream = isLocal
        ? (screenSharing && screenStream ? screenStream : localStream)
        : participant?.stream;

    useEffect(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream || null;
        if (stream) videoRef.current.play().catch(() => {});
    }, [stream]);

    const name = isLocal ? 'You' : (participant?.name || 'Participant');
    const videoOff = isLocal
        ? !localStream?.getVideoTracks().some(t => t.enabled)
        : !participant?.stream;
    const muted = isLocal
        ? !localStream?.getAudioTracks().some(t => t.enabled)
        : participant?.muted;
    const raisedHand = participant?.raisedHand;

    const qualityColor = { good: '#10b981', medium: '#f59e0b', poor: '#ef4444' };

    return (
        <div className={`pt-tile ${isLocal ? 'pt-local' : ''}`}>
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
                    className={`pt-video ${isLocal ? 'pt-mirror' : ''}`}
                />
            )}

            <div className="pt-overlay">
                <div className="pt-name-row">
                    {raisedHand && <span className="pt-hand">✋</span>}
                    <span className="pt-name">{name}</span>
                    {muted && <span className="pt-muted-icon">🔇</span>}
                    {quality && (
                        <span className="pt-quality-dot" style={{ background: qualityColor[quality] || '#6366f1' }} title={`Connection: ${quality}`} />
                    )}
                </div>
            </div>
        </div>
    );
}
