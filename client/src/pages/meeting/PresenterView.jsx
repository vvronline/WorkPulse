import React, { useRef, useEffect } from 'react';
import { MonitorUp } from 'lucide-react';
import './MeetingRoom.css';

/**
 * Full-screen presenter view when someone is sharing their screen.
 * Shows the screen share as the main content with a small camera inset.
 */
export default function PresenterView({ presenterStream, presenterName, isLocal, localStream }) {
    const screenRef = useRef(null);
    const camRef = useRef(null);

    useEffect(() => {
        if (!screenRef.current) return;
        screenRef.current.srcObject = presenterStream || null;
        if (presenterStream) screenRef.current.play().catch(() => {});
    }, [presenterStream]);

    useEffect(() => {
        if (!camRef.current || !isLocal) return;
        camRef.current.srcObject = localStream || null;
        if (localStream) camRef.current.play().catch(() => {});
    }, [localStream, isLocal]);

    return (
        <div className="pv-root">
            <div className="pv-label">
                <span className="pv-icon"><MonitorUp size={18} /></span>
                <span>{presenterName || 'Participant'} is presenting</span>
            </div>
            <div className="pv-screen-wrap">
                {presenterStream ? (
                    <video ref={screenRef} autoPlay playsInline className="pv-screen" />
                ) : (
                    <div className="pv-placeholder">Waiting for screen share…</div>
                )}
            </div>
            {isLocal && localStream && (
                <div className="pv-cam-inset">
                    <video ref={camRef} autoPlay playsInline muted className="pv-cam-video" />
                </div>
            )}
        </div>
    );
}
