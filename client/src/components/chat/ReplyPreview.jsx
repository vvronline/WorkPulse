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
                <button
                    type="button"
                    className={s.close}
                    onClick={(e) => { e.stopPropagation(); onClear(); }}
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                </button>
            )}
        </div>
    );
}
