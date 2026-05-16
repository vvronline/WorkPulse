import { useRef, useState, useCallback, useEffect } from 'react';

/**
 * useMeetingRecording — records the entire meeting locally.
 *
 * Approach:
 * - Composites all participant video streams onto a canvas
 * - Mixes all audio streams (local + remote) via AudioContext
 * - Combines canvas video track + mixed audio into one MediaStream
 * - Records via MediaRecorder and saves to the user's local file system
 *   using the File System Access API (showSaveFilePicker), with a
 *   fallback download for unsupported browsers.
 */
export function useMeetingRecording({ localStream, screenStream, participants, presenterId, localUserId }) {
    const [recording, setRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);

    const recorderRef = useRef(null);
    const chunksRef = useRef([]);
    const canvasRef = useRef(null);
    const ctxRef = useRef(null);
    const audioCtxRef = useRef(null);
    const destRef = useRef(null);
    const audioSourcesRef = useRef([]);
    const animFrameRef = useRef(null);
    const timerRef = useRef(null);
    const startTimeRef = useRef(0);

    // Canvas dimensions for the composite recording
    const CANVAS_WIDTH = 1280;
    const CANVAS_HEIGHT = 720;

    /**
     * Draw all participant videos onto the composite canvas in a grid layout
     */
    const drawFrame = useCallback(() => {
        const canvas = canvasRef.current;
        const ctx = ctxRef.current;
        if (!canvas || !ctx) return;

        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        // Collect all video elements to draw
        const videos = [];

        // If presenter is sharing screen, draw that as the main view
        if (presenterId && screenStream) {
            const screenTrack = screenStream.getVideoTracks()[0];
            if (screenTrack && screenTrack.readyState === 'live') {
                videos.push({ stream: screenStream, isPresenter: true });
            }
        }

        // Local stream
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack && videoTrack.enabled && videoTrack.readyState === 'live') {
                videos.push({ stream: localStream, isPresenter: false });
            }
        }

        // Remote participant streams
        if (participants) {
            for (const [, p] of participants) {
                if (p.stream) {
                    const vt = p.stream.getVideoTracks()[0];
                    if (vt && vt.enabled && vt.readyState === 'live') {
                        videos.push({ stream: p.stream, isPresenter: false });
                    }
                }
            }
        }

        if (videos.length === 0) {
            // Draw "No video" placeholder
            ctx.fillStyle = '#ffffff';
            ctx.font = '24px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Meeting Recording', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
            animFrameRef.current = requestAnimationFrame(drawFrame);
            return;
        }

        // Check if we have a presenter screen share — use presenter layout
        const presenterVideo = videos.find(v => v.isPresenter);
        if (presenterVideo) {
            // Presenter takes 75% width, thumbnails on the side
            const mainW = Math.floor(CANVAS_WIDTH * 0.75);
            const mainH = CANVAS_HEIGHT;
            drawStreamToCanvas(ctx, presenterVideo.stream, 0, 0, mainW, mainH);

            const others = videos.filter(v => !v.isPresenter);
            const sideW = CANVAS_WIDTH - mainW;
            const thumbH = others.length > 0 ? Math.floor(mainH / Math.min(others.length, 4)) : 0;
            others.slice(0, 4).forEach((v, i) => {
                drawStreamToCanvas(ctx, v.stream, mainW, i * thumbH, sideW, thumbH);
            });
        } else {
            // Grid layout
            const count = videos.length;
            const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
            const rows = Math.ceil(count / cols);
            const cellW = Math.floor(CANVAS_WIDTH / cols);
            const cellH = Math.floor(CANVAS_HEIGHT / rows);

            videos.forEach((v, i) => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                drawStreamToCanvas(ctx, v.stream, col * cellW, row * cellH, cellW, cellH);
            });
        }

        animFrameRef.current = requestAnimationFrame(drawFrame);
    }, [localStream, screenStream, participants, presenterId]);

    /**
     * Utility: draw a video stream onto a region of the canvas, maintaining aspect ratio
     */
    function drawStreamToCanvas(ctx, stream, x, y, w, h) {
        // We need a video element to draw from
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) return;

        // Use ImageCapture if available, otherwise fallback to hidden video element approach
        // For performance, we use a map of video elements keyed by track id
        const trackId = videoTrack.id;
        if (!drawStreamToCanvas._videoElements) {
            drawStreamToCanvas._videoElements = new Map();
        }

        let videoEl = drawStreamToCanvas._videoElements.get(trackId);
        if (!videoEl || videoEl.srcObject !== stream) {
            videoEl = document.createElement('video');
            videoEl.srcObject = stream;
            videoEl.muted = true;
            videoEl.playsInline = true;
            videoEl.play().catch(() => { });
            drawStreamToCanvas._videoElements.set(trackId, videoEl);
        }

        if (videoEl.readyState >= 2) { // HAVE_CURRENT_DATA
            const vw = videoEl.videoWidth || w;
            const vh = videoEl.videoHeight || h;
            // Cover-fit
            const scale = Math.max(w / vw, h / vh);
            const sw = w / scale;
            const sh = h / scale;
            const sx = (vw - sw) / 2;
            const sy = (vh - sh) / 2;
            try {
                ctx.drawImage(videoEl, sx, sy, sw, sh, x, y, w, h);
            } catch { /* ignore draw errors */ }
        } else {
            // Draw placeholder
            ctx.fillStyle = '#2a2a3e';
            ctx.fillRect(x, y, w, h);
        }
    }

    /**
     * Connect all audio sources to the AudioContext destination for mixing
     */
    const connectAudioSources = useCallback(() => {
        const audioCtx = audioCtxRef.current;
        const dest = destRef.current;
        if (!audioCtx || !dest) return;

        // Disconnect old sources
        audioSourcesRef.current.forEach(src => {
            try { src.disconnect(); } catch { /* ignore */ }
        });
        audioSourcesRef.current = [];

        // Local audio
        if (localStream) {
            const audioTracks = localStream.getAudioTracks();
            if (audioTracks.length > 0) {
                try {
                    const source = audioCtx.createMediaStreamSource(localStream);
                    source.connect(dest);
                    audioSourcesRef.current.push(source);
                } catch { /* ignore */ }
            }
        }

        // Remote participant audio
        if (participants) {
            for (const [, p] of participants) {
                if (p.stream) {
                    const audioTracks = p.stream.getAudioTracks();
                    if (audioTracks.length > 0) {
                        try {
                            const source = audioCtx.createMediaStreamSource(p.stream);
                            source.connect(dest);
                            audioSourcesRef.current.push(source);
                        } catch { /* ignore */ }
                    }
                }
            }
        }
    }, [localStream, participants]);

    // Reconnect audio sources when participants change during recording
    useEffect(() => {
        if (recording) {
            connectAudioSources();
        }
    }, [recording, connectAudioSources]);

    /**
     * Start recording
     */
    const startRecording = useCallback(() => {
        if (recording) return;

        // Create offscreen canvas
        const canvas = document.createElement('canvas');
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
        canvasRef.current = canvas;
        ctxRef.current = canvas.getContext('2d');

        // Create AudioContext and mix all audio
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const dest = audioCtx.createMediaStreamDestination();
        audioCtxRef.current = audioCtx;
        destRef.current = dest;

        // Connect current audio sources
        connectAudioSources();

        // Get canvas video stream
        const canvasStream = canvas.captureStream(30); // 30 fps
        const videoTrack = canvasStream.getVideoTracks()[0];
        const audioTrack = dest.stream.getAudioTracks()[0];

        // Combine into single stream
        const combinedStream = new MediaStream();
        if (videoTrack) combinedStream.addTrack(videoTrack);
        if (audioTrack) combinedStream.addTrack(audioTrack);

        // Choose codec
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
            ? 'video/webm;codecs=vp9,opus'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
                ? 'video/webm;codecs=vp8,opus'
                : 'video/webm';

        const recorder = new MediaRecorder(combinedStream, {
            mimeType,
            videoBitsPerSecond: 2500000, // 2.5 Mbps
        });

        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                chunksRef.current.push(e.data);
            }
        };

        recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
            saveRecording(blob);
            cleanup();
        };

        recorder.start(1000); // Collect data every second
        recorderRef.current = recorder;
        setRecording(true);
        startTimeRef.current = Date.now();
        timerRef.current = setInterval(() => {
            setRecordingDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }, 1000);

        // Start drawing frames
        animFrameRef.current = requestAnimationFrame(drawFrame);
    }, [recording, connectAudioSources, drawFrame]);

    /**
     * Stop recording
     */
    const stopRecording = useCallback(() => {
        if (!recording || !recorderRef.current) return;
        if (recorderRef.current.state !== 'inactive') {
            recorderRef.current.stop();
        }
        setRecording(false);
        clearInterval(timerRef.current);
        setRecordingDuration(0);
    }, [recording]);

    /**
     * Toggle recording on/off
     */
    const toggleRecording = useCallback(() => {
        if (recording) {
            stopRecording();
        } else {
            startRecording();
        }
    }, [recording, startRecording, stopRecording]);

    /**
     * Save the recorded blob — uses File System Access API (showSaveFilePicker)
     * so the user can choose where to save. Falls back to a download link.
     */
    async function saveRecording(blob) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `Meeting-Recording-${timestamp}.webm`;

        // Try File System Access API (Chrome/Edge)
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'WebM Video',
                        accept: { 'video/webm': ['.webm'] },
                    }],
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return;
            } catch (err) {
                // User cancelled or API error — fall through to download
                if (err.name === 'AbortError') return;
            }
        }

        // Fallback: trigger download with browser's save dialog
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    /**
     * Cleanup resources
     */
    function cleanup() {
        cancelAnimationFrame(animFrameRef.current);
        clearInterval(timerRef.current);

        // Disconnect audio sources
        audioSourcesRef.current.forEach(src => {
            try { src.disconnect(); } catch { /* ignore */ }
        });
        audioSourcesRef.current = [];

        // Close AudioContext
        if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
            audioCtxRef.current.close().catch(() => { });
        }
        audioCtxRef.current = null;
        destRef.current = null;

        // Clean up video elements cache
        if (drawStreamToCanvas._videoElements) {
            drawStreamToCanvas._videoElements.forEach(el => {
                el.srcObject = null;
            });
            drawStreamToCanvas._videoElements.clear();
        }

        canvasRef.current = null;
        ctxRef.current = null;
        recorderRef.current = null;
    }

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (recorderRef.current && recorderRef.current.state !== 'inactive') {
                recorderRef.current.stop();
            }
            cleanup();
        };
    }, []);

    return { recording, recordingDuration, toggleRecording, startRecording, stopRecording };
}
