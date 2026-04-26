import { useCallback, useEffect, useRef, useState } from 'react';
import { startMeetingHlsBroadcast, stopMeetingHlsBroadcast } from '../../api';

/**
 * useHlsBroadcast — publisher-side HLS broadcast helper.
 *
 * Flow (mirrors the videosdk-hls pattern):
 *   1. The host clicks "Go Live" → we POST /meetings/:code/hls/start
 *   2. The server returns { ingestUrl, hlsUrl, broadcastId }
 *      - ingestUrl: where to POST media chunks (typically a WHIP/RTMP/HTTP-PUT
 *                   endpoint on your media server, e.g. nginx-rtmp / OvenMediaEngine)
 *      - hlsUrl:    the .m3u8 viewers should subscribe to via <HlsViewer src=… />
 *   3. We capture the local stream + every connected peer's audio (mixed via
 *      a Web Audio AudioContext) and screen, encode it via MediaRecorder, and
 *      stream the chunks to ingestUrl.
 *   4. The host clicks "Stop Live" → we POST /meetings/:code/hls/stop and
 *      tear down the recorder.
 *
 * The actual ingest mechanism is intentionally pluggable. The server route
 * decides how broadcasts are produced — common options:
 *   • nginx-rtmp + ffmpeg sidecar that re-segments to HLS
 *   • OvenMediaEngine (WebRTC ingest → HLS/LL-HLS)
 *   • LiveKit Egress with HLS output
 *   • A self-hosted Mediasoup pipeline with ffmpeg → HLS
 *
 * This hook is implementation-agnostic; it only needs an HTTP endpoint that
 * accepts a continuous stream of WebM/MP4 chunks via fetch with a streaming
 * body (Chrome/Edge) or a sequence of POSTs (everything else).
 */
export function useHlsBroadcast({ meetingCode, getMixedStream }) {
    const [state, setState] = useState('idle'); // idle | starting | live | stopping | error
    const [hlsUrl, setHlsUrl] = useState(null);
    const [error, setError] = useState(null);

    const recorderRef = useRef(null);
    const ingestUrlRef = useRef(null);
    const broadcastIdRef = useRef(null);
    const queueRef = useRef([]); // chunks awaiting upload (XHR fallback path)
    const uploadingRef = useRef(false);

    /**
     * Pick the best available codec. h264 + aac in MP4 plays everywhere
     * (HLS spec). VP9/Opus in WebM is smaller but needs server-side
     * transcoding. We probe in order and let the server transcode as needed.
     */
    const pickMimeType = () => {
        const candidates = [
            'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // H.264 baseline + AAC-LC
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
        ];
        for (const m of candidates) {
            if (MediaRecorder.isTypeSupported?.(m)) return m;
        }
        return '';
    };

    /**
     * Upload one chunk to the ingest endpoint. We use XHR/fetch per chunk
     * (instead of a single streaming POST) for maximum proxy compatibility —
     * many corporate HTTP proxies buffer chunked transfer encoding badly.
     */
    const uploadChunk = useCallback(async (blob, sequence) => {
        if (!ingestUrlRef.current) return;
        try {
            const url = `${ingestUrlRef.current}?seq=${sequence}&broadcastId=${encodeURIComponent(broadcastIdRef.current)}`;
            const resp = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Content-Type': blob.type || 'application/octet-stream',
                    'X-Broadcast-Id': broadcastIdRef.current,
                    'X-Sequence': String(sequence),
                },
                body: blob,
                credentials: 'include',
                // keepalive lets pending chunks finish sending if the user
                // navigates away (best-effort; max body 64 KiB on most browsers)
                keepalive: blob.size < 60_000,
            });
            if (!resp.ok) {
                console.warn('[hls-publish] chunk', sequence, 'rejected:', resp.status);
            }
        } catch (err) {
            console.warn('[hls-publish] chunk', sequence, 'upload failed:', err?.message || err);
        }
    }, []);

    /** Drain queued chunks one-by-one (preserves ordering for the segmenter). */
    const drainQueue = useCallback(async () => {
        if (uploadingRef.current) return;
        uploadingRef.current = true;
        try {
            while (queueRef.current.length > 0) {
                const item = queueRef.current.shift();
                await uploadChunk(item.blob, item.seq);
            }
        } finally {
            uploadingRef.current = false;
        }
    }, [uploadChunk]);

    const start = useCallback(async () => {
        if (state === 'live' || state === 'starting') return;
        setState('starting');
        setError(null);
        try {
            // Ask the server to provision an HLS broadcast (allocates an ingest
            // slot, returns the public m3u8 URL).
            const { data } = await startMeetingHlsBroadcast(meetingCode);
            if (!data?.ingestUrl || !data?.hlsUrl) {
                throw new Error('Server did not return ingest/hls URLs');
            }
            ingestUrlRef.current = data.ingestUrl;
            broadcastIdRef.current = data.broadcastId;
            setHlsUrl(data.hlsUrl);

            const stream = await getMixedStream?.();
            if (!stream) throw new Error('No stream to broadcast');

            const mimeType = pickMimeType();
            if (!mimeType) throw new Error('No supported MediaRecorder MIME type');

            const recorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: 1_500_000, // 1.5 Mbps — good for 720p HLS
                audioBitsPerSecond: 128_000,
            });
            recorderRef.current = recorder;

            let seq = 0;
            recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    queueRef.current.push({ blob: e.data, seq: seq++ });
                    drainQueue();
                }
            };
            recorder.onerror = (e) => {
                console.error('[hls-publish] recorder error:', e?.error || e);
                setError(e?.error?.message || 'Recorder error');
                setState('error');
            };
            recorder.onstop = () => {
                // Final flush to make sure last segments arrive in order.
                drainQueue();
            };

            // Emit a chunk every 2s — short enough for low-latency HLS
            // (server can target ~6s segments by combining 3 chunks), long
            // enough that we're not flooding the proxy with tiny PUTs.
            recorder.start(2000);
            setState('live');
        } catch (err) {
            console.error('[hls-publish] start failed:', err);
            setError(err?.message || 'Failed to start broadcast');
            setState('error');
            ingestUrlRef.current = null;
            broadcastIdRef.current = null;
        }
    }, [meetingCode, state, getMixedStream, drainQueue]);

    const stop = useCallback(async () => {
        if (state !== 'live' && state !== 'error') return;
        setState('stopping');
        try {
            if (recorderRef.current && recorderRef.current.state !== 'inactive') {
                recorderRef.current.stop();
            }
        } catch (err) {
            console.warn('[hls-publish] stop recorder error:', err);
        }
        recorderRef.current = null;
        try {
            await stopMeetingHlsBroadcast(meetingCode, broadcastIdRef.current);
        } catch (err) {
            console.warn('[hls-publish] server stop ack failed:', err);
        }
        ingestUrlRef.current = null;
        broadcastIdRef.current = null;
        queueRef.current = [];
        setState('idle');
    }, [meetingCode, state]);

    // Stop the broadcast if the publisher unmounts (e.g. closes the meeting tab).
    useEffect(() => () => {
        if (recorderRef.current && recorderRef.current.state !== 'inactive') {
            try { recorderRef.current.stop(); } catch { /* ignore */ }
        }
    }, []);

    return { state, hlsUrl, error, start, stop };
}