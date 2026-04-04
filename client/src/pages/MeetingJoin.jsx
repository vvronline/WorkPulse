import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getMeeting } from '../api';
import { useAuth } from '../AuthContext';
import './MeetingJoin.css';

export default function MeetingJoin() {
    const { code } = useParams();
    const navigate = useNavigate();
    const { user } = useAuth();

    const [meeting, setMeeting] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [audioMuted, setAudioMuted] = useState(false);
    const [videoOff, setVideoOff] = useState(false);
    const [stream, setStream] = useState(null);
    const [devices, setDevices] = useState({ audio: [], video: [], speaker: [] });
    const [selectedAudio, setSelectedAudio] = useState('');
    const [selectedVideo, setSelectedVideo] = useState('');
    const [selectedSpeaker, setSelectedSpeaker] = useState('');
    const [audioLevel, setAudioLevel] = useState(0);
    const [networkStats, setNetworkStats] = useState(null);
    const [networkError, setNetworkError] = useState('');
    const [copied, setCopied] = useState(false);

    const videoRef = useRef(null);
    const audioCtxRef = useRef(null);
    const analyserRef = useRef(null);
    const animRef = useRef(null);

    useEffect(() => {
        getMeeting(code)
            .then(r => setMeeting(r.data))
            .catch(() => setError('Meeting not found or you are not invited.'))
            .finally(() => setLoading(false));
    }, [code]);

    // Acquire media
    useEffect(() => {
        let s;
        navigator.mediaDevices.getUserMedia({ audio: true, video: true })
            .then(st => {
                s = st;
                setStream(st);
                if (videoRef.current) { videoRef.current.srcObject = st; videoRef.current.play().catch(() => {}); }
                return navigator.mediaDevices.enumerateDevices();
            })
            .then(devs => {
                setDevices({
                    audio: devs.filter(d => d.kind === 'audioinput'),
                    video: devs.filter(d => d.kind === 'videoinput'),
                    speaker: devs.filter(d => d.kind === 'audiooutput'),
                });
            })
            .catch(() => {
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
                            audio: devs.filter(d => d.kind === 'audioinput'),
                            video: devs.filter(d => d.kind === 'videoinput'),
                            speaker: devs.filter(d => d.kind === 'audiooutput'),
                        });
                    })
                    .catch(err => {
                        setVideoOff(true);
                        setAudioMuted(true);
                        if (err?.name === 'NotAllowedError') {
                            setError('Camera/microphone access is blocked. Click the lock/tune icon in the address bar to allow access. If the setting is locked, your organization may be blocking it — contact your IT admin to whitelist this site.');
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
                audio: devs.filter(d => d.kind === 'audioinput'),
                video: devs.filter(d => d.kind === 'videoinput'),
                speaker: devs.filter(d => d.kind === 'audiooutput'),
            });
        };
        navigator.mediaDevices?.addEventListener('devicechange', handleChange);
        return () => navigator.mediaDevices?.removeEventListener('devicechange', handleChange);
    }, []);

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
            cancelAnimationFrame(animRef.current);
            audioCtxRef.current?.close().catch(() => {});
        };
    }, [stream, audioMuted]);

    // Network speed check
    const checkNetworkSpeed = useCallback(async () => {
        setNetworkError('');
        setNetworkStats(null);
        try {
            const startTime = performance.now();
            // Simple download speed check using a small fetch
            const response = await fetch('/api/health', { cache: 'no-store' });
            const data = await response.text();
            const endTime = performance.now();
            const duration = (endTime - startTime) / 1000; // seconds
            const sizeInBits = data.length * 8;
            const speedMbps = (sizeInBits / duration / 1000000).toFixed(2);
            // Use RTT as a proxy for quality
            const rtt = Math.round(endTime - startTime);
            const quality = rtt < 100 ? 'good' : rtt < 300 ? 'medium' : 'poor';
            setNetworkStats({ rtt, quality, speed: speedMbps });
        } catch {
            setNetworkError('Could not check network');
        }
    }, []);

    useEffect(() => { checkNetworkSpeed(); }, [checkNetworkSpeed]);

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
    const handleAudioChange = async (deviceId) => {
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
    const handleVideoChange = async (deviceId) => {
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
        navigate(`/meeting/${code}/room`, {
            state: { initialMuted: audioMuted, initialVideoOff: videoOff, meeting },
        });
    };

    const copyCode = () => {
        navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    if (loading) return <div className="mj-loading"><div className="mj-loading-spinner" />Loading meeting…</div>;
    if (error) return <div className="mj-error">{error}</div>;

    const isEnded = meeting?.status === 'ended' || meeting?.status === 'cancelled';
    const networkQualityColor = { good: '#10b981', medium: '#f59e0b', poor: '#ef4444' };

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
                            <span className="mj-avatar">{(user?.full_name || user?.username || 'U')[0].toUpperCase()}</span>
                        </div>
                    ) : (
                        <video ref={videoRef} autoPlay muted playsInline className="mj-video" />
                    )}
                    <div className="mj-preview-controls">
                        <button
                            className={`mj-ctrl-btn ${audioMuted ? 'mj-ctrl-off' : ''}`}
                            onClick={() => setAudioMuted(v => !v)}
                            title={audioMuted ? 'Unmute' : 'Mute'}
                        >
                            {audioMuted ? '🔇' : '🎙️'}
                        </button>
                        <button
                            className={`mj-ctrl-btn ${videoOff ? 'mj-ctrl-off' : ''}`}
                            onClick={() => setVideoOff(v => !v)}
                            title={videoOff ? 'Start video' : 'Stop video'}
                        >
                            {videoOff ? '📷' : '🎥'}
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
                    <h2 className="mj-title">{meeting?.title || 'Meeting'}</h2>
                    <div className="mj-code-row">
                        <span className="mj-code">Code: {code}</span>
                        <button className="mj-copy-btn" onClick={copyCode} title="Copy code">
                            {copied ? '✓' : '📋'}
                        </button>
                    </div>
                    {meeting?.organizer_name && (
                        <p className="mj-host">Hosted by {meeting.organizer_name}</p>
                    )}

                    {/* Device selectors */}
                    <div className="mj-devices">
                        {devices.audio.length > 0 && (
                            <div className="mj-device-select">
                                <label>🎙️ Microphone</label>
                                <select value={selectedAudio} onChange={e => handleAudioChange(e.target.value)}>
                                    {devices.audio.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
                                </select>
                            </div>
                        )}
                        {devices.video.length > 0 && (
                            <div className="mj-device-select">
                                <label>🎥 Camera</label>
                                <select value={selectedVideo} onChange={e => handleVideoChange(e.target.value)}>
                                    {devices.video.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>)}
                                </select>
                            </div>
                        )}
                        {devices.speaker.length > 0 && (
                            <div className="mj-device-select">
                                <label>🔊 Speaker</label>
                                <select value={selectedSpeaker} onChange={e => setSelectedSpeaker(e.target.value)}>
                                    {devices.speaker.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Speaker'}</option>)}
                                </select>
                            </div>
                        )}
                    </div>

                    {isEnded ? (
                        <div className="mj-ended">This meeting has ended.</div>
                    ) : (
                        <button className="mj-join-btn" onClick={handleJoin}>
                            Join now
                        </button>
                    )}
                    <button className="mj-back-btn" onClick={() => navigate(-1)}>← Back</button>
                </div>
            </div>
        </div>
    );
}
