/**
 * ICE/TURN server configuration helpers shared by the 1:1 call screen
 * (`app/call/[conversationId].tsx`) and the group/meeting mesh
 * (`src/meeting/useMeetingMesh.ts`).
 */

const REAL_TURN_MODES = new Set(["cloudflare-calls", "coturn-rest", "static"]);

/**
 * A single entry of an `RTCConfiguration.iceServers` array. Structurally
 * compatible with the DOM `RTCIceServer` and react-native-webrtc's own type,
 * declared locally so this module stays dependency-free and testable in a
 * plain Node/jest environment.
 */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Shape of the `/api/calls/ice` payload, as far as this module cares. */
export interface IceConfigLike {
  mode?: string;
  iceServers?: IceServer[];
  allowPublicFallback?: boolean;
}

export const FALLBACK_ICE: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

/** Normalise the `urls` field, which may be a single string or an array. */
function toUrlList(
  server: IceServer | null | undefined,
): (string | undefined)[] {
  const urls = server?.urls;
  return Array.isArray(urls) ? urls : [urls];
}

export function hasRealTurn(cfg: IceConfigLike | null | undefined): boolean {
  if (!cfg) return false;
  if (cfg.mode && REAL_TURN_MODES.has(cfg.mode)) return true;
  const servers = cfg.iceServers || [];
  for (const s of servers) {
    for (const u of toUrlList(s)) {
      if (typeof u !== "string") continue;
      const lower = u.toLowerCase();
      if (
        (lower.startsWith("turn:") || lower.startsWith("turns:")) &&
        !lower.includes("openrelay.metered.ca")
      ) {
        return true;
      }
    }
  }
  return false;
}

export function applyPublicTurnPolicy(
  servers: IceServer[],
  allowPublic: boolean,
): IceServer[] {
  if (allowPublic) return servers;
  const out: IceServer[] = [];
  for (const s of servers || []) {
    const kept = toUrlList(s).filter(
      (u): u is string =>
        typeof u === "string" &&
        !u.toLowerCase().includes("openrelay.metered.ca"),
    );
    if (kept.length === 0) continue;
    out.push({ ...s, urls: kept.length === 1 ? kept[0] : kept });
  }
  return out;
}
