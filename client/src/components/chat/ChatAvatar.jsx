import s from './ChatAvatar.module.css';

export default function ChatAvatar({ avatar, name, size = 'md', online }) {
    const initials = (name || '?')
        .split(' ')
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();

    return (
        <div className={`${s.wrap} ${s[size]}`}>
            {avatar ? (
                <img src={avatar} alt={name} className={s.img} />
            ) : (
                <div className={s.initials}>{initials}</div>
            )}
            {online !== undefined && (
                <span className={`${s.dot} ${online ? s.online : s.offline}`} />
            )}
        </div>
    );
}
