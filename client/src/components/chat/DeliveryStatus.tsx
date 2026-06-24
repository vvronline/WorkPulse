import s from "./MessageBubble.module.css";

interface ChatMsg {
    id: number | string;
    created_at: string;
    delivered_to?: (number | string)[];
    [key: string]: unknown;
}

interface DeliveryStatusProps {
    isMine: boolean;
    msg: ChatMsg;
    participantCount?: number;
    readReceipts?: Record<string, string>;
    userId: number | string;
}

/* ───────────────────────────────────────────────────────────────────────────
 * Signal-style delivery ticks (SVG)
 *
 *   sending   → an animated spinning ring (message not yet confirmed)
 *   sent      → a single check
 *   delivered → a check inside a single circle
 *   read      → a check inside a double circle, filled with the accent color
 * ─────────────────────────────────────────────────────────────────────────── */

function SendingTick() {
    return (
        <span className={`${s.tick} ${s.tickSending}`} title="Sending…" aria-label="Sending">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
                <path d="M8 2a6 6 0 016 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        </span>
    );
}

function SentTick() {
    return (
        <span className={`${s.tick} ${s.tickSent}`} title="Sent" aria-label="Sent">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        </span>
    );
}

function DeliveredTick() {
    return (
        <span className={`${s.tick} ${s.tickDelivered}`} title="Delivered" aria-label="Delivered">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3" />
                <path d="M4.6 8.2l2.2 2.2L11.4 5.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        </span>
    );
}

function ReadTick() {
    return (
        <span className={`${s.tick} ${s.tickRead}`} title="Read" aria-label="Read">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                {/* Outer ring */}
                <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.1" />
                {/* Inner filled disc */}
                <circle cx="8" cy="8" r="5.2" fill="currentColor" />
                {/* Check punched out of the filled disc */}
                <path d="M5.4 8.1l1.8 1.8L10.7 6" stroke="var(--read-check-bg, #fff)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        </span>
    );
}

export default function DeliveryStatus({ isMine, msg, participantCount, readReceipts, userId }: DeliveryStatusProps) {
    if (!isMine) return null;

    if (msg._failed) {
        return <span className={s.deliveryFailed} title={String(msg._failureReason || "Failed to send")}>!</span>;
    }

    // Pending message — not yet confirmed by server
    if (String(msg.id).startsWith("pending_")) {
        return <SendingTick />;
    }

    const delivered = msg.delivered_to || [];
    const others = (participantCount || 2) - 1;
    if (others <= 0) return null;

    const msgTime = new Date(msg.created_at).getTime();
    const receipts = readReceipts || {};
    const otherReaders = Object.entries(receipts).filter(
        ([uid, readAt]) => Number(uid) !== userId && new Date(readAt).getTime() >= msgTime,
    );

    // Read by everyone (or read + delivered to all) → double-circle filled check
    if (otherReaders.length >= others) {
        return <ReadTick />;
    }
    if (otherReaders.length > 0 && delivered.length >= others) {
        return <ReadTick />;
    }
    // Delivered to all / some → check inside a circle
    if (delivered.length >= others) {
        return <DeliveredTick />;
    }
    if (delivered.length > 0) {
        return <DeliveredTick />;
    }
    // Sent only → single check
    return <SentTick />;
}