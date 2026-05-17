import React, { useState, useRef, useEffect } from 'react';
import { Paperclip, FileText, Send } from 'lucide-react';
import './MeetingRoom.css';

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * In-meeting chat panel (sidebar).
 */
export default function MeetingChat({ messages, onSend, onSendFile }) {
    const [text, setText] = useState('');
    const bottomRef = useRef(null);
    const fileRef = useRef(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const send = () => {
        if (!text.trim()) return;
        onSend(text.trim());
        setText('');
    };

    const handleKey = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };

    const handleFileSelect = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
            alert('File must be under 10MB');
            return;
        }
        onSendFile && onSendFile(file);
        e.target.value = '';
    };

    return (
        <div className="mc-panel">
            <div className="mc-messages">
                {messages.length === 0 && (
                    <div className="mc-empty">No messages yet</div>
                )}
                {messages.map((m, i) => (
                    <div key={i} className="mc-msg">
                        <span className="mc-msg-sender">{m.sender_name || 'Participant'}</span>
                        {m.file_url ? (
                            <a className="mc-file-msg" href={m.file_url} target="_blank" rel="noopener noreferrer">
                                <FileText size={16} />
                                <span className="mc-file-name">{m.file_name || 'File'}</span>
                                {m.file_size && <span className="mc-file-size">{formatFileSize(m.file_size)}</span>}
                            </a>
                        ) : (
                            <span className="mc-msg-text">{m.text}</span>
                        )}
                        <span className="mc-msg-time">{new Date(m.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>
            <div className="mc-input-wrap">
                <button className="mc-attach-btn" onClick={() => fileRef.current?.click()} title="Attach file">
                    <Paperclip size={18} />
                </button>
                <input
                    type="file"
                    ref={fileRef}
                    style={{ display: 'none' }}
                    onChange={handleFileSelect}
                />
                <textarea
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={handleKey}
                    placeholder="Send a message…"
                    rows={1}
                    className="mc-input"
                />
                <button className="mc-send" onClick={send} disabled={!text.trim()}>
                    <Send size={16} />
                </button>
            </div>
        </div>
    );
}
