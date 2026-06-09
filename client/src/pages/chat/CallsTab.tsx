import { useState, useEffect } from "react";
import { Phone, Video, PhoneIncoming, PhoneOutgoing, PhoneMissed } from "lucide-react";
import { ChatAvatar } from "../../components/chat";
import { getAllCallHistory } from "../../api";
import s from "./ChatSidebar.module.css";

function formatCallDuration(secs: number): string | null {
    if (!secs) return null;
    const m = Math.floor(secs / 60),
        sec = secs % 60;
    return m === 0 ? `${sec}s` : `${m}m${sec > 0 ? ` ${sec}s` : ""}`;
}

function formatCallTime(iso: string): string {
    const d = new Date(iso),
        now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) return time;
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
    if (now.getTime() - d.getTime() < 7 * 86400000)
        return `${d.toLocaleDateString([], { weekday: "short" })}, ${time}`;
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

interface CallsTabProps {
    userId: number | string;
}

export default function CallsTab({ userId }: CallsTabProps) {
    const [calls, setCalls] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        getAllCallHistory()
            .then((r) => setCalls(r.data || []))
            .catch(() => setCalls([]))
            .finally(() => setLoading(false));
    }, []);

    if (loading)
        return (
            <div className={s.callsEmpty}>
                <div className={s.callsSpinner} />
                <span>Loading…</span>
            </div>
        );
    if (calls.length === 0)
        return (
            <div className={s.callsEmpty}>
                <Phone size={32} strokeWidth={1.2} />
                <p>No calls yet</p>
            </div>
        );

    return (
        <div className={s.callsList}>
            {calls.map((call) => {
                const isOutgoing = call.caller_id === userId;
                const isMissed = call.status === "missed" && !isOutgoing;
                const otherName = isOutgoing ? call.other_name || "Unknown" : call.caller_name || "Unknown";
                const otherAvatar = isOutgoing ? call.other_avatar : call.caller_avatar;
                const displayName = call.is_group ? call.group_name || "Group" : otherName;

                return (
                    <div key={call.id} className={`${s.callItem} ${isMissed ? s.callItemMissed : ""}`}>
                        <div className={s.callAvatar}>
                            <ChatAvatar name={displayName} avatar={otherAvatar} size="md" />
                        </div>
                        <div className={s.callInfo}>
                            <div className={s.callName}>{displayName}</div>
                            <div className={s.callMeta}>
                                {isMissed ? (
                                    <PhoneMissed size={13} className={s.iconMissed} />
                                ) : isOutgoing ? (
                                    <PhoneOutgoing size={13} className={s.iconOutgoing} />
                                ) : (
                                    <PhoneIncoming size={13} className={s.iconIncoming} />
                                )}
                                <span className={isMissed ? s.callMetaMissed : s.callMetaText}>
                                    {isMissed ? "Missed" : isOutgoing ? "Outgoing" : "Incoming"}
                                    {call.call_type === "video" ? " video" : ""}
                                </span>
                                {call.duration > 0 && (
                                    <span className={s.callDuration}>· {formatCallDuration(call.duration)}</span>
                                )}
                            </div>
                        </div>
                        <div className={s.callRight}>
                            <span className={s.callTime}>{formatCallTime(call.created_at)}</span>
                            <span className={s.callTypeIcon}>
                                {call.call_type === "video" ? <Video size={13} /> : <Phone size={13} />}
                            </span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}