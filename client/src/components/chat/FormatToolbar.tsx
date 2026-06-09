import s from "./FormatToolbar.module.css";

interface FormatAction {
    label: string;
    title: string;
    wrap?: [string, string];
    prefix?: string;
    italic?: boolean;
    mono?: boolean;
}

interface FormatToolbarProps {
    onInsert: (wrap: [string, string] | null, prefix: string | null) => void;
}

export default function FormatToolbar({ onInsert }: FormatToolbarProps) {
    const actions: FormatAction[] = [
        { label: "B", title: "Bold", wrap: ["**", "**"] },
        { label: "I", title: "Italic", wrap: ["*", "*"], italic: true },
        { label: "~", title: "Strikethrough", wrap: ["~~", "~~"] },
        { label: "</>", title: "Inline code", wrap: ["`", "`"], mono: true },
        { label: "```", title: "Code block", wrap: ["```\n", "\n```"], mono: true },
        { label: "• ", title: "Bullet list", prefix: "- " },
        { label: "1.", title: "Numbered list", prefix: "1. " },
        { label: "> ", title: "Quote", prefix: "> " },
    ];

    return (
        <div className={s.bar}>
            {actions.map((a) => (
                <button
                    key={a.title}
                    className={`${s.btn} ${a.italic ? s.italic : ""} ${a.mono ? s.mono : ""}`}
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