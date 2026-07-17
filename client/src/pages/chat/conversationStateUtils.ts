import type { AnyRecord } from "../../types";

export type TimelineMessage = AnyRecord & { id: number | string };

/**
 * Creates a request generation token. A response may commit only while both
 * the generation and active conversation still match.
 */
export function isCurrentConversationRequest(
    expectedGeneration: number,
    currentGeneration: number,
    expectedConversationId: number | string,
    activeConversationId: number | string | null | undefined,
): boolean {
    return (
        expectedGeneration === currentGeneration &&
        expectedConversationId === activeConversationId
    );
}

/**
 * Merge canonical server rows with optimistic/realtime rows by stable message
 * id, preserving local-only rows and returning deterministic chronological
 * order. Server rows win when the same id exists in both inputs.
 */
export function mergeTimelineMessages(
    current: TimelineMessage[],
    fetched: TimelineMessage[],
): TimelineMessage[] {
    const byId = new Map<number | string, TimelineMessage>();
    current.forEach((message) => byId.set(message.id, message));
    fetched.forEach((message) => byId.set(message.id, message));

    return [...byId.values()].sort((a, b) => {
        const aTime = new Date(a.created_at as string).getTime();
        const bTime = new Date(b.created_at as string).getTime();
        const safeATime = Number.isFinite(aTime) ? aTime : 0;
        const safeBTime = Number.isFinite(bTime) ? bTime : 0;
        return safeATime - safeBTime;
    });
}