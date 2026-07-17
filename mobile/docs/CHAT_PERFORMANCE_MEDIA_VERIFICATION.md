# Mobile Chat Performance and Media Verification

Use this checklist on both Android and iOS development builds after changing chat navigation, message virtualization, media dimensions, or fullscreen viewers.

## Prerequisites

- Use a development build containing the current native dependencies.
- Sign in to an account with at least two populated conversations.
- Prepare messages containing:
  - portrait image;
  - landscape image;
  - square image;
  - portrait video;
  - landscape video;
  - legacy image/video without `metadata.width` and `metadata.height`;
  - view-once image;
  - forwarded image or video.
- Keep one media-heavy conversation with at least 50 recent messages.

## Chat opening

### Warm cache

1. Open the chat list.
2. Open a populated conversation and return to the list.
3. Repeat across at least six different conversations.
4. Reopen the first conversation.

Pass criteria:

- Navigation starts immediately after the row press.
- The destination header and cached messages paint during the native transition.
- No progressively increasing delay occurs after repeated opens.
- No duplicate thread is pushed by a rapid double tap.
- Returning to the list does not leave a row highlighted.
- The newest message remains pinned above the composer.

### Cold cache

1. Clear application data or use a conversation never opened on the device.
2. Open the conversation from the list.
3. Repeat from a message notification/deep link.

Pass criteria:

- The route opens immediately and shows one stable loading state.
- The header does not flash incorrect peer information when route identity is available.
- Messages appear once without staged bottom-to-top row animations.
- The background reconciliation does not visibly shift the list.

## Media dimensions

For each portrait, landscape, square, and very tall image/video:

1. Send the media.
2. Observe the optimistic message through upload completion.
3. Receive the same media on a second account/device.
4. Leave and reopen the conversation.
5. Restart the app and reopen it.

Pass criteria:

- The bubble uses its final aspect ratio from its first visible frame.
- Upload completion does not resize the bubble.
- REST reconciliation does not resize the bubble.
- Reopening the conversation does not resize the bubble.
- Portrait media is not initially shown as a landscape 4:3 box.
- Message rows around the media do not jump.

### Legacy media

1. Open an older media message without server dimension metadata.
2. Allow its dimensions/poster to resolve.
3. Leave and reopen the conversation.
4. Restart the app and reopen it.

Pass criteria:

- The legacy item may resolve once on its first-ever view.
- Every subsequent render uses the persisted dimensions synchronously.
- Dimension-cache storage remains bounded after viewing more than 300 unique items.

### Forwarded media

1. Forward portrait and landscape media to another conversation.
2. Open the destination conversation on sender and recipient devices.

Pass criteria:

- Forwarded messages preserve the original aspect ratio.
- The destination bubble does not perform a 4:3-to-final-size transition.

## Fullscreen image viewer

Test uncached remote, cached remote, local optimistic, offline cached, and view-once images.

Pass criteria:

- The stable dark backdrop appears immediately.
- A loader is shown only while the image is unresolved.
- No white, transparent, or black flash occurs.
- The decoded image fades in once over approximately 140 ms.
- The image source does not change and decode a second time while visible.
- Pinch, pan, double-tap, single-tap dismiss, and close button work.
- A failed image displays an error instead of an empty viewer.

## Fullscreen video viewer

Test local and remote portrait/landscape videos.

Pass criteria:

- The bubble poster remains visible when fullscreen opens.
- The native player does not expose a black decoder shutter.
- The poster stays mounted until `onFirstFrameRender`.
- The poster cross-fades to the first video frame over approximately 160 ms.
- Controls, scrub, close, and replay work.
- Opening fullscreen does not resize the message bubble after returning.

## Offline media

1. View an image and play a video while online.
2. Close the viewer.
3. Disable network access.
4. Reopen both media items.

Pass criteria:

- Cached image opens from its local file without auth/network delay.
- Cached video plays through the Expo video cache.
- No authenticated remote request is required for the cached image.
- The bubble dimensions remain stable offline.

## View-once media

1. Send a view-once image with known dimensions.
2. Open it as the recipient.
3. Close it and attempt to open it again.

Pass criteria:

- The access request completes before protected media is shown.
- The viewer uses the same stable loading/reveal behavior.
- The recipient cannot reopen consumed media.
- The sender retains the intended sender-side behavior.
- Width/height metadata remains present alongside `viewOnce` and `viewedBy`.

## Automated gates

Run before release:

```powershell
cmd /c mobile\node_modules\.bin\tsc.cmd -p mobile\tsconfig.json --noEmit --pretty false
npm --prefix server run typecheck
npm --prefix server test -- --runInBand
git diff --check
```

Expected results:

- Mobile TypeScript: no diagnostics.
- Server TypeScript: no diagnostics.
- Server Jest: all suites pass.
- Git diff check: no whitespace errors.