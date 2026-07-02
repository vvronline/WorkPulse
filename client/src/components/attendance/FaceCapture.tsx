import { useEffect, useRef, useState, useCallback } from "react";
import { Camera, RotateCcw, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { loadFaceModels, extractDescriptor, detectFaceScore, getWebcamStream, stopStream } from "../../utils/faceApi";
import s from "./FaceCapture.module.css";

type CaptureState = "idle" | "loading" | "ready" | "capturing" | "error";

interface FaceCaptureProps {
    autoStart?: boolean;
    /** When true, automatically captures once a face is steadily detected
     *  (no button press needed). The manual button remains as a fallback. */
    autoCapture?: boolean;
    captureLabel?: string;
    capturingLabel?: string;
    onCapture?: (descriptor: number[] | Float32Array) => void | Promise<void>;
    onError?: (msg: string) => void;
    disabled?: boolean;
}

// Auto-capture tuning: poll the video ~2x/sec with the cheap detector and
// fire once we've seen a confident face on N consecutive polls (avoids
// capturing a half-turned face mid-motion).
const AUTO_POLL_MS = 500;
const AUTO_CONSECUTIVE_HITS = 2;

/**
 * Reusable webcam + face-descriptor capture widget.
 *
 * Usage:
 *   <FaceCapture
 *       autoStart
 *       onCapture={descriptor => ...}
 *       captureLabel="Enroll Face"
 *   />
 *
 * - Loads face-api.js models on mount (lazy, ~6 MB total — cached after first load).
 * - Streams webcam into a <video>.
 * - On "Capture" button, extracts the 128-float descriptor from the current
 *   video frame and calls `onCapture(descriptor)`.
 * - Stops the camera stream on unmount.
 */
export default function FaceCapture({
    autoStart = true,
    autoCapture = false,
    captureLabel = "Capture",
    capturingLabel = "Capturing...",
    onCapture,
    onError,
    disabled = false,
}: FaceCaptureProps) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [state, setState] = useState<CaptureState>("idle");
    const [error, setError] = useState<string | null>(null);
    const [faceSeen, setFaceSeen] = useState(false);

    const start = useCallback(async () => {
        setState("loading");
        setError(null);
        try {
            // Load the model weights first (one-time, cached by the browser).
            await loadFaceModels();
            const stream = await getWebcamStream();
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play().catch(() => { /* autoplay may fail silently */ });
            }
            setState("ready");
        } catch (err) {
            const msg = (err as Error)?.message || "Failed to start camera";
            setError(msg);
            setState("error");
            onError?.(msg);
        }
    }, [onError]);

    const stop = useCallback(() => {
        stopStream(streamRef.current);
        streamRef.current = null;
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
    }, []);

    useEffect(() => {
        if (autoStart) start();
        return () => stop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleCapture = useCallback(async () => {
        if (!videoRef.current || state !== "ready") return;
        setState("capturing");
        setError(null);
        try {
            const descriptor = await extractDescriptor(videoRef.current);
            if (!descriptor) {
                setError("Couldn't detect a face. Make sure your face is clearly visible and well-lit.");
                setState("ready");
                return;
            }
            await onCapture?.(descriptor);
            setState("ready");
        } catch (err) {
            const msg = (err as Error)?.message || "Failed to capture face";
            setError(msg);
            setState("ready");
            onError?.(msg);
        }
    }, [onCapture, onError, state]);

    // Auto-capture loop: cheap detector polls the live video; after N
    // consecutive confident hits we run the full capture automatically.
    // Cancels itself when disabled / a capture is in flight / unmount.
    useEffect(() => {
        if (!autoCapture || disabled || state !== "ready") return;
        let cancelled = false;
        let hits = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const poll = async () => {
            if (cancelled) return;
            try {
                const score = await detectFaceScore(videoRef.current);
                if (cancelled) return;
                if (score != null && score >= 0.5) {
                    hits++;
                    setFaceSeen(true);
                    if (hits >= AUTO_CONSECUTIVE_HITS) {
                        handleCapture();
                        return; // state change re-arms the effect after capture
                    }
                } else {
                    hits = 0;
                    setFaceSeen(false);
                }
            } catch { /* model not ready yet — keep polling */ }
            timer = setTimeout(poll, AUTO_POLL_MS);
        };
        timer = setTimeout(poll, AUTO_POLL_MS);

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [autoCapture, disabled, state, handleCapture]);

    return (
        <div className={s.wrap}>
            <div className={s.videoWrap}>
                <video ref={videoRef} className={s.video} muted playsInline />
                {state === "loading" && (
                    <div className={s.overlay}>
                        <Loader2 size={26} className={s.spin} />
                        <div className={s.overlayText}>Starting camera…</div>
                    </div>
                )}
                {state === "error" && (
                    <div className={s.overlay}>
                        <AlertTriangle size={26} />
                        <div className={s.overlayText}>{error}</div>
                        <button type="button" className="btn btn-sm" onClick={start}>
                            <RotateCcw size={14} /> Retry
                        </button>
                    </div>
                )}
                {state === "capturing" && (
                    <div className={s.overlay}>
                        <Loader2 size={26} className={s.spin} />
                        <div className={s.overlayText}>Analysing…</div>
                    </div>
                )}
                {state === "ready" && (
                    <div className={s.frameGuide} aria-hidden="true" />
                )}
                {autoCapture && state === "ready" && (
                    <div className={s.autoHint}>
                        {faceSeen
                            ? <><CheckCircle2 size={13} /> Face detected — capturing…</>
                            : "Position your face in the frame"}
                    </div>
                )}
            </div>

            {error && state !== "error" && (
                <div className={s.err}>
                    <AlertTriangle size={14} /> {error}
                </div>
            )}

            <div className={s.actions}>
                <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleCapture}
                    disabled={disabled || state !== "ready"}
                >
                    {state === "capturing"
                        ? (<><Loader2 size={14} className={s.spin} /> {capturingLabel}</>)
                        : (<><Camera size={14} /> {captureLabel}</>)}
                </button>
            </div>
        </div>
    );
}