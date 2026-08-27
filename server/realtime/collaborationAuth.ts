/** Cookie/origin policy for the collaboration WebSocket upgrade. */
import * as cookie from "cookie";

/** Prefer protocol/native token; browser auth falls back to HttpOnly cookie. */
function resolveCollaborationToken(
    token: string | null | undefined,
    cookieHeader: string,
): string | null {
    return token || cookie.parse(cookieHeader || "").token || null;
}

/** Same origin policy as the primary /ws server. */
function isCollaborationOriginAllowed(
    origin: string | undefined,
    host: string | undefined,
): boolean {
    if (!origin) return true;
    if (host && (origin === `https://${host}` || origin === `http://${host}`)) return true;
    if (origin.startsWith("workpulse://") || origin.startsWith("aino://")) return true;
    if ((process.env.CORS_ORIGIN || "").split(",").map((v) => v.trim()).includes(origin)) return true;
    return process.env.NODE_ENV !== "production"
        && [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:5173",
            "http://localhost:5000",
        ].includes(origin);
}

export { resolveCollaborationToken, isCollaborationOriginAllowed };