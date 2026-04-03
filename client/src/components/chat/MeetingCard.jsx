import React from 'react';
import { useNavigate } from 'react-router-dom';
import s from './MeetingCard.module.css';

/**
 * In-chat card for meeting invites/references.
 * Rendered when msg.metadata.meetingCode is present and format_type is 'meeting'.
 */
export default function MeetingCard({ msg }) {
    const navigate = useNavigate();
    const meta = msg.metadata || {};
    const { meetingCode, meetingTitle, hostName, status } = meta;
    const isEnded = status === 'ended' || status === 'cancelled';

    const handleJoin = () => {
        navigate(`/meeting/${meetingCode}`);
    };

    return (
        <div className={s.card}>
            <div className={s.cardHeader}>
                <span className={s.icon}>📹</span>
                <div className={s.info}>
                    <div className={s.title}>{meetingTitle || 'Meeting'}</div>
                    {hostName && <div className={s.host}>Hosted by {hostName}</div>}
                </div>
            </div>
            <div className={s.cardBody}>
                <code className={s.code}>{meetingCode}</code>
            </div>
            <div className={s.cardFooter}>
                {isEnded ? (
                    <span className={s.ended}>Meeting ended</span>
                ) : (
                    <button className={s.joinBtn} onClick={handleJoin}>
                        Join meeting
                    </button>
                )}
            </div>
        </div>
    );
}
