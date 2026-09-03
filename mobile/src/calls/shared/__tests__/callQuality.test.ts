/// <reference types="jest" />

import {
  applyAudioEncodingCap,
  applyVideoEncodingTier,
  BOTTOM_TIER_INDEX,
  buildTiers,
  collectStatsSample,
  createQualityController,
  MOBILE_TOP_TIER_BITRATE,
  preferOpusFec,
  RAMP_START_TIER_INDEX,
  startBitrateRampUp,
  VIDEO_TIERS,
  type PeerConnectionLike,
  type RawStatsSample,
  type SenderLike,
  type SendParamsLike,
} from "../callQuality";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `collectStatsSample`'s report types are internal to the module, so they are
 * derived from its signature here rather than widened to `any` — a typo in a
 * fixture field name then fails the build instead of silently producing a
 * zeroed sample.
 */
type StatsReportMapLike = Parameters<typeof collectStatsSample>[0];
type StatsReportLike = Parameters<
  Parameters<StatsReportMapLike["forEach"]>[0]
>[0];

/**
 * Build a CUMULATIVE getStats reading. The controller differences consecutive
 * samples itself, so tests must feed monotonic counters exactly like
 * react-native-webrtc does.
 */
function makeSample(
  overrides: Partial<RawStatsSample> & { timestampMs: number },
): RawStatsSample {
  return {
    rttSeconds: 0.1,
    packetsLost: 0,
    packetsReceived: 0,
    freezeCount: 0,
    jitterBufferDelay: 0,
    jitterBufferEmittedCount: 0,
    qualityLimitationReason: null,
    ...overrides,
  };
}

function createSender(
  kind: "audio" | "video",
  hooks: {
    onGet?: () => void;
    onSet?: (params: SendParamsLike) => Promise<void> | void;
  } = {},
) {
  const params: SendParamsLike = { encodings: [] };
  const getParameters = jest.fn((): SendParamsLike => {
    hooks.onGet?.();
    return params;
  });
  const setParameters = jest.fn(async (next: SendParamsLike): Promise<void> => {
    await hooks.onSet?.(next);
  });
  return { track: { kind }, getParameters, setParameters, params };
}

function createPc(senders: SenderLike[]): PeerConnectionLike {
  return { getSenders: () => senders };
}

/** A stats report shaped like the Map-ish object react-native-webrtc returns. */
function createStatsReport(reports: StatsReportLike[]): StatsReportMapLike {
  return {
    forEach: (cb: (report: StatsReportLike) => void) => reports.forEach(cb),
  };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Ladder
// ─────────────────────────────────────────────────────────────────────────────

describe("video tier ladder", () => {
  it("is ordered best -> worst and drops framerate with bitrate", () => {
    for (let i = 1; i < VIDEO_TIERS.length; i++) {
      expect(VIDEO_TIERS[i].maxBitrate).toBeLessThan(
        VIDEO_TIERS[i - 1].maxBitrate,
      );
      expect(VIDEO_TIERS[i].scaleResolutionDownBy).toBeGreaterThanOrEqual(
        VIDEO_TIERS[i - 1].scaleResolutionDownBy,
      );
      expect(VIDEO_TIERS[i].maxFramerate).toBeLessThanOrEqual(
        VIDEO_TIERS[i - 1].maxFramerate,
      );
    }
  });

  it("caps the top rung lower on mobile uplinks", () => {
    expect(buildTiers(true)[0].maxBitrate).toBe(MOBILE_TOP_TIER_BITRATE);
    expect(buildTiers(false)[0].maxBitrate).toBe(VIDEO_TIERS[0].maxBitrate);
  });

  it("defaults to the mobile ladder", () => {
    // The web module defaults to desktop; this one must default to mobile so a
    // caller that forgets the flag never uncaps a phone uplink.
    const controller = createQualityController();
    controller.setTierIndex(0);
    expect(controller.getTier().maxBitrate).toBe(MOBILE_TOP_TIER_BITRATE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// collectStatsSample (mobile-only helper)
// ─────────────────────────────────────────────────────────────────────────────

describe("collectStatsSample", () => {
  it("folds a getStats report into raw cumulative counters", () => {
    const stats = createStatsReport([
      {
        type: "candidate-pair",
        nominated: true,
        currentRoundTripTime: 0.12,
      },
      {
        type: "inbound-rtp",
        kind: "audio",
        packetsLost: 3,
        packetsReceived: 500,
        jitterBufferDelay: 4,
        jitterBufferEmittedCount: 400,
      },
      {
        type: "inbound-rtp",
        kind: "video",
        packetsLost: 9,
        packetsReceived: 1500,
        jitterBufferDelay: 6,
        jitterBufferEmittedCount: 600,
        freezeCount: 2,
      },
      { type: "outbound-rtp", kind: "video", qualityLimitationReason: "cpu" },
    ]);

    const sample = collectStatsSample(stats, 1234);

    expect(sample).toEqual({
      timestampMs: 1234,
      rttSeconds: 0.12,
      // Audio AND video loss are summed: a video call can stutter badly while
      // the audio stream alone still looks clean.
      packetsLost: 12,
      packetsReceived: 2000,
      freezeCount: 2,
      jitterBufferDelay: 10,
      jitterBufferEmittedCount: 1000,
      qualityLimitationReason: "cpu",
    });
  });

  it("falls back to remote-inbound-rtp RTT when the candidate pair has none", () => {
    const sample = collectStatsSample(
      createStatsReport([
        { type: "candidate-pair", nominated: true },
        { type: "remote-inbound-rtp", kind: "video", roundTripTime: 0.24 },
      ]),
      1,
    );
    expect(sample.rttSeconds).toBe(0.24);
  });

  it("reports a null RTT when no report carries one", () => {
    const sample = collectStatsSample(
      createStatsReport([
        { type: "inbound-rtp", kind: "audio", packetsReceived: 10 },
      ]),
      1,
    );
    expect(sample.rttSeconds).toBeNull();
  });

  it("ignores an un-nominated candidate pair", () => {
    const sample = collectStatsSample(
      createStatsReport([
        {
          type: "candidate-pair",
          state: "failed",
          nominated: false,
          currentRoundTripTime: 9,
        },
      ]),
      1,
    );
    expect(sample.rttSeconds).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

describe("quality controller", () => {
  it("holds position until it has an RTT sample", () => {
    const controller = createQualityController();
    const decision = controller.observe(
      makeSample({ timestampMs: 0, rttSeconds: null }),
    );
    expect(decision.quality).toBe("unknown");
    expect(decision.changed).toBe(false);
    expect(decision.tierIndex).toBe(RAMP_START_TIER_INDEX);
  });

  it("grades RTT against the learned path baseline, not an absolute threshold", () => {
    // A Cloudflare-TURN-relayed path sits at a steady 250 ms. The old mobile
    // classifier (`rtt < 0.15 → good`, `< 0.4 → fair`) called that "fair"
    // forever and re-configured the encoder every sample.
    const controller = createQualityController();
    let decision = controller.observe(
      makeSample({ timestampMs: 0, rttSeconds: 0.25 }),
    );
    for (let i = 1; i < 5; i++) {
      decision = controller.observe(
        makeSample({ timestampMs: i * 2000, rttSeconds: 0.25 }),
      );
    }
    expect(decision.quality).toBe("good");
    expect(decision.baselineRttSeconds).toBeCloseTo(0.25, 3);

    let downshifted = false;
    for (let i = 0; i < 6 && !downshifted; i++) {
      decision = controller.observe(
        makeSample({ timestampMs: 10_000 + i * 2000, rttSeconds: 0.5 }),
      );
      downshifted = decision.changed;
    }
    expect(downshifted).toBe(true);
    expect(decision.quality).toBe("poor");
    // A congestion-induced rise must never be absorbed into "normal".
    expect(decision.baselineRttSeconds).toBeCloseTo(0.25, 3);
  });

  it("uses interval loss so one burst cannot pin the encoder for the whole call", () => {
    const controller = createQualityController();
    controller.observe(
      makeSample({ timestampMs: 0, packetsLost: 0, packetsReceived: 100 }),
    );
    let decision = controller.observe(
      makeSample({ timestampMs: 2000, packetsLost: 200, packetsReceived: 200 }),
    );
    expect(decision.quality).toBe("poor");

    let received = 200;
    for (let i = 0; i < 6; i++) {
      received += 300;
      decision = controller.observe(
        makeSample({
          timestampMs: 4000 + i * 2000,
          packetsLost: 200,
          packetsReceived: received,
        }),
      );
    }
    // The cumulative rate the OLD code used is still ~9%; the interval EWMA
    // has decayed back to clean.
    expect(200 / (200 + received)).toBeGreaterThan(0.05);
    expect(decision.smoothedLossRate).toBeLessThan(0.02);
    expect(decision.quality).toBe("good");
  });

  it("downshifts one rung at a time and stops at the bottom", () => {
    const controller = createQualityController();
    controller.setTierIndex(0);
    controller.observe(makeSample({ timestampMs: 0 }));

    const path: number[] = [];
    let freezeCount = 0;
    for (let i = 1; i <= 5; i++) {
      freezeCount += 1;
      path.push(
        controller.observe(makeSample({ timestampMs: i * 2000, freezeCount }))
          .tierIndex,
      );
    }
    expect(path).toEqual([1, 2, 3, 4, 4]);
  });

  it("treats an encoder bandwidth limitation as a downshift trigger", () => {
    const controller = createQualityController();
    controller.setTierIndex(1);
    controller.observe(makeSample({ timestampMs: 0 }));
    const decision = controller.observe(
      makeSample({ timestampMs: 2000, qualityLimitationReason: "bandwidth" }),
    );
    expect(decision.changed).toBe(true);
    expect(decision.tierIndex).toBe(2);
  });

  it("recovers slowly, and even slower when the step changes resolution", () => {
    const controller = createQualityController();
    controller.observe(makeSample({ timestampMs: 0 }));
    const dropped = controller.observe(
      makeSample({ timestampMs: 2000, freezeCount: 1 }),
    );
    expect(dropped.tierIndex).toBe(BOTTOM_TIER_INDEX);

    // Bottom -> next rung changes scaleResolutionDownBy, which costs a
    // keyframe, so it needs the extra damping: 4 + 2 = 6 clean samples.
    let decision = dropped;
    for (let i = 0; i < 5; i++) {
      decision = controller.observe(
        makeSample({ timestampMs: 4000 + i * 2000, freezeCount: 1 }),
      );
      expect(decision.changed).toBe(false);
    }
    decision = controller.observe(
      makeSample({ timestampMs: 14_000, freezeCount: 1 }),
    );
    expect(decision.changed).toBe(true);
    expect(decision.tierIndex).toBe(BOTTOM_TIER_INDEX - 1);
  });

  it("holds position in the warn dead-band instead of flapping", () => {
    const controller = createQualityController();
    for (let i = 0; i < 4; i++) {
      controller.observe(makeSample({ timestampMs: i * 2000 }));
    }
    // Settle the EWMA into the mid-band (~120 ms over the 100 ms baseline).
    let decision = controller.observe(makeSample({ timestampMs: 0 }));
    for (let i = 0; i < 3; i++) {
      decision = controller.observe(
        makeSample({ timestampMs: 8000 + i * 2000, rttSeconds: 0.22 }),
      );
    }
    expect(decision.quality).toBe("fair");

    const start = controller.getTierIndex();
    for (let i = 0; i < 6; i++) {
      decision = controller.observe(
        makeSample({ timestampMs: 14_000 + i * 2000, rttSeconds: 0.22 }),
      );
      expect(decision.quality).toBe("fair");
      expect(decision.tierIndex).toBe(start);
      expect(decision.changed).toBe(false);
    }
  });

  it("clears learned state on reset", () => {
    const controller = createQualityController();
    controller.observe(makeSample({ timestampMs: 0 }));
    controller.observe(makeSample({ timestampMs: 2000, freezeCount: 4 }));
    expect(controller.getTierIndex()).toBe(BOTTOM_TIER_INDEX);
    controller.reset();
    expect(controller.getTierIndex()).toBe(RAMP_START_TIER_INDEX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Encoder writes
// ─────────────────────────────────────────────────────────────────────────────

describe("encoder parameter writes", () => {
  it("applies bitrate, framerate and scale to video senders only", async () => {
    const video = createSender("video");
    const audio = createSender("audio");
    const pc = createPc([video, audio]);

    await expect(
      applyVideoEncodingTier(pc, VIDEO_TIERS[BOTTOM_TIER_INDEX]),
    ).resolves.toBe(true);

    expect(video.params.encodings?.[0]).toMatchObject({
      maxBitrate: 150_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 2,
    });
    expect(video.params.degradationPreference).toBe("balanced");
    expect(audio.setParameters).not.toHaveBeenCalled();
  });

  it("caps audio separately so video adaptation cannot starve it", async () => {
    const video = createSender("video");
    const audio = createSender("audio");
    const pc = createPc([video, audio]);

    await expect(applyAudioEncodingCap(pc)).resolves.toBe(true);
    expect(audio.params.encodings?.[0]?.maxBitrate).toBe(48_000);
    expect(video.setParameters).not.toHaveBeenCalled();
  });

  it("serialises concurrent writes and re-reads parameters for each one", async () => {
    const log: string[] = [];
    const video = createSender("video", {
      onGet: () => log.push("get"),
      onSet: (params) =>
        new Promise<void>((resolve) => {
          log.push(`set:${params.encodings?.[0]?.maxBitrate}`);
          setTimeout(resolve, 5);
        }),
    });
    const pc = createPc([video]);

    // The connect ramp and the stats loop racing — the exact pattern that used
    // to throw InvalidStateError and silently drop a write.
    await Promise.all([
      applyVideoEncodingTier(pc, VIDEO_TIERS[0]),
      applyVideoEncodingTier(pc, VIDEO_TIERS[BOTTOM_TIER_INDEX]),
    ]);

    expect(log).toEqual([
      "get",
      `set:${VIDEO_TIERS[0].maxBitrate}`,
      "get",
      `set:${VIDEO_TIERS[BOTTOM_TIER_INDEX].maxBitrate}`,
    ]);
  });

  it("reports failures instead of swallowing them, and keeps the queue alive", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const failing = createSender("video", {
      onSet: () => Promise.reject(new Error("InvalidStateError")),
    });
    const pc = createPc([failing]);

    await expect(applyVideoEncodingTier(pc, VIDEO_TIERS[0])).resolves.toBe(
      false,
    );
    expect(warn).toHaveBeenCalled();

    failing.setParameters.mockImplementation(async () => {});
    await expect(applyVideoEncodingTier(pc, VIDEO_TIERS[1])).resolves.toBe(
      true,
    );
  });

  it("is a no-op on a peer connection with no senders (voice call)", async () => {
    const pc = createPc([]);
    await expect(applyVideoEncodingTier(pc, VIDEO_TIERS[0])).resolves.toBe(
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connect-time ramp
// ─────────────────────────────────────────────────────────────────────────────

describe("connect-time bitrate ramp", () => {
  it("walks up one rung per step and shares its position with the controller", () => {
    jest.useFakeTimers();
    const controller = createQualityController();
    const pc = createPc([createSender("video"), createSender("audio")]);

    const cancel = startBitrateRampUp(pc, controller, { stepMs: 100 });
    expect(controller.getTierIndex()).toBe(RAMP_START_TIER_INDEX);

    jest.advanceTimersByTime(100);
    expect(controller.getTierIndex()).toBe(RAMP_START_TIER_INDEX - 1);
    jest.advanceTimersByTime(200);
    expect(controller.getTierIndex()).toBe(0);
    cancel();
  });

  it("aborts as soon as the adaptive controller has moved down", () => {
    jest.useFakeTimers();
    const controller = createQualityController();
    const pc = createPc([createSender("video")]);

    startBitrateRampUp(pc, controller, { stepMs: 100 });
    jest.advanceTimersByTime(100);

    // The stats loop drops us because the link is genuinely bad; the ramp must
    // not fight it back up.
    controller.setTierIndex(BOTTOM_TIER_INDEX);
    jest.advanceTimersByTime(500);
    expect(controller.getTierIndex()).toBe(BOTTOM_TIER_INDEX);
  });

  it("stops stepping once cancelled", () => {
    jest.useFakeTimers();
    const controller = createQualityController();
    const pc = createPc([createSender("video")]);

    startBitrateRampUp(pc, controller, { stepMs: 100 })();
    jest.advanceTimersByTime(1000);
    expect(controller.getTierIndex()).toBe(RAMP_START_TIER_INDEX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SDP munging
// ─────────────────────────────────────────────────────────────────────────────

describe("preferOpusFec", () => {
  it("turns on in-band FEC while preserving unrelated fmtp params", () => {
    const sdp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111 110",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 minptime=10;useinbandfec=0",
      "a=rtpmap:110 telephone-event/48000",
      "a=fmtp:110 0-15",
    ].join("\r\n");

    const out = preferOpusFec(sdp);
    const opusFmtp = out
      .split("\r\n")
      .find((line) => line.startsWith("a=fmtp:111"))!;

    expect(opusFmtp).toContain("minptime=10");
    expect(opusFmtp).toContain("useinbandfec=1");
    expect(opusFmtp).toContain("usedtx=0");
    expect(opusFmtp).not.toContain("useinbandfec=0");
    expect(out).toContain("a=fmtp:110 0-15");
  });

  it("is a no-op when there is no Opus line", () => {
    const sdp =
      "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000";
    expect(preferOpusFec(sdp)).toBe(sdp);
    expect(preferOpusFec("")).toBe("");
  });
});
