import React, { useEffect, useState } from 'react';
import { Phone, HandMetal, Check, ClipboardList, Users } from 'lucide-react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useMeeting } from '../MeetingContext';
import { useMeetingState } from './meeting/useMeetingState';
import ParticipantTile from './meeting/ParticipantTile';
import PresenterView from './meeting/PresenterView';
import MeetingBottomBar from './meeting/MeetingBottomBar';
import MeetingChat from './meeting/MeetingChat';
import MeetingParticipants from './meeting/MeetingParticipants';
import './meeting/MeetingRoom.css';

export default function MeetingRoom() {
    const { code } = useParams();
    const { state: routeState } = useLocation();
    const navigate = useNavigate();
    const { user } = useAuth();
    const { session, joinMeeting, leaveMeeting: ctxLeave, setLocalStream, localStreamRef, wsRef } = useMeeting();
    const [copied, setCopied] = useState(false);
    const [meetingTimer, setMeetingTimer] = useState(0);

    const meeting = routeState?.meeting || session?.meeting;
    const meetingId = meeting?.id;
    const isOrganizer = meeting?.created_by === user?.id;
    const isReturning = routeState?.returning || false;

    // Register meeting session in global context on first mount (not on return)
    useEffect(() => {
        if (!meetingId) return;
        // If already in a session for this meeting, skip
        if (session?.meetingId === meetingId) return;
        joinMeeting({
            meetingId,
            code,
            meeting,
            initialMuted: routeState?.initialMuted ?? false,
            initialVideoOff: routeState?.initialVideoOff ?? false,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meetingId]);

    const {
        localStream, screenStream, muted, videoOff, screenSharing,
        participants, status, raisedHand, messages,
        activePanel, setActivePanel,
        connectionQualities, presenterId,
        toggleMute, toggleVideo, toggleScreenShare, raiseHand,
        sendChatMessage, endMeeting, leaveMeeting, muteParticipant, addParticipant,
        bgEffect, setBackgroundEffect, bgEffectError,
    } = useMeetingState({
        meetingId,
        ws: wsRef.current,
        initialMuted: routeState?.initialMuted ?? false,
        initialVideoOff: routeState?.initialVideoOff ?? false,
        keepAliveOnUnmount: true,
        existingStream: isReturning ? localStreamRef.current : null,
    });

    // Store localStream in context so PiP can access it
    useEffect(() => {
        if (localStream) setLocalStream(localStream);
    }, [localStream, setLocalStream]);

    // Meeting duration timer
    useEffect(() => {
        if (status !== 'connected') return;
        const interval = setInterval(() => setMeetingTimer(t => t + 1), 1000);
        return () => clearInterval(interval);
    }, [status]);

    // On explicit leave or end, tear down the global session
    useEffect(() => {
        if (status === 'left' || status === 'ended') {
            ctxLeave();
        }
    }, [status, ctxLeave]);

    if (!meetingId) {
        navigate(`/meeting/${code}`);
        return null;
    }

    const allParticipants = [...participants.values()];
    const totalCount = allParticipants.length + 1;

    const presenterUser = presenterId
        ? (presenterId === user?.id ? { name: 'You', stream: screenStream } : participants.get(presenterId))
        : null;

    const tilesInGrid = presenterId ? allParticipants.filter(p => p.userId !== presenterId) : allParticipants;
    const gridCount = Math.min(presenterId ? tilesInGrid.length + 1 : totalCount, 9);
    const gridDataCount = presenterId ? 'strip' : (gridCount <= 6 ? String(gridCount) : 'n');

    const handleLeave = () => { leaveMeeting(); };
    const handleEnd = () => { endMeeting(); };

    const handleRejoin = () => {
        navigate(`/meeting/${code}`, { state: { meeting } });
    };

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
                    <div className="mr-leave-icon">{status === 'ended' ? <Phone size={36} strokeWidth={1.5} /> : <HandMetal size={36} strokeWidth={1.5} />}</div>
                    <h2>{status === 'ended' ? 'Meeting has ended' : 'You left the meeting'}</h2>
                    {meetingTimer > 0 && <p className="mr-leave-duration">Duration: {formatTimer(meetingTimer)}</p>}
                    <div className="mr-leave-actions">
                        <button className="mr-rejoin-btn" onClick={handleRejoin}>Rejoin</button>
                        <button className="mr-back-btn" onClick={() => navigate('/')}>Go to Dashboard</button>
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
                        <span className="mr-copy-icon">{copied ? <Check size={14} /> : <ClipboardList size={14} />}</span>
                    </button>
                    <span><Users size={14} style={{marginRight:4,verticalAlign:'middle'}} />{totalCount}</span>
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
                            participant={{ raisedHand }}
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
                        bgEffect={bgEffect}
                        onBgEffectChange={setBackgroundEffect}
                        bgEffectError={bgEffectError}
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
