type AnyMsg = Record<string, any>;

export type TimelineRow =
    | { key: string; kind: "date"; label: string }
    | { key: string; kind: "system"; msg: AnyMsg }
    | { key: string; kind: "meeting"; msg: AnyMsg }
    | { key: string; kind: "message"; msg: AnyMsg; isNewGroup: boolean };

function sameDay(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    return new Date(a).toDateString() === new Date(b).toDateString();
}

function formatDateLabel(iso: string): string {
    return new Date(iso).toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
    });
}

export function buildTimelineRows(messages: AnyMsg[]): TimelineRow[] {
    const rows: TimelineRow[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const prev = messages[i - 1];
        const showDate = i === 0 || !sameDay(msg.created_at, prev?.created_at);
        if (showDate) {
            rows.push({
                key: `date-${String(msg.id)}`,
                kind: "date",
                label: formatDateLabel(msg.created_at),
            });
        }

        if (msg.format_type === "system") {
            rows.push({ key: `system-${String(msg.id)}`, kind: "system", msg });
            continue;
        }
        if (msg.format_type === "meeting" && msg.metadata?.meetingCode) {
            rows.push({ key: `meeting-${String(msg.id)}`, kind: "meeting", msg });
            continue;
        }

        const isNewGroup =
            !prev ||
            prev.sender_id !== msg.sender_id ||
            showDate ||
            new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() > 300000;

        rows.push({
            key: `msg-${String(msg.id)}`,
            kind: "message",
            msg,
            isNewGroup,
        });
    }
    return rows;
}
