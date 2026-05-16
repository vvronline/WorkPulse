import React, { useState, useRef, useEffect } from 'react';
import {
    Mic, MicOff, Video, VideoOff, MonitorUp, Hand, MessageSquare,
    Users, PhoneOff, Copy, Check, Circle, MoreVertical,
    MicOffIcon, SmilePlus, Pin
} from 'lucide-react';

const REACTIONS = ['👍', '👏', '😂', '🎉', '❤️', '🔥'];

/**
 * VideoSDK-inspired bottom bar — proper icons, recording, reactions, mobile drawer.
 */
export default function MeetingBottomBar({
    muted, videoOff, screenSharing, raisedHand, raisedHandCount,
    activePanel, participantCount, meetingCode,
    recording, onToggleRecording,
    onToggleMute, onToggleVideo, onToggleScreenShare,
    onRaiseHand, onToggleChat, onToggleParticipants,
    onLeaveMeeting, onEndMeeting, onMuteAll, onReaction,
    isHost,
}) {
    const [copied, setCopied] = useState(false);
    const [showMore, setShowMore] = useState(false);
    const [showReactions, setShowReactions] = useState(false);
    const moreRef = useRef(null);
    const reactionsRef = useRef(null);

    // Close popups on outside click
    useEffect(() => {
        const handler = (e) => {
            if (moreRef.current && !moreRef.current.contains(e.target)) setShowMore(false);
            if (reactionsRef.current && !reactionsRef.current.contains(e.target)) setShowReactions(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const handleCopy = () => {
        if (!meetingCode) return;
        navigator.clipboard?.writeText(meetingCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="mb-bar">
            {/* Left: meeting ID + recording indicator */}
            <div className="mb-left">
                {meetingCode && (
                    <button className="mb-info-btn" onClick={handleCopy} title="Copy meeting code">
                        <span className="mb-code">{meetingCode}</span>
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                )}
                {recording && (
                    <span className="mb-recording-badge" title="Recording in progress">
                        <Circle size={10} fill="#ef4444" stroke="none" className="mb-rec-dot" />
                        <span>REC</span>
                    </span>
                )}
            </div>

            {/* Center: controls */}
            <div className="mb-center">
                {/* Mic */}
                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${muted ? 'mb-btn--muted' : ''}`}
                        onClick={onToggleMute}
                        title={muted ? 'Unmute (Alt+A)' : 'Mute (Alt+A)'}
                    >
                        {muted ? <MicOff size={20} /> : <Mic size={20} />}
                    </button>
                    <span className="mb-btn-label">{muted ? 'Unmute' : 'Mute'}</span>
                </div>

                {/* Camera */}
                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${videoOff ? 'mb-btn--muted' : ''}`}
                        onClick={onToggleVideo}
                        title={videoOff ? 'Start Video (Alt+V)' : 'Stop Video (Alt+V)'}
                    >
                        {videoOff ? <VideoOff size={20} /> : <Video size={20} />}
                    </button>
                    <span className="mb-btn-label">{videoOff ? 'Start' : 'Stop'}</span>
                </div>

                {/* Screen Share */}
                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${screenSharing ? 'mb-btn--active' : ''}`}
                        onClick={onToggleScreenShare}
                        title={screenSharing ? 'Stop Sharing' : 'Share Screen'}
                    >
                        <MonitorUp size={20} />
                    </button>
                    <span className="mb-btn-label">Share</span>
                </div>

                {/* Record (host only) */}
                {isHost && onToggleRecording && (
                    <div className="mb-btn-wrap mb-hide-mobile">
                        <button
                            className={`mb-btn ${recording ? 'mb-btn--active mb-btn--rec' : ''}`}
                            onClick={onToggleRecording}
                            title={recording ? 'Stop Recording' : 'Start Recording'}
                        >
                            <Circle size={20} fill={recording ? '#ef4444' : 'none'} />
                        </button>
                        <span className="mb-btn-label">Record</span>
                    </div>
                )}

                {/* Raise Hand */}
                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${raisedHand ? 'mb-btn--active' : ''}`}
                        onClick={onRaiseHand}
                        title={raisedHand ? 'Lower Hand' : 'Raise Hand'}
                    >
                        <Hand size={20} />
                        {raisedHandCount > 0 && <span className="mb-badge mb-badge--hand">{raisedHandCount}</span>}
                    </button>
                    <span className="mb-btn-label">Hand</span>
                </div>

                {/* Reactions */}
                {onReaction && (
                    <div className="mb-btn-wrap mb-hide-mobile" ref={reactionsRef}>
                        <button
                            className={`mb-btn ${showReactions ? 'mb-btn--active' : ''}`}
                            onClick={() => setShowReactions(v => !v)}
                            title="Reactions"
                        >
                            <SmilePlus size={20} />
                        </button>
                        <span className="mb-btn-label">React</span>
                        {showReactions && (
                            <div className="mb-reactions-popup">
                                {REACTIONS.map(r => (
                                    <button key={r} className="mb-reaction-item" onClick={() => { onReaction(r); setShowReactions(false); }}>{r}</button>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Chat */}
                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${activePanel === 'chat' ? 'mb-btn--active' : ''}`}
                        onClick={onToggleChat}
                        title="Chat"
                    >
                        <MessageSquare size={20} />
                    </button>
                    <span className="mb-btn-label">Chat</span>
                </div>

                {/* Participants */}
                <div className="mb-btn-wrap mb-hide-mobile">
                    <button
                        className={`mb-btn ${activePanel === 'participants' ? 'mb-btn--active' : ''}`}
                        onClick={onToggleParticipants}
                        title="Participants"
                    >
                        <Users size={20} />
                        {participantCount > 0 && <span className="mb-badge">{participantCount}</span>}
                    </button>
                    <span className="mb-btn-label">People</span>
                </div>

                {/* Mute All (host) */}
                {isHost && onMuteAll && (
                    <div className="mb-btn-wrap mb-hide-mobile">
                        <button className="mb-btn" onClick={onMuteAll} title="Mute All Participants">
                            <MicOffIcon size={20} />
                        </button>
                        <span className="mb-btn-label">Mute All</span>
                    </div>
                )}

                {/* More (mobile only) */}
                <div className="mb-btn-wrap mb-show-mobile-only" ref={moreRef}>
                    <button className="mb-btn" onClick={() => setShowMore(v => !v)} title="More actions">
                        <MoreVertical size={20} />
                    </button>
                    <span className="mb-btn-label">More</span>
                    {showMore && (
                        <div className="mb-more-drawer">
                            <button className="mb-drawer-item" onClick={() => { onToggleParticipants(); setShowMore(false); }}>
                                <Users size={16} /> Participants ({participantCount})
                            </button>
                            {isHost && onToggleRecording && (
                                <button className="mb-drawer-item" onClick={() => { onToggleRecording(); setShowMore(false); }}>
                                    <Circle size={16} fill={recording ? '#ef4444' : 'none'} /> {recording ? 'Stop Recording' : 'Start Recording'}
                                </button>
                            )}
                            {onReaction && (
                                <button className="mb-drawer-item" onClick={() => { setShowMore(false); setShowReactions(true); }}>
                                    <SmilePlus size={16} /> Reactions
                                </button>
                            )}
                            {isHost && onMuteAll && (
                                <button className="mb-drawer-item" onClick={() => { onMuteAll(); setShowMore(false); }}>
                                    <MicOffIcon size={16} /> Mute All
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Right: leave/end */}
            <div className="mb-right">
                <button className="mb-btn mb-btn--danger mb-leave-btn" onClick={onLeaveMeeting} title="Leave meeting">
                    <PhoneOff size={20} />
                    <span className="mb-leave-text">Leave</span>
                </button>
                {isHost && (
                    <button className="mb-btn mb-btn--danger mb-end-btn" onClick={onEndMeeting} title="End meeting for all">
                        End All
                    </button>
                )}
            </div>
        </div>
    );
}
