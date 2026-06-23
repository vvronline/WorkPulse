# Picture-in-Picture (PiP) — call window minimize

Android Picture-in-Picture for the WorkPulse call screen, modelled on
**Signal-Android** (`WebRtcCallActivity`). When the user leaves the app during a
live call (Home press / switch to another app) the call shrinks into a floating
OS window that keeps rendering the WebRTC video/audio — replacing the old
"Ongoing call — Return" banner as the primary minimize affordance.

Works for **both video and voice** calls:
- **Video** → the floating tile shows the remote video (9:16 aspect).
- **Voice** → the floating tile shows the peer avatar + name + call timer (1:1).

## How it works (Signal-Android parity)

1. **Manifest** — `withAndroidPip` config plugin adds
   `android:supportsPictureInPicture="true"` to MainActivity and merges
   `screenSize|smallestScreenSize|screenLayout|orientation` into its
   `configChanges` so the OS does NOT recreate the Activity when it resizes into
   the floating window (a recreate would tear down the live WebRTC session).
2. **MainActivity overrides** (injected by the same plugin):
   - `onUserLeaveHint()` → `enterPictureInPictureMode()` when
     `PipModule.isCallActive()` (API 26–30).
   - `onPictureInPictureModeChanged()` → `PipModule.emitPipChanged(isInPip)` so
     JS collapses/restores the call UI.
3. **Native module `PipModule`** (`expo.modules.pip.PipModule`) exposes:
   - `isPipSupported()` — API ≥ 26 + `FEATURE_PICTURE_IN_PICTURE`.
   - `setCallActive(active)` — gate for `onUserLeaveHint`.
   - `setAutoEnter(enabled, w, h)` — API ≥ 31 seamless auto-enter on Home.
   - `enterPip(w, h)` — manual minimize.
   - `onPipModeChanged` event.
4. **Call screen** (`app/call/[conversationId].tsx`) arms PiP while the call is
   `connecting`/`connected`, and on `onPipModeChanged(true)` renders a stripped
   layout (video/avatar only, no controls/badges/sheets). Cleared on teardown.

## iOS

No-op. `isPipSupported()` returns `false` on iOS, so iOS keeps the existing
"Ongoing call — Return" banner. (App-wide WebRTC PiP on iOS requires a separate,
larger `AVPictureInPictureController` native effort.)

## Build requirement

This adds a **native module + manifest changes**, so it needs a custom dev /
EAS build — it will NOT run in Expo Go. After pulling these changes:

```bash
cd mobile
npx expo prebuild --clean   # regenerates android/ with the PiP manifest + MainActivity overrides
npx expo run:android        # or an EAS build
```

The "Return" banner (`src/realtime/OngoingCallBanner.tsx`) is retained as a
fallback for: PiP-unsupported devices, iOS, and the killed/reopened case where
the call screen was fully unmounted (PiP only applies while the screen is still
mounted and merely shrunk).