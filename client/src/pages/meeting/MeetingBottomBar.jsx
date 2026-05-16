import React from 'react';

/**
 * VideoSDK-style bottom bar — clean centered controls.
 * No background effects, no audio level buttons.
 */
export default function MeetingBottomBar({
    muted, videoOff, screenSharing, raisedHand,
    activePanel, participantCount,
    onToggleMute, onToggleVideo, onToggleScreenShare,
    onRaiseHand, onToggleChat, onToggleParticipants,
    onLeaveMeeting, onEndMeeting, isHost,
}) {
    return (
        <div className="mb-bar">
            {/* Left: meeting info */}
            <div className="mb-left">
                <span style={{ fontSize: 12, color: 'var(--mr-text-muted)' }}>
                    {participantCount || 0} participant{participantCount !== 1 ? 's' : ''}
                </span>
            </div>

            {/* Center: controls */}
            <div className="mb-center">
                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${muted ? 'mb-btn--muted' : ''}`}
                        onClick={onToggleMute}
                        title={muted ? 'Unmute' : 'Mute'}
                    >
                        {muted ? '🔇' : '🎤'}
                    </button>
                </div>

                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${videoOff ? 'mb-btn--muted' : ''}`}
                        onClick={onToggleVideo}
                        title={videoOff ? 'Turn on camera' : 'Turn off camera'}
                    >
                        {videoOff ? '📷' : '🎥'}
                    </button>
                </div>

                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${screenSharing ? 'mb-btn--active' : ''}`}
                        onClick={onToggleScreenShare}
                        title={screenSharing ? 'Stop sharing' : 'Share screen'}
                    >
                        🖥️
                    </button>
                </div>

                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${raisedHand ? 'mb-btn--active' : ''}`}
                        onClick={onRaiseHand}
                        title={raisedHand ? 'Lower hand' : 'Raise hand'}
                    >
                        ✋
                    </button>
                </div>

                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${activePanel === 'chat' ? 'mb-btn--active' : ''}`}
                        onClick={onToggleChat}
                        title="Chat"
                    >
                        💬
                    </button>
                </div>

                <div className="mb-btn-wrap">
                    <button
                        className={`mb-btn ${activePanel === 'participants' ? 'mb-btn--active' : ''}`}
                        onClick={onToggleParticipants}
                        title="Participants"
                    >
                        👥
                    </button>
                </div>
            </div>

            {/* Right: leave/end */}
            <div className="mb-right">
                <button className="mb-btn mb-btn--danger" onClick={onLeaveMeeting} title="Leave meeting">
                    📞
                </button>
                {isHost && (
                    <button
                        className="mb-btn mb-btn--danger"
                        onClick={onEndMeeting}
                        title="End meeting for all"
                        style={{ fontSize: 12, width: 'auto', borderRadius: 8, padding: '0 12px' }}
                    >
                        End
                    </button>
                )}
            </div>
        </div>
    );
}
