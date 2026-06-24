// CameraCapture — a small modal that opens the device webcam via
// getUserMedia, shows a live preview, and lets the user snap a photo. The
// captured frame is converted to a JPEG File and handed back to the caller
// (the chat composer) which uploads it like any other image attachment.
//
// This replaces the old hidden <input capture="environment"> approach which
// only triggers a real camera on mobile; on desktop the OS ignored `capture`
// and showed the file picker instead. getUserMedia works on both the web app
// and the packaged Electron desktop (camera permission is granted in
// desktop/main.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Camera, RotateCcw } from "lucide-react";
import s from "./CameraCapture.module.css";

interface CameraCaptureProps {
    onCapture: (file: File) => void;
    onClose: () => void;
}

export default function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(true);
    const [preview, setPreview] = useState<string | null>(null);

    const stopStream = useCallback(() => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
        }
    }, []);

    const startCamera = useCallback(async () => {
        setError(null);
        setStarting(true);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user" },
                audio: false,
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play().catch(() => {});
            }
        } catch (err) {
            const name = (err as Error)?.name;
            if (name === "NotAllowedError") {
                setError("Camera access was blocked. Please allow camera access and try again.");
            } else if (name === "NotFoundError") {
                setError("No camera was found on this device.");
            } else {
                setError((err as Error)?.message || "Could not start the camera.");
            }
        } finally {
            setStarting(false);
        }
    }, []);

    useEffect(() => {
        startCamera();
        return () => stopStream();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Close on Escape.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const capture = useCallback(() => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas) return;
        const w = video.videoWidth || 1280;
        const h = video.videoHeight || 720;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);
        setPreview(canvas.toDataURL("image/jpeg", 0.92));
        stopStream();
    }, [stopStream]);

    const retake = useCallback(() => {
        setPreview(null);
        startCamera();
    }, [startCamera]);

    const usePhoto = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.toBlob(
            (blob) => {
                if (!blob) return;
                const file = new File([blob], `photo-${Date.now()}.jpg`, {
                    type: "image/jpeg",
                });
                onCapture(file);
                onClose();
            },
            "image/jpeg",
            0.92,
        );
    }, [onCapture, onClose]);

    return (
        <div className={s.overlay} onClick={onClose}>
            <div className={s.modal} onClick={(e) => e.stopPropagation()}>
                <div className={s.header}>
                    <span className={s.title}>Take a photo</span>
                    <button type="button" className={s.closeBtn} onClick={onClose} aria-label="Close">
                        <X size={18} />
                    </button>
                </div>

                <div className={s.body}>
                    {error ? (
                        <div className={s.error}>
                            <span>{error}</span>
                            <button type="button" className={s.retryBtn} onClick={startCamera}>
                                Try again
                            </button>
                        </div>
                    ) : preview ? (
                        <img src={preview} alt="Captured" className={s.preview} />
                    ) : (
                        <>
                            <video
                                ref={videoRef}
                                className={s.video}
                                playsInline
                                muted
                                autoPlay
                            />
                            {starting && <div className={s.starting}>Starting camera…</div>}
                        </>
                    )}
                    <canvas ref={canvasRef} style={{ display: "none" }} />
                </div>

                {!error && (
                    <div className={s.footer}>
                        {preview ? (
                            <>
                                <button type="button" className={s.secondaryBtn} onClick={retake}>
                                    <RotateCcw size={16} /> Retake
                                </button>
                                <button type="button" className={s.primaryBtn} onClick={usePhoto}>
                                    Send photo
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                className={s.captureBtn}
                                onClick={capture}
                                disabled={starting}
                                aria-label="Capture photo"
                            >
                                <Camera size={20} />
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}