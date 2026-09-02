export type ConnectionQuality = "good" | "fair" | "poor" | "unknown";

export interface VideoEncodingTarget {
    maxBitrate: number;
    scaleResolutionDownBy: number;
}

export interface AdaptiveVideoState {
    target: VideoEncodingTarget;
    recoverySamples: number;
    changed: boolean;
}

export const VIDEO_ENCODING_TARGETS: Record<Exclude<ConnectionQuality, "unknown">, VideoEncodingTarget> = {
    poor: { maxBitrate: 200_000, scaleResolutionDownBy: 2 },
    fair: { maxBitrate: 500_000, scaleResolutionDownBy: 1 },
    good: { maxBitrate: 1_200_000, scaleResolutionDownBy: 1 },
};

export function classifyConnectionQuality(
    rttSeconds: number | null,
    packetLossRate: number,
): ConnectionQuality {
    if (rttSeconds === null) return "unknown";
    if (rttSeconds < 0.15 && packetLossRate < 0.02) return "good";
    if (rttSeconds < 0.4 && packetLossRate < 0.05) return "fair";
    return "poor";
}

export function nextAdaptiveVideoState(
    quality: ConnectionQuality,
    current: VideoEncodingTarget,
    recoverySamples: number,
    goodTarget: VideoEncodingTarget = VIDEO_ENCODING_TARGETS.good,
): AdaptiveVideoState {
    if (quality === "unknown") {
        return { target: current, recoverySamples: 0, changed: false };
    }

    const desired = quality === "good" ? goodTarget : VIDEO_ENCODING_TARGETS[quality];
    const isDownshift = desired.maxBitrate < current.maxBitrate;
    if (isDownshift || quality === "poor") {
        return {
            target: desired,
            recoverySamples: 0,
            changed:
                desired.maxBitrate !== current.maxBitrate ||
                desired.scaleResolutionDownBy !== current.scaleResolutionDownBy,
        };
    }

    if (
        desired.maxBitrate === current.maxBitrate &&
        desired.scaleResolutionDownBy === current.scaleResolutionDownBy
    ) {
        return { target: current, recoverySamples: 0, changed: false };
    }

    const nextRecoverySamples = recoverySamples + 1;
    if (nextRecoverySamples < 2) {
        return { target: current, recoverySamples: nextRecoverySamples, changed: false };
    }

    return { target: desired, recoverySamples: 0, changed: true };
}

export async function applyVideoEncodingTarget(
    pc: RTCPeerConnection,
    target: VideoEncodingTarget,
): Promise<boolean> {
    let applied = false;
    for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "video") continue;
        try {
            const params = sender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            params.encodings[0].maxBitrate = target.maxBitrate;
            params.encodings[0].maxFramerate = 30;
            params.encodings[0].scaleResolutionDownBy = target.scaleResolutionDownBy;
            params.degradationPreference = "balanced";
            await sender.setParameters(params);
            applied = true;
        } catch {
            // Some older browsers expose setParameters but reject encoding changes.
        }
    }
    return applied;
}
