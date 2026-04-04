import React, { useState } from 'react';
import { MicOff, Mic, CameraOff, Camera, MonitorUp, Hand, MessageSquare, Users, X } from 'lucide-react';
import './MeetingRoom.css';

/**
 * Bottom control bar for the meeting room.
 * Responsive: shows "more" drawer on mobile for secondary controls.
 */
export default function MeetingBottomBar({
    muted, videoOff, screenSharing, raisedHand,
    onToggleMute, onToggleVideo, onScreenShare, onRaiseHand,
    onToggleChat, onToggleParticipants,
    onLeave, onEnd, isOrganizer,
    participantCount, activePanel,
}) {
    const [moreOpen, setMoreOpen] = useState(false);

    return (
        <>
            <div className="mb-bar">
                <div className="mb-left">
                    <span className="mb-participant-count"><Users size={14} style={{marginRight:4,verticalAlign:'middle'}} />{participantCount}</span>
                </div>

                <div className="mb-center">
                    <button
                        className={`mb-btn ${muted ? 'mb-btn-off' : ''}`}
                        onClick={onToggleMute}
                        title={muted ? 'Unmute' : 'Mute'}
                    >
                        {muted ? <MicOff size={20} /> : <Mic size={20} />}
                        <span className="mb-label">{muted ? 'Unmute' : 'Mute'}</span>
                    </button>

                    <button
                        className={`mb-btn ${videoOff ? 'mb-btn-off' : ''}`}
                        onClick={onToggleVideo}
                        title={videoOff ? 'Start video' : 'Stop video'}
                    >
                        {videoOff ? <CameraOff size={20} /> : <Camera size={20} />}
                        <span className="mb-label">Video</span>
                    </button>

                    {/* Desktop-only buttons */}
                    <button
                        className={`mb-btn mb-desktop-only ${screenSharing ? 'mb-btn-active' : ''}`}
                        onClick={onScreenShare}
                        title={screenSharing ? 'Stop sharing' : 'Share screen'}
                    >
                        <MonitorUp size={20} />
                        <span className="mb-label">{screenSharing ? 'Stop' : 'Share'}</span>
                    </button>

                    <button
                        className={`mb-btn mb-desktop-only ${raisedHand ? 'mb-btn-active' : ''}`}
                        onClick={onRaiseHand}
                        title={raisedHand ? 'Lower hand' : 'Raise hand'}
                    >
                        <Hand size={20} />
                        <span className="mb-label">Hand</span>
                    </button>

                    <button
                        className={`mb-btn mb-desktop-only ${activePanel === 'chat' ? 'mb-btn-active' : ''}`}
                        onClick={onToggleChat}
                        title="Meeting chat"
                    >
                        <MessageSquare size={20} />
                        <span className="mb-label">Chat</span>
                    </button>

                    <button
                        className={`mb-btn mb-desktop-only ${activePanel === 'participants' ? 'mb-btn-active' : ''}`}
                        onClick={onToggleParticipants}
                        title="Participants"
                    >
                        <Users size={20} />
                        <span className="mb-label">People</span>
                    </button>

                    {/* Mobile "more" button */}
                    <button
                        className="mb-btn mb-mobile-only"
                        onClick={() => setMoreOpen(v => !v)}
                        title="More options"
                    >
                        ⋯
                        <span className="mb-label">More</span>
                    </button>
                </div>

                <div className="mb-right">
                    {isOrganizer && (
                        <button className="mb-end-btn" onClick={onEnd} title="End meeting for everyone">
                            End
                        </button>
                    )}
                    <button className="mb-leave-btn" onClick={onLeave} title="Leave meeting">
                        Leave
                    </button>
                </div>
            </div>

            {/* Mobile "more" drawer */}
            {moreOpen && (
                <div className="mb-drawer-overlay" onClick={() => setMoreOpen(false)}>
                    <div className="mb-drawer" onClick={e => e.stopPropagation()}>
                        <div className="mb-drawer-header">
                            <span>More Options</span>
                            <button className="mb-drawer-close" onClick={() => setMoreOpen(false)}><X size={16} /></button>
                        </div>
                        <div className="mb-drawer-grid">
                            <button
                                className={`mb-drawer-btn ${screenSharing ? 'mb-btn-active' : ''}`}
                                onClick={() => { onScreenShare(); setMoreOpen(false); }}
                            >
                                <MonitorUp size={16} style={{marginRight:6,verticalAlign:'middle'}} />{screenSharing ? 'Stop Share' : 'Share Screen'}
                            </button>
                            <button
                                className={`mb-drawer-btn ${raisedHand ? 'mb-btn-active' : ''}`}
                                onClick={() => { onRaiseHand(); setMoreOpen(false); }}
                            >
                                <Hand size={16} style={{marginRight:6,verticalAlign:'middle'}} />{raisedHand ? 'Lower Hand' : 'Raise Hand'}
                            </button>
                            <button
                                className={`mb-drawer-btn ${activePanel === 'chat' ? 'mb-btn-active' : ''}`}
                                onClick={() => { onToggleChat(); setMoreOpen(false); }}
                            >
                                <MessageSquare size={16} style={{marginRight:6,verticalAlign:'middle'}} />Chat
                            </button>
                            <button
                                className={`mb-drawer-btn ${activePanel === 'participants' ? 'mb-btn-active' : ''}`}
                                onClick={() => { onToggleParticipants(); setMoreOpen(false); }}
                            >
                                <Users size={16} style={{marginRight:6,verticalAlign:'middle'}} />Participants
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
