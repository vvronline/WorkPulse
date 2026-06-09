import React from "react";
import { Phone, PhoneOff, PhoneMissed, Video, VideoOff, UserPlus, Info } from "lucide-react";
import s from "./SystemMessage.module.css";

const ICON_MAP: Record<string, React.ReactElement> = {
    call_started: <Phone size={14} />,
    call_ended: <PhoneOff size={14} />,
    call_missed: <PhoneMissed size={14} />,
    meeting_started: <Video size={14} />,
    meeting_ended: <VideoOff size={14} />,
    meeting_joined: <UserPlus size={14} />,
    meeting_left: <PhoneOff size={14} />,
    meeting_created: <Video size={14} />,
    meeting_updated: <Video size={14} />,
    meeting_cancelled: <VideoOff size={14} />,
    participant_added: <UserPlus size={14} />,
};

function formatDuration(secs?: number): string {
    if (!secs) return "";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s > 0 ? s + "s" : ""}`.trim();
}

interface SystemMsg {
    metadata?: Record<string, unknown>;
    content?: string;
    created_at: string;
    [key: string]: unknown;
}

interface SystemMessageProps {
    msg: SystemMsg;
}

/**
 * Renders a system message (call_started, call_ended, meeting_started, etc.)
 * from a message with format_type='system' and metadata JSONB.
 */
export default function SystemMessage({ msg }: SystemMessageProps) {
    const meta = (msg.metadata || {}) as Record<string, any>;
    const type = (meta.type as string) || "system";
    const icon = ICON_MAP[type] || <Info size={14} />;

    let text = meta.text || msg.content || "System event";

    if (type === "call_started") {
        const callType = meta.callType === "video" ? "Video call" : "Voice call";
        text = `${meta.callerName || "Someone"} started a ${callType}`;
    } else if (type === "call_ended") {
        const dur = formatDuration(meta.duration);
        const callType = meta.callType === "video" ? "Video call" : "Voice call";
        text = `${callType} ended${dur ? ` · ${dur}` : ""}`;
    } else if (type === "call_missed") {
        const callType = meta.callType === "video" ? "Video call" : "Voice call";
        text = `Missed ${callType}`;
    } else if (type === "meeting_started") {
        text = `${meta.startedBy || "Meeting"} started`;
    } else if (type === "meeting_ended") {
        const dur = formatDuration(meta.duration);
        text = `Meeting ended${dur ? ` · ${dur}` : ""}`;
    } else if (type === "meeting_joined") {
        text = `${meta.name || "Someone"} joined`;
    } else if (type === "meeting_left") {
        text = `${meta.name || "Someone"} left`;
    } else if (type === "participant_added") {
        text = `${meta.addedBy || "Someone"} added ${meta.name || "a participant"}`;
    }

    return (
        <div className={s.wrap}>
            <span className={s.icon}>{icon}</span>
            <span className={s.text}>{text}</span>
            <span className={s.time}>
                {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
        </div>
    );
}