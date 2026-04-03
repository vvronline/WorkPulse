import React, { useEffect, useRef, useState } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useMeetingState } from './meeting/useMeetingState';
import ParticipantTile from './meeting/ParticipantTile';
import PresenterView from './meeting/PresenterView';
import MeetingBottomBar from './meeting/MeetingBottomBar';
import MeetingChat from './meeting/MeetingChat';
import MeetingParticipants from './meeting/MeetingParticipants';
import './meeting/MeetingRoom.css';

function useAppWs() {
    const wsRef = useRef(null);

    useEffect(() => {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const host = import.meta.env.PROD ? window.location.host : `${window.location.hostname}:${import.meta.env.VITE_API_PORT || '5000'}`;
        const wsUrl = `${proto}://${host}/ws`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        return () => { ws.close(); };
    }, []);

    return wsRef;
}

export default function MeetingRoom() {
    const { code } = useParams();
    const { state: routeState } = useLocation();
    const navigate = useNavigate();
    const { user } = useAuth();
    const [copied, setCopied] = useState(false);
    const [meetingTimer, setMeetingTimer] = useState(0);

    const meeting = routeState?.meeting;
    const meetingId = meeting?.id;
    const isOrganizer = meeting?.created_by === user?.id;

    const wsRef = useAppWs();

    const {
        localStream, screenStream, muted, videoOff, screenSharing,
        participants, status, raisedHand, messages,
        activePanel, setActivePanel,
        connectionQualities, presenterId,
        toggleMute, toggleVideo, toggleScreenShare, raiseHand,
        sendChatMessage, endMeeting, leaveMeeting, muteParticipant, addParticipant,
        handleWsMessage,
    } = useMeetingState({
        meetingId,
        ws: wsRef.current,
        initialMuted: routeState?.initialMuted ?? false,
        initialVideoOff: routeState?.initialVideoOff ?? false,
    });

    // Route incoming WS messages to the hook
    useEffect(() => {
        const ws = wsRef.current;
        if (!ws) return;
        const onMessage = (e) => {
            try { handleWsMessage(JSON.parse(e.data)); } catch { /* ignore */ }
        };
        ws.addEventListener('message', onMessage);
        return () => ws.removeEventListener('message', onMessage);
    }, [handleWsMessage]);

    // Meeting duration timer
    useEffect(() => {
        if (status !== 'connected') return;
        const interval = setInterval(() => setMeetingTimer(t => t + 1), 1000);
        return () => clearInterval(interval);
    }, [status]);

    // Navigate away when meeting ends or left
    useEffect(() => {
        if (status === 'ended' || status === 'left') {
            const timer = setTimeout(() => navigate(-1), 4000);
            return () => clearTimeout(timer);
        }
    }, [status, navigate]);

    if (!meetingId) {
        navigate(`/meeting/${code}`);
        return null;
    }

    const allParticipants = [...participants.values()];
    const totalCount = allParticipants.length + 1;

    // Presenter mode: someone is screen-sharing
    const presenterUser = presenterId
        ? (presenterId === user?.id ? { name: 'You', stream: screenStream } : participants.get(presenterId))
        : null;

    // In presenter mode, show fewer tiles in a strip
    const tilesInGrid = presenterId ? allParticipants.filter(p => p.userId !== presenterId) : allParticipants;
    const gridCount = Math.min(presenterId ? tilesInGrid.length + 1 : totalCount, 9);
    const gridDataCount = presenterId ? 'strip' : (gridCount <= 6 ? String(gridCount) : 'n');

    const handleLeave = () => { leaveMeeting(); navigate(-1); };
    const handleEnd = () => { endMeeting(); };

    const copyMeetingId = () => {
        navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const formatTimer = (s) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };

    // Waiting screen
    if (status === 'joining' || status === 'connecting') {
        return (
            <div className="mr-root">
                <div className="mr-waiting">
                    <div className="mr-waiting-spinner" />
                    <h2>{status === 'joining' ? 'Joining meeting…' : 'Connecting to participants…'}</h2>
                    <p>{meeting?.title || 'Meeting'}</p>
                </div>
            </div>
        );
    }

    // Left / ended screen
    if (status === 'left' || status === 'ended') {
        return (
            <div className="mr-root">
                <div className="mr-leave-screen">
                    <div className="mr-leave-icon">{status === 'ended' ? '📞' : '👋'}</div>
                    <h2>{status === 'ended' ? 'Meeting has ended' : 'You left the meeting'}</h2>
                    {meetingTimer > 0 && <p className="mr-leave-duration">Duration: {formatTimer(meetingTimer)}</p>}
                    <p className="mr-leave-sub">Redirecting you back…</p>
                    <div className="mr-leave-actions">
                        <button className="mr-back-btn" onClick={() => navigate(-1)}>Go back now</button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="mr-root">
            {/* Header */}
            <div className="mr-header">
                <div className="mr-header-left">
                    <span className="mr-header-title">{meeting?.title || 'Meeting'}</span>
                    {meetingTimer > 0 && <span className="mr-header-timer">{formatTimer(meetingTimer)}</span>}
                </div>
                <div className="mr-header-info">
                    <button className="mr-code-btn" onClick={copyMeetingId} title="Copy meeting code">
                        <span className="mr-code">{code}</span>
                        <span className="mr-copy-icon">{copied ? '✓' : '📋'}</span>
                    </button>
                    <span>👥 {totalCount}</span>
                </div>
            </div>

            {/* Body */}
            <div className="mr-body">
                <div className="mr-main">
                    {/* Presenter view when someone is screen-sharing */}
                    {presenterId && presenterUser && (
                        <PresenterView
                            presenterStream={presenterUser.stream}
                            presenterName={presenterUser.name || 'Participant'}
                            isLocal={presenterId === user?.id}
                            localStream={localStream}
                        />
                    )}

                    {/* Participant grid */}
                    <div className={`mr-grid ${presenterId ? 'mr-grid-strip' : ''}`} data-count={gridDataCount}>
                        <ParticipantTile
                            isLocal
                            localStream={localStream}
                            screenStream={screenStream}
                            screenSharing={screenSharing && !presenterId}
                            userName={user?.full_name || user?.username}
                            muted={muted}
                            videoOff={videoOff}
                        />
                        {tilesInGrid.map(p => (
                            <ParticipantTile
                                key={p.userId}
                                participant={p}
                                quality={connectionQualities.get(p.userId)}
                            />
                        ))}
                    </div>

                    {/* Bottom bar */}
                    <MeetingBottomBar
                        muted={muted}
                        videoOff={videoOff}
                        screenSharing={screenSharing}
                        raisedHand={raisedHand}
                        onToggleMute={toggleMute}
                        onToggleVideo={toggleVideo}
                        onScreenShare={toggleScreenShare}
                        onRaiseHand={raiseHand}
                        onToggleChat={() => setActivePanel(p => p === 'chat' ? null : 'chat')}
                        onToggleParticipants={() => setActivePanel(p => p === 'participants' ? null : 'participants')}
                        onLeave={handleLeave}
                        onEnd={handleEnd}
                        isOrganizer={isOrganizer}
                        participantCount={totalCount}
                        activePanel={activePanel}
                    />
                </div>

                {/* Sidebar */}
                {activePanel && (
                    <div className="mr-side">
                        {activePanel === 'chat' && (
                            <MeetingChat messages={messages} onSend={sendChatMessage} />
                        )}
                        {activePanel === 'participants' && (
                            <MeetingParticipants
                                participants={participants}
                                localUserId={user?.id}
                                isOrganizer={isOrganizer}
                                onMute={muteParticipant}
                                onAdd={addParticipant}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
