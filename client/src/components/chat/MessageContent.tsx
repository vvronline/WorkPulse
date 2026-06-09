import React from "react";
import CodeBlock from "./CodeBlock";
import s from "./MessageBubble.module.css";

interface MessageContentProps {
    text?: string;
    isMine?: boolean;
}

/** Parse markdown-style text: **bold**, *italic*, ~~strike~~, `code`, @mentions, URLs */
export default function MessageContent({ text }: MessageContentProps) {
    if (!text) return null;
    const tokens: React.ReactNode[] = [];
    const regex = /```(\w*)\n([\s\S]*?)```|`([^`]+)`|\*\*(.+?)\*\*|\*(?!\s)(.+?)(?<!\s)\*|~~(.+?)~~|(@\w[\w\s]*?)(?=\s|$)|(https?:\/\/[^\s<]+)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > last) {
            tokens.push(text.slice(last, match.index));
        }
        if (match[2] !== undefined) {
            tokens.push(<CodeBlock key={key++} language={match[1] || ""} code={match[2]} />);
        } else if (match[3]) {
            tokens.push(<code key={key++} className={s.inlineCode}>{match[3]}</code>);
        } else if (match[4]) {
            tokens.push(<strong key={key++}>{match[4]}</strong>);
        } else if (match[5]) {
            tokens.push(<em key={key++}>{match[5]}</em>);
        } else if (match[6]) {
            tokens.push(<del key={key++}>{match[6]}</del>);
        } else if (match[7]) {
            tokens.push(<span key={key++} className={s.mention}>{match[7]}</span>);
        } else if (match[8]) {
            tokens.push(
                <a key={key++} href={match[8]} target="_blank" rel="noopener noreferrer"
                    className={s.link}>{match[8]}</a>
            );
        }
        last = match.index + match[0].length;
    }
    if (last < text.length) tokens.push(text.slice(last));

    return <div className={s.text}>{tokens.length > 0 ? tokens : text}</div>;
}