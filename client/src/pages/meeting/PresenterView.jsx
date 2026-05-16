import React, { useRef, useEffect } from 'react';

/**
 * PresenterView — shows the screen share in a large tile.
 */
export default function PresenterView({ presenterStream, presenterName }) {
    const videoRef = useRef(null);

    useEffect(() => {
        if (videoRef.current && presenterStream) {
            videoRef.current.srcObject = presenterStream;
        }
    }, [presenterStream]);

    if (!presenterStream) return null;

    return (
        <div className="mr-tile" style={{ aspectRatio: 'auto', width: '100%', height: '100%' }}>
            <video
                ref={videoRef}
                autoPlay
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 'var(--mr-radius)' }}
            />
            <div className="mr-tile-overlay mr-tile-overlay--visible">
                <span className="mr-tile-name">📺 {presenterName || 'Screen Share'}</span>
            </div>
        </div>
    );
}
