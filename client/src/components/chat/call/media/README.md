# Call media track (web + Electron)

The call overlay talks to ONE hook, `useCallMediaEngine`, which decides where a
call's media lives and then presents whichever engine won through the same
`{ webrtc, controls }` surface the overlay already consumed. No overlay markup
changed, and the legacy peer-to-peer engine (`../useWebRTC.ts`) is untouched.

```
components/chat/call/index.tsx      overlay (unchanged UI)
  └── useCallMediaEngine            backend selection + lifecycle machine
        ├── mediaSessionClient      GET /api/chat/calls/:id/media-session
        ├── useWebRTC (legacy p2p)  inert unless the server said "p2p"
        └── useLiveKitCall          inert unless the server said "livekit"
              └── livekitEngine     React-free Room ⇄ UI mapping
```

## Rules this module enforces

1. **The server chooses the transport, once per call.** Only an explicit
   `backend: "p2p"` selects the legacy engine. There is no client default and no
   local degrade: every failure (timeout, network, 4xx incl. 404, 5xx, 405/501,
   or a 2xx body without usable credentials) is retried a bounded number of
   times and then **fails call setup**. A client that guessed a transport could
   land on a different plane than its peer, producing a call that looks
   connected and carries no media.
2. **No mid-call fallback.** The verdict is fetched before either engine starts
   and is memoised per call, so a remount cannot flip a live call.
3. **Media never ends a call.** `MediaEngineHandlers` has no end-call channel.
   A dropped SFU socket is at worst `reconnecting`; only WorkPulse
   (`call_ended` / `call_rejected` / `call_busy`) or a local hang-up is terminal.
4. **Terminal state is absorbing.** `callStateMachine` + a serial queue mean a
   late `Connected` / `Reconnected` callback cannot revive an ended call.
5. **Local reject/end are durable.** `durableCallActions` mirrors mobile:
   `clientMsgId`, acknowledged websocket retry with backoff + jitter, and an
   always-run idempotent HTTP confirmation (`POST /api/chat/calls/:id/{reject,end}`).
   On the p2p path `useWebRTC` already emits the frame, so the helper runs with
   `emitSocket: false` — the confirmation is added, never a second emit.
6. **One MediaStream per direction.** `livekitEngine` reconciles track
   membership on a stable instance instead of rebuilding a stream per event, so
   `<video>/<audio>.srcObject` is only re-assigned when tracks actually change.
7. **The SFU path keeps p2p's lifecycle parity.** When `call_accepted` arrives
   for an outgoing call the phase moves to `connecting` exactly once, which
   stops the ringback and swaps the overlay's 35s "No answer" ring timer for the
   30s connect timeout — the same thing `useWebRTC` does in its
   `accepted && !isIncoming` branch. And because our own Room stays healthy when
   the *peer* crashes or loses power, a remote participant count that drops to 0
   after having connected shows `reconnecting` and arms a bounded 30s
   (`NO_PEER_TIMEOUT_MS`) watchdog; the peer's return clears it, and expiry runs
   the ordinary durable hang-up rather than letting media end a call itself.

## Configuration

### Server

The backend verdict comes from `server/services/callMedia.ts`. LiveKit requires
`CALL_MEDIA_BACKEND=livekit`, `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` on the server; without them the route answers `p2p` (or
503), and this client obeys either answer without inventing one.

### Browser

Nothing. `livekit-client` is lazily imported, so p2p-only deployments never
download the SDK chunk.

### Electron

The renderer runs under a Content-Security-Policy, so the SFU's `wss://` +
`https://` origins must be allowed or every desktop call fails while the browser
build works. A packaged app has **no build-time environment**, so this cannot be
env-only — `desktop/cspSources.ts` therefore:

- always allows Railway's service domain (`*.up.railway.app`), where the SFU is
  deployed — the same shape as the hard-coded `API_SERVER` default; and
- **adds** any `LIVEKIT_URL`, `LIVEKIT_ORIGIN` or `VITE_LIVEKIT_URL` value
  (full URL, bare host, or a comma/space separated list) for custom domains,
  self-built installers and `npm start`; a `*.livekit.cloud` host is widened to
  the cloud domain because LiveKit Cloud redirects to region subdomains
  mid-handshake.

It never emits an empty entry. Covered by `client/src/__tests__/desktopCsp.test.ts`.

## Tests

| File | Covers |
| --- | --- |
| `callMediaSession.test.ts` | verdict parsing, bounded retry, never choosing a transport locally |
| `callMediaEngine.test.tsx` | backend selection, failed setup, no mid-call fallback, terminal absorption, durable local actions, capture release, late accept, peer leave/rejoin/timeout |
| `webCallStateMachine.test.ts` | absorbing transitions + serialization |
| `livekitEngineEvents.test.ts` | Room event mapping, capture defaults, stable streams |
| `durableCallActions.test.ts` | retry/backoff, idempotent confirmation, dedupe, p2p HTTP-only mode |
| `callHttpContract.test.ts` | the `/api/chat/...` paths these helpers depend on |
| `desktopCsp.test.ts` | Electron SFU CSP sources |
