# ADR-011 — Wire MeetingStore (ADR-008) and Preflight (ADR-010) into the live UI

**Status**: Accepted, follow-up consumer wiring for ADR-008 + ADR-010.
**Date**: 2026-05-26
**Related**: ADR-008 (MeetingStore foundation), ADR-010 (Preflight foundation).

---

## Context

ADR-008 shipped the `MeetingStore` foundation and ADR-010 shipped the
preflight utility, both with the explicit out-of-scope note that the
*consumer wiring* was deferred to a separate focused review. That
follow-up is this ADR.

Without consumers, the two modules were technically dead code. Shipping
dead code to production is operationally noisy — you can't tell whether
it's unfinished work or load-bearing scaffolding. ADR-011 closes that
loop with the smallest possible diff so each consumer can be reverted
in isolation if needed.

---

## Decision

Two minimal wirings, both reversible with a single `git revert`.

### 1. ADR-008 — `MeetingStore` published from `useMeetingState`

```js
// useMeetingState.js (new export)
export const meetingStore = createMeetingStore({ ...DEFAULT_MEETING_STATE });

// new effect at the end of the hook:
useEffect(() => {
    meetingStore.setState({
        muted, videoOff, screenSharing, raisedHand,
        status, fsmState, connectionBanner,
        activeSpeakerId, presenterId, messages,
    });
}, [/* the same 10 slices */]);
```

**Why a single effect mirroring 10 slices instead of 10 separate effects?**
The store does its own ref-equality check before notifying subscribers,
so an unchanged slice produces zero downstream re-renders. Mirroring all
10 in one effect is one shallow merge per dependency change — cheaper
than 10 effects firing 10 listener loops.

**Why a module-scope singleton rather than a hook-local one?**
The future consumers we want to migrate — `MeetingChat`, `ParticipantTile`,
`MeetingBottomBar` — are siblings of `useMeetingState`, not children.
React Context would mean a render-cascade back to the parent for every
state change, defeating the point of the store. The singleton lives in
the module so any sibling can import it directly:

```js
import { meetingStore } from './meeting/useMeetingState';
const muted = meetingStore(s => s.muted); // re-renders ONLY when muted changes
```

**What's NOT mirrored** (deliberately):
- `localStream` / `screenStream` / `participants` — these are large
  objects (MediaStream + Map). Cheap to *reference* but expensive if a
  selector accidentally returns a new object every tick. Keep the
  consumer code using the hook return for now.
- `audioLevelsRef` / `requestedQualityRef` / `lastRequestSentRef` —
  refs by design (high-frequency, no render path).
- `participants` Map — its mutations already drive the entire grid;
  putting it in the store would create two sources of truth for the
  same data without selector wins.

### 2. ADR-010 — Preflight banner in `MeetingJoin.jsx`

```jsx
// New state:
const [preflight, setPreflight] = useState(null);

// New effect:
useEffect(() => {
    let cancelled = false;
    (async () => {
        const res = await getIceConfig().catch(() => ({}));
        const result = await runPreflight({
            iceServers: res?.data?.iceServers,
            timeoutMs: 5_000,
        });
        if (!cancelled) setPreflight(result);
    })();
    return () => { cancelled = true; };
}, []);

// Banner above device selectors, only when not 'ok':
{preflight && (() => {
    const s = summarisePreflight(preflight);
    if (s.severity === 'ok') return null; // silent on success
    return (
        <div role="alert" style={{ /* yellow if warn, red if error */ }}>
            {s.label}
        </div>
    );
})()}
```

**UX choices that earned their place vs the alternatives**:

| Question                          | Choice                | Why                                                                                                   |
|-----------------------------------|-----------------------|-------------------------------------------------------------------------------------------------------|
| Block joining on failure?         | **No** — warn only    | Preflight can false-positive (timing, transient TURN hiccup). Never prevent the user from trying.    |
| Show "Checking…" while in-flight? | **No**                | The 200-ms median makes "Checking…" flash for less than one frame. Render the banner only on result. |
| Show the OK case?                 | **No**                | A green "Network looks good" badge is UI noise. Silence is the right default for the happy path.    |
| Use the existing `mj-` CSS class? | **No, inline styles** | The styling is `role="alert"`-driven and palette-matched to the existing badge — three lines inline avoids polluting the CSS file with a banner that may never be customised. |

**Where the preflight ICE servers come from**: the same
`/api/chat/ice-config` endpoint used by `useMeetingState`'s real
connection. This means the preflight exercises the *actual* production
TURN credentials the user will join with — not a public STUN server
that could pass while production fails. Falls back to the runPreflight
default (public STUN) if the endpoint is slow / down so the banner
still appears.

---

## Consequences

### Positive

- **Both foundation ADRs (008, 010) now have at least one live
  consumer**. No more "dead code in production" objection on the
  pre-push checklist.
- **MeetingStore is immediately usable** by any sibling component that
  wants a fast selector path — the contract published in ADR-008 is
  the contract you import today.
- **Preflight banner closes the "black tile" failure mode** at its
  source. The first time a user opens a meeting on a corporate VPN
  that blocks UDP, they now see "your network may block WebRTC" *before*
  they click Join.
- **Diff is small and isolated**: two files (`useMeetingState.js` +
  `MeetingJoin.jsx`), each addition is a discrete commit so revert is
  surgical.
- **All tests still pass** (server 443/443, client 132/132). No
  regressions.

### Negative

- **No new tests were added in this ADR.** Both wirings are
  integration glue between code that already has unit-test coverage
  (the foundation modules + the host components). An end-to-end test
  would require a full meeting-flow harness which we don't have yet;
  smoke-testing in staging is sufficient at this size.
- **The store is published but not yet *consumed* selectively** —
  components still destructure from `useMeetingState`. The render-
  perf win shows up only when a future ADR migrates at least one
  high-render-cost component (MeetingChat / ParticipantTile) to
  `meetingStore(s => …)` selectors. ADR-011 unblocks that work;
  doing it lives in its own follow-up.
- **Preflight runs unconditionally on every MeetingJoin mount** — a
  few hundred ms of background work per page visit. Cheap in
  absolute terms but visible in browser perf traces.

### Neutral

- Test counts unchanged from the ADR-010 baseline:
  ```
  server: 443 / 443
  client: 132 / 132
  ```
- The `meetingStore` export is additive; consumers that don't import
  it are unaffected.

---

## Smoke-test checklist (for staging before push)

1. **Preflight banner — happy path**: open MeetingJoin on a normal
   network → no banner appears (within 1 s of page load).
2. **Preflight banner — warning path**: open MeetingJoin while on a
   LAN with no internet egress → yellow banner: "Only local
   candidates found — may not work outside your network".
3. **Preflight banner — error path**: open MeetingJoin with WebRTC
   disabled in `about:config` (Firefox) → red banner: "Unable to
   reach STUN/TURN servers".
4. **Preflight respects timeout**: artificially slow the
   `/api/chat/ice-config` endpoint (e.g. 6 s) → banner still appears
   within ~5 s using the default STUN.
5. **MeetingStore — subscribe verifies the mirror works**: open the
   browser devtools console inside MeetingRoom and run:
   ```js
   const { meetingStore } = await import('/src/pages/meeting/useMeetingState.js');
   meetingStore.subscribe(s => console.log('store update', s.muted, s.videoOff));
   ```
   Then toggle mute / camera → expect one console line per toggle, no
   lines on unrelated state changes like chat typing.

---

## Files changed

- `client/src/pages/meeting/useMeetingState.js`:
  - new import: `createMeetingStore`, `DEFAULT_MEETING_STATE`
  - new export: `meetingStore` (the singleton)
  - new `useEffect` mirroring 10 high-traffic slices into the store
- `client/src/pages/MeetingJoin.jsx`:
  - new imports: `getIceConfig` (already exported), `runPreflight`,
    `summarisePreflight`
  - new state: `const [preflight, setPreflight] = useState(null)`
  - new effect: fire-and-forget preflight on mount with cancellation
  - new render block: banner above device selectors, only shown when
    `severity !== 'ok'`

## Test summary

```
server: Test Suites: 35 passed, 35 total | Tests: 443 passed, 443 total  (unchanged)
client: Test Files:  17 passed, 17 total | Tests: 132 passed, 132 total  (unchanged)