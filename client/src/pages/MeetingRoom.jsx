import React, { useEffect, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import { useMeetingState } from './useMeetingState';
import ParticipantTile from './ParticipantTile';
import MeetingBottomBar from './MeetingBottomBar';
import MeetingChat from './MeetingChat';
import MeetingParticipants from './MeetingParticipants';
import './MeetingRoom.css';

// Access the WebSocket from the window (set up by App.jsx / ws utility)
// In production, import from your WS context or hook.
function useAppWs() {
    const wsRef = useRef(null);

    useEffect(() => {
        // Re-use existing WS if already established via ChatContext
        // Fall back to direct connection
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const host = window.location.hostname;
        const port = import.meta.env.VITE_API_PORT || '5000';
        const wsUrl = `${proto}://${host}:${port}/ws`;
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

    const meeting = routeState?.meeting;
    const meetingId = meeting?.id;
    const isOrganizer = meeting?.created_by === user?.id;

    // WS connection for the meeting room
    const wsRef = useAppWs();

    const {
        localStream, screenStream, muted, videoOff, screenSharing,
        participants, status, raisedHand, messages,
        activePanel, setActivePanel,
        connectionQualities,
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

    // Navigate away when meeting ends
    useEffect(() => {
        if (status === 'ended') {
            const timer = setTimeout(() => navigate(-1), 3000);
            return () => clearTimeout(timer);
        }
    }, [status, navigate]);

    if (!meetingId) {
        navigate(`/meeting/${code}`);
        return null;
    }

    const allParticipants = [...participants.values()];
    const totalCount = allParticipants.length + 1; // +1 for local user
    const gridCount = Math.min(totalCount, 9);
    const gridDataCount = gridCount <= 6 ? String(gridCount) : 'n';

    const handleLeave = () => { leaveMeeting(); navigate(-1); };
    const handleEnd = () => { endMeeting(); };

    return (
        <div className="mr-root">
            {/* Header */}
            <div className="mr-header">
                <span className="mr-header-title">{meeting?.title || 'Meeting'}</span>
                <div className="mr-header-info">
                    <span className="mr-code">{code}</span>
                    <span>{totalCount} participant{totalCount !== 1 ? 's' : ''}</span>
                </div>
            </div>

            {/* Body */}
            <div className="mr-body">
                {/* Main video area */}
                <div className="mr-main">
                    <div className="mr-grid" data-count={gridDataCount}>
                        {/* Local tile always first */}
                        <ParticipantTile
                            isLocal
                            localStream={localStream}
                            screenStream={screenStream}
                            screenSharing={screenSharing}
                        />
                        {/* Remote participants */}
                        {allParticipants.map(p => (
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

            {/* Meeting ended overlay */}
            {status === 'ended' && (
                <div className="mr-status">
                    <h2>Meeting ended</h2>
                    <p>Returning you to the previous page…</p>
                    <div className="mr-status-actions">
                        <button className="mr-back-btn" onClick={() => navigate(-1)}>Go back now</button>
                    </div>
                </div>
            )}
        </div>
    );
}
