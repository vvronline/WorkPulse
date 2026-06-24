import { useState, useRef, useEffect, useCallback } from "react";
import { Image, Music, Film, FileText, Table2, FileEdit, Package, Paperclip, X, Eye, EyeOff, Timer } from "lucide-react";
import { markMessageViewed } from "../../api";
import s from "./FilePreview.module.css";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];

function formatSize(bytes?: number): string {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileTypeIcon({ type }: { type?: string }) {
    const size = 20;
    if (type && IMAGE_TYPES.includes(type)) return <Image size={size} />;
    if (type?.startsWith("audio/")) return <Music size={size} />;
    if (type?.startsWith("video/")) return <Film size={size} />;
    if (type?.includes("pdf")) return <FileText size={size} />;
    if (type?.includes("spreadsheet") || type?.includes("excel")) return <Table2 size={size} />;
    if (type?.includes("document") || type?.includes("word")) return <FileEdit size={size} />;
    if (type?.includes("zip") || type?.includes("compressed")) return <Package size={size} />;
    return <Paperclip size={size} />;
}

function fmtTime(sec: number): string {
    if (!sec || !isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

const SPEEDS = [1, 1.5, 2];
const audioDurationCache = new Map<string, number>();
const videoPosterCache = new Map<string, string>();

interface AudioPlayerProps {
    fileUrl: string;
    fileType?: string;
}

function AudioPlayer({ fileUrl, fileType }: AudioPlayerProps) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(() => audioDurationCache.get(fileUrl) || 0);
    const [speedIdx, setSpeedIdx] = useState(0);
    const progressRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const onTime = () => setCurrentTime(audio.currentTime);
        const onMeta = () => {
            const d = audio.duration;
            setDuration(d);
            if (Number.isFinite(d) && d > 0) {
                audioDurationCache.set(fileUrl, d);
            }
        };
        const onEnd = () => setPlaying(false);
        audio.addEventListener("timeupdate", onTime);
        audio.addEventListener("loadedmetadata", onMeta);
        audio.addEventListener("ended", onEnd);
        return () => {
            audio.removeEventListener("timeupdate", onTime);
            audio.removeEventListener("loadedmetadata", onMeta);
            audio.removeEventListener("ended", onEnd);
        };
    }, [fileUrl]);

    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (playing) { audio.pause(); }
        else { audio.play(); }
        setPlaying(p => !p);
    }, [playing]);

    const seek = useCallback((e: React.MouseEvent) => {
        const audio = audioRef.current;
        const bar = progressRef.current;
        if (!audio || !bar || !duration) return;
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        audio.currentTime = ratio * duration;
    }, [duration]);

    const cycleSpeed = useCallback(() => {
        const next = (speedIdx + 1) % SPEEDS.length;
        setSpeedIdx(next);
        if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
    }, [speedIdx]);

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
        <div className={s.audioPlayer}>
            <audio ref={audioRef} preload="metadata">
                <source src={fileUrl} type={fileType} />
            </audio>

            <button className={s.playBtn} onClick={togglePlay} title={playing ? "Pause" : "Play"}>
                {playing ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <rect x="3" y="2" width="4" height="12" rx="1" />
                        <rect x="9" y="2" width="4" height="12" rx="1" />
                    </svg>
                ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M4 2.5v11l9-5.5L4 2.5z" />
                    </svg>
                )}
            </button>

            <div className={s.trackArea}>
                <div className={s.progressBar} ref={progressRef} onClick={seek}>
                    <div className={s.progressFill} style={{ width: `${progress}%` }} />
                    <div className={s.progressThumb} style={{ left: `${progress}%` }} />
                </div>
                <div className={s.timeRow}>
                    <span className={s.timeLabel}>{fmtTime(currentTime)}</span>
                    <span className={s.timeLabel}>{fmtTime(duration)}</span>
                </div>
            </div>

            <button className={s.speedBtn} onClick={cycleSpeed} title="Playback speed">
                {SPEEDS[speedIdx]}x
            </button>
        </div>
    );
}

interface FilePreviewProps {
    fileUrl: string;
    fileName?: string;
    fileType?: string;
    fileSize?: number;
    isMessage?: boolean;
    /** Message id — required for view-once consume. */
    messageId?: number | string;
    /** View-once metadata from the message. */
    viewOnce?: boolean;
    /** Whether the current viewer already consumed a view-once message. */
    viewOnceConsumed?: boolean;
    /** Whether the current user is the sender (sender can always re-view). */
    isMine?: boolean;
}

export default function FilePreview({
    fileUrl, fileName, fileType, fileSize, isMessage,
    messageId, viewOnce, viewOnceConsumed, isMine,
}: FilePreviewProps) {
    const [lightbox, setLightbox] = useState(false);
    const [videoPoster, setVideoPoster] = useState<string | null>(() => videoPosterCache.get(fileUrl) || null);
    // View-once: resolved URL fetched on demand when the recipient taps to view.
    const [revealedUrl, setRevealedUrl] = useState<string | null>(null);
    const [consumed, setConsumed] = useState(!!viewOnceConsumed);
    const [loadingView, setLoadingView] = useState(false);
    const isImage = !!fileType && IMAGE_TYPES.includes(fileType);
    const isAudio = fileType?.startsWith("audio/");
    const isVideo = fileType?.startsWith("video/");

    useEffect(() => {
        if (!isVideo || videoPosterCache.has(fileUrl)) return;
        let cancelled = false;
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.src = fileUrl;
        video.playsInline = true;
        const capture = () => {
            if (cancelled) return;
            const w = Math.max(1, video.videoWidth || 0);
            const h = Math.max(1, video.videoHeight || 0);
            if (!w || !h) return;
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.drawImage(video, 0, 0, w, h);
            canvas.toBlob((blob) => {
                if (!blob || cancelled) return;
                const posterUrl = URL.createObjectURL(blob);
                videoPosterCache.set(fileUrl, posterUrl);
                setVideoPoster(posterUrl);
            }, "image/jpeg", 0.8);
        };
        video.addEventListener("loadeddata", () => {
            if (cancelled) return;
            try {
                video.currentTime = 0.1;
            } catch {
                capture();
            }
        });
        video.addEventListener("seeked", capture);
        video.addEventListener("error", () => {
            if (!cancelled) setVideoPoster(null);
        });
        return () => {
            cancelled = true;
            video.removeAttribute("src");
            video.load();
        };
    }, [fileUrl, isVideo]);

    const openViewOnce = useCallback(async () => {
        if (loadingView) return;
        // Sender re-viewing their own media uses the URL directly.
        if (isMine && fileUrl) {
            setRevealedUrl(fileUrl);
            setLightbox(true);
            return;
        }
        if (consumed) return;
        setLoadingView(true);
        try {
            const { data } = await markMessageViewed(messageId as number | string);
            if (data?.fileUrl) {
                setRevealedUrl(data.fileUrl);
                setLightbox(true);
                setConsumed(true);
            } else {
                setConsumed(true);
            }
        } catch {
            /* ignore */
        } finally {
            setLoadingView(false);
        }
    }, [loadingView, isMine, fileUrl, consumed, messageId]);

    // ─── View-once image bubble ───
    if (viewOnce && isImage && isMessage) {
        const alreadyViewed = consumed && !isMine;
        return (
            <>
                <button
                    type="button"
                    className={`${s.viewOnceCard} ${alreadyViewed ? s.viewOnceDone : ""}`}
                    onClick={alreadyViewed ? undefined : openViewOnce}
                    disabled={alreadyViewed || loadingView}
                >
                    <span className={s.viewOnceIcon}>
                        {alreadyViewed ? <EyeOff size={16} /> : <Timer size={16} />}
                    </span>
                    <span className={s.viewOnceLabel}>
                        {alreadyViewed ? "Viewed" : loadingView ? "Opening…" : "Photo"}
                    </span>
                    {!alreadyViewed && <Eye size={15} className={s.viewOnceEye} />}
                </button>
                {lightbox && revealedUrl && (
                    <div className={s.lightbox} onClick={() => setLightbox(false)}>
                        <button className={s.lbClose} onClick={() => setLightbox(false)}><X size={16} /></button>
                        <img src={revealedUrl} alt={fileName} className={s.lbImage} onClick={(e) => e.stopPropagation()} />
                        <div className={s.lbViewOnceNote}>This photo can only be viewed once</div>
                    </div>
                )}
            </>
        );
    }

    if (isImage && isMessage) {
        return (
            <>
                <div className={s.imgWrap} onClick={() => setLightbox(true)}>
                    <img src={fileUrl} alt={fileName} className={s.image} loading="lazy" />
                </div>
                {lightbox && (
                    <FullScreenImage
                        url={fileUrl}
                        fileName={fileName}
                        onClose={() => setLightbox(false)}
                    />
                )}
            </>
        );
    }

    if (isAudio && isMessage) {
        return <AudioPlayer fileUrl={fileUrl} fileType={fileType} />;
    }

    if (isVideo && isMessage) {
        return (
            <a href={fileUrl} target="_blank" rel="noopener noreferrer" className={s.videoWrap}>
                {videoPoster ? (
                    <img src={videoPoster} alt={fileName || "Video"} className={s.videoThumb} loading="lazy" />
                ) : (
                    <div className={s.videoFallback}>
                        <Film size={20} />
                        <span>{fileName || "Video"}</span>
                    </div>
                )}
            </a>
        );
    }

    return (
        <a href={fileUrl} target="_blank" rel="noopener noreferrer" className={s.file}>
            <span className={s.icon}><FileTypeIcon type={fileType} /></span>
            <div className={s.info}>
                <span className={s.name}>{fileName || "File"}</span>
                {!!fileSize && fileSize > 0 && <span className={s.size}>{formatSize(fileSize)}</span>}
            </div>
        </a>
    );
}

/**
 * FullScreenImage — Signal-style full-screen image viewer with scroll-to-zoom,
 * drag-to-pan when zoomed, Esc/click-to-close and a download button.
 */
function FullScreenImage({
    url,
    fileName,
    onClose,
    allowDownload = true,
}: {
    url: string;
    fileName?: string;
    onClose: () => void;
    allowDownload?: boolean;
}) {
    const [scale, setScale] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const onWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        setScale((prev) => {
            const next = Math.min(5, Math.max(1, prev - e.deltaY * 0.0015));
            if (next === 1) setOffset({ x: 0, y: 0 });
            return next;
        });
    };

    const onPointerDown = (e: React.PointerEvent) => {
        if (scale <= 1) return;
        drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    };
    const onPointerMove = (e: React.PointerEvent) => {
        if (!drag.current) return;
        setOffset({
            x: drag.current.ox + (e.clientX - drag.current.x),
            y: drag.current.oy + (e.clientY - drag.current.y),
        });
    };
    const onPointerUp = () => {
        drag.current = null;
    };

    return (
        <div className={s.lightbox} onClick={onClose} onWheel={onWheel}>
            <button className={s.lbClose} onClick={onClose}><X size={16} /></button>
            <img
                src={url}
                alt={fileName}
                className={s.lbImage}
                style={{
                    transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                    cursor: scale > 1 ? "grab" : "default",
                }}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    setScale((p) => (p > 1 ? 1 : 2));
                    setOffset({ x: 0, y: 0 });
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                draggable={false}
            />
            {allowDownload && (
                <a href={url} download={fileName} className={s.lbDownload} onClick={(e) => e.stopPropagation()}>
                    ⬇ Download
                </a>
            )}
        </div>
    );
}
