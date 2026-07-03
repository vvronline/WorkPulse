/**
 * SCOPED navigation-claim registry for call surfaces.
 *
 * WHY THIS EXISTS:
 * The legacy guard (src/realtime/callRouting.ts) tracked ONE global
 * `activeKey` shared by every call surface — the 1:1 /call screen, the
 * group-call ring screen, and meeting navigation. Any surface could release
 * (or overwrite) any other surface's claim:
 *   • a group ring timing out called the global endCallNavigation() and
 *     silently released a LIVE 1:1 call's claim → the "Return to call"
 *     banner re-appeared over an active call, and a second navigation path
 *     could re-push the /call fullScreenModal → fatal Fabric double-mount
 *     ("child already has a parent") — the "call UI disappears but voice
 *     keeps going" bug;
 *   • a leaked claim (surface dismissed via a path that skipped its cleanup)
 *     permanently blocked the NEXT incoming call's navigation.
 *
 * This registry fixes the entire bug class BY CONSTRUCTION:
 *   1. Claims are scoped per SURFACE ("p2p" | "groupRing" | "meeting") —
 *      a group ring can never hold, block, or release a p2p claim.
 *   2. `claim()` returns an OWNER TOKEN; only the holder of that exact token
 *      can release the claim. A late/stale release from an old surface is a
 *      no-op instead of clobbering a fresh claim.
 *
 * The legacy callRouting API is re-implemented on top of this registry (see
 * src/realtime/callRouting.ts) so existing call-sites keep working unchanged
 * while new code migrates to the scoped API.
 */

export type CallSurface = "p2p" | "groupRing" | "meeting";

/** Opaque owner token returned by claim(); required to release. */
export type ClaimToken = {
  readonly surface: CallSurface;
  readonly key: string;
  readonly id: number;
};

type ActiveClaim = { key: string; id: number };

let nextId = 1;
const active = new Map<CallSurface, ActiveClaim>();

// Subscribers notified whenever the p2p surface's claim is released via the
// legacy endCallNavigation() path (the OngoingCallBanner uses this to clear
// itself on local hang-up — the server does not echo `call_ended` back to the
// party that ended the call).
type EndListener = () => void;
const endListeners = new Set<EndListener>();

/** Subscribe to p2p call-end (claim release) events. Returns unsubscribe. */
export function onClaimReleased(listener: EndListener): () => void {
  endListeners.add(listener);
  return () => {
    endListeners.delete(listener);
  };
}

function notifyReleased(): void {
  for (const listener of endListeners) {
    try {
      listener();
    } catch {
      // A misbehaving listener must not prevent the others from running.
    }
  }
}

export function keyFor(
  callId: number | string,
  conversationId: number | string,
): string {
  return `${conversationId}:${callId}`;
}

/**
 * Attempt to claim navigation for a call on a given surface. Returns an
 * owner token when the claim succeeded, or null when that surface is already
 * claimed for this call (the caller must NOT navigate again).
 *
 * NOTE: a claim on one surface does not block another surface — the p2p call
 * screen and a group ring for a DIFFERENT call may coexist. Blocking rules
 * between surfaces (e.g. "busy on another call") are the server's job.
 */
export function claim(
  surface: CallSurface,
  callId: number | string | undefined | null,
  conversationId: number | string | undefined | null,
): ClaimToken | null {
  if (callId == null || conversationId == null) return null;
  const key = keyFor(callId, conversationId);
  const existing = active.get(surface);
  if (existing && existing.key === key) return null; // already claimed
  const id = nextId++;
  active.set(surface, { key, id });
  return { surface, key, id };
}

/**
 * Release a claim — ONLY if the token still owns it. A stale token (the
 * surface was superseded by a newer claim) is a safe no-op.
 */
export function release(token: ClaimToken | null | undefined): void {
  if (!token) return;
  const existing = active.get(token.surface);
  if (!existing || existing.id !== token.id) return; // superseded — no-op
  active.delete(token.surface);
  if (token.surface === "p2p") notifyReleased();
}

/** True if the given surface currently holds a claim for the given call. */
export function isClaimed(
  surface: CallSurface,
  callId?: number | string,
  conversationId?: number | string,
): boolean {
  const existing = active.get(surface);
  if (!existing) return false;
  if (callId == null || conversationId == null) return true;
  return existing.key === keyFor(callId, conversationId);
}

/**
 * Release the surface's claim ONLY when it belongs to the given call. Used
 * where the claim crosses a navigation boundary (claimed by a listener,
 * released by the screen it navigated to) and the owner token cannot be
 * passed through route params. Scoped by (surface, call) so it can never
 * clobber another surface's or another call's claim.
 */
export function releaseIfClaimed(
  surface: CallSurface,
  callId: number | string | undefined | null,
  conversationId: number | string | undefined | null,
): void {
  if (callId == null || conversationId == null) return;
  const existing = active.get(surface);
  if (!existing || existing.key !== keyFor(callId, conversationId)) return;
  active.delete(surface);
  if (surface === "p2p") notifyReleased();
}

/**
 * LEGACY-compat release: drop the surface's claim regardless of owner.
 * Only the legacy callRouting adapter should use this; new code must hold a
 * token and use release().
 *
 * NOTE: for the p2p surface the listeners are notified UNCONDITIONALLY —
 * matching the historical endCallNavigation() contract, which some callers
 * (e.g. the decline path clearing the OngoingCallBanner) rely on even when
 * no claim was held.
 */
export function forceRelease(surface: CallSurface): void {
  active.delete(surface);
  if (surface === "p2p") notifyReleased();
}

/** Test helper: reset all state. */
export function _resetForTests(): void {
  active.clear();
  endListeners.clear();
  nextId = 1;
}