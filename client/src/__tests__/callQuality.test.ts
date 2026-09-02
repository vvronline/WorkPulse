import { describe, expect, it, vi } from "vitest";
import {
    applyVideoEncodingTarget,
    classifyConnectionQuality,
    nextAdaptiveVideoState,
    VIDEO_ENCODING_TARGETS,
} from "../components/chat/call/callQuality";

describe("call quality adaptation", () => {
    it("classifies RTT and packet loss using the worst measured path", () => {
        expect(classifyConnectionQuality(0.1, 0.01)).toBe("good");
        expect(classifyConnectionQuality(0.2, 0.03)).toBe("fair");
        expect(classifyConnectionQuality(0.1, 0.08)).toBe("poor");
        expect(classifyConnectionQuality(null, 0)).toBe("unknown");
    });

    it("downshifts immediately and requires two recovery samples", () => {
        const poor = nextAdaptiveVideoState(
            "poor",
            VIDEO_ENCODING_TARGETS.good,
            0,
        );
        expect(poor).toEqual({
            target: VIDEO_ENCODING_TARGETS.poor,
            recoverySamples: 0,
            changed: true,
        });

        const firstRecovery = nextAdaptiveVideoState("good", poor.target, 0);
        expect(firstRecovery.changed).toBe(false);
        expect(firstRecovery.recoverySamples).toBe(1);

        const recovered = nextAdaptiveVideoState(
            "good",
            firstRecovery.target,
            firstRecovery.recoverySamples,
        );
        expect(recovered).toEqual({
            target: VIDEO_ENCODING_TARGETS.good,
            recoverySamples: 0,
            changed: true,
        });

        const mobileGood = { maxBitrate: 800_000, scaleResolutionDownBy: 1 };
        expect(nextAdaptiveVideoState("good", poor.target, 1, mobileGood)).toEqual({
            target: mobileGood,
            recoverySamples: 0,
            changed: true,
        });
    });

    it("applies balanced bitrate and resolution limits to video only", async () => {
        const setVideoParameters = vi.fn().mockResolvedValue(undefined);
        const setAudioParameters = vi.fn().mockResolvedValue(undefined);
        const createParameters = (): RTCRtpSendParameters => ({
            transactionId: "",
            codecs: [],
            headerExtensions: [],
            rtcp: {},
            encodings: [],
        });
        const videoParams = createParameters();
        const audioParams = createParameters();
        const pc = {
            getSenders: () => [
                {
                    track: { kind: "video" },
                    getParameters: () => videoParams,
                    setParameters: setVideoParameters,
                },
                {
                    track: { kind: "audio" },
                    getParameters: () => audioParams,
                    setParameters: setAudioParameters,
                },
            ],
        } as unknown as RTCPeerConnection;

        await expect(
            applyVideoEncodingTarget(pc, VIDEO_ENCODING_TARGETS.poor),
        ).resolves.toBe(true);
        expect(videoParams.encodings[0]).toMatchObject({
            maxBitrate: 200_000,
            maxFramerate: 30,
            scaleResolutionDownBy: 2,
        });
        expect(videoParams.degradationPreference).toBe("balanced");
        expect(setVideoParameters).toHaveBeenCalledWith(videoParams);
        expect(setAudioParameters).not.toHaveBeenCalled();
    });
});
