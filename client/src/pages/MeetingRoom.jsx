import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Copy, Check } from 'lucide-react';
import { useMeeting } from '../MeetingContext';
import { useAuth } from '../AuthContext';
import { getMeeting } from '../api';
import { useMeetingState } from './meeting/useMeetingState';
import { useMeetingRecording } from './meeting/useMeetingRecording';
import ParticipantTile from './meeting/ParticipantTile';
import PresenterView from './meeting/PresenterView';
import MeetingBottomBar from './meeting/MeetingBottomBar';
import MeetingChat from './meeting/MeetingChat';
import MeetingParticipants from './meeting/MeetingParticipants';
import './meeting/MeetingRoom.css';

/**
 * Main meeting room page — VideoSDK-inspired full-viewport dark layout.
 */
export default function MeetingRoom() {
    const navigate = useNavigate();
    const { code } = useParams();
    const { user } = useAuth();
    const { session, wsRef, localStreamRef, leaveMeeting: ctxLeave, joinMeeting } = useMeeting();
    const ws = wsRef?.current;
    const [autoJoinError, setAutoJoinError] = useState('');
    const [codeCopied, setCodeCopied] = useState(false);

    const copyMeetingCode = useCallback(() => {
        const c = session?.code || code;
        if (!c) return;
        navigator.clipboard?.writeText(c);
        setCodeCopied(true);
        setTimeout(() => setCodeCopied(false), 2000);
    }, [session?.code, code]);

    // Auto-join: if navigated directly (e.g. desktop deep link) without a session, fetch meeting and join
    useEffect(() => {
        if (session || !code) return;
        let cancelled = false;
        getMeeting(code)
            .then(r => {
                if (cancelled) return;
                joinMeeting({ meetingId: r.data.id, code, meeting: r.data, initialMuted: false, initialVideoOff: false });
            })
            .catch(() => {
                if (!cancelled) setAutoJoinError('Meeting not found or you are not invited.');
            });
        return () => { cancelled = true; };
    }, [session, code, joinMeeting]);

    const {
        localStream, screenStream, muted, videoOff, screenSharing,
        participants, status, raisedHand, messages,
        activePanel, setActivePanel, connectionQualities, presenterId,
        toggleMute, toggleVideo, toggleScreenShare, raiseHand,
        sendChatMessage, sendChatFile, endMeeting, leaveMeeting, muteParticipant, addParticipant,
    } = useMeetingState({
        meetingId: session?.meetingId,
        ws,
        initialMuted: session?.initialMuted,
        initialVideoOff: session?.initialVideoOff,
        existingStream: localStreamRef?.current || null,
    });

    // Timer
    const [elapsed, setElapsed] = useState(0);
    const timerRef = useRef(null);
    useEffect(() => {
        timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
        return () => clearInterval(timerRef.current);
    }, []);
    const formatTime = (s) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
    };

    // Navigate away on end/leave
    useEffect(() => {
        if (status === 'ended' || status === 'left') {
            ctxLeave();
            navigate('/');
        }
    }, [status, ctxLeave, navigate]);

    // Keyboard shortcuts (Alt+A = mute, Alt+V = video)
    useEffect(() => {
        const handler = (e) => {
            if (e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); toggleMute(); }
            if (e.altKey && e.key.toLowerCase() === 'v') { e.preventDefault(); toggleVideo(); }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [toggleMute, toggleVideo]);

    // Build tile list: local + remote participants
    const tiles = useMemo(() => {
        const list = [];
        // Local tile
        list.push({
            key: 'local',
            participant: {
                userId: user?.id,
                name: user?.full_name || user?.username || 'You',
                stream: localStream,
                muted,
                videoOff,
                raisedHand,
            },
            isLocal: true,
        });
        // Remote tiles
        for (const [uid, p] of participants) {
            list.push({ key: uid, participant: p, isLocal: false });
        }
        return list;
    }, [user, localStream, muted, videoOff, raisedHand, participants]);

    // Determine presenter
    const presenterParticipant = presenterId === user?.id ? null : participants.get(presenterId);
    const presenterStream = presenterId === user?.id ? screenStream : presenterParticipant?.stream;
    const presenterName = presenterId === user?.id
        ? (user?.full_name || 'You')
        : (presenterParticipant?.name || 'Participant');

    const isHost = session?.meeting?.organizer_id === user?.id;
    const tileCount = tiles.length;

    // Count raised hands (local + remote)
    const raisedHandCount = useMemo(() => {
        let count = raisedHand ? 1 : 0;
        for (const [, p] of participants) { if (p.raisedHand) count++; }
        return count;
    }, [raisedHand, participants]);

    // Meeting recording
    const { recording, toggleRecording } = useMeetingRecording({
        localStream,
        screenStream,
        participants,
        presenterId,
        localUserId: user?.id,
    });

    const handleToggleChat = () => setActivePanel(p => p === 'chat' ? null : 'chat');
    const handleToggleParticipants = () => setActivePanel(p => p === 'participants' ? null : 'participants');

    // Track unread chat messages when panel is not open
    const [chatUnreadCount, setChatUnreadCount] = useState(0);
    const prevMsgCountRef = useRef(messages.length);
    useEffect(() => {
        if (messages.length > prevMsgCountRef.current) {
            if (activePanel !== 'chat') {
                setChatUnreadCount(c => c + (messages.length - prevMsgCountRef.current));
            }
        }
        prevMsgCountRef.current = messages.length;
    }, [messages.length, activePanel]);
    useEffect(() => {
        if (activePanel === 'chat') setChatUnreadCount(0);
    }, [activePanel]);

    // Mute all participants (host only)
    const muteAllParticipants = useCallback(() => {
        for (const [uid] of participants) {
            if (uid !== user?.id) muteParticipant(uid);
        }
    }, [participants, user?.id, muteParticipant]);

    const handleLeave = () => { leaveMeeting(); };
    const handleEnd = () => { endMeeting(); };

    if (!session) {
        return (
            <div className="mr-root">
                <div className="mr-status-overlay">
                    <span className="mr-status-text">{autoJoinError || 'Joining meeting…'}</span>
                </div>
            </div>
        );
    }

    return (
        <div className="mr-root">
            {/* Header */}
            <div className="mr-header">
                <div className="mr-header-left">
                    <span className="mr-header-title">{session.meeting?.title || 'Meeting'}</span>
                    <span
                        className="mr-header-id"
                        onClick={copyMeetingCode}
                        title="Click to copy code"
                    >
                        {session.code || code}
                        {codeCopied ? <Check size={12} style={{ marginLeft: 4 }} /> : <Copy size={12} style={{ marginLeft: 4 }} />}
                    </span>
                </div>
                <div className="mr-header-right">
                    <span className="mr-timer">{formatTime(elapsed)}</span>
                </div>
            </div>

            {/* Body */}
            <div className="mr-body">
                <div className="mr-main">
                    {presenterId ? (
                        /* Presenter layout */
                        <div className="mr-presenter-layout">
                            <div className="mr-presenter-main">
                                <PresenterView
                                    presenterStream={presenterStream}
                                    presenterName={presenterName}
                                />
                            </div>
                            <div className="mr-presenter-sidebar">
                                {tiles.map(({ key, participant, isLocal }) => (
                                    <ParticipantTile
                                        key={key}
                                        participant={participant}
                                        isLocal={isLocal}
                                        quality={connectionQualities.get(participant.userId)}
                                        isMini
                                    />
                                ))}
                            </div>
                        </div>
                    ) : (
                        /* Grid layout */
                        <div className="mr-grid" data-count={Math.min(tileCount, 6)}>
                            {tiles.map(({ key, participant, isLocal }) => (
                                <ParticipantTile
                                    key={key}
                                    participant={participant}
                                    isLocal={isLocal}
                                    quality={connectionQualities.get(participant.userId)}
                                />
                            ))}
                        </div>
                    )}
                </div>

                {/* Sidebar */}
                {activePanel && (
                    <div className="mr-sidebar">
                        <div className="mr-sidebar-header">
                            <span className="mr-sidebar-title">
                                {activePanel === 'chat' ? 'Chat' : 'Participants'}
                            </span>
                            <button className="mr-sidebar-close" onClick={() => setActivePanel(null)}>✕</button>
                        </div>
                        <div className="mr-sidebar-body">
                            {activePanel === 'chat' && (
                                <MeetingChat messages={messages} onSend={sendChatMessage} onSendFile={sendChatFile} />
                            )}
                            {activePanel === 'participants' && (
                                <MeetingParticipants
                                    participants={participants}
                                    localUserId={user?.id}
                                    isOrganizer={isHost}
                                    onMute={muteParticipant}
                                    onMuteAll={muteAllParticipants}
                                    onAdd={addParticipant}
                                />
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Bottom bar */}
            <MeetingBottomBar
                muted={muted}
                videoOff={videoOff}
                screenSharing={screenSharing}
                raisedHand={raisedHand}
                raisedHandCount={raisedHandCount}
                activePanel={activePanel}
                participantCount={tileCount}
                meetingCode={session.code || code}
                recording={recording}
                onToggleRecording={toggleRecording}
                chatUnreadCount={chatUnreadCount}
                onToggleMute={toggleMute}
                onToggleVideo={toggleVideo}
                onToggleScreenShare={toggleScreenShare}
                onRaiseHand={raiseHand}
                onToggleChat={handleToggleChat}
                onToggleParticipants={handleToggleParticipants}
                onLeaveMeeting={handleLeave}
                onEndMeeting={handleEnd}
                onMuteAll={muteAllParticipants}
                isHost={isHost}
            />

            {/* Joining overlay */}
            {status === 'joining' && (
                <div className="mr-status-overlay">
                    <span className="mr-status-text">Joining meeting…</span>
                </div>
            )}
        </div>
    );
}
