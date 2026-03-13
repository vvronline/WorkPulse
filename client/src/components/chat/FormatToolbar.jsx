import s from './FormatToolbar.module.css';

export default function FormatToolbar({ onInsert }) {
    const actions = [
        { label: 'B', title: 'Bold', wrap: ['**', '**'] },
        { label: 'I', title: 'Italic', wrap: ['*', '*'], italic: true },
        { label: '~', title: 'Strikethrough', wrap: ['~~', '~~'] },
        { label: '</>', title: 'Inline code', wrap: ['`', '`'], mono: true },
        { label: '```', title: 'Code block', wrap: ['```\n', '\n```'], mono: true },
        { label: '• ', title: 'Bullet list', prefix: '- ' },
        { label: '1.', title: 'Numbered list', prefix: '1. ' },
        { label: '> ', title: 'Quote', prefix: '> ' },
    ];

    return (
        <div className={s.bar}>
            {actions.map((a) => (
                <button
                    key={a.title}
                    className={`${s.btn} ${a.italic ? s.italic : ''} ${a.mono ? s.mono : ''}`}
                    title={a.title}
                    type="button"
                    onMouseDown={(e) => {
                        e.preventDefault();
                        onInsert(a.wrap || null, a.prefix || null);
                    }}
                >{a.label}</button>
            ))}
        </div>
    );
}
