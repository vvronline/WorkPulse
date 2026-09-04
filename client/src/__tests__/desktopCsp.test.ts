import { describe, it, expect } from "vitest";
/*
 * The Electron main process assembles the renderer's CSP. Its trickiest part is
 * which SFU origins to allow: a packaged app has no build-time environment, so
 * an env-only rule silently emits nothing and every desktop SFU call fails
 * while dev works. The builder lives in a dependency-free module precisely so
 * that rule can be tested here without booting Electron.
 */
import {
  buildLiveKitCspSources,
  normalizeHost,
  RAILWAY_SERVICE_HOST_PATTERN,
} from "../../../desktop/cspSources";

describe("normalizeHost", () => {
  it("accepts full URLs, bare hosts and wildcards", () => {
    expect(normalizeHost("wss://calls.example.com")).toBe("calls.example.com");
    expect(normalizeHost("https://calls.example.com/rtc")).toBe("calls.example.com");
    expect(normalizeHost("calls.example.com:7880")).toBe("calls.example.com:7880");
    expect(normalizeHost("*.up.railway.app")).toBe("*.up.railway.app");
  });

  it("drops unusable values", () => {
    expect(normalizeHost("")).toBe("");
    expect(normalizeHost("   ")).toBe("");
    expect(normalizeHost("http://")).toBe("");
  });
});

describe("buildLiveKitCspSources", () => {
  it("never emits an empty entry, even with no environment at all", () => {
    const sources = buildLiveKitCspSources({});
    expect(sources.trim().length).toBeGreaterThan(0);
    expect(sources).toContain(`https://${RAILWAY_SERVICE_HOST_PATTERN}`);
    expect(sources).toContain(`wss://${RAILWAY_SERVICE_HOST_PATTERN}`);
  });

  it("keeps the production default reachable in a packaged build", () => {
    // Packaged apps see the END USER's env, which has none of our config.
    const packagedEnv = { PATH: "/usr/bin", HOME: "/home/user" };
    expect(buildLiveKitCspSources(packagedEnv)).toBe(
      `https://${RAILWAY_SERVICE_HOST_PATTERN} wss://${RAILWAY_SERVICE_HOST_PATTERN}`,
    );
  });

  it("stays narrowly scoped — no bare scheme wildcards", () => {
    const sources = buildLiveKitCspSources({ LIVEKIT_URL: "wss://calls.example.com" });
    expect(sources).not.toMatch(/(^|\s)(https:|wss:|\*)(\s|$)/);
    for (const source of sources.split(" ")) {
      expect(source).toMatch(/^(https|wss):\/\/[^*]|^(https|wss):\/\/\*\.[^*]+$/);
    }
  });

  it("ADDS explicit origins to the default instead of replacing it", () => {
    const sources = buildLiveKitCspSources({ LIVEKIT_URL: "wss://calls.aino.org.in" });
    expect(sources).toContain(`https://${RAILWAY_SERVICE_HOST_PATTERN}`);
    expect(sources).toContain("https://calls.aino.org.in");
    expect(sources).toContain("wss://calls.aino.org.in");
  });

  it("accepts every documented env var and multiple origins", () => {
    const sources = buildLiveKitCspSources({
      LIVEKIT_ORIGIN: "sfu-a.example.com",
      VITE_LIVEKIT_URL: "wss://sfu-b.example.com, wss://sfu-c.example.com",
    });
    expect(sources).toContain("wss://sfu-a.example.com");
    expect(sources).toContain("wss://sfu-b.example.com");
    expect(sources).toContain("wss://sfu-c.example.com");
  });

  it("widens to the LiveKit Cloud domain, which redirects to region subdomains", () => {
    const sources = buildLiveKitCspSources({ LIVEKIT_URL: "wss://proj.livekit.cloud" });
    expect(sources).toContain("wss://proj.livekit.cloud");
    expect(sources).toContain("wss://*.livekit.cloud");
  });

  it("does not widen a normal custom domain", () => {
    const sources = buildLiveKitCspSources({ LIVEKIT_URL: "wss://calls.aino.org.in" });
    expect(sources).not.toContain("*.aino.org.in");
    expect(sources).not.toContain("*.org.in");
  });

  it("de-duplicates and ignores junk", () => {
    const sources = buildLiveKitCspSources({
      LIVEKIT_URL: "wss://dup.example.com",
      LIVEKIT_ORIGIN: "https://dup.example.com",
      VITE_LIVEKIT_URL: "   ",
    });
    expect(sources.split(" ").filter((s) => s === "wss://dup.example.com")).toHaveLength(1);
  });
});
