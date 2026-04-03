import React, { useState, useRef, useEffect } from 'react';
import './MeetingRoom.css';

/**
 * In-meeting chat panel (sidebar).
 */
export default function MeetingChat({ messages, onSend }) {
    const [text, setText] = useState('');
    const bottomRef = useRef(null);

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

    return (
        <div className="mc-panel">
            <div className="mc-header">Meeting Chat</div>
            <div className="mc-messages">
                {messages.length === 0 && (
                    <div className="mc-empty">No messages yet</div>
                )}
                {messages.map((m, i) => (
                    <div key={i} className="mc-msg">
                        <span className="mc-sender">{m.sender_name || 'Participant'}</span>
                        <span className="mc-text">{m.text}</span>
                        <span className="mc-time">{new Date(m.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>
            <div className="mc-input-row">
                <textarea
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={handleKey}
                    placeholder="Send a message…"
                    rows={2}
                    className="mc-input"
                />
                <button className="mc-send-btn" onClick={send} disabled={!text.trim()}>➤</button>
            </div>
        </div>
    );
}
