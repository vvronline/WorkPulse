const MAX_SEEN_SIGNAL_IDS = 256;

export function rememberInboundSignal(
    signal: { signalId?: unknown },
    seen: Set<string>,
): boolean {
    if (typeof signal.signalId !== "string" || signal.signalId.length === 0) {
        return true;
    }
    if (seen.has(signal.signalId)) return false;

    seen.add(signal.signalId);
    if (seen.size > MAX_SEEN_SIGNAL_IDS) {
        const oldest = seen.values().next().value;
        if (oldest) seen.delete(oldest);
    }
    return true;
}

export function forgetInboundSignal(
    signal: { signalId?: unknown },
    seen: Set<string>,
): void {
    if (typeof signal.signalId === "string") seen.delete(signal.signalId);
}
