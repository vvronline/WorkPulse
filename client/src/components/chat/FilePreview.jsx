import { useState, useRef, useEffect, useCallback } from 'react';
import s from './FilePreview.module.css';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];

function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(type) {
    if (IMAGE_TYPES.includes(type)) return '🖼️';
    if (type?.startsWith('audio/')) return '🎵';
    if (type?.startsWith('video/')) return '🎬';
    if (type?.includes('pdf')) return '📄';
    if (type?.includes('spreadsheet') || type?.includes('excel')) return '📊';
    if (type?.includes('document') || type?.includes('word')) return '📝';
    if (type?.includes('zip') || type?.includes('compressed')) return '📦';
    return '📎';
}

function fmtTime(sec) {
    if (!sec || !isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

const SPEEDS = [1, 1.5, 2];

function AudioPlayer({ fileUrl, fileType }) {
    const audioRef = useRef(null);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [speedIdx, setSpeedIdx] = useState(0);
    const progressRef = useRef(null);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const onTime = () => setCurrentTime(audio.currentTime);
        const onMeta = () => setDuration(audio.duration);
        const onEnd = () => setPlaying(false);
        audio.addEventListener('timeupdate', onTime);
        audio.addEventListener('loadedmetadata', onMeta);
        audio.addEventListener('ended', onEnd);
        return () => {
            audio.removeEventListener('timeupdate', onTime);
            audio.removeEventListener('loadedmetadata', onMeta);
            audio.removeEventListener('ended', onEnd);
        };
    }, []);

    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (playing) { audio.pause(); }
        else { audio.play(); }
        setPlaying(p => !p);
    }, [playing]);

    const seek = useCallback((e) => {
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

            <button className={s.playBtn} onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
                {playing ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <rect x="3" y="2" width="4" height="12" rx="1"/>
                        <rect x="9" y="2" width="4" height="12" rx="1"/>
                    </svg>
                ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M4 2.5v11l9-5.5L4 2.5z"/>
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

export default function FilePreview({ fileUrl, fileName, fileType, fileSize, isMessage }) {
    const [lightbox, setLightbox] = useState(false);
    const isImage = IMAGE_TYPES.includes(fileType);
    const isAudio = fileType?.startsWith('audio/');

    if (isImage && isMessage) {
        return (
            <>
                <div className={s.imgWrap} onClick={() => setLightbox(true)}>
                    <img src={fileUrl} alt={fileName} className={s.image} loading="lazy" />
                </div>
                {lightbox && (
                    <div className={s.lightbox} onClick={() => setLightbox(false)}>
                        <button className={s.lbClose} onClick={() => setLightbox(false)}>✕</button>
                        <img src={fileUrl} alt={fileName} className={s.lbImage} onClick={e => e.stopPropagation()} />
                        <a href={fileUrl} download={fileName} className={s.lbDownload} onClick={e => e.stopPropagation()}>⬇ Download</a>
                    </div>
                )}
            </>
        );
    }

    if (isAudio && isMessage) {
        return <AudioPlayer fileUrl={fileUrl} fileType={fileType} />;
    }

    return (
        <a href={fileUrl} target="_blank" rel="noopener noreferrer" className={s.file}>
            <span className={s.icon}>{fileIcon(fileType)}</span>
            <div className={s.info}>
                <span className={s.name}>{fileName || 'File'}</span>
                {fileSize > 0 && <span className={s.size}>{formatSize(fileSize)}</span>}
            </div>
        </a>
    );
}
