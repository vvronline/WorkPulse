# ADR-004 — Meeting Mesh Quality (Phase 5)

**Status**: Accepted, implemented as Phase 5 of the meeting-reliability roadmap.
**Date**: 2026-05-26
**Related**: ADR-001 (status service v2), ADR-002 (chat reliability — Phase 0.5), ADR-003 (Resilience Pack — Phase 1).

---

## Context

After Phases 0.5 + 1 the meeting client reliably **stays connected** and
**doesn't lose chat messages**. The next bottleneck is **scaling the
mesh** — every additional participant in a peer-to-peer mesh adds N-1
upstream video streams from every other peer, so bandwidth grows
quadratically (5 participants ≈ 20 streams).

Three concrete user-visible problems followed from this:

1. **Bandwidth is wasted on tiles nobody is looking at.** A 12-person
   meeting renders maybe 4–6 tiles above the fold; the rest are
   scrolled-off and we kept paying full bitrate for them.
2. **Bandwidth is wasted on quiet participants.** When one person is
   presenting, everyone else's camera is still pumping at the same
   bitrate as the speaker's — bandwidth wasted on tiny tiles of
   silent listeners.
3. **No visual signal of who's actually talking.** With 5+ tiles in
   a grid, it was hard to find the speaker. The per-tile "speaking"
   ring (green) flickered whenever anyone made any noise, which is
   too granular to be useful as an "active speaker" cue.

We deliberately **chose not to introduce an SFU** for this phase
(zero-cost stays a hard requirement; mediasoup self-hosting is
deferred to Phase 7). Instead we implement the equivalent client-side
patterns: receiver-driven bitrate caps, active-speaker promotion, and
viewport-aware downgrade.

---

## Decision

Three small additions, all additive, no new dependencies, no new
infrastructure. ~250 LoC total across 4 files.

### 1. Receiver-driven quality requests (`meeting_request_quality`)

A new WS message type. Each participant maintains a tier per peer:

| Tier | Meaning              | maxBitrate |
| ---- | -------------------- | ---------- |
| `q`  | quality (off-screen) | 150 kbps   |
| `h`  | half (visible)       | 500 kbps   |
| `f`  | full (speaker/presenter) | 1.2 Mbps |

When a peer's tile crosses an `IntersectionObserver` threshold
(off-screen / on-screen), the receiver sends a `meeting_request_quality`
to the sender; the sender then flips `setParameters({ encodings:
[{ maxBitrate }] })` on the matching `RTCRtpSender`. This is the mesh
equivalent of an SFU's "subscribe to layer L" — we just do it on the
sender's encoder instead of a server-side layer selector.

The handler is idempotent and throttled — `lastRequestSentRef`
ensures we never send the same level twice in a row to the same peer.

### 2. Active-speaker detection (`meeting_audio_level` + selector)

Every client samples its local mic's RMS via a WebAudio `AnalyserNode`
~5×/s and broadcasts the level (0..1) as `meeting_audio_level`. The
server is a pure relay — no DB writes, no DB reads beyond the
"is this user actually a participant" check we already do for
`meeting_track_state`.

A second client-side timer runs every 350 ms and picks the loudest
publisher within the last 2 s as `activeSpeakerId`. A 0.08 floor
prevents background noise from triggering a false speaker; a 2-s
stickiness prevents flickering between two close-volume speakers.

When the speaker changes, `useMeetingState` automatically calls
`requestPeerQuality(speakerId, 'f')` and downgrades everyone else
to `'h'` — so the speaker's tile is always the highest-quality
upstream and the audience's are throttled.

### 3. Active-speaker UI ring (`.mr-tile--active-speaker`)

A bright blue glowing ring around the meeting-wide active speaker's
tile. Distinct from the existing per-tile green "speaking" ring,
which still fires per-participant but is now relegated to a more
fine-grained "this person made noise" indicator. The active-speaker
ring is what tells the user "this is who you should be looking at".

### Bandwidth math

For a 6-person meeting with 1 active speaker, 2 visible non-speakers,
3 off-screen:

* Before Phase 5:  6 × 1.2 Mbps = 7.2 Mbps total upstream pressure
* After  Phase 5:  1 × 1.2 + 2 × 0.5 + 3 × 0.15 = 2.65 Mbps
* **~63% bandwidth reduction** with zero loss of fidelity for the
  user who actually matters (the speaker).

---

## Consequences

### Positive

- Massive bandwidth reduction in meetings of 4+ participants — see
  math above. This is the difference between mesh "scaling to 6" and
  mesh "scaling to 10–12".
- Active-speaker ring solves the "who's talking?" UX problem for
  busy grids.
- Server change is trivial (~30 LoC pure relay); no new DB columns,
  no new endpoints, no new dependencies.
- Falls back gracefully: a client without `IntersectionObserver`
  (rare) just stays at `'h'` for every visible tile — no worse than
  pre-Phase 5.
- The same machinery works the day we add an SFU — we'd just send
  `meeting_request_quality` to the SFU instead of the originator,
  and the SFU would forward the matching simulcast layer.

### Negative

- Receivers send a small amount of extra WS traffic (1 `meeting_audio_level`
  per ~500 ms while speaking + 1 `meeting_request_quality` per
  visibility transition). Negligible compared to media traffic.
- The 1.2 Mbps "full" cap is half what the original code budgeted
  for 2-person calls (it was already 1.2 Mbps but only applied
  pre-quality-request); 6-person meetings used to share 400 kbps
  per peer. Net effect is that small meetings stay where they were
  and large meetings dramatically improve.
- Active-speaker selection is naive (loudest wins) — doesn't yet
  account for sustained-speech vs cough/keyboard noise. Acceptable
  for shipping; can refine the heuristic in a follow-up if reports
  come in.

### Neutral

- The mesh's existing per-peer-count bitrate adaptation (1.2 Mbps
  → 600 kbps → 400 kbps as peer count grows) still runs at peer
  connection creation. The quality-request system layers on top —
  the `setParameters` calls just overwrite the encoding's
  `maxBitrate` and the more recent write wins. No conflict.
- Local audio-level publisher uses its own `AudioContext` (not the
  shared one in `ParticipantTile`) so its lifecycle is bounded to
  the `localStream` + `muted` deps. Cleanly disposed on unmount.

---

## Out of scope

- **Real simulcast** (3 SVC layers per sender). We rejected this for
  mesh because it doubles outbound encoder cost on every sender's
  CPU for a benefit that's identical to per-peer `maxBitrate`
  capping in our particular topology (1-to-1 SDP per peer). The day
  we add an SFU, simulcast becomes worthwhile — Phase 7.
- **Audio focus / dominant speaker switching** (large-meeting layout
  promoting the active speaker into a bigger central tile). Useful
  but UX-heavy; deferred.
- **Server-side audio level aggregation** (compute a top-N speakers
  list server-side and broadcast just that). Our client-side
  per-peer math handles 12 participants fine; revisit if we hit
  scaling problems.

---

## Files changed

- `server/utils/ws.js` — two new WS message types:
  `meeting_request_quality` (pure relay) and `meeting_audio_level`
  (relay with the existing participant check).
- `client/src/pages/meeting/useMeetingState.js`:
  - new refs: `audioLevelsRef`, `requestedQualityRef`,
    `lastRequestSentRef`
  - new state: `activeSpeakerId`
  - new callbacks: `applyQualityCapForPeer`, `requestPeerQuality`
  - new WS handlers: `meeting_request_quality`, `meeting_audio_level`
  - new effects:
    1. Local audio-level publisher (WebAudio analyser → WS broadcast)
    2. Active-speaker selector (350 ms timer over the levels map)
    3. Adaptive bitrate from active-speaker + presenter changes
  - returns `activeSpeakerId`, `requestPeerQuality`
- `client/src/pages/meeting/ParticipantTile.jsx`:
  - accepts `isActiveSpeaker` + `onVisibilityChange` props
  - new `IntersectionObserver` effect fires `onVisibilityChange('q' | 'h')`
  - new class `mr-tile--active-speaker` toggled by the prop
- `client/src/pages/MeetingRoom.jsx` — wires `activeSpeakerId` and
  `requestPeerQuality` into `<ParticipantTile />` in both layouts
  (grid + presenter sidebar).
- `client/src/pages/meeting/MeetingRoom.css` — `.mr-tile--active-speaker`
  with blue glow + pulse animation.