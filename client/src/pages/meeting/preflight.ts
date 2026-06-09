/**
 * Meeting preflight check — verifies the user can actually establish a
 * peer connection BEFORE we let them try to join. Caller can render the
 * result however they want (banner / blocking modal / silent log).
 *
 * Why this is useful
 * ──────────────────
 * Today MeetingJoin.jsx checks camera + microphone access and runs a
 * network-speed test (`checkNetworkSpeed`). What it does NOT verify is:
 *
 *   • Can the browser actually exchange ICE candidates with the
 *     configured STUN/TURN servers? — corporate firewalls + symmetric
 *     NATs commonly block UDP entirely, forcing the meeting onto TCP/443
 *     TURN. Without a preflight, the user discovers this at the moment
 *     the very first peer tries to connect and sees a black tile.
 *   • Is the TURN credential still valid? — our credentials are
 *     time-bound (~30 minutes); a meeting that's joined right before
 *     expiry can hand out an already-stale TURN config.
 *
 * Design
 * ──────
 * Pure async function. No React, no DOM, no UI side effects. Returns a
 * structured result that any caller (MeetingJoin, MeetingRoom, an
 * automated health check, …) can act on.
 *
 *   const result = await runPreflight({ iceServers, timeoutMs: 5_000 });
 *
 * Verdict logic:
 *   - At least ONE candidate of any kind          → ok: true
 *   - Zero candidates after `timeoutMs`            → ok: false
 *   - Browser doesn't support RTCPeerConnection    → ok: false + errorCode
 *
 * Why we don't try to establish a full peer connection in preflight:
 *   - It would need a second loopback peer, doubling complexity
 *   - The signalling round-trip would dominate latency (~3-5s)
 *   - Candidate gathering alone catches every problem that matters:
 *     "STUN/TURN unreachable" + "browser blocked WebRTC entirely"
 */

export interface PreflightResult {
    ok: boolean;
    hasLocalCandidate: boolean;
    hasHostCandidate: boolean;
    hasSrflxCandidate: boolean;
    hasRelayCandidate: boolean;
    elapsedMs: number;
    errorCode: string | null;
}

export interface PreflightOptions {
    iceServers?: RTCIceServer[];
    timeoutMs?: number;
    onCandidate?: (type: string, candidate: RTCIceCandidate) => void;
}

export interface PreflightSummary {
    severity: "ok" | "warn" | "error";
    label: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Run the preflight check.
 */
async function runPreflight({
    iceServers = [{ urls: "stun:stun.l.google.com:19302" }],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onCandidate,
}: PreflightOptions = {}): Promise<PreflightResult> {
    const t0 = Date.now();
    const result: PreflightResult = {
        ok: false,
        hasLocalCandidate: false,
        hasHostCandidate: false,
        hasSrflxCandidate: false,
        hasRelayCandidate: false,
        elapsedMs: 0,
        errorCode: null,
    };

    if (typeof RTCPeerConnection === "undefined") {
        result.errorCode = "no-rtcpeerconnection";
        result.elapsedMs = Date.now() - t0;
        return result;
    }

    let pc: RTCPeerConnection;
    try {
        pc = new RTCPeerConnection({ iceServers });
    } catch (err) {
        result.errorCode = `pc-construct-failed:${(err as Error)?.message || "unknown"}`;
        result.elapsedMs = Date.now() - t0;
        return result;
    }

    // We need at least one m-line for ICE gathering to start. A no-track
    // recv-only audio transceiver is the lightest possible nudge — no
    // microphone access needed, no SDP heft.
    try {
        if (typeof pc.addTransceiver === "function") {
            pc.addTransceiver("audio", { direction: "recvonly" });
        }
    } catch { /* some embedded browsers reject this — fall through */ }

    return new Promise<PreflightResult>((resolve) => {
        let settled = false;
        const finish = (errCode: string | null = null) => {
            if (settled) return;
            settled = true;
            if (errCode) result.errorCode = errCode;
            result.ok = result.hasLocalCandidate;
            result.elapsedMs = Date.now() - t0;
            try { pc.close(); } catch { /* ignore */ }
            resolve(result);
        };

        const timer = setTimeout(() => finish("timeout"), timeoutMs);

        pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                result.hasLocalCandidate = true;
                // `candidate.type` is the standard property on modern
                // browsers; older ones expose it via the SDP `candidate`
                // line so we fall back to a string-match.
                const t = ev.candidate.type
                    || (ev.candidate.candidate || "").match(/typ\s+(\w+)/)?.[1]
                    || "unknown";
                if (t === "host") result.hasHostCandidate = true;
                else if (t === "srflx") result.hasSrflxCandidate = true;
                else if (t === "relay") result.hasRelayCandidate = true;
                onCandidate?.(t, ev.candidate);
            } else {
                // null candidate means gathering complete — settle early.
                clearTimeout(timer);
                finish();
            }
        };
        pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === "complete") {
                clearTimeout(timer);
                finish();
            }
        };

        // Kick off candidate gathering.
        pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false } as RTCOfferOptions)
            .then((offer) => pc.setLocalDescription(offer))
            .catch((err) => {
                clearTimeout(timer);
                finish(`create-offer-failed:${(err as Error)?.message || "unknown"}`);
            });
    });
}

/**
 * Pretty summariser — used by the future UI banner. Pure, no I/O.
 */
function summarisePreflight(result: PreflightResult | null | undefined): PreflightSummary {
    if (!result) return { severity: "error", label: "Preflight not run" };
    if (result.errorCode === "no-rtcpeerconnection") {
        return { severity: "error", label: "Your browser doesn't support real-time calls" };
    }
    if (!result.ok) {
        return {
            severity: "error",
            label: "Unable to reach STUN/TURN servers — your network may block WebRTC",
        };
    }
    if (result.hasRelayCandidate) {
        return { severity: "ok", label: "Network looks good (TURN reachable)" };
    }
    if (result.hasSrflxCandidate) {
        return { severity: "ok", label: "Network looks good (STUN reachable)" };
    }
    if (result.hasHostCandidate) {
        return {
            severity: "warn",
            // Host-only is fine on a LAN, but explicitly worth flagging so
            // the user isn't surprised when the meeting fails outside it.
            label: "Only local candidates found — may not work outside your network",
        };
    }
    return { severity: "error", label: "No ICE candidates gathered" };
}

export { runPreflight, summarisePreflight, DEFAULT_TIMEOUT_MS };
export default { runPreflight, summarisePreflight, DEFAULT_TIMEOUT_MS };