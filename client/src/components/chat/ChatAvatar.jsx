import s from './ChatAvatar.module.css';

const STATUS_CONFIG = {
    available:  { cls: 'available', label: 'Available' },
    busy:       { cls: 'busy', label: 'Busy' },
    dnd:        { cls: 'dnd', label: 'Do Not Disturb' },
    away:       { cls: 'away', label: 'Away' },
    offline:    { cls: 'offline', label: 'Offline' },
    in_call:    { cls: 'inCall', label: 'In a Call' },
    in_meeting: { cls: 'inMeeting', label: 'In a Meeting' },
};

export default function ChatAvatar({ avatar, name, size = 'md', online, userStatus }) {
    const initials = (name || '?')
        .split(' ')
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();

    // Determine which dot style to show
    // If userStatus is provided, use the rich status system; otherwise fall back to online/offline
    const statusInfo = userStatus ? STATUS_CONFIG[userStatus] : null;
    const showDot = userStatus || online !== undefined;
    const showIcon = size !== 'sm'; // Icons too small at 8px

    let dotClass = '';
    if (statusInfo) {
        dotClass = `${s.dot} ${s[statusInfo.cls] || s.offline}`;
    } else if (online !== undefined) {
        dotClass = `${s.dot} ${online ? s.available : s.offline}`;
    }

    return (
        <div className={`${s.wrap} ${s[size]}`}>
            {avatar ? (
                <img src={avatar} alt={name} className={s.img} />
            ) : (
                <div className={s.initials}>{initials}</div>
            )}
            {showDot && (
                <span
                    className={dotClass}
                    title={statusInfo?.label || (online ? 'Online' : 'Offline')}
                >
                    {showIcon && userStatus === 'dnd' && (
                        <svg className={s.dotIcon} viewBox="0 0 10 10" fill="none">
                            <line x1="3" y1="5" x2="7" y2="5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                    )}
                    {showIcon && userStatus === 'in_call' && (
                        <svg className={s.dotIcon} viewBox="0 0 10 10" fill="none">
                            <path d="M2.5 3.5c0-0.5 0.5-1 1-1s1.5 1 1.5 1.5-0.5 0.7-0.5 1 1.2 1.7 1.5 1.7 0.5-0.5 1-0.5 1.5 0.5 1.5 1-0.5 1-1 1C4.5 8.2 1.8 5.5 2.5 3.5z" fill="#fff" />
                        </svg>
                    )}
                    {showIcon && userStatus === 'in_meeting' && (
                        <svg className={s.dotIcon} viewBox="0 0 10 10" fill="none">
                            <rect x="1.5" y="3" width="5" height="4" rx="0.5" fill="#fff" />
                            <path d="M6.5 4.2L8.5 3v4L6.5 5.8" fill="#fff" />
                        </svg>
                    )}
                </span>
            )}
        </div>
    );
}
