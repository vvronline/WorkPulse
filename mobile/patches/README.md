# patches/

These patches are applied automatically on `npm install` via `patch-package`
(see the `postinstall` script in `package.json`).

## `react-native-webrtc+124.0.7.patch` — true rounded corners for the self-view

### Why

`RTCView` renders Android video through a `SurfaceViewRenderer`, i.e. a
`SurfaceView`. A `SurfaceView` is composited on a **separate hardware overlay**
outside the normal view hierarchy, so a parent's `borderRadius` /
`overflow: "hidden"` **cannot clip it** — you get the classic "rounded border
inside a square video" artefact on the floating self-preview. This is a
long-standing, well-documented WebRTC/Android limitation; no JS-only trick
(SVG mask, `clipPath`, `setClipToOutline`, …) can fix it.

### What the patch adds (purely additive — nothing existing is changed)

- `TextureViewRenderer.java` — a `TextureView`-backed WebRTC renderer. A
  `TextureView` is an ordinary in-hierarchy view, so it honours the parent's
  rounded clip. (Java port of GetStream's `VideoTextureViewRenderer`, Apache-2.0.)
- `RTCTextureView.java` + `RTCTextureViewManager.java` — a new native view
  (`RTCTextureView`) exposing the same props as `RTCVideoView`
  (`streamURL` / `mirror` / `objectFit` / `zOrder`).
- `WebRTCModulePackage.java` — registers the new view manager **alongside** the
  default `RTCVideoViewManager`, which is left untouched. Remote and full-screen
  video keep their more efficient `SurfaceView` rendering; only the small,
  rounded self-view tile uses the TextureView.

### JS usage

`src/components/call/RTCTextureView.tsx` exports `RoundedSelfView`, which uses the
native `RTCTextureView` on Android (when registered) and transparently falls back
to the stock `RTCView` on iOS or if the patch hasn't been applied yet — so the
call never breaks, it just keeps square corners in that fallback case.

### Applying / verifying

```sh
npm install          # runs patch-package via postinstall
npx expo run:android # or an EAS build — native code must be recompiled
```

A JS-only reload is **not** enough; the native module must be rebuilt.
