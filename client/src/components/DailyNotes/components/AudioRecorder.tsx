/* ─────────────────────────────────────────────────────────
   AudioRecorder — modal dialog that uses MediaRecorder to
   capture microphone audio. Returns a base64 data URL on
   save so the AudioBlot can embed it inline (no backend
   storage required).

   Browser support: Chrome / Edge / Firefox / Safari 14+.
   Falls back to a friendly message if MediaRecorder or
   getUserMedia is unavailable.
   ───────────────────────────────────────────────────────── */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, X, Check, PauseCircle, PlayCircle } from "../../../constants/icons";
import s from "./AudioRecorder.module.css";

function pickMimeType(): string {
    if (typeof MediaRecorder === "undefined") return "";
    const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
    ];
    return candidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
}

type Phase = "idle" | "recording" | "paused" | "preview" | "error";

interface AudioRecorderProps {
    onSave?: (data: { src: string; label: string }) => void;
    onClose: () => void;
}

export default function AudioRecorder({ onSave, onClose }: AudioRecorderProps) {
    const [supported] = useState<boolean>(() =>
        typeof navigator !== "undefined"
        && !!navigator.mediaDevices?.getUserMedia
        && typeof MediaRecorder !== "undefined",
    );
    const [phase, setPhase] = useState<Phase>("idle"); // 'idle' | 'recording' | 'paused' | 'preview' | 'error'
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState("");
    const [previewUrl, setPreviewUrl] = useState("");
    const [savedBlob, setSavedBlob] = useState<Blob | null>(null);

    const recRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const startedAtRef = useRef(0);

    /* Cleanup helper — stop tracks, drop refs */
    const stopStream = () => {
        try { streamRef.current?.getTracks?.().forEach(t => t.stop()); } catch { /* noop */ }
        streamRef.current = null;
    };
    const stopTimer = () => {
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    };

    useEffect(() => () => {
        stopTimer();
        stopStream();
        if (previewUrl) URL.revokeObjectURL(previewUrl);
    }, [previewUrl]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    /* ── Start recording ────────────────────────────────── */
    const startRecording = async () => {
        if (!supported) {
            setError("Audio recording is not supported in this browser.");
            setPhase("error");
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const mimeType = pickMimeType();
            const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            recRef.current = rec;
            chunksRef.current = [];
            rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
            rec.onstop = () => {
                stopStream();
                stopTimer();
                const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
                const url = URL.createObjectURL(blob);
                setSavedBlob(blob);
                setPreviewUrl(url);
                setPhase("preview");
            };
            rec.start(250);
            startedAtRef.current = Date.now();
            setElapsed(0);
            tickRef.current = setInterval(
                () => setElapsed((Date.now() - startedAtRef.current) / 1000),
                250,
            );
            setPhase("recording");
        } catch (err: any) {
            setError(err?.message || "Could not access microphone.");
            setPhase("error");
        }
    };

    const pauseRecording = () => {
        const rec = recRef.current;
        if (!rec || rec.state !== "recording") return;
        rec.pause();
        stopTimer();
        setPhase("paused");
    };

    const resumeRecording = () => {
        const rec = recRef.current;
        if (!rec || rec.state !== "paused") return;
        startedAtRef.current = Date.now() - elapsed * 1000;
        rec.resume();
        tickRef.current = setInterval(
            () => setElapsed((Date.now() - startedAtRef.current) / 1000),
            250,
        );
        setPhase("recording");
    };

    const stopRecording = () => {
        const rec = recRef.current;
        if (rec && rec.state !== "inactive") rec.stop();
    };

    const discardPreview = () => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl("");
        setSavedBlob(null);
        setElapsed(0);
        setPhase("idle");
    };

    /* ── Persist as data URL and bubble up ─────────────── */
    const saveAndInsert = () => {
        if (!savedBlob) return;
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result || "");
            const label = `Recording — ${new Date().toLocaleString(undefined, {
                month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            })} · ${formatTime(elapsed)}`;
            onSave?.({ src: dataUrl, label });
        };
        reader.readAsDataURL(savedBlob);
    };

    return createPortal(
        <div className={s.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={s.panel} role="dialog" aria-modal="true" aria-label="Audio recorder">
                <div className={s.header}>
                    <span className={s.title}>
                        <Mic size={14} /> Record audio
                    </span>
                    <button className={s.iconBtn} onClick={onClose} title="Close" aria-label="Close">
                        <X size={14} />
                    </button>
                </div>

                <div className={s.body}>
                    {!supported && (
                        <p className={s.muted}>
                            Audio recording requires a modern browser with MediaRecorder support.
                        </p>
                    )}

                    {phase === "error" && (
                        <p className={s.error}>{error || "Could not start recording."}</p>
                    )}

                    {(phase === "idle" || phase === "error") && supported && (
                        <div className={s.idle}>
                            <button className={s.recordBtn} onClick={startRecording}>
                                <Mic size={20} />
                                <span>Start recording</span>
                            </button>
                            <p className={s.muted}>Recordings are stored inside this page.</p>
                        </div>
                    )}

                    {(phase === "recording" || phase === "paused") && (
                        <div className={s.activeWrap}>
                            <div className={`${s.indicator} ${phase === "recording" ? s.indicatorOn : ""}`}>
                                <span className={s.dot} />
                                <span>{phase === "recording" ? "Recording" : "Paused"}</span>
                            </div>
                            <div className={s.timer}>{formatTime(elapsed)}</div>
                            <div className={s.controls}>
                                {phase === "recording" ? (
                                    <button className={s.iconBtnLg} onClick={pauseRecording} title="Pause">
                                        <PauseCircle size={20} />
                                    </button>
                                ) : (
                                    <button className={s.iconBtnLg} onClick={resumeRecording} title="Resume">
                                        <PlayCircle size={20} />
                                    </button>
                                )}
                                <button
                                    className={`${s.iconBtnLg} ${s.iconBtnLgStop}`}
                                    onClick={stopRecording}
                                    title="Stop"
                                >
                                    <MicOff size={20} />
                                </button>
                            </div>
                        </div>
                    )}

                    {phase === "preview" && previewUrl && (
                        <div className={s.previewWrap}>
                            <p className={s.previewLabel}>
                                Preview · {formatTime(elapsed)}
                            </p>
                            <audio src={previewUrl} controls className={s.audio} />
                            <div className={s.previewActions}>
                                <button className="btn btn-secondary btn-sm" onClick={discardPreview}>
                                    Discard
                                </button>
                                <button className="btn btn-primary btn-sm" onClick={saveAndInsert}>
                                    <Check size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                                    Insert into page
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}