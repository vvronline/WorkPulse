import React, { useRef, useEffect } from "react";
import { MonitorUp } from "lucide-react";

interface PresenterViewProps {
    presenterStream: MediaStream | null;
    presenterName?: string;
    isLocal?: boolean;
}

/**
 * PresenterView — shows the screen share in a large tile.
 * Uses `object-fit: contain` so the entire shared screen is visible without
 * cropping, which is the standard convention for screen-share panels in
 * Zoom/Meet/Teams and the videosdk-rtc-react-sdk example.
 */
export default function PresenterView({ presenterStream, presenterName, isLocal }: PresenterViewProps) {
    const videoRef = useRef<HTMLVideoElement | null>(null);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !presenterStream) return;
        if (video.srcObject !== presenterStream) {
            video.srcObject = presenterStream;
        }
        // Aggressively start playback — same reasoning as ParticipantTile:
        // browsers may silently block autoplay of an un-muted (or even muted)
        // remote video element until we explicitly call play().
        const tryPlay = () => {
            const p = video.play();
            if (p && typeof p.catch === "function")
                p.catch(() => {
                    /* retry */
                });
        };
        tryPlay();
        video.addEventListener("loadedmetadata", tryPlay);
        video.addEventListener("canplay", tryPlay);
        return () => {
            video.removeEventListener("loadedmetadata", tryPlay);
            video.removeEventListener("canplay", tryPlay);
        };
    }, [presenterStream]);

    if (!presenterStream) return null;

    return (
        <div className="mr-tile mr-tile--presenter">
            <video ref={videoRef} autoPlay playsInline muted className="mr-tile-screen" />
            <div className="mr-tile-overlay mr-tile-overlay--visible">
                <span className="mr-tile-name">
                    <MonitorUp size={13} style={{ verticalAlign: "middle", marginRight: 6 }} />
                    {isLocal ? "You are presenting" : `${presenterName || "Participant"} is presenting`}
                </span>
            </div>
        </div>
    );
}