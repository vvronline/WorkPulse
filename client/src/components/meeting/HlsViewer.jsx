import React, { useEffect, useRef, useState } from 'react';

/**
 * HlsViewer — plays an HLS (`.m3u8`) live stream produced by an upstream
 * media server (Mediasoup/LiveKit/Janus → ffmpeg → HLS, or coturn-hosted
 * recorder pipeline) so large meetings (100s of viewers) don't have to
 * negotiate a WebRTC peer connection per-attendee.
 *
 * This is the same UX pattern as
 * https://github.com/videosdk-live/videosdk-hls-react-sdk-example —
 * a small group of "speakers" runs on the WebRTC mesh, while everyone else
 * watches a low-cost HLS stream with ~6-10s latency.
 *
 * Usage:
 *   <HlsViewer src={meeting.hlsUrl} poster={hostAvatar} />
 *
 * The component:
 *   • Uses native HLS on Safari (which has built-in support)
 *   • Loads hls.js dynamically on Chromium / Firefox
 *   • Recovers from network errors by retrying with exponential backoff
 *   • Surfaces playback state so the room UI can show "live", "loading", etc.
 */
export default function HlsViewer({ src, poster, autoPlay = true, muted = false, className = '', onState }) {
    const videoRef = useRef(null);
    const hlsRef = useRef(null);
    const retryRef = useRef({ count: 0, timer: null });
    const [state, setState] = useState('loading'); // loading | live | error | offline

    const setS = (s) => { setState(s); onState?.(s); };

    useEffect(() => {
        if (!src || !videoRef.current) return;
        const video = videoRef.current;
        retryRef.current = { count: 0, timer: null };

        let cancelled = false;
        let cleanup = () => { };

        // Native HLS path (Safari, iOS) — always preferred when available.
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = src;
            const onLoaded = () => { if (!cancelled) setS('live'); };
            const onErr = () => { if (!cancelled) setS('error'); scheduleRetry(); };
            video.addEventListener('loadedmetadata', onLoaded);
            video.addEventListener('error', onErr);
            cleanup = () => {
                video.removeEventListener('loadedmetadata', onLoaded);
                video.removeEventListener('error', onErr);
                video.removeAttribute('src');
                video.load();
            };
        } else {
            // Chromium / Firefox — load hls.js dynamically so we don't pay
            // the bundle cost when the user never opens an HLS room.
            (async () => {
                try {
                    const { default: Hls } = await import('hls.js');
                    if (cancelled) return;
                    if (!Hls.isSupported()) {
                        setS('error');
                        return;
                    }
                    const hls = new Hls({
                        lowLatencyMode: true,
                        backBufferLength: 30,
                        maxBufferLength: 12,
                        maxMaxBufferLength: 30,
                        liveSyncDuration: 4,
                        liveMaxLatencyDuration: 10,
                        liveDurationInfinity: true,
                        enableWorker: true,
                        // Honour browser network-info hints when available
                        capLevelToPlayerSize: true,
                    });
                    hlsRef.current = hls;
                    hls.loadSource(src);
                    hls.attachMedia(video);

                    hls.on(Hls.Events.MANIFEST_PARSED, () => {
                        if (cancelled) return;
                        retryRef.current.count = 0;
                        setS('live');
                        if (autoPlay) video.play().catch(() => { /* autoplay blocked */ });
                    });

                    hls.on(Hls.Events.ERROR, (_evt, data) => {
                        if (cancelled) return;
                        // Only treat fatal errors as a real failure. Recoverable
                        // ones (buffer stalls, single-segment 404) just log.
                        if (!data.fatal) {
                            console.warn('[hls] non-fatal error', data.type, data.details);
                            return;
                        }
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                console.warn('[hls] fatal network error — retrying:', data.details);
                                hls.startLoad();
                                scheduleRetry();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                console.warn('[hls] fatal media error — recovering');
                                hls.recoverMediaError();
                                break;
                            default:
                                console.error('[hls] unrecoverable error', data);
                                setS('error');
                                scheduleRetry();
                                break;
                        }
                    });

                    cleanup = () => {
                        try { hls.destroy(); } catch { /* ignore */ }
                        hlsRef.current = null;
                    };
                } catch (err) {
                    if (!cancelled) {
                        console.error('[hls] failed to load hls.js:', err);
                        setS('error');
                    }
                }
            })();
        }

        function scheduleRetry() {
            const r = retryRef.current;
            if (r.count > 8) { setS('offline'); return; }
            r.count++;
            const delay = Math.min(30_000, 1000 * Math.pow(2, r.count - 1)); // 1s, 2s, 4s ... cap 30s
            console.log('[hls] retry #' + r.count + ' in', delay, 'ms');
            r.timer = setTimeout(() => {
                if (cancelled) return;
                if (hlsRef.current) {
                    hlsRef.current.loadSource(src);
                } else if (videoRef.current) {
                    videoRef.current.src = src;
                }
                setS('loading');
            }, delay);
        }

        return () => {
            cancelled = true;
            clearTimeout(retryRef.current.timer);
            cleanup();
        };
    }, [src, autoPlay]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className={`hls-viewer ${className}`} data-state={state}>
            <video
                ref={videoRef}
                poster={poster}
                playsInline
                controls
                autoPlay={autoPlay}
                muted={muted}
                style={{ width: '100%', height: '100%', background: '#000' }}
            />
            {state === 'loading' && (
                <div className="hls-overlay">Connecting to live stream…</div>
            )}
            {state === 'error' && (
                <div className="hls-overlay">Stream interrupted — reconnecting…</div>
            )}
            {state === 'offline' && (
                <div className="hls-overlay">Live stream is offline. Please refresh.</div>
            )}
        </div>
    );
}