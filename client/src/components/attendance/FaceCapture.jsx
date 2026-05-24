import { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, RotateCcw, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { loadFaceModels, extractDescriptor, getWebcamStream, stopStream } from '../../utils/faceApi';
import s from './FaceCapture.module.css';

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
    captureLabel = 'Capture',
    capturingLabel = 'Capturing...',
    onCapture,
    onError,
    disabled = false,
}) {
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const [state, setState] = useState('idle'); // idle | loading | ready | capturing | error
    const [error, setError] = useState(null);

    const start = useCallback(async () => {
        setState('loading');
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
            setState('ready');
        } catch (err) {
            const msg = err?.message || 'Failed to start camera';
            setError(msg);
            setState('error');
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
        if (!videoRef.current || state !== 'ready') return;
        setState('capturing');
        setError(null);
        try {
            const descriptor = await extractDescriptor(videoRef.current);
            if (!descriptor) {
                setError("Couldn't detect a face. Make sure your face is clearly visible and well-lit.");
                setState('ready');
                return;
            }
            await onCapture?.(descriptor);
            setState('ready');
        } catch (err) {
            const msg = err?.message || 'Failed to capture face';
            setError(msg);
            setState('ready');
            onError?.(msg);
        }
    }, [onCapture, onError, state]);

    return (
        <div className={s.wrap}>
            <div className={s.videoWrap}>
                <video ref={videoRef} className={s.video} muted playsInline />
                {state === 'loading' && (
                    <div className={s.overlay}>
                        <Loader2 size={26} className={s.spin} />
                        <div className={s.overlayText}>Starting camera…</div>
                    </div>
                )}
                {state === 'error' && (
                    <div className={s.overlay}>
                        <AlertTriangle size={26} />
                        <div className={s.overlayText}>{error}</div>
                        <button type="button" className="btn btn-sm" onClick={start}>
                            <RotateCcw size={14} /> Retry
                        </button>
                    </div>
                )}
                {state === 'capturing' && (
                    <div className={s.overlay}>
                        <Loader2 size={26} className={s.spin} />
                        <div className={s.overlayText}>Analysing…</div>
                    </div>
                )}
                {state === 'ready' && (
                    <div className={s.frameGuide} aria-hidden="true" />
                )}
            </div>

            {error && state !== 'error' && (
                <div className={s.err}>
                    <AlertTriangle size={14} /> {error}
                </div>
            )}

            <div className={s.actions}>
                <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleCapture}
                    disabled={disabled || state !== 'ready'}
                >
                    {state === 'capturing'
                        ? (<><Loader2 size={14} className={s.spin} /> {capturingLabel}</>)
                        : (<><Camera size={14} /> {captureLabel}</>)}
                </button>
            </div>
        </div>
    );
}