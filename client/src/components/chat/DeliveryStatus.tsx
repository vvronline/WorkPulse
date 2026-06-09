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

export default function DeliveryStatus({ isMine, msg, participantCount, readReceipts, userId }: DeliveryStatusProps) {
    if (!isMine) return null;

    // Pending message — not yet confirmed by server
    if (String(msg.id).startsWith("pending_")) {
        return <span className={s.deliveryPending} title="Sending…">○</span>;
    }

    const delivered = msg.delivered_to || [];
    const others = (participantCount || 2) - 1;
    if (others <= 0) return null;

    const msgTime = new Date(msg.created_at).getTime();
    const receipts = readReceipts || {};
    const otherReaders = Object.entries(receipts).filter(
        ([uid, readAt]) => Number(uid) !== userId && new Date(readAt).getTime() >= msgTime
    );

    if (otherReaders.length >= others) {
        return <span className={s.deliveryRead} title="Read">✓✓</span>;
    }
    if (otherReaders.length > 0 && delivered.length >= others) {
        return <span className={s.deliveryRead} title="Read">✓✓</span>;
    }
    if (delivered.length >= others) {
        return <span className={s.deliveryPartial} title="Delivered to all">✓✓</span>;
    }
    if (delivered.length > 0) {
        return <span className={s.deliveryPartial} title="Delivered">✓✓</span>;
    }
    return <span className={s.deliverySent} title="Sent">✓</span>;
}