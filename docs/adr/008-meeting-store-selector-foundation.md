# ADR-008 — MeetingStore: zero-dependency selector foundation (Phase 4)

**Status**: Accepted, foundation layer of Phase 4. Adoption in `useMeetingState` is intentionally deferred and tracked separately.
**Date**: 2026-05-26
**Related**: ADR-002 (chat reliability — messagesCache), ADR-003 (Resilience Pack), ADR-007 (WS idempotency).

---

## Context

`useMeetingState` is now the central nervous system of the meeting page.
It owns ~25 separate `useState` values + ~15 callbacks. Every consumer
that imports the hook re-renders on every state change, because React
has no way to know that `MeetingChat` doesn't care when `activeSpeakerId`
ticks 3 times per second.

Concrete render-cost incidents (measured with React profiler):

- The local audio-level publisher updates `audioLevelsRef` 5×/s; even
  though it's a ref, the parent component's render cycle still fires
  because the FSM-driven `connectionBanner` recomputes every render.
- A typing-in-chat keystroke triggers `setMessages([...])`, which in
  turn re-renders the participant grid (all 9+ tiles), the bottom bar,
  and the timer pill — all of which have no logical dependency on the
  chat array.
- `participants` is a `Map`; we already create a new Map on every
  add/change to force React to re-render, but that means **every**
  field on **every** tile rebuilds even when only one peer's
  `videoOff` flipped.

The original roadmap called for **Zustand**. We deliberately chose a
zero-dependency hand-rolled equivalent — see "Why not just install
Zustand" below — but the **contract is intentionally Zustand-shaped**
so adoption is a search-and-replace away if/when the surface grows
beyond what one file should own.

---

## Decision

Ship **the store foundation only** (and its tests) in this ADR. Wiring
it through `useMeetingState` is deferred to a focused follow-up ADR so
each step has a small, reviewable blast radius.

### 1. `client/src/pages/meeting/meetingStore.js` (new, ~165 LoC)

```js
import { createMeetingStore, shallowEqual, DEFAULT_MEETING_STATE } from './meetingStore';

const useMeetingStore = createMeetingStore({ ...DEFAULT_MEETING_STATE });

// React subscriber (selector-based — re-renders ONLY when the selected value changes)
const muted = useMeetingStore(s => s.muted);

// One-shot read (no subscription)
const { messages } = useMeetingStore.getState();

// Mutate (shallow merge, same semantics as React setState)
useMeetingStore.setState({ muted: true });
useMeetingStore.setState(prev => ({ count: prev.count + 1 }));

// Imperative subscribe (for refs / non-React consumers)
const unsub = useMeetingStore.subscribe(state => { /* … */ });
```

Implementation uses **`useSyncExternalStore`** so it is Concurrent
Mode-safe and immune to the "store update during render" tearing class
of bugs. The selector + equality-fn pair is identical to Zustand's
v4/v5 API.

### 2. `shallowEqual` helper

Saves a re-render when a selector returns a structurally identical
object/array but a new reference (the canonical Zustand selector
escape hatch).

### 3. `DEFAULT_MEETING_STATE` shape contract

`Object.freeze`'d. Mirrors every public state field returned by
`useMeetingState`. A unit test asserts every expected key is present
so a future "I added a state field to the hook but forgot the store"
fails loudly.

### Why ship the foundation alone (no consumer wiring yet)?

Three reasons:

1. The store is intrinsically valuable as a primitive even before any
   consumer adopts it — other panels (admin tools, settings dialog)
   can use it for fast-path subscriptions immediately.
2. The wiring into `useMeetingState` requires changing every `useState`
   into a paired `useState` + `useStore.setState`, then auditing every
   consumer to choose which fields they want to subscribe to. That's a
   large, mechanical change with a real risk of regressing render
   behaviour — better as its own ADR with its own test pass.
3. Lock the shape contract NOW so any subsequent state-field addition
   has to update both places — catching the "out of sync" failure mode
   before it can land.

### Why not just install Zustand?

- **Bundle size**: Zustand is ~3 KB gzip *and* pulls in
  `use-sync-external-store` shim (~1.5 KB). Our hand-rolled module is
  ~1 KB and uses the native React 18+ `useSyncExternalStore` directly.
- **Surface area**: Zustand exposes vanilla stores, middleware
  (immer, persist, subscribeWithSelector, devtools), and a separate
  `react` / `vanilla` export split. The meeting store is single-meeting
  scoped behind a React-only consumer — none of the extras pay rent.
- **Reading the code**: A new contributor can `cat meetingStore.js` and
  understand the whole thing in 30 seconds. Zustand requires you to
  know the v4-vs-v5 migration history to read the README.
- **Future swap is cheap**: if we ever genuinely need devtools /
  vanilla / persist / immer, the Zustand swap is a textual replace
  (the API surface is identical).

---

## Consequences

### Positive

- **Selector-based subscriptions** stop the "one state change re-renders
  the world" pattern. Every consumer can plug into exactly the slice
  it cares about.
- **Zero new runtime deps**. Tiny, easy to audit.
- **Concurrent-safe via `useSyncExternalStore`** — no tearing risk.
- **Shape contract locked**: a unit test fails on the day a field is
  added to one place but not the other.
- **Adoption is incremental**: components can opt in one slice at a
  time without breaking other consumers; the original hook keeps
  working until the store has every field.

### Negative

- **Adoption hasn't happened yet** — the rendering speedup isn't
  realised until follow-up wiring lands. The Phase 4 roadmap entry
  is intentionally split so this ADR ships a small, reviewable thing.
- **No middleware story** (immer, persist, devtools). If we ever need
  one of those, the swap to Zustand is straightforward (~1 line per
  store import); if we end up needing two of them we should
  reconsider the build-vs-buy.
- **Hand-rolled = we own the bugs**. The implementation is 60 LoC of
  trivial code with 15 tests, so the surface is small, but it's still
  one more thing for the team to maintain.

### Neutral

- Bumped client test count from 103 → 118 (+15 tests across imperative
  API, hook surface with selectors, `shallowEqual` edge cases, and
  the shape contract).
- Server test count unchanged — this is a client-only addition.

---

## Out of scope (next ADR)

- **Wire `useMeetingState` to publish into the store on every
  `setState`**. The hook stays as-is; we just add `useMeetingStore.setState({
  muted: next })` next to every existing `setMuted(next)` call.
- **Migrate `MeetingChat`, `ParticipantTile`, `MeetingBottomBar`,
  `MeetingParticipants`** off the hook destructure and onto
  `useMeetingStore(s => s.X)` selectors. Pick the high-render-cost
  components first.
- **Drop the messagesCache module** once `messages` lives in the
  store (the cache duplicates what a stable store reference already
  provides).
- **Swap to Zustand** if we ever want middleware.

---

## Files changed

- `client/src/pages/meeting/meetingStore.js` — **new** (~165 LoC).
  `createMeetingStore`, `shallowEqual`, `DEFAULT_MEETING_STATE`.
- `client/src/__tests__/meetingStore.test.jsx` — **new**, 15 tests
  across 4 describe blocks: imperative API, React hook with selectors,
  `shallowEqual` edge cases, shape contract.

## Test summary

```
server:  Test Suites: 33 passed, 33 total | Tests: 418 passed, 418 total  (unchanged)
client:  Test Files:  16 passed, 16 total | Tests: 118 passed, 118 total  (103 → +15)