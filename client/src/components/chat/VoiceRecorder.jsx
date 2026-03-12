import s from './VoiceRecorder.module.css';
import { useState, useRef, useCallback, useEffect } from 'react';

export default function VoiceRecorder({ onSend, onCancel }) {
    const [recording, setRecording] = useState(false);
    const [duration, setDuration] = useState(0);
    const mediaRef = useRef(null);
    const chunksRef = useRef([]);
    const timerRef = useRef(null);
    const streamRef = useRef(null);

    const start = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            mediaRef.current = mr;
            chunksRef.current = [];
            mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
            mr.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
                stream.getTracks().forEach(t => t.stop());
                onSend(blob, duration);
            };
            mr.start();
            setRecording(true);
            setDuration(0);
            timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
        } catch {
            onCancel?.();
        }
    }, [onSend, onCancel, duration]);

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
        if (!recording) start();
        return () => clearInterval(timerRef.current);
    }, []);

    const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

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
