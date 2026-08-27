/**
 * CSP must allow the origins the app actually loads from.
 *
 * WHY THIS TEST EXISTS
 *   A3 moved uploads to R2. `/uploads/...` authorizes the request and then
 *   302-redirects to a presigned URL on `*.r2.cloudflarestorage.com`. CSP is
 *   evaluated against the FINAL origin, so leaving the policy at `'self'`
 *   blocks every avatar, chat image, attachment and org logo.
 *
 *   That failure is invisible server-side — the request returns 200/302 and the
 *   logs look clean. It surfaces only as a broken image plus a console error, so
 *   nothing in CI caught it. It reached production on 2026-08-27.
 */
import express from "express";
import request from "supertest";
import { installSecurity } from "../http/middleware/security";

const ACCOUNT = "testaccount123";

function policyFor(env: Record<string, string | undefined>): Promise<string> {
    const previous = { ...process.env };
    Object.assign(process.env, env);
    try {
        const app = express();
        installSecurity(app);
        app.get("/", (_req, res) => res.send("ok"));
        return request(app).get("/").then((res) => String(res.headers["content-security-policy"] || ""));
    } finally {
        process.env = previous;
    }
}

/** Extract one directive's source list from a CSP header. */
function directive(policy: string, name: string): string {
    const found = policy.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
    return found || "";
}

describe("CSP allows R2-served uploads", () => {
    // Every directive a redirected upload can be loaded through:
    //   img-src     avatars, chat images, org logos
    //   media-src   <audio>/<video> chat attachments (FilePreview <source src>)
    //   frame-src   PDF/attachment preview iframes
    //   connect-src fetch()/XHR downloads
    it.each(["img-src", "media-src", "frame-src", "connect-src"])(
        "%s includes the R2 upload origin",
        async (name) => {
            const policy = await policyFor({ R2_ACCOUNT_ID: ACCOUNT });
            expect(directive(policy, name)).toContain(`${ACCOUNT}.r2.cloudflarestorage.com`);
        },
    );

    it("allows both virtual-hosted and path-style R2 hosts", async () => {
        const policy = await policyFor({ R2_ACCOUNT_ID: ACCOUNT });
        const img = directive(policy, "img-src");
        expect(img).toContain(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
        expect(img).toContain(`https://*.${ACCOUNT}.r2.cloudflarestorage.com`);
    });

    it("does not widen the policy to every https origin", async () => {
        // A bare `https:` would let a compromised page pull media from anywhere.
        const policy = await policyFor({ R2_ACCOUNT_ID: ACCOUNT });
        expect(directive(policy, "img-src")).not.toMatch(/(^|\s)https:(\s|$)/);
        expect(directive(policy, "media-src")).not.toMatch(/(^|\s)https:(\s|$)/);
    });

    it("omits the R2 origin entirely when R2 is not configured", async () => {
        // Local dev streams uploads from disk through the app, so 'self' is
        // correct and no third-party origin should be introduced.
        const policy = await policyFor({ R2_ACCOUNT_ID: undefined });
        expect(policy).not.toContain("r2.cloudflarestorage.com");
        expect(directive(policy, "img-src")).toContain("'self'");
    });

    it("keeps the existing third-party image sources", async () => {
        const img = directive(await policyFor({ R2_ACCOUNT_ID: ACCOUNT }), "img-src");
        for (const origin of ["'self'", "data:", "blob:", "openstreetmap.org", "giphy.com"]) {
            expect(img).toContain(origin);
        }
    });
});

describe("CSP allows the Cloudflare Web Analytics beacon", () => {
    // Cloudflare injects this script at the edge; it is not in our index.html,
    // so it only appears in production and only as a console error.
    it("permits the beacon script and its telemetry endpoint", async () => {
        const policy = await policyFor({ R2_ACCOUNT_ID: ACCOUNT });
        expect(directive(policy, "script-src-elem")).toContain("static.cloudflareinsights.com");
        expect(directive(policy, "script-src")).toContain("static.cloudflareinsights.com");
        expect(directive(policy, "connect-src")).toContain("cloudflareinsights.com");
    });
});
