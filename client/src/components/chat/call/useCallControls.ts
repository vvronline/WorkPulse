/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useRef } from "react";
import {
    applyVideoEncodingTarget,
    classifyConnectionQuality,
    nextAdaptiveVideoState,
    VIDEO_ENCODING_TARGETS,
    type ConnectionQuality,
    type VideoEncodingTarget,
} from "./callQuality";

interface DetailedStats {
    rtt: number | null;
    packetLoss: number;
    bitrateIn: number;
    bitrateOut: number;
    frameRate: number | null;
    frameWidth: number | null;
    frameHeight: number | null;
    audioCodec: string | null;
    videoCodec: string | null;
    localCandidateType: string | null;
    remoteCandidateType: string | null;
    transportProtocol: string | null;
    qualityLimitationReason: string | null;
    framesDropped: number;
    freezeCount: number;
    totalFreezesDuration: number;
}

interface UseCallControlsParams {
    localStreamRef: React.MutableRefObject<MediaStream | null>;
    pcRef: React.MutableRefObject<RTCPeerConnection | null>;
    screenStreamRef: React.MutableRefObject<MediaStream | null>;
    screenSenderRef: React.MutableRefObject<RTCRtpSender | null>;
    localVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
    remoteVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
    overlayRef: React.MutableRefObject<HTMLElement | null>;
}

export default function useCallControls({
    localStreamRef,
    pcRef,
    screenStreamRef,
    screenSenderRef,
    localVideoRef,
    remoteVideoRef,
    overlayRef,
}: UseCallControlsParams) {
    const [muted, setMuted] = useState(false);
    const [videoOff, setVideoOff] = useState(false);
    const [screenSharing, setScreenSharing] = useState(false);
    const [onHold, setOnHold] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>("unknown");

    // Device switching
    const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
    const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
    const [activeAudioDevice, setActiveAudioDevice] = useState("");
    const [activeVideoDevice, setActiveVideoDevice] = useState("");
    const [showAudioDevices, setShowAudioDevices] = useState(false);
    const [showVideoDevices, setShowVideoDevices] = useState(false);

    // ─── Detailed stats ───
    const [detailedStats, setDetailedStats] = useState<DetailedStats | null>(null);
    const prevBytesRef = useRef({ sent: 0, received: 0, timestamp: 0 });
    const goodVideoTargetRef = useRef<VideoEncodingTarget>({
        ...VIDEO_ENCODING_TARGETS.good,
        maxBitrate: /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
            ? 800_000
            : VIDEO_ENCODING_TARGETS.good.maxBitrate,
    });
    const currentVideoTargetRef = useRef<VideoEncodingTarget>(goodVideoTargetRef.current);
    const recoverySamplesRef = useRef(0);

    // ─── Connection quality monitor (enhanced with detailed stats) ───
    const startQualityMonitor = useCallback((pc: RTCPeerConnection) => {
        currentVideoTargetRef.current = goodVideoTargetRef.current;
        recoverySamplesRef.current = 0;
        const interval = setInterval(async () => {
            try {
                const stats = await pc.getStats();
                let rtt: number | null = null,
                    packetsLost = 0,
                    packetsReceived = 0;
                let remoteLossRate = 0;
                let bytesSent = 0,
                    bytesReceived = 0;
                let frameRate: number | null = null,
                    frameWidth: number | null = null,
                    frameHeight: number | null = null;
                let audioCodec: string | null = null,
                    videoCodec: string | null = null;
                let localCandidateType: string | null = null,
                    remoteCandidateType: string | null = null,
                    transportProtocol: string | null = null,
                    qualityLimitationReason: string | null = null;
                let framesDropped = 0,
                    freezeCount = 0,
                    totalFreezesDuration = 0;
                const codecIds: Record<string, string> = {};

                stats.forEach((report: any) => {
                    if (
                        report.type === "candidate-pair" &&
                        (report.nominated || report.state === "succeeded")
                    ) {
                        if (typeof report.currentRoundTripTime === "number") {
                            rtt = report.currentRoundTripTime;
                        }
                        if (report.localCandidateId) {
                            const local = stats.get(report.localCandidateId);
                            if (local) {
                                localCandidateType = local.candidateType || null;
                                transportProtocol = local.protocol || null;
                            }
                        }
                        if (report.remoteCandidateId) {
                            const remote = stats.get(report.remoteCandidateId);
                            if (remote) remoteCandidateType = remote.candidateType || null;
                        }
                    }
                    if (report.type === "inbound-rtp" && report.kind === "audio") {
                        packetsLost += report.packetsLost || 0;
                        packetsReceived += report.packetsReceived || 0;
                        bytesReceived += report.bytesReceived || 0;
                        if (report.codecId) codecIds[report.codecId] = "audio";
                    }
                    if (report.type === "inbound-rtp" && report.kind === "video") {
                        packetsLost += report.packetsLost || 0;
                        packetsReceived += report.packetsReceived || 0;
                        frameRate = report.framesPerSecond || null;
                        frameWidth = report.frameWidth || null;
                        frameHeight = report.frameHeight || null;
                        framesDropped += report.framesDropped || 0;
                        freezeCount += report.freezeCount || 0;
                        totalFreezesDuration += report.totalFreezesDuration || 0;
                        bytesReceived += report.bytesReceived || 0;
                        if (report.codecId) codecIds[report.codecId] = "video";
                    }
                    if (report.type === "outbound-rtp") {
                        bytesSent += report.bytesSent || 0;
                        if (report.kind === "video" && report.qualityLimitationReason) {
                            qualityLimitationReason = report.qualityLimitationReason;
                        }
                    }
                    if (report.type === "remote-inbound-rtp") {
                        if (typeof report.fractionLost === "number") {
                            remoteLossRate = Math.max(remoteLossRate, report.fractionLost);
                        }
                        if (typeof report.roundTripTime === "number") {
                            rtt = Math.max(rtt ?? 0, report.roundTripTime);
                        }
                    }
                });

                stats.forEach((report: any) => {
                    if (report.type === "codec") {
                        if (codecIds[report.id] === "audio") audioCodec = report.mimeType;
                        else if (codecIds[report.id] === "video") videoCodec = report.mimeType;
                    }
                });

                const inboundLossRate =
                    packetsReceived > 0 ? packetsLost / (packetsLost + packetsReceived) : 0;
                const lossRate = Math.max(inboundLossRate, remoteLossRate);
                const quality = classifyConnectionQuality(rtt, lossRate);
                setConnectionQuality(quality);

                const adaptive = nextAdaptiveVideoState(
                    quality,
                    currentVideoTargetRef.current,
                    recoverySamplesRef.current,
                    goodVideoTargetRef.current,
                );
                recoverySamplesRef.current = adaptive.recoverySamples;
                if (adaptive.changed && await applyVideoEncodingTarget(pc, adaptive.target)) {
                    currentVideoTargetRef.current = adaptive.target;
                }

                const now = Date.now();
                const elapsed = (now - prevBytesRef.current.timestamp) / 1000;
                const bitrateOut = elapsed > 0 ? Math.round(((bytesSent - prevBytesRef.current.sent) * 8) / elapsed / 1000) : 0;
                const bitrateIn = elapsed > 0 ? Math.round(((bytesReceived - prevBytesRef.current.received) * 8) / elapsed / 1000) : 0;
                prevBytesRef.current = { sent: bytesSent, received: bytesReceived, timestamp: now };

                setDetailedStats({
                    rtt: rtt !== null ? Math.round(rtt * 1000) : null,
                    packetLoss: Math.round(lossRate * 100 * 10) / 10,
                    bitrateIn: Math.max(0, bitrateIn),
                    bitrateOut: Math.max(0, bitrateOut),
                    frameRate,
                    frameWidth,
                    frameHeight,
                    audioCodec,
                    videoCodec,
                    localCandidateType,
                    remoteCandidateType,
                    transportProtocol,
                    qualityLimitationReason,
                    framesDropped,
                    freezeCount,
                    totalFreezesDuration,
                });
            } catch {
                /* stats unavailable */
            }
        }, 3000);
        return interval;
    }, []);

    // ─── Enumerate devices ───
    useEffect(() => {
        async function loadDevices() {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                setAudioDevices(devices.filter((d) => d.kind === "audioinput"));
                setVideoDevices(devices.filter((d) => d.kind === "videoinput"));
            } catch {
                /* ignore */
            }
        }
        loadDevices();
        navigator.mediaDevices?.addEventListener?.("devicechange", loadDevices);
        return () => navigator.mediaDevices?.removeEventListener?.("devicechange", loadDevices);
    }, []);

    // ─── Fullscreen listener ───
    useEffect(() => {
        const handler = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener("fullscreenchange", handler);
        return () => document.removeEventListener("fullscreenchange", handler);
    }, []);

    const toggleMute = () => {
        if (localStreamRef.current) {
            localStreamRef.current.getAudioTracks().forEach((t) => {
                t.enabled = !t.enabled;
            });
            setMuted(!muted);
        }
    };

    // ─── Camera ON/OFF — releases the hardware (LED off) when turned off ─────
    //
    // The previous implementation only flipped `track.enabled`, which stops
    // *transmitting* frames but keeps the OS-level camera capture alive. That
    // is why the camera LED stayed on and the camera remained "in use" by the
    // browser tab in the background. We now fully release the device when
    // turning the camera off, and re-acquire a fresh track when turning it
    // back on. We use `sender.replaceTrack()` so the peer's video tile stays
    // attached to the same transceiver across the toggle — no renegotiation,
    // no flicker, no spontaneous video drop.
    const videoToggleInFlightRef = useRef(false);
    const toggleVideo = useCallback(async () => {
        if (videoToggleInFlightRef.current) return;
        videoToggleInFlightRef.current = true;
        try {
            const stream = localStreamRef.current;
            const pc = pcRef.current;
            if (!stream) return;

            if (!videoOff) {
                // ── Turn camera OFF ────────────────────────────────────────
                // 1. Tell every video sender to stop sending (peer sees track
                //    end immediately, far faster than renegotiation).
                if (pc) {
                    const videoSenders = pc.getSenders().filter((s) => s.track && s.track.kind === "video");
                    await Promise.all(videoSenders.map((s) => s.replaceTrack(null).catch(() => {})));
                }
                // 2. Stop & remove every local video track — this is what
                //    actually releases the camera hardware (LED off).
                const tracks = stream.getVideoTracks();
                tracks.forEach((t) => {
                    try {
                        t.stop();
                    } catch {
                        /* ignore */
                    }
                    try {
                        stream.removeTrack(t);
                    } catch {
                        /* ignore */
                    }
                });
                // 3. Reflect the change in the local preview element.
                if (localVideoRef.current) {
                    try {
                        localVideoRef.current.srcObject = stream;
                    } catch {
                        /* ignore */
                    }
                }
                screenSenderRef.current = null;
                setVideoOff(true);
            } else {
                // ── Turn camera ON ─────────────────────────────────────────
                let newStream: MediaStream;
                try {
                    newStream = await navigator.mediaDevices.getUserMedia({
                        video: activeVideoDevice
                            ? { deviceId: { exact: activeVideoDevice }, width: { ideal: 1280 }, height: { ideal: 720 } }
                            : { width: { ideal: 1280 }, height: { ideal: 720 } },
                        audio: false,
                    });
                } catch (err) {
                    console.error("[call] re-acquire camera failed:", err);
                    return;
                }
                const newTrack = newStream.getVideoTracks()[0];
                if (!newTrack) return;
                try {
                    (newTrack as any).contentHint = "motion";
                } catch {
                    /* ignore */
                }
                stream.addTrack(newTrack);

                if (pc) {
                    const videoSender =
                        pc.getSenders().find((s) => s.track == null && ((s as any).transport || true)) || // prefer empty sender
                        pc.getSenders().find((s) => s.track && s.track.kind === "video");
                    if (videoSender) {
                        try {
                            await videoSender.replaceTrack(newTrack);
                            screenSenderRef.current = videoSender;
                        } catch (err: any) {
                            console.warn("[call] replaceTrack failed, falling back to addTrack:", err?.message || err);
                            try {
                                screenSenderRef.current = pc.addTrack(newTrack, stream);
                            } catch {
                                /* ignore */
                            }
                        }
                    } else {
                        try {
                            screenSenderRef.current = pc.addTrack(newTrack, stream);
                        } catch {
                            /* ignore */
                        }
                    }
                }

                if (localVideoRef.current) {
                    try {
                        localVideoRef.current.srcObject = stream;
                    } catch {
                        /* ignore */
                    }
                    try {
                        localVideoRef.current.play().catch(() => {});
                    } catch {
                        /* ignore */
                    }
                }
                setVideoOff(false);
            }
        } finally {
            videoToggleInFlightRef.current = false;
        }
    }, [videoOff, localStreamRef, pcRef, localVideoRef, screenSenderRef, activeVideoDevice]);

    const toggleScreenShare = async () => {
        if (!pcRef.current) return;

        if (screenSharing) {
            if (screenStreamRef.current) {
                screenStreamRef.current.getTracks().forEach((t) => t.stop());
                screenStreamRef.current = null;
            }
            const camTrack = localStreamRef.current?.getVideoTracks()[0];
            if (camTrack && screenSenderRef.current) {
                await screenSenderRef.current.replaceTrack(camTrack);
            } else if (screenSenderRef.current && !camTrack) {
                pcRef.current.removeTrack(screenSenderRef.current);
                screenSenderRef.current = null;
            }
            if (localVideoRef.current && localStreamRef.current) {
                localVideoRef.current.srcObject = localStreamRef.current;
            }
            setScreenSharing(false);
        } else {
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { cursor: "always" } as any,
                    audio: false,
                });
                screenStreamRef.current = screenStream;
                const screenTrack = screenStream.getVideoTracks()[0];

                if (screenSenderRef.current) {
                    await screenSenderRef.current.replaceTrack(screenTrack);
                } else {
                    const sender = pcRef.current.addTrack(screenTrack, screenStream);
                    screenSenderRef.current = sender;
                }

                screenTrack.onended = () => {
                    toggleScreenShare();
                };
                setScreenSharing(true);
            } catch (err) {
                console.error("Screen share failed:", err);
            }
        }
    };

    const toggleHold = () => {
        if (!localStreamRef.current) return;
        const hold = !onHold;
        localStreamRef.current.getTracks().forEach((t) => {
            t.enabled = !hold;
        });
        setOnHold(hold);
        if (hold) {
            setMuted(true);
            setVideoOff(true);
        } else {
            setMuted(false);
            setVideoOff(false);
        }
    };

    const toggleFullscreen = async () => {
        try {
            if (!document.fullscreenElement) {
                await overlayRef.current?.requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
        } catch {
            /* fullscreen not supported */
        }
    };

    const togglePiP = async () => {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (remoteVideoRef.current) {
                await remoteVideoRef.current.requestPictureInPicture();
            }
        } catch {
            /* PiP not supported */
        }
    };

    const switchAudioDevice = async (deviceId: string) => {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
            const newTrack = newStream.getAudioTracks()[0];
            const oldTrack = localStreamRef.current?.getAudioTracks()[0];
            const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === "audio");
            if (sender) await sender.replaceTrack(newTrack);
            if (oldTrack) {
                localStreamRef.current!.removeTrack(oldTrack);
                oldTrack.stop();
            }
            localStreamRef.current?.addTrack(newTrack);
            setActiveAudioDevice(deviceId);
        } catch (err) {
            console.error("Switch mic failed:", err);
        }
    };

    const switchVideoDevice = async (deviceId: string) => {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: deviceId }, width: 1280, height: 720 },
            });
            const newTrack = newStream.getVideoTracks()[0];
            const oldTrack = localStreamRef.current?.getVideoTracks()[0];
            if (screenSenderRef.current && !screenSharing) {
                await screenSenderRef.current.replaceTrack(newTrack);
            }
            if (oldTrack) {
                localStreamRef.current!.removeTrack(oldTrack);
                oldTrack.stop();
            }
            localStreamRef.current?.addTrack(newTrack);
            if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
            setActiveVideoDevice(deviceId);
        } catch (err) {
            console.error("Switch camera failed:", err);
        }
    };

    // ─── Call recording ───
    const [recording, setRecording] = useState(false);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);

    const startRecording = useCallback(
        (remoteStream: MediaStream) => {
            if (recording || !remoteStream) return;
            try {
                const ctx = new AudioContext();
                const dest = ctx.createMediaStreamDestination();
                if (localStreamRef.current) {
                    const localSrc = ctx.createMediaStreamSource(new MediaStream(localStreamRef.current.getAudioTracks()));
                    localSrc.connect(dest);
                }
                const remoteSrc = ctx.createMediaStreamSource(new MediaStream(remoteStream.getAudioTracks()));
                remoteSrc.connect(dest);

                const tracks = [...dest.stream.getTracks()];
                const videoTracks = remoteStream.getVideoTracks();
                if (videoTracks.length) tracks.push(...videoTracks);

                const combinedStream = new MediaStream(tracks);
                const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
                    ? "video/webm;codecs=vp9,opus"
                    : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
                      ? "video/webm;codecs=vp8,opus"
                      : "audio/webm;codecs=opus";

                const recorder = new MediaRecorder(combinedStream, { mimeType });
                chunksRef.current = [];
                recorder.ondataavailable = (e) => {
                    if (e.data.size > 0) chunksRef.current.push(e.data);
                };
                recorder.onstop = () => {
                    const blob = new Blob(chunksRef.current, { type: mimeType });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `call-recording-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.webm`;
                    a.click();
                    URL.revokeObjectURL(url);
                    ctx.close().catch(() => {});
                };
                recorder.start(1000);
                recorderRef.current = recorder;
                setRecording(true);
            } catch (err) {
                console.error("[call] recording start failed:", err);
            }
        },
        [recording, localStreamRef]
    );

    const stopRecording = useCallback(() => {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
            recorderRef.current.stop();
            recorderRef.current = null;
        }
        setRecording(false);
    }, []);

    // ─── Noise suppression ───
    const [noiseSuppression, setNoiseSuppression] = useState(false);
    const noiseCtxRef = useRef<AudioContext | null>(null);
    const originalTrackRef = useRef<MediaStreamTrack | null>(null);

    const toggleNoiseSuppression = useCallback(async () => {
        if (!localStreamRef.current || !pcRef.current) return;
        const sender = pcRef.current.getSenders().find((s) => s.track?.kind === "audio");
        if (!sender) return;

        if (!noiseSuppression) {
            try {
                const audioTrack = localStreamRef.current.getAudioTracks()[0];
                if (!audioTrack) return;
                originalTrackRef.current = audioTrack;
                const ctx = new AudioContext();
                noiseCtxRef.current = ctx;
                const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
                const filter = ctx.createBiquadFilter();
                filter.type = "highpass";
                filter.frequency.value = 85;
                filter.Q.value = 0.7;
                const dest = ctx.createMediaStreamDestination();
                source.connect(filter);
                filter.connect(dest);
                const filteredTrack = dest.stream.getAudioTracks()[0];
                await sender.replaceTrack(filteredTrack);
                setNoiseSuppression(true);
            } catch (err) {
                console.error("[call] noise suppression failed:", err);
            }
        } else {
            if (originalTrackRef.current) {
                await sender.replaceTrack(originalTrackRef.current);
            }
            if (noiseCtxRef.current) {
                noiseCtxRef.current.close().catch(() => {});
                noiseCtxRef.current = null;
            }
            setNoiseSuppression(false);
        }
    }, [noiseSuppression, localStreamRef, pcRef]);

    return {
        muted,
        videoOff,
        screenSharing,
        onHold,
        isFullscreen,
        connectionQuality,
        detailedStats,
        audioDevices,
        videoDevices,
        activeAudioDevice,
        activeVideoDevice,
        showAudioDevices,
        setShowAudioDevices,
        showVideoDevices,
        setShowVideoDevices,
        toggleMute,
        toggleVideo,
        toggleScreenShare,
        toggleHold,
        toggleFullscreen,
        togglePiP,
        switchAudioDevice,
        switchVideoDevice,
        startQualityMonitor,
        recording,
        startRecording,
        stopRecording,
        noiseSuppression,
        toggleNoiseSuppression,
    };
}