import React, { useState, useEffect, useRef } from 'react';
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
    const [devices, setDevices] = useState({ audio: [], video: [] });
    const [selectedAudio, setSelectedAudio] = useState('');
    const [selectedVideo, setSelectedVideo] = useState('');

    const videoRef = useRef(null);

    useEffect(() => {
        getMeeting(code)
            .then(r => setMeeting(r.data))
            .catch(() => setError('Meeting not found or you are not invited.'))
            .finally(() => setLoading(false));
    }, [code]);

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
                });
            })
            .catch(() => {
                setVideoOff(true);
                setAudioMuted(true);
            });
        return () => { if (s) s.getTracks().forEach(t => t.stop()); };
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

    const handleJoin = () => {
        // Stop the lobby preview stream before entering room (room will re-acquire)
        if (stream) stream.getTracks().forEach(t => t.stop());
        navigate(`/meeting/${code}/room`, {
            state: { initialMuted: audioMuted, initialVideoOff: videoOff, meeting },
        });
    };

    if (loading) return <div className="mj-loading">Loading meeting…</div>;
    if (error) return <div className="mj-error">{error}</div>;

    const isEnded = meeting?.status === 'ended' || meeting?.status === 'cancelled';

    return (
        <div className="mj-root">
            <div className="mj-card">
                <div className="mj-preview">
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
                </div>

                <div className="mj-info">
                    <h2 className="mj-title">{meeting?.title || 'Meeting'}</h2>
                    <p className="mj-code">Code: {code}</p>
                    {meeting?.organizer_name && (
                        <p className="mj-host">Hosted by {meeting.organizer_name}</p>
                    )}

                    {devices.audio.length > 1 && (
                        <div className="mj-device-select">
                            <label>Microphone</label>
                            <select value={selectedAudio} onChange={e => setSelectedAudio(e.target.value)}>
                                {devices.audio.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
                            </select>
                        </div>
                    )}
                    {devices.video.length > 1 && (
                        <div className="mj-device-select">
                            <label>Camera</label>
                            <select value={selectedVideo} onChange={e => setSelectedVideo(e.target.value)}>
                                {devices.video.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>)}
                            </select>
                        </div>
                    )}

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
