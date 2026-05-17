import React, { useRef, useEffect, useState } from 'react';
import { MicOff, Mic, CameraOff, Camera, PhoneOff } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useMeeting } from '../../MeetingContext';
import './MeetingPiP.css';

/**
 * Floating Picture-in-Picture widget shown when user navigates away from an active meeting.
 * Like MS Teams: shows mini self-video, mic/video/hangup controls, click to return.
 * Draggable.
 */
export default function MeetingPiP() {
    const { session, leaveMeeting, localStreamRef, wsRef, joinedAt } = useMeeting();
    const location = useLocation();
    const navigate = useNavigate();
    const videoRef = useRef(null);
    const pipRef = useRef(null);
    const dragState = useRef(null);
    const [pos, setPos] = useState({ right: 24, bottom: 24 });
    const [muted, setMuted] = useState(false);
    const [videoOff, setVideoOff] = useState(false);
    const [timer, setTimer] = useState(() => joinedAt ? Math.floor((Date.now() - joinedAt) / 1000) : 0);

    // Don't show if no active session or we're on the meeting room page
    const isInMeetingRoom = /^\/meeting\/[^/]+\/room/.test(location.pathname);
    const visible = session && !isInMeetingRoom;

    // Attach localStream to video element
    useEffect(() => {
        if (!visible || !videoRef.current) return;
        const stream = localStreamRef.current;
        if (stream) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => {});
            // Reflect current mute/video state
            const audioOff = !stream.getAudioTracks().some(t => t.enabled);
            const vidOff = !stream.getVideoTracks().some(t => t.enabled);
            setMuted(audioOff);
            setVideoOff(vidOff);
        }
    }, [visible, localStreamRef]);

    // Meeting timer — derived from shared joinedAt timestamp
    useEffect(() => {
        if (!visible || !joinedAt) { setTimer(0); return; }
        setTimer(Math.floor((Date.now() - joinedAt) / 1000));
        const id = setInterval(() => setTimer(Math.floor((Date.now() - joinedAt) / 1000)), 1000);
        return () => clearInterval(id);
    }, [visible, joinedAt]);

    // Dragging
    useEffect(() => {
        if (!visible) return;
        const onMove = (e) => {
            if (!dragState.current) return;
            e.preventDefault();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const dx = clientX - dragState.current.startX;
            const dy = clientY - dragState.current.startY;
            setPos({
                right: Math.max(0, dragState.current.origRight - dx),
                bottom: Math.max(0, dragState.current.origBottom - dy),
            });
        };
        const onUp = () => { dragState.current = null; };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onUp);
        };
    }, [visible]);

    const onDragStart = (e) => {
        // Don't start drag from button clicks
        if (e.target.closest('button')) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        dragState.current = {
            startX: clientX,
            startY: clientY,
            origRight: pos.right,
            origBottom: pos.bottom,
        };
    };

    const handleToggleMute = (e) => {
        e.stopPropagation();
        const stream = localStreamRef.current;
        if (!stream) return;
        const next = !muted;
        stream.getAudioTracks().forEach(t => { t.enabled = !next; });
        setMuted(next);
        // Notify peers via WS
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'meeting_track_state',
                data: { meetingId: session.meetingId, muted: next, videoOff, screenSharing: false },
            }));
        }
    };

    const handleToggleVideo = (e) => {
        e.stopPropagation();
        const stream = localStreamRef.current;
        if (!stream) return;
        const next = !videoOff;
        stream.getVideoTracks().forEach(t => { t.enabled = !next; });
        setVideoOff(next);
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'meeting_track_state',
                data: { meetingId: session.meetingId, muted, videoOff: next, screenSharing: false },
            }));
        }
    };

    const handleHangup = (e) => {
        e.stopPropagation();
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'meeting_leave',
                data: { meetingId: session.meetingId },
            }));
        }
        leaveMeeting();
    };

    const handleReturn = () => {
        navigate(`/meeting/${session.code}/room`, {
            state: {
                meeting: session.meeting,
                initialMuted: muted,
                initialVideoOff: videoOff,
                returning: true,
            },
        });
    };

    const formatTimer = (s) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };

    if (!visible) return null;

    return (
        <div
            ref={pipRef}
            className="pip-root"
            style={{ right: pos.right, bottom: pos.bottom }}
            onMouseDown={onDragStart}
            onTouchStart={onDragStart}
        >
            {/* Video preview */}
            <div className="pip-video-wrap" onClick={handleReturn}>
                {videoOff ? (
                    <div className="pip-avatar">
                        {(session.meeting?.title || 'M')[0].toUpperCase()}
                    </div>
                ) : (
                    <video ref={videoRef} className="pip-video" muted playsInline />
                )}
                <div className="pip-overlay">
                    <span className="pip-title">{session.meeting?.title || 'Meeting'}</span>
                    <span className="pip-timer">{formatTimer(timer)}</span>
                </div>
                <div className="pip-return-hint">Click to return</div>
            </div>

            {/* Controls */}
            <div className="pip-controls">
                <button
                    className={`pip-btn ${muted ? 'pip-btn-off' : ''}`}
                    onClick={handleToggleMute}
                    title={muted ? 'Unmute' : 'Mute'}
                >
                    {muted ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
                <button
                    className={`pip-btn ${videoOff ? 'pip-btn-off' : ''}`}
                    onClick={handleToggleVideo}
                    title={videoOff ? 'Start video' : 'Stop video'}
                >
                    {videoOff ? <CameraOff size={16} /> : <Camera size={16} />}
                </button>
                <button
                    className="pip-btn pip-btn-hangup"
                    onClick={handleHangup}
                    title="Leave meeting"
                >
                    <PhoneOff size={16} />
                </button>
            </div>
        </div>
    );
}
