import { useRef, useState, useCallback, useEffect } from "react";
import type { AnyRecord } from "../../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Participant = AnyRecord & { stream?: MediaStream | null };

interface UseMeetingRecordingParams {
    localStream: MediaStream | null;
    screenStream: MediaStream | null;
    participants: Map<number | string, Participant>;
    presenterId: number | string | null;
    localUserId?: number | string;
}

interface DrawStreamFn {
    (
        ctx: CanvasRenderingContext2D,
        stream: MediaStream,
        x: number,
        y: number,
        w: number,
        h: number,
    ): void;
    _videoElements?: Map<string, HTMLVideoElement>;
}

/**
 * useMeetingRecording — records the entire meeting locally.
 */
export function useMeetingRecording({
    localStream,
    screenStream,
    participants,
    presenterId,
}: UseMeetingRecordingParams) {
    const [recording, setRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);

    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
    const audioSourcesRef = useRef<MediaStreamAudioSourceNode[]>([]);
    const animFrameRef = useRef<number | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

        ctx.fillStyle = "#1a1a2e";
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        const videos: { stream: MediaStream; isPresenter: boolean }[] = [];

        if (presenterId && screenStream) {
            const screenTrack = screenStream.getVideoTracks()[0];
            if (screenTrack && screenTrack.readyState === "live") {
                videos.push({ stream: screenStream, isPresenter: true });
            }
        }

        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (
                videoTrack &&
                videoTrack.enabled &&
                videoTrack.readyState === "live"
            ) {
                videos.push({ stream: localStream, isPresenter: false });
            }
        }

        if (participants) {
            for (const [, p] of participants) {
                if (p.stream) {
                    const vt = p.stream.getVideoTracks()[0];
                    if (vt && vt.enabled && vt.readyState === "live") {
                        videos.push({
                            stream: p.stream,
                            isPresenter: false,
                        });
                    }
                }
            }
        }

        if (videos.length === 0) {
            ctx.fillStyle = "#ffffff";
            ctx.font = "24px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(
                "Meeting Recording",
                CANVAS_WIDTH / 2,
                CANVAS_HEIGHT / 2,
            );
            animFrameRef.current = requestAnimationFrame(drawFrame);
            return;
        }

        const presenterVideo = videos.find((v) => v.isPresenter);
        if (presenterVideo) {
            const mainW = Math.floor(CANVAS_WIDTH * 0.75);
            const mainH = CANVAS_HEIGHT;
            drawStreamToCanvas(ctx, presenterVideo.stream, 0, 0, mainW, mainH);

            const others = videos.filter((v) => !v.isPresenter);
            const sideW = CANVAS_WIDTH - mainW;
            const thumbH =
                others.length > 0
                    ? Math.floor(mainH / Math.min(others.length, 4))
                    : 0;
            others.slice(0, 4).forEach((v, i) => {
                drawStreamToCanvas(
                    ctx,
                    v.stream,
                    mainW,
                    i * thumbH,
                    sideW,
                    thumbH,
                );
            });
        } else {
            const count = videos.length;
            const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
            const rows = Math.ceil(count / cols);
            const cellW = Math.floor(CANVAS_WIDTH / cols);
            const cellH = Math.floor(CANVAS_HEIGHT / rows);

            videos.forEach((v, i) => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                drawStreamToCanvas(
                    ctx,
                    v.stream,
                    col * cellW,
                    row * cellH,
                    cellW,
                    cellH,
                );
            });
        }

        animFrameRef.current = requestAnimationFrame(drawFrame);
    }, [localStream, screenStream, participants, presenterId]);

    /**
     * Utility: draw a video stream onto a region of the canvas, maintaining aspect ratio
     */
    const drawStreamToCanvas = function (
        ctx: CanvasRenderingContext2D,
        stream: MediaStream,
        x: number,
        y: number,
        w: number,
        h: number,
    ) {
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) return;

        const trackId = videoTrack.id;
        const self = drawStreamToCanvas as DrawStreamFn;
        if (!self._videoElements) {
            self._videoElements = new Map();
        }

        let videoEl = self._videoElements.get(trackId);
        if (!videoEl || videoEl.srcObject !== stream) {
            videoEl = document.createElement("video");
            videoEl.srcObject = stream;
            videoEl.muted = true;
            videoEl.playsInline = true;
            videoEl.play().catch(() => {});
            self._videoElements.set(trackId, videoEl);
        }

        if (videoEl.readyState >= 2) {
            const vw = videoEl.videoWidth || w;
            const vh = videoEl.videoHeight || h;
            const scale = Math.max(w / vw, h / vh);
            const sw = w / scale;
            const sh = h / scale;
            const sx = (vw - sw) / 2;
            const sy = (vh - sh) / 2;
            try {
                ctx.drawImage(videoEl, sx, sy, sw, sh, x, y, w, h);
            } catch {
                /* ignore draw errors */
            }
        } else {
            ctx.fillStyle = "#2a2a3e";
            ctx.fillRect(x, y, w, h);
        }
    } as DrawStreamFn;

    /**
     * Connect all audio sources to the AudioContext destination for mixing
     */
    const connectAudioSources = useCallback(() => {
        const audioCtx = audioCtxRef.current;
        const dest = destRef.current;
        if (!audioCtx || !dest) return;

        audioSourcesRef.current.forEach((src) => {
            try {
                src.disconnect();
            } catch {
                /* ignore */
            }
        });
        audioSourcesRef.current = [];

        if (localStream) {
            const audioTracks = localStream.getAudioTracks();
            if (audioTracks.length > 0) {
                try {
                    const source =
                        audioCtx.createMediaStreamSource(localStream);
                    source.connect(dest);
                    audioSourcesRef.current.push(source);
                } catch {
                    /* ignore */
                }
            }
        }

        if (participants) {
            for (const [, p] of participants) {
                if (p.stream) {
                    const audioTracks = p.stream.getAudioTracks();
                    if (audioTracks.length > 0) {
                        try {
                            const source = audioCtx.createMediaStreamSource(
                                p.stream,
                            );
                            source.connect(dest);
                            audioSourcesRef.current.push(source);
                        } catch {
                            /* ignore */
                        }
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

        const canvas = document.createElement("canvas");
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
        canvasRef.current = canvas;
        ctxRef.current = canvas.getContext("2d");

        const audioCtx = new (window.AudioContext ||
            (window as any).webkitAudioContext)();
        const dest = audioCtx.createMediaStreamDestination();
        audioCtxRef.current = audioCtx;
        destRef.current = dest;

        connectAudioSources();

        const canvasStream = canvas.captureStream(30);
        const videoTrack = canvasStream.getVideoTracks()[0];
        const audioTrack = dest.stream.getAudioTracks()[0];

        const combinedStream = new MediaStream();
        if (videoTrack) combinedStream.addTrack(videoTrack);
        if (audioTrack) combinedStream.addTrack(audioTrack);

        const mimeType = MediaRecorder.isTypeSupported(
            "video/webm;codecs=vp9,opus",
        )
            ? "video/webm;codecs=vp9,opus"
            : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
              ? "video/webm;codecs=vp8,opus"
              : "video/webm";

        const recorder = new MediaRecorder(combinedStream, {
            mimeType,
            videoBitsPerSecond: 2500000,
        });

        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                chunksRef.current.push(e.data);
            }
        };

        recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, {
                type: recorder.mimeType || "video/webm",
            });
            saveRecording(blob);
            cleanup();
        };

        recorder.start(1000);
        recorderRef.current = recorder;
        setRecording(true);
        startTimeRef.current = Date.now();
        timerRef.current = setInterval(() => {
            setRecordingDuration(
                Math.floor((Date.now() - startTimeRef.current) / 1000),
            );
        }, 1000);

        animFrameRef.current = requestAnimationFrame(drawFrame);
    }, [recording, connectAudioSources, drawFrame]);

    /**
     * Stop recording
     */
    const stopRecording = useCallback(() => {
        if (!recording || !recorderRef.current) return;
        if (recorderRef.current.state !== "inactive") {
            recorderRef.current.stop();
        }
        setRecording(false);
        if (timerRef.current) clearInterval(timerRef.current);
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
     * Save the recorded blob.
     */
    async function saveRecording(blob: Blob) {
        const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, 19);
        const filename = `Meeting-Recording-${timestamp}.webm`;

        if ((window as any).showSaveFilePicker) {
            try {
                const handle = await (window as any).showSaveFilePicker({
                    suggestedName: filename,
                    types: [
                        {
                            description: "WebM Video",
                            accept: { "video/webm": [".webm"] },
                        },
                    ],
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return;
            } catch (err) {
                if ((err as Error).name === "AbortError") return;
            }
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
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
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        if (timerRef.current) clearInterval(timerRef.current);

        audioSourcesRef.current.forEach((src) => {
            try {
                src.disconnect();
            } catch {
                /* ignore */
            }
        });
        audioSourcesRef.current = [];

        if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
            audioCtxRef.current.close().catch(() => {});
        }
        audioCtxRef.current = null;
        destRef.current = null;

        const self = drawStreamToCanvas as DrawStreamFn;
        if (self._videoElements) {
            self._videoElements.forEach((el) => {
                el.srcObject = null;
            });
            self._videoElements.clear();
        }

        canvasRef.current = null;
        ctxRef.current = null;
        recorderRef.current = null;
    }

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (
                recorderRef.current &&
                recorderRef.current.state !== "inactive"
            ) {
                recorderRef.current.stop();
            }
            cleanup();
        };
    }, []);

    return {
        recording,
        recordingDuration,
        toggleRecording,
        startRecording,
        stopRecording,
    };
}