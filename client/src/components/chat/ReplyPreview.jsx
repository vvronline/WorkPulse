import s from './ReplyPreview.module.css';

export default function ReplyPreview({ senderName, content, onClear }) {
    return (
        <div className={s.bar}>
            <div className={s.accent} />
            <div className={s.body}>
                <span className={s.name}>{senderName}</span>
                <span className={s.text}>{content?.slice(0, 100) || '📎 Attachment'}</span>
            </div>
            {onClear && (
                <button className={s.close} onClick={onClear}>✕</button>
            )}
        </div>
    );
}
