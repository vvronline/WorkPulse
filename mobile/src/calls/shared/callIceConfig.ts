const REAL_TURN_MODES = new Set(["cloudflare-calls", "coturn-rest", "static"]);

export const FALLBACK_ICE = [
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

export function hasRealTurn(
  cfg: { mode?: string; iceServers?: any[] } | null | undefined,
): boolean {
  if (!cfg) return false;
  if (cfg.mode && REAL_TURN_MODES.has(cfg.mode)) return true;
  const servers = cfg.iceServers || [];
  for (const s of servers) {
    const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
    for (const u of urls) {
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

export function applyPublicTurnPolicy(servers: any[], allowPublic: boolean): any[] {
  if (allowPublic) return servers;
  const out: any[] = [];
  for (const s of servers || []) {
    const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
    const kept = urls.filter(
      (u: any) =>
        typeof u === "string" &&
        !u.toLowerCase().includes("openrelay.metered.ca"),
    );
    if (kept.length === 0) continue;
    out.push({ ...s, urls: kept.length === 1 ? kept[0] : kept });
  }
  return out;
}
