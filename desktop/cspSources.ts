/**
 * CSP source builders for the Electron renderer.
 *
 * Pure and dependency-free on purpose: the renderer's Content-Security-Policy
 * is assembled in `main.ts`, but the tricky part — which SFU origins to allow —
 * is worth being able to unit test without booting Electron. It is exercised by
 * `client/src/__tests__/desktopCsp.test.ts`.
 *
 * ─── Why a wildcard rather than an env var ───────────────────────────────────
 * A packaged Electron app has NO build-time environment. `process.env.X` in the
 * main process reads the END USER's machine at launch, which of course does not
 * carry our deployment config, so an env-only rule silently produces an empty
 * `connect-src` entry and every SFU call fails in the packaged build while dev
 * works. AINO's backend (and its LiveKit service) run on Railway, which serves
 * every service under `*.up.railway.app`, so that host space is baked in as the
 * production default — the same shape as the hard-coded `API_SERVER` default in
 * main.ts. It is narrow: only Railway-hosted services match, not the whole web.
 *
 * Anything else (a custom SFU domain, a LiveKit Cloud project, a local server)
 * is added through `LIVEKIT_URL` / `LIVEKIT_ORIGIN` — still useful for `npm
 * start` and for self-built installers — and is combined with, never replaced
 * by, the default.
 */

/** Railway's public service domain. LiveKit is deployed as a Railway service. */
export const RAILWAY_SERVICE_HOST_PATTERN = "*.up.railway.app";

/** Env var names checked for extra SFU origins, in order. */
export const LIVEKIT_ENV_KEYS = ["LIVEKIT_URL", "LIVEKIT_ORIGIN", "VITE_LIVEKIT_URL"] as const;

export interface LiveKitCspOptions {
  /**
   * Extra hosts to always allow (e.g. the API origin's host when the SFU is
   * proxied through it). Values may be full URLs or bare hosts.
   */
  extraHosts?: string[];
  /** Set false in tests to isolate the env-var behaviour. */
  includeRailwayDefault?: boolean;
}

/** `https://x` / `wss://x` / bare `x[:port]` → `x[:port]`, or "" if unusable. */
export function normalizeHost(raw: string): string {
  const value = (raw || "").trim();
  if (!value) return "";
  // Wildcard patterns are not valid URLs but are valid CSP sources.
  if (value.startsWith("*.")) return value;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.host;
  } catch {
    return "";
  }
}

/**
 * LiveKit Cloud hands a client off to a region-specific subdomain during the
 * handshake (`project.livekit.cloud` → `project.region.production.livekit.cloud`),
 * and CSP is evaluated against the FINAL origin. Widen to the cloud's own
 * domain in that one case, and only that one.
 */
function expandCloudHost(host: string): string[] {
  return host.endsWith(".livekit.cloud") ? [host, "*.livekit.cloud"] : [host];
}

/**
 * Build the `connect-src` entries the LiveKit browser SDK needs: it opens a
 * `wss://` signalling socket and makes `https://` requests to the same host.
 * Media itself is UDP/WebRTC and is not subject to CSP.
 *
 * Never returns an empty string — an empty entry is exactly the silent failure
 * this helper exists to prevent.
 */
export function buildLiveKitCspSources(
  env: Record<string, string | undefined> = {},
  options: LiveKitCspOptions = {},
): string {
  const { extraHosts = [], includeRailwayDefault = true } = options;
  const hosts: string[] = [];

  if (includeRailwayDefault) hosts.push(RAILWAY_SERVICE_HOST_PATTERN);

  const configured = [
    ...LIVEKIT_ENV_KEYS.map((key) => env[key] || ""),
    ...extraHosts,
  ].flatMap((value) => value.split(/[\s,]+/));

  for (const candidate of configured) {
    const host = normalizeHost(candidate);
    if (!host) continue;
    hosts.push(...expandCloudHost(host));
  }

  const sources: string[] = [];
  for (const host of hosts) {
    for (const scheme of ["https", "wss"]) {
      const source = `${scheme}://${host}`;
      if (!sources.includes(source)) sources.push(source);
    }
  }
  return sources.join(" ");
}
