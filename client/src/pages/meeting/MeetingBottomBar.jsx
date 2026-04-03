import React from 'react';
import './MeetingRoom.css';

/**
 * Bottom control bar for the meeting room.
 */
export default function MeetingBottomBar({
    muted, videoOff, screenSharing, raisedHand,
    onToggleMute, onToggleVideo, onScreenShare, onRaiseHand,
    onToggleChat, onToggleParticipants,
    onLeave, onEnd, isOrganizer,
    participantCount, activePanel,
}) {
    return (
        <div className="mb-bar">
            <div className="mb-left">
                <span className="mb-participant-count">👥 {participantCount}</span>
            </div>

            <div className="mb-center">
                <button
                    className={`mb-btn ${muted ? 'mb-btn-off' : ''}`}
                    onClick={onToggleMute}
                    title={muted ? 'Unmute' : 'Mute'}
                >
                    {muted ? '🔇' : '🎙️'}
                    <span className="mb-label">{muted ? 'Unmute' : 'Mute'}</span>
                </button>

                <button
                    className={`mb-btn ${videoOff ? 'mb-btn-off' : ''}`}
                    onClick={onToggleVideo}
                    title={videoOff ? 'Start video' : 'Stop video'}
                >
                    {videoOff ? '📷' : '🎥'}
                    <span className="mb-label">Video</span>
                </button>

                <button
                    className={`mb-btn ${screenSharing ? 'mb-btn-active' : ''}`}
                    onClick={onScreenShare}
                    title={screenSharing ? 'Stop sharing' : 'Share screen'}
                >
                    🖥️
                    <span className="mb-label">{screenSharing ? 'Stop' : 'Share'}</span>
                </button>

                <button
                    className={`mb-btn ${raisedHand ? 'mb-btn-active' : ''}`}
                    onClick={onRaiseHand}
                    title={raisedHand ? 'Lower hand' : 'Raise hand'}
                >
                    ✋
                    <span className="mb-label">Hand</span>
                </button>

                <button
                    className={`mb-btn ${activePanel === 'chat' ? 'mb-btn-active' : ''}`}
                    onClick={onToggleChat}
                    title="Meeting chat"
                >
                    💬
                    <span className="mb-label">Chat</span>
                </button>

                <button
                    className={`mb-btn ${activePanel === 'participants' ? 'mb-btn-active' : ''}`}
                    onClick={onToggleParticipants}
                    title="Participants"
                >
                    👥
                    <span className="mb-label">People</span>
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
    );
}
