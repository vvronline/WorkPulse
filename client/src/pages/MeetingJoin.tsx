import React, { useState, useEffect, useRef, useCallback } from "react";
import { MicOff, Mic, CameraOff, Camera, Check, ClipboardList, Volume2, Play } from "lucide-react";
import { useParams, useNavigate } from "react-router-dom";
import { getMeeting, getIceConfig } from "../api";
import { useAuth } from "../AuthContext";
import { useMeeting } from "../MeetingContext";
// ADR-010 — ICE preflight. Runs in parallel with media + network
// checks so the user can be warned BEFORE clicking Join if their
// network blocks WebRTC.
import { runPreflight, summarisePreflight } from "./meeting/preflight";
import "./MeetingJoin.css";

interface DeviceLists {
    audio: MediaDeviceInfo[];
    video: MediaDeviceInfo[];
    speaker: MediaDeviceInfo[];
}

interface NetworkStats {
    rtt: number;
    quality: string;
    speed: string;
}

export default function MeetingJoin() {
    const { code } = useParams<{ code: string }>();
    const navigate = useNavigate();
    const { user } = useAuth() as any;
    const { joinMeeting } = useMeeting() as any;

    const [meeting, setMeeting] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [audioMuted, setAudioMuted] = useState(false);
    const [videoOff, setVideoOff] = useState(false);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [devices, setDevices] = useState<DeviceLists>({ audio: [], video: [], speaker: [] });
    const [selectedAudio, setSelectedAudio] = useState("");
    const [selectedVideo, setSelectedVideo] = useState("");
    const [selectedSpeaker, setSelectedSpeaker] = useState("");
    const [audioLevel, setAudioLevel] = useState(0);
    const [networkStats, setNetworkStats] = useState<NetworkStats | null>(null);
    const [networkError, setNetworkError] = useState("");
    const [copied, setCopied] = useState(false);
    const [testingSpeaker, setTestingSpeaker] = useState(false);

    // ADR-010 — ICE preflight result. Runs once in the background after
    // the page mounts and persists through the join action so the user
    // can see WHY they're being asked to wait. `null` while in-flight.
    const [preflight, setPreflight] = useState<any>(null);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const animRef = useRef<number | null>(null);
    const testAudioRef = useRef<HTMLAudioElement | null>(null);

    // Speaker test — plays a short tone through the currently selected
    // audio output device so users can verify their speakers/headphones
    // before joining. Uses HTMLAudioElement.setSinkId() to route the
    // playback to the chosen device (where supported by the browser).
    // VideoSDK exposes the same behaviour in their DropDownSpeaker component.
    const testSpeaker = useCallback(async () => {
        if (testingSpeaker) return;
        try {
            // Generate a 0.6s ping using Web Audio so we don't ship an mp3.
            const Ctx = window.AudioContext || (window as any).webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const dest = ctx.createMediaStreamDestination();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = 660;
            gain.gain.setValueAtTime(0, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.05);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.55);
            osc.connect(gain).connect(dest);
            osc.start();
            osc.stop(ctx.currentTime + 0.6);

            const audio = new Audio();
            audio.srcObject = dest.stream;
            testAudioRef.current = audio;
            // Route to selected speaker if the browser supports it
            if (selectedSpeaker && typeof (audio as any).setSinkId === "function") {
                try { await (audio as any).setSinkId(selectedSpeaker); } catch { /* fallback to default */ }
            }
            setTestingSpeaker(true);
            await audio.play().catch(() => { /* autoplay blocked */ });
            setTimeout(() => {
                setTestingSpeaker(false);
                try { audio.pause(); } catch { /* ignore */ }
                try { ctx.close(); } catch { /* ignore */ }
            }, 700);
        } catch {
            setTestingSpeaker(false);
        }
    }, [selectedSpeaker, testingSpeaker]);

    useEffect(() => {
        getMeeting(code as any)
            .then(r => setMeeting(r.data))
            .catch(() => setError("Meeting not found or you are not invited."))
            .finally(() => setLoading(false));
    }, [code]);

    // Acquire media
    useEffect(() => {
        let s: MediaStream | null = null;
        navigator.mediaDevices.getUserMedia({ audio: true, video: true })
            .then(st => {
                s = st;
                setStream(st);
                if (videoRef.current) { videoRef.current.srcObject = st; videoRef.current.play().catch(() => {}); }
                return navigator.mediaDevices.enumerateDevices();
            })
            .then(devs => {
                setDevices({
                    audio: devs.filter(d => d.kind === "audioinput"),
                    video: devs.filter(d => d.kind === "videoinput"),
                    speaker: devs.filter(d => d.kind === "audiooutput"),
                });
            })
            .catch(() => {
                // Stop first stream's tracks before trying audio-only fallback
                if (s) { s.getTracks().forEach(t => t.stop()); s = null; }
                // Try audio only
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then(st => {
                        s = st;
                        setStream(st);
                        setVideoOff(true);
                        return navigator.mediaDevices.enumerateDevices();
                    })
                    .then(devs => {
                        setDevices({
                            audio: devs.filter(d => d.kind === "audioinput"),
                            video: devs.filter(d => d.kind === "videoinput"),
                            speaker: devs.filter(d => d.kind === "audiooutput"),
                        });
                    })
                    .catch((err: any) => {
                        setVideoOff(true);
                        setAudioMuted(true);
                        if (err?.name === "NotAllowedError") {
                            setError("Camera/microphone access is blocked. Click the lock/tune icon in the address bar to allow access. If the setting is locked, your organization may be blocking it — contact your IT admin to whitelist this site.");
                        }
                    });
            });
        return () => { if (s) s.getTracks().forEach(t => t.stop()); };
    }, []);

    // Listen for device changes
    useEffect(() => {
        const handleChange = async () => {
            const devs = await navigator.mediaDevices.enumerateDevices();
            setDevices({
                audio: devs.filter(d => d.kind === "audioinput"),
                video: devs.filter(d => d.kind === "videoinput"),
                speaker: devs.filter(d => d.kind === "audiooutput"),
            });
        };
        navigator.mediaDevices?.addEventListener("devicechange", handleChange);
        return () => navigator.mediaDevices?.removeEventListener("devicechange", handleChange);
    }, []);

    // Attach stream to video element when it changes
    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
        }
    }, [stream, videoOff]);

    // Audio level monitoring
    useEffect(() => {
        if (!stream || audioMuted) { setAudioLevel(0); return; }
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) return;
        try {
            const ctx = new AudioContext();
            audioCtxRef.current = ctx;
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyserRef.current = analyser;
            const source = ctx.createMediaStreamSource(stream);
            source.connect(analyser);
            const data = new Uint8Array(analyser.frequencyBinCount);
            const tick = () => {
                analyser.getByteFrequencyData(data);
                const avg = data.reduce((a, b) => a + b, 0) / data.length;
                setAudioLevel(Math.min(avg / 128, 1));
                animRef.current = requestAnimationFrame(tick);
            };
            tick();
        } catch { /* ignore */ }
        return () => {
            if (animRef.current) cancelAnimationFrame(animRef.current);
            audioCtxRef.current?.close().catch(() => {});
        };
    }, [stream, audioMuted]);

    // Network speed check
    const checkNetworkSpeed = useCallback(async () => {
        setNetworkError("");
        setNetworkStats(null);
        try {
            const startTime = performance.now();
            // Simple download speed check using a small fetch
            const response = await fetch("/api/health", { cache: "no-store" });
            const data = await response.text();
            const endTime = performance.now();
            const duration = (endTime - startTime) / 1000; // seconds
            const sizeInBits = data.length * 8;
            const speedMbps = (sizeInBits / duration / 1000000).toFixed(2);
            // Use RTT as a proxy for quality
            const rtt = Math.round(endTime - startTime);
            const quality = rtt < 100 ? "good" : rtt < 300 ? "medium" : "poor";
            setNetworkStats({ rtt, quality, speed: speedMbps });
        } catch {
            setNetworkError("Could not check network");
        }
    }, []);

    useEffect(() => { checkNetworkSpeed(); }, [checkNetworkSpeed]);

    // ADR-010 — ICE preflight. Fire-and-forget on mount. Uses the
    // production ICE config (so we exercise the actual TURN servers
    // the user will join with) but falls back to public STUN if the
    // config endpoint is slow / down. Runs in parallel with media
    // acquisition; banner appears the moment it settles (~300ms typical).
    useEffect(() => {
        let cancelled = false;
        (async () => {
            let iceServers;
            try {
                const res = await getIceConfig();
                iceServers = (res?.data as any)?.iceServers;
            } catch { /* fall through to default */ }
            const result = await runPreflight({ iceServers, timeoutMs: 5_000 });
            if (!cancelled) setPreflight(result);
        })();
        return () => { cancelled = true; };
    }, []);

    // Apply audio/video mute to local stream
    useEffect(() => {
        if (!stream) return;
        stream.getAudioTracks().forEach(t => { t.enabled = !audioMuted; });
    }, [audioMuted, stream]);

    useEffect(() => {
        if (!stream) return;
        stream.getVideoTracks().forEach(t => { t.enabled = !videoOff; });
    }, [videoOff, stream]);

    // Switch audio device
    const handleAudioChange = async (deviceId: string) => {
        setSelectedAudio(deviceId);
        if (!stream) return;
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
            const newTrack = newStream.getAudioTracks()[0];
            stream.getAudioTracks().forEach(t => { t.stop(); stream.removeTrack(t); });
            stream.addTrack(newTrack);
            newTrack.enabled = !audioMuted;
        } catch { /* ignore */ }
    };

    // Switch video device
    const handleVideoChange = async (deviceId: string) => {
        setSelectedVideo(deviceId);
        if (!stream) return;
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
            const newTrack = newStream.getVideoTracks()[0];
            stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t); });
            stream.addTrack(newTrack);
            if (videoRef.current) { videoRef.current.srcObject = stream; }
            newTrack.enabled = !videoOff;
        } catch { /* ignore */ }
    };



    const handleJoin = () => {
        if (stream) stream.getTracks().forEach(t => t.stop());
        joinMeeting({
            meetingId: meeting.id,
            code,
            meeting,
            initialMuted: audioMuted,
            initialVideoOff: videoOff,
        });
        navigate(`/meeting/${code}/room`);
    };

    const copyCode = () => {
        navigator.clipboard.writeText(code as string).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    if (loading) return <div className="mj-loading"><div className="mj-loading-spinner" />Loading meeting…</div>;
    if (error) return <div className="mj-error">{error}</div>;

    const isEnded = meeting?.status === "ended" || meeting?.status === "cancelled";
    const networkQualityColor: Record<string, string> = { good: "#10b981", medium: "#f59e0b", poor: "#ef4444" };

    return (
        <div className="mj-root">
            <div className="mj-card">
                <div className="mj-preview">
                    {/* Network stats badge */}
                    <div className="mj-network-badge">
                        {networkStats ? (
                            <>
                                <span className="mj-net-dot" style={{ background: networkQualityColor[networkStats.quality] }} />
                                <span className="mj-net-text">{networkStats.rtt}ms</span>
                            </>
                        ) : networkError ? (
                            <span className="mj-net-text mj-net-err">⚠ Offline</span>
                        ) : (
                            <span className="mj-net-text">Checking…</span>
                        )}
                        <button className="mj-net-refresh" onClick={checkNetworkSpeed} title="Recheck network">↻</button>
                    </div>

                    {videoOff ? (
                        <div className="mj-video-placeholder">
                            <span className="mj-avatar">{(user?.full_name || user?.username || "U")[0].toUpperCase()}</span>
                        </div>
                    ) : (
                        <video ref={videoRef} autoPlay muted playsInline className="mj-video" />
                    )}
                    <div className="mj-preview-controls">
                        <button
                            className={`mj-ctrl-btn ${audioMuted ? "mj-ctrl-off" : ""}`}
                            onClick={() => setAudioMuted(v => !v)}
                            title={audioMuted ? "Unmute" : "Mute"}
                        >
                            {audioMuted ? <MicOff size={20} /> : <Mic size={20} />}
                        </button>
                        <button
                            className={`mj-ctrl-btn ${videoOff ? "mj-ctrl-off" : ""}`}
                            onClick={() => setVideoOff(v => !v)}
                            title={videoOff ? "Start video" : "Stop video"}
                        >
                            {videoOff ? <CameraOff size={20} /> : <Camera size={20} />}
                        </button>

                    </div>

                    {/* Audio level bar */}
                    {!audioMuted && (
                        <div className="mj-audio-bar">
                            <div className="mj-audio-fill" style={{ width: `${audioLevel * 100}%` }} />
                        </div>
                    )}
                </div>

                <div className="mj-info">
                    <h2 className="mj-title">{meeting?.title || "Meeting"}</h2>
                    <div className="mj-code-row">
                        <span className="mj-code">Code: {code}</span>
                        <button className="mj-copy-btn" onClick={copyCode} title="Copy code">
                            {copied ? <Check size={16} /> : <ClipboardList size={16} />}
                        </button>
                    </div>
                    {meeting?.organizer_name && (
                        <p className="mj-host">Hosted by {meeting.organizer_name}</p>
                    )}

                    {/* ADR-010 — Preflight banner. Hidden while in-flight
                        (preflight === null) to avoid flashing "Checking…"
                        for the ~200ms typical resolution time. */}
                    {preflight && (() => {
                        const s = summarisePreflight(preflight);
                        if (s.severity === "ok") return null; // OK = silent, don't clutter the UI
                        const bg = s.severity === "error" ? "#fef2f2" : "#fffbeb";
                        const fg = s.severity === "error" ? "#991b1b" : "#92400e";
                        const border = s.severity === "error" ? "#fecaca" : "#fde68a";
                        return (
                            <div
                                role="alert"
                                style={{
                                    padding: "8px 12px",
                                    margin: "8px 0",
                                    background: bg,
                                    color: fg,
                                    border: `1px solid ${border}`,
                                    borderRadius: 6,
                                    fontSize: 13,
                                    lineHeight: 1.4,
                                }}
                            >
                                <strong>{s.severity === "error" ? "⚠ " : "ⓘ "}</strong>
                                {s.label}
                            </div>
                        );
                    })()}

                    {/* Device selectors */}
                    <div className="mj-devices">
                        {devices.audio.length > 0 && (
                            <div className="mj-device-select">
                                <label><Mic size={13} style={{ marginRight: 5, verticalAlign: "middle" }} />Microphone</label>
                                <select value={selectedAudio} onChange={e => handleAudioChange(e.target.value)}>
                                    {devices.audio.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || "Microphone"}</option>)}
                                </select>
                            </div>
                        )}
                        {devices.video.length > 0 && (
                            <div className="mj-device-select">
                                <label><Camera size={13} style={{ marginRight: 5, verticalAlign: "middle" }} />Camera</label>
                                <select value={selectedVideo} onChange={e => handleVideoChange(e.target.value)}>
                                    {devices.video.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || "Camera"}</option>)}
                                </select>
                            </div>
                        )}
                        {devices.speaker.length > 0 && (
                            <div className="mj-device-select">
                                <label>
                                    <Volume2 size={13} style={{ marginRight: 5, verticalAlign: "middle" }} />Speaker
                                    <button
                                        type="button"
                                        className="mj-speaker-test"
                                        onClick={testSpeaker}
                                        disabled={testingSpeaker}
                                        title="Play test sound"
                                    >
                                        <Play size={11} />
                                        {testingSpeaker ? "Playing…" : "Test"}
                                    </button>
                                </label>
                                <select value={selectedSpeaker} onChange={e => setSelectedSpeaker(e.target.value)}>
                                    {devices.speaker.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || "Speaker"}</option>)}
                                </select>
                            </div>
                        )}
                    </div>

                    <button className="mj-join-btn" onClick={handleJoin}>
                        {isEnded ? "Rejoin meeting" : "Join now"}
                    </button>
                    <button className="mj-back-btn" onClick={() => navigate(-1)}>← Back</button>
                </div>
            </div>
        </div>
    );
}