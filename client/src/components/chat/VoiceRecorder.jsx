import s from './VoiceRecorder.module.css';
import { useState, useRef, useCallback, useEffect } from 'react';

export default function VoiceRecorder({ onSend, onCancel }) {
    const [recording, setRecording] = useState(false);
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState('');
    const mediaRef = useRef(null);
    const chunksRef = useRef([]);
    const timerRef = useRef(null);
    const streamRef = useRef(null);
    const durationRef = useRef(0);

    const start = useCallback(async () => {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            setError('Voice messages require HTTPS');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
            const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            const ext = (mr.mimeType || mimeType || '').includes('mp4') ? 'mp4' : 'webm';
            mediaRef.current = mr;
            chunksRef.current = [];
            mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
            mr.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
                stream.getTracks().forEach(t => t.stop());
                onSend(blob, durationRef.current, ext);
            };
            mr.start();
            setRecording(true);
            setDuration(0);
            durationRef.current = 0;
            timerRef.current = setInterval(() => setDuration(d => { durationRef.current = d + 1; return d + 1; }), 1000);
        } catch (err) {
            const msg = err?.name === 'NotAllowedError'
                ? 'Microphone blocked — click the 🔒 icon in the address bar and allow microphone'
                : err?.name === 'NotFoundError'
                ? 'No microphone found'
                : 'Could not access microphone';
            setError(msg);
        }
    }, [onSend]);

    const stop = useCallback(() => {
        clearInterval(timerRef.current);
        if (mediaRef.current?.state === 'recording') mediaRef.current.stop();
        setRecording(false);
    }, []);

    const cancel = useCallback(() => {
        clearInterval(timerRef.current);
        if (mediaRef.current?.state === 'recording') {
            mediaRef.current.onstop = null;
            mediaRef.current.stop();
        }
        streamRef.current?.getTracks().forEach(t => t.stop());
        setRecording(false);
        onCancel?.();
    }, [onCancel]);

    useEffect(() => {
        start();
        return () => {
            clearInterval(timerRef.current);
            streamRef.current?.getTracks().forEach(t => t.stop());
        };
    }, []);

    // Auto-dismiss error after 3s
    useEffect(() => {
        if (!error) return;
        const t = setTimeout(() => onCancel?.(), 3000);
        return () => clearTimeout(t);
    }, [error, onCancel]);

    const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

    if (error) {
        return (
            <div className={s.recorderError}>
                <span className={s.errorMsg}>⚠ {error}</span>
                <button className={s.cancelBtn} onClick={cancel} title="Close">✕</button>
            </div>
        );
    }

    return (
        <div className={s.recorder}>
            <button className={s.cancelBtn} onClick={cancel} title="Cancel">✕</button>
            <div className={s.wave}>
                <span className={s.dot} />
                <span className={s.time}>{fmt(duration)}</span>
            </div>
            <button className={s.sendBtn} onClick={stop} title="Send voice message">
                ➤
            </button>
        </div>
    );
}
