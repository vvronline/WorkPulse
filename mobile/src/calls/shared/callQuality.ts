/**
 * ADAPTIVE VIDEO QUALITY CONTROLLER (1:1 calls) — mobile mirror.
 *
 * Parity twin of `client/src/components/chat/call/callQuality.ts`. The repo has
 * no shared web/native package, so parity is maintained by duplication (same
 * convention as `callSignalDeduplicator.ts` / `peerConnectionMachine.ts`).
 * KEEP THE TWO FILES IN SYNC — the grading thresholds and the ladder must match
 * or the two ends of a call will disagree about what "good" means.
 *
 * WHY THIS REPLACES THE INLINE CONTROLLER IN app/call/[conversationId].tsx:
 *
 *   1. CUMULATIVE LOSS — the old loop computed
 *      `packetsLost / (packetsLost + packetsReceived)` from the counters SINCE
 *      CALL START. `packetsLost` is monotonic, so one early loss burst pinned
 *      the encoder low for the remainder of the call.
 *      → Interval deltas here.
 *
 *   2. ABSOLUTE RTT THRESHOLDS — `rtt < 0.15 → good` is wrong on a
 *      TURN-relayed path (Cloudflare Calls), where a healthy call sits at
 *      60-150 ms. The old classifier oscillated across that boundary every 3 s
 *      sample, and mobile had NO hysteresis at all, so every oscillation wrote
 *      a new bitrate AND flipped `scaleResolutionDownBy` — each flip forcing an
 *      encoder reinit + keyframe, i.e. a visible freeze.
 *      → Graded on RTT EXCESS over a learned per-path baseline here.
 *
 *   3. RACING setParameters() — three writers (ramp timers, the stats loop,
 *      camera swaps) mutated the same sender concurrently with every failure
 *      swallowed, so ramp steps were silently dropped.
 *      → Serialised through a per-PeerConnection queue.
 *
 * The types are structural on purpose: this module must not import
 * `react-native-webrtc` (it is also exercised by node-based jest tests).
 */

export type ConnectionQuality = "good" | "fair" | "poor" | "unknown";

/** One rung of the quality ladder. Bitrate, resolution and framerate move together. */
export interface VideoEncodingTier {
  maxBitrate: number;
  /** 1 = native resolution, 2 = half width & height. */
  scaleResolutionDownBy: number;
  maxFramerate: number;
}

/**
 * The ladder, best → worst. Framerate drops with bitrate: the old code forced
 * `maxFramerate: 30` even at 200 kbps, which guarantees the encoder drops
 * frames (a freeze) instead of degrading smoothly.
 */
export const VIDEO_TIERS: readonly VideoEncodingTier[] = [
  { maxBitrate: 1_500_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
  { maxBitrate: 800_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
  { maxBitrate: 500_000, scaleResolutionDownBy: 1, maxFramerate: 24 },
  { maxBitrate: 300_000, scaleResolutionDownBy: 1.5, maxFramerate: 20 },
  { maxBitrate: 150_000, scaleResolutionDownBy: 2, maxFramerate: 15 },
];

/** Mobile uplinks are the usual bottleneck — cap the top rung lower. */
export const MOBILE_TOP_TIER_BITRATE = 1_200_000;

export const BOTTOM_TIER_INDEX = VIDEO_TIERS.length - 1;
/** Connect-time ramp starts here (low = fast, stable connect) and walks up. */
export const RAMP_START_TIER_INDEX = 3;

/** Opus is capped separately — video adaptation must never starve audio. */
export const AUDIO_MAX_BITRATE = 48_000;

export function buildTiers(isMobile: boolean): VideoEncodingTier[] {
  return VIDEO_TIERS.map((tier, index) =>
    index === 0 && isMobile
      ? {
          ...tier,
          maxBitrate: Math.min(tier.maxBitrate, MOBILE_TOP_TIER_BITRATE),
        }
      : { ...tier },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural WebRTC types (avoids importing react-native-webrtc here)
// ─────────────────────────────────────────────────────────────────────────────

export interface EncodingParamsLike {
  maxBitrate?: number;
  maxFramerate?: number;
  scaleResolutionDownBy?: number;
  active?: boolean;
}

export interface SendParamsLike {
  encodings?: EncodingParamsLike[];
  degradationPreference?: string;
  [key: string]: unknown;
}

export interface SenderLike {
  track?: { kind?: string } | null;
  getParameters?: () => SendParamsLike;
  setParameters?: (params: SendParamsLike) => Promise<void> | void;
}

export interface PeerConnectionLike {
  getSenders?: () => SenderLike[];
  getReceivers?: () => Record<string, unknown>[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Sampling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A raw reading pulled from `getStats()`. The counter fields are CUMULATIVE as
 * reported by the platform; the controller differences them internally.
 */
export interface RawStatsSample {
  timestampMs: number;
  /** RTT of the nominated candidate pair, seconds. */
  rttSeconds: number | null;
  /** Cumulative `inbound-rtp.packetsLost` summed over audio + video. */
  packetsLost: number;
  /** Cumulative `inbound-rtp.packetsReceived` summed over audio + video. */
  packetsReceived: number;
  /** Cumulative `inbound-rtp.freezeCount` (video). */
  freezeCount: number;
  /** Cumulative `inbound-rtp.jitterBufferDelay` (seconds). */
  jitterBufferDelay: number;
  /** Cumulative `inbound-rtp.jitterBufferEmittedCount`. */
  jitterBufferEmittedCount: number;
  /** `outbound-rtp.qualityLimitationReason` for the video sender. */
  qualityLimitationReason: string | null;
}

export interface QualityDecision {
  quality: ConnectionQuality;
  tierIndex: number;
  tier: VideoEncodingTier;
  /** True when `tierIndex` moved on this sample (i.e. the encoder needs a write). */
  changed: boolean;
  smoothedRttSeconds: number | null;
  baselineRttSeconds: number | null;
  /** EWMA-smoothed INTERVAL loss (0..1) — not the since-call-start average. */
  smoothedLossRate: number;
  freezeDelta: number;
  jitterBufferSeconds: number;
  reason: string;
}

// Grading thresholds — MUST match the web twin.
const LOSS_BAD = 0.05;
const LOSS_WARN = 0.02;
const RTT_EXCESS_BAD = 0.2;
const RTT_EXCESS_WARN = 0.08;
const JITTER_BUFFER_BAD = 0.5;
const JITTER_BUFFER_WARN = 0.25;

const EWMA_ALPHA = 0.4;
const UPSHIFT_SAMPLES = 4;
const UPSHIFT_RESOLUTION_PENALTY = 2;
const BASELINE_WINDOW_MS = 10_000;
const BASELINE_MIN_SAMPLES = 3;

type Grade = "good" | "warn" | "bad";

export interface QualityController {
  observe(sample: RawStatsSample): QualityDecision;
  getTierIndex(): number;
  getTier(): VideoEncodingTier;
  setTierIndex(index: number): void;
  reset(): void;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * p)),
  );
  return sorted[idx];
}

export function createQualityController(
  options: { isMobile?: boolean } = {},
): QualityController {
  const tiers = buildTiers(options.isMobile !== false);

  let tierIndex = RAMP_START_TIER_INDEX;
  let prev: RawStatsSample | null = null;
  let rttEwma: number | null = null;
  let lossEwma = 0;
  let goodStreak = 0;
  let baselineRtt: number | null = null;
  let baselineSamples: number[] = [];
  let firstSampleAt: number | null = null;

  function reset() {
    tierIndex = RAMP_START_TIER_INDEX;
    prev = null;
    rttEwma = null;
    lossEwma = 0;
    goodStreak = 0;
    baselineRtt = null;
    baselineSamples = [];
    firstSampleAt = null;
  }

  function updateBaseline(rtt: number, timestampMs: number) {
    if (firstSampleAt === null) firstSampleAt = timestampMs;
    if (timestampMs - firstSampleAt <= BASELINE_WINDOW_MS) {
      baselineSamples.push(rtt);
      if (baselineSamples.length >= BASELINE_MIN_SAMPLES) {
        baselineRtt = percentile(
          [...baselineSamples].sort((a, b) => a - b),
          0.25,
        );
      } else if (baselineRtt === null) {
        baselineRtt = rtt;
      }
      return;
    }
    // Window closed. Adapt DOWNWARD only: if ICE switched from a relay to a
    // direct pair the floor follows, but congestion must never be absorbed
    // into "normal".
    if (baselineRtt === null || rtt < baselineRtt) baselineRtt = rtt;
  }

  function observe(sample: RawStatsSample): QualityDecision {
    const previous = prev;
    prev = sample;

    if (sample.rttSeconds !== null && Number.isFinite(sample.rttSeconds)) {
      rttEwma =
        rttEwma === null
          ? sample.rttSeconds
          : EWMA_ALPHA * sample.rttSeconds + (1 - EWMA_ALPHA) * rttEwma;
      updateBaseline(rttEwma, sample.timestampMs);
    }

    let intervalLoss = 0;
    if (previous) {
      const dLost = Math.max(0, sample.packetsLost - previous.packetsLost);
      const dReceived = Math.max(
        0,
        sample.packetsReceived - previous.packetsReceived,
      );
      const total = dLost + dReceived;
      if (total > 0) intervalLoss = dLost / total;
    }
    lossEwma = previous
      ? EWMA_ALPHA * intervalLoss + (1 - EWMA_ALPHA) * lossEwma
      : intervalLoss;

    const freezeDelta = previous
      ? Math.max(0, sample.freezeCount - previous.freezeCount)
      : 0;
    let jitterBufferSeconds = 0;
    if (previous) {
      const dDelay = sample.jitterBufferDelay - previous.jitterBufferDelay;
      const dEmitted =
        sample.jitterBufferEmittedCount - previous.jitterBufferEmittedCount;
      if (dEmitted > 0 && dDelay >= 0) jitterBufferSeconds = dDelay / dEmitted;
    }

    const rttExcess =
      rttEwma !== null && baselineRtt !== null
        ? Math.max(0, rttEwma - baselineRtt)
        : 0;

    let grade: Grade = "good";
    let reason = "stable";
    if (rttEwma === null) {
      return {
        quality: "unknown",
        tierIndex,
        tier: tiers[tierIndex],
        changed: false,
        smoothedRttSeconds: null,
        baselineRttSeconds: baselineRtt,
        smoothedLossRate: lossEwma,
        freezeDelta,
        jitterBufferSeconds,
        reason: "no rtt sample yet",
      };
    }

    if (freezeDelta > 0) {
      grade = "bad";
      reason = `${freezeDelta} freeze(s) observed`;
    } else if (sample.qualityLimitationReason === "bandwidth") {
      grade = "bad";
      reason = "encoder bandwidth-limited";
    } else if (lossEwma >= LOSS_BAD) {
      grade = "bad";
      reason = `loss ${(lossEwma * 100).toFixed(1)}%`;
    } else if (rttExcess >= RTT_EXCESS_BAD) {
      grade = "bad";
      reason = `rtt +${Math.round(rttExcess * 1000)}ms over baseline`;
    } else if (jitterBufferSeconds >= JITTER_BUFFER_BAD) {
      grade = "bad";
      reason = `jitter buffer ${Math.round(jitterBufferSeconds * 1000)}ms`;
    } else if (
      lossEwma >= LOSS_WARN ||
      rttExcess >= RTT_EXCESS_WARN ||
      jitterBufferSeconds >= JITTER_BUFFER_WARN ||
      sample.qualityLimitationReason === "cpu"
    ) {
      grade = "warn";
      reason = "degrading";
    }

    const before = tierIndex;
    if (grade === "bad") {
      goodStreak = 0;
      if (tierIndex < BOTTOM_TIER_INDEX) tierIndex += 1;
    } else if (grade === "warn") {
      // Hold. Warn is the dead-band that stops the old good↔fair flapping.
      goodStreak = 0;
    } else {
      goodStreak += 1;
      if (tierIndex > 0) {
        const next = tiers[tierIndex - 1];
        const current = tiers[tierIndex];
        const changesResolution =
          next.scaleResolutionDownBy !== current.scaleResolutionDownBy;
        const required =
          UPSHIFT_SAMPLES +
          (changesResolution ? UPSHIFT_RESOLUTION_PENALTY : 0);
        if (goodStreak >= required) {
          tierIndex -= 1;
          goodStreak = 0;
          reason = "recovered";
        }
      }
    }

    const quality: ConnectionQuality =
      grade === "good" ? "good" : grade === "warn" ? "fair" : "poor";

    return {
      quality,
      tierIndex,
      tier: tiers[tierIndex],
      changed: tierIndex !== before,
      smoothedRttSeconds: rttEwma,
      baselineRttSeconds: baselineRtt,
      smoothedLossRate: lossEwma,
      freezeDelta,
      jitterBufferSeconds,
      reason,
    };
  }

  return {
    observe,
    getTierIndex: () => tierIndex,
    getTier: () => tiers[tierIndex],
    setTierIndex: (index: number) => {
      tierIndex = Math.min(BOTTOM_TIER_INDEX, Math.max(0, index));
      goodStreak = 0;
    },
    reset,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats collection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single `getStats()` entry. Typed loosely on purpose: the exact field set
 * differs per report type AND per platform (react-native-webrtc omits several
 * standard fields), so every read below is individually guarded.
 */
interface StatsReportLike {
  type?: string;
  kind?: string;
  state?: string;
  nominated?: boolean;
  currentRoundTripTime?: number;
  roundTripTime?: number;
  packetsLost?: number;
  packetsReceived?: number;
  freezeCount?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  qualityLimitationReason?: string;
}

/**
 * Fold a `getStats()` report map into a `RawStatsSample`. Accepts anything
 * iterable with `forEach` (the RTCStatsReport shape on both platforms).
 */
export function collectStatsSample(
  stats: { forEach: (cb: (report: StatsReportLike) => void) => void },
  now: number = Date.now(),
): RawStatsSample {
  let rttSeconds: number | null = null;
  let packetsLost = 0;
  let packetsReceived = 0;
  let freezeCount = 0;
  let jitterBufferDelay = 0;
  let jitterBufferEmittedCount = 0;
  let qualityLimitationReason: string | null = null;

  stats.forEach((report: StatsReportLike) => {
    if (
      report?.type === "candidate-pair" &&
      (report.nominated || report.state === "succeeded")
    ) {
      if (typeof report.currentRoundTripTime === "number") {
        rttSeconds = report.currentRoundTripTime;
      }
    }
    if (
      report?.type === "inbound-rtp" &&
      (report.kind === "audio" || report.kind === "video")
    ) {
      packetsLost += report.packetsLost || 0;
      packetsReceived += report.packetsReceived || 0;
      jitterBufferDelay += report.jitterBufferDelay || 0;
      jitterBufferEmittedCount += report.jitterBufferEmittedCount || 0;
      if (report.kind === "video") freezeCount += report.freezeCount || 0;
    }
    if (report?.type === "outbound-rtp" && report.kind === "video") {
      if (report.qualityLimitationReason) {
        qualityLimitationReason = report.qualityLimitationReason;
      }
    }
    // Fallback RTT: `remote-inbound-rtp` carries one when the candidate pair
    // report omits it (common on older react-native-webrtc builds).
    if (
      report?.type === "remote-inbound-rtp" &&
      rttSeconds === null &&
      typeof report.roundTripTime === "number"
    ) {
      rttSeconds = report.roundTripTime;
    }
  });

  return {
    timestampMs: now,
    rttSeconds,
    packetsLost,
    packetsReceived,
    freezeCount,
    jitterBufferDelay,
    jitterBufferEmittedCount,
    qualityLimitationReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialised encoder writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One promise chain per peer connection. `getParameters()` returns a snapshot
 * carrying a `transactionId`; a second `setParameters()` applied before the
 * first resolves makes the first REJECT. Every writer must go through here so
 * parameters are re-read immediately before being mutated.
 */
const applyQueues = new WeakMap<object, Promise<unknown>>();

function enqueue<T>(
  pc: PeerConnectionLike,
  task: () => Promise<T>,
): Promise<T> {
  const key = pc as unknown as object;
  const tail = applyQueues.get(key) ?? Promise.resolve();
  const next = tail.then(task, task);
  applyQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Apply a ladder rung to every video sender. Serialised per peer connection. */
export function applyVideoEncodingTier(
  pc: PeerConnectionLike,
  tier: VideoEncodingTier,
): Promise<boolean> {
  return enqueue(pc, async () => {
    let applied = false;
    const senders = typeof pc.getSenders === "function" ? pc.getSenders() : [];
    for (const sender of senders) {
      if (sender?.track?.kind !== "video") continue;
      try {
        const params = sender.getParameters?.();
        if (!params) continue;
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = tier.maxBitrate;
        params.encodings[0].maxFramerate = tier.maxFramerate;
        params.encodings[0].scaleResolutionDownBy = tier.scaleResolutionDownBy;
        // "balanced" lets the encoder trade BOTH resolution and framerate as
        // the link degrades, softening gracefully instead of freezing.
        params.degradationPreference = "balanced";
        await sender.setParameters?.(params);
        applied = true;
      } catch (err) {
        // Never silent: a swallowed InvalidStateError is exactly how the
        // encoder used to get stuck at the connect-time start cap.
        console.warn(
          "[call-quality] setParameters(video) failed:",
          (err as Error)?.message || err,
        );
      }
    }
    return applied;
  });
}

/** Cap the Opus sender so video adaptation can never starve audio. */
export function applyAudioEncodingCap(
  pc: PeerConnectionLike,
  maxBitrate: number = AUDIO_MAX_BITRATE,
): Promise<boolean> {
  return enqueue(pc, async () => {
    let applied = false;
    const senders = typeof pc.getSenders === "function" ? pc.getSenders() : [];
    for (const sender of senders) {
      if (sender?.track?.kind !== "audio") continue;
      try {
        const params = sender.getParameters?.();
        if (!params) continue;
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = maxBitrate;
        await sender.setParameters?.(params);
        applied = true;
      } catch (err) {
        console.warn(
          "[call-quality] setParameters(audio) failed:",
          (err as Error)?.message || err,
        );
      }
    }
    return applied;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect-time ramp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the ladder from `RAMP_START_TIER_INDEX` up to the top rung so the
 * connection establishes on a modest bitrate and only then opens up. Shares
 * its position with the adaptive controller so the two can never disagree,
 * and ABORTS the moment the controller has moved DOWN (a genuinely bad link
 * must not be fought back up by the ramp).
 *
 * Returns a cancel function.
 */
export function startBitrateRampUp(
  pc: PeerConnectionLike,
  controller: QualityController,
  options: { stepMs?: number } = {},
): () => void {
  const stepMs = options.stepMs ?? 700;
  const timers: ReturnType<typeof setTimeout>[] = [];

  controller.setTierIndex(RAMP_START_TIER_INDEX);
  void applyVideoEncodingTier(pc, controller.getTier());
  void applyAudioEncodingCap(pc);

  for (let step = 1; step <= RAMP_START_TIER_INDEX; step++) {
    const target = RAMP_START_TIER_INDEX - step;
    timers.push(
      setTimeout(() => {
        if (controller.getTierIndex() !== target + 1) return;
        controller.setTierIndex(target);
        void applyVideoEncodingTier(pc, controller.getTier());
      }, stepMs * step),
    );
  }

  return () => timers.forEach((t) => clearTimeout(t));
}

// ─────────────────────────────────────────────────────────────────────────────
// SDP: Opus in-band FEC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enable Opus in-band FEC (and disable DTX) on the LOCAL description before it
 * is signalled. Without `useinbandfec=1` every lost audio packet is an audible
 * gap — the most-noticed form of "jitter" on a call.
 *
 * Safe on any SDP: with no Opus fmtp line the input is returned unchanged.
 */
export function preferOpusFec(sdp: string): string {
  if (!sdp) return sdp;
  const payloadTypes = new Set<string>();
  const rtpmap = /^a=rtpmap:(\d+)\s+opus\/48000/gim;
  let match: RegExpExecArray | null;
  while ((match = rtpmap.exec(sdp))) payloadTypes.add(match[1]);
  if (payloadTypes.size === 0) return sdp;

  const wanted: Record<string, string> = {
    useinbandfec: "1",
    usedtx: "0",
    maxaveragebitrate: "32000",
  };

  return sdp
    .split(/\r\n|\n/)
    .map((line) => {
      const fmtp = /^a=fmtp:(\d+)\s+(.*)$/.exec(line);
      if (!fmtp || !payloadTypes.has(fmtp[1])) return line;
      const params = new Map<string, string>();
      for (const part of fmtp[2].split(";")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) params.set(trimmed, "");
        else params.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
      }
      for (const [key, value] of Object.entries(wanted)) params.set(key, value);
      const rebuilt = [...params.entries()]
        .map(([k, v]) => (v === "" ? k : `${k}=${v}`))
        .join(";");
      return `a=fmtp:${fmtp[1]} ${rebuilt}`;
    })
    .join("\r\n");
}
