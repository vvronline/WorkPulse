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
    const analyserRef = useRef(null);
    const rafRef = useRef(null);
    const barsRef = useRef(null);

    const NUM_BARS = 28;

    const drawWaveform = useCallback(() => {
        const analyser = analyserRef.current;
        const bars = barsRef.current;
        if (!analyser || !bars) return;
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const step = Math.floor(data.length / NUM_BARS);
        const children = bars.children;
        for (let i = 0; i < NUM_BARS && i < children.length; i++) {
            const val = data[i * step] / 255;
            const height = Math.max(4, val * 28);
            children[i].style.height = `${height}px`;
        }
        rafRef.current = requestAnimationFrame(drawWaveform);
    }, []);

    const start = useCallback(async () => {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            setError('Voice messages require HTTPS');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            // Set up audio analyser for waveform
            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyserRef.current = analyser;

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
                audioCtx.close();
                onSend(blob, durationRef.current, ext);
            };
            mr.start();
            setRecording(true);
            setDuration(0);
            durationRef.current = 0;
            timerRef.current = setInterval(() => setDuration(d => { durationRef.current = d + 1; return d + 1; }), 1000);
            rafRef.current = requestAnimationFrame(drawWaveform);
        } catch (err) {
            const msg = err?.name === 'NotAllowedError'
                ? 'Microphone blocked — click the lock/tune icon in the address bar to allow microphone. If the setting is locked, your organization may be blocking it.'
                : err?.name === 'NotFoundError'
                ? 'No microphone found'
                : 'Could not access microphone';
            setError(msg);
        }
    }, [onSend, drawWaveform]);

    const stop = useCallback(() => {
        clearInterval(timerRef.current);
        cancelAnimationFrame(rafRef.current);
        if (mediaRef.current?.state === 'recording') mediaRef.current.stop();
        setRecording(false);
    }, []);

    const cancel = useCallback(() => {
        clearInterval(timerRef.current);
        cancelAnimationFrame(rafRef.current);
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
            cancelAnimationFrame(rafRef.current);
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
                <svg className={s.errorIcon} width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M8 4.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <circle cx="8" cy="11" r="0.75" fill="currentColor"/>
                </svg>
                <span className={s.errorMsg}>{error}</span>
                <button className={s.cancelBtn} onClick={cancel} title="Close">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                </button>
            </div>
        );
    }

    return (
        <div className={s.recorder}>
            <button className={s.cancelBtn} onClick={cancel} title="Cancel recording">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <rect x="3" y="3" width="12" height="12" rx="2" fill="currentColor"/>
                </svg>
            </button>

            <div className={s.liveIndicator}>
                <span className={s.dot} />
                <span className={s.time}>{fmt(duration)}</span>
            </div>

            <div className={s.waveform} ref={barsRef}>
                {Array.from({ length: NUM_BARS }, (_, i) => (
                    <span key={i} className={s.bar} />
                ))}
            </div>

            <button className={s.sendBtn} onClick={stop} title="Send voice message">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M3 10l6-7v4.5h8v5h-8V17L3 10z" fill="currentColor"/>
                </svg>
            </button>
        </div>
    );
}
