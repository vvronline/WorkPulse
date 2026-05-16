import React, { useRef, useEffect, memo } from 'react';

/**
 * VideoSDK-style participant tile.
 * Shows video when available, avatar initial when not.
 * Name overlay at bottom, mic/hand indicators.
 * No audio level visualization for performance.
 */
const ParticipantTile = memo(function ParticipantTile({ participant, isLocal, quality, isMini }) {
    const videoRef = useRef(null);
    const { stream, name, muted: pMuted, videoOff: pVideoOff, raisedHand } = participant || {};

    useEffect(() => {
        if (!videoRef.current) return;
        if (stream && !pVideoOff) {
            videoRef.current.srcObject = stream;
        } else {
            videoRef.current.srcObject = null;
        }
    }, [stream, pVideoOff]);

    const showVideo = stream && !pVideoOff;
    const initial = (name || '?').charAt(0).toUpperCase();
    const displayName = isLocal ? `${name || 'You'} (You)` : (name || 'Participant');

    return (
        <div className={`mr-tile ${isLocal ? 'mr-tile--local' : ''}`}>
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

            {/* Name overlay */}
            <div className="mr-tile-overlay mr-tile-overlay--visible">
                <span className="mr-tile-name">{displayName}</span>
                <span className="mr-tile-icons">
                    {pMuted && (
                        <span className="mr-tile-icon mr-tile-icon--muted" title="Muted">
                            🔇
                        </span>
                    )}
                    {raisedHand && (
                        <span className="mr-tile-icon mr-tile-icon--hand" title="Hand raised">
                            ✋
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
