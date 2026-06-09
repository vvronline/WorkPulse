/**
 * Thin wrapper over the v2 status REST endpoints.
 *
 * INVARIANTS:
 *   • Only this file makes HTTP calls to /api/me/status*.
 *   • The shape of the returned payload matches the server resolver
 *     output verbatim — see server/services/status/index.js → toPayload.
 *
 * We intentionally do NOT import the existing `client/src/api.js` axios
 * instance from inside `StatusContext.jsx` directly; this thin layer lets
 * tests stub the network without monkey-patching axios.
 */

import API from "../api";
import type { ManualStatus, PresencePreference } from "./constants";

export interface SetMyStatusBody {
    status: ManualStatus | null;
    message?: string | null;
    messageExpiresAt?: string | null;
}

/** GET /api/me/status — fetch the resolved effective state for the current user. */
export const getMyStatus = () => API.get("/me/status");

/**
 * PUT /api/me/status — set manual status (or clear by passing status=null).
 */
export const setMyStatus = (body: SetMyStatusBody) => API.put("/me/status", body);

/** PUT /api/me/status/presence-preference  body: { preference: 'auto' | 'invisible' } */
export const setPresencePreference = (preference: PresencePreference) =>
    API.put("/me/status/presence-preference", { preference });

/** POST /api/me/status/activity-ping — refreshes last_activity_at (no broadcast). */
export const sendActivityPing = () => API.post("/me/status/activity-ping");