import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { AlertTriangle } from "../icons";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

/**
 * FaceCaptureWebView
 * ------------------
 * Renders an embedded WebView that loads @vladmandic/face-api (TensorFlow.js)
 * from the jsDelivr CDN — the SAME library + model set used by the web app
 * (`client/src/utils/faceApi.ts`). This guarantees the 128-float descriptor
 * extracted here is directly comparable on the server with descriptors
 * enrolled / verified from the web client (`server/utils/face.compareDescriptors`).
 *
 * Flow:
 *   1. WebView opens the front camera via getUserMedia and shows a live preview.
 *   2. When `autoCapture` is on, a lightweight detector polls the live video
 *      (~2x/sec) and automatically captures once a face has been steadily in
 *      frame — no button press needed (mirrors the web client's FaceCapture
 *      autoCapture behaviour). The manual button remains as a fallback.
 *   3. On capture, it runs TinyFaceDetector + FaceLandmark68 +
 *      FaceRecognitionNet and posts a 128-length number[] back to RN via
 *      window.ReactNativeWebView.postMessage.
 *   4. RN forwards it to `onCapture(descriptor)`.
 *
 * The raw camera frame NEVER leaves the device — only the embedding (which is
 * not reversible to a photo) is surfaced.
 */

type Props = {
  captureLabel?: string;
  capturingLabel?: string;
  onCapture: (descriptor: number[]) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
  /** Automatically capture once a face is steadily detected in frame. */
  autoCapture?: boolean;
  /** Bump this to re-arm the capture button after a failed submit. */
  resetNonce?: number;
};

// face-api fork that ships a self-contained, version-matched model set.
//
// The version is PINNED (and must match client/package.json's
// "@vladmandic/face-api" version) so the 128-float descriptor produced here
// is computed with the exact same model weights as the web client. An
// unpinned CDN path can serve a newer model release whose embeddings are not
// comparable with descriptors enrolled on the web — pushing the Euclidean
// distance past the server's match threshold and causing a false
// "Face didn't match" at clock-in. jsDelivr also guarantees the manifest +
// shard binaries come from the same release when the version is pinned.
const FACEAPI_VERSION = "1.7.15";
const FACEAPI_CDN = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${FACEAPI_VERSION}/dist/face-api.js`;
const MODEL_URL = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${FACEAPI_VERSION}/model`;

// Auto-capture tuning (mirrors client/src/components/attendance/FaceCapture.tsx):
// poll the video with the cheap detector and fire once we've seen a confident
// face on N consecutive polls (avoids capturing a half-turned face
// mid-motion). The first poll fires IMMEDIATELY once models/camera are ready
// (no initial delay) and the interval is short so auto-verification kicks in
// with minimal lag.
const AUTO_POLL_MS = 300;
const AUTO_CONSECUTIVE_HITS = 2;
// While auto-capture is active the manual button is hidden. If no face has
// been auto-captured within this grace window, the manual button is revealed
// as a fallback (the auto loop keeps polling in the background).
const AUTO_FALLBACK_BTN_MS = 7000;

function buildHtml(
  theme: Theme,
  captureLabel: string,
  capturingLabel: string,
  autoCapture: boolean,
): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  * { box-sizing: border-box; -webkit-user-select: none; user-select: none; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: ${theme.bg};
    color: ${theme.text};
    font-family: -apple-system, system-ui, sans-serif;
    overflow: hidden;
  }
  #wrap { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px; height: 100%; }
  #videoBox {
    position: relative; width: 100%; max-width: 360px; aspect-ratio: 3 / 4;
    border-radius: 16px; overflow: hidden; background: #000;
    border: 1px solid ${theme.glassBorder};
  }
  video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
  #status {
    font-size: 14px; color: ${theme.textSecondary}; text-align: center; min-height: 20px;
  }
  #err {
    display: none; align-items: center; gap: 6px; color: ${theme.danger};
    font-size: 13px; text-align: center; padding: 0 16px;
  }
  #btn {
    width: 100%; max-width: 360px; padding: 14px; border: none; border-radius: 10px;
    background: ${theme.primary}; color: #fff; font-size: 15px; font-weight: 600;
  }
  #btn:disabled { opacity: 0.5; }
  #btn.hidden { display: none; }
  .spinner {
    width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff; border-radius: 50%; display: inline-block;
    animation: spin 0.8s linear infinite; vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="wrap">
  <div id="videoBox"><video id="video" autoplay muted playsinline></video></div>
  <div id="status">Loading face models…</div>
  <div id="err"></div>
  <button id="btn" class="${autoCapture ? "hidden" : ""}" disabled>${captureLabel}</button>
</div>

<script src="${FACEAPI_CDN}"></script>
<script>
  var MODEL_URL = "${MODEL_URL}";
  var video = document.getElementById("video");
  var statusEl = document.getElementById("status");
  var errEl = document.getElementById("err");
  var btn = document.getElementById("btn");
  var stream = null;
  var modelsReady = false;
  // Auto-capture loop state.
  var autoCapture = ${autoCapture ? "true" : "false"};
  var autoTimer = null;
  var autoHits = 0;
  var capturing = false;
  var captured = false;
  // Fallback timer: reveals the manual button if auto-capture hasn't fired
  // within the grace window (user's face not detected — bad light, angle…).
  var fallbackTimer = null;

  function post(obj) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(obj));
    }
  }
  function showError(msg) {
    errEl.style.display = "flex";
    errEl.textContent = msg;
    statusEl.textContent = "";
    post({ type: "error", message: msg });
  }
  function setStatus(msg) { statusEl.textContent = msg; }

  // The manual button is hidden while auto-capture is running; it is shown
  // only when auto mode is off (e.g. after a server rejection), when a
  // capture attempt fails, or after the fallback grace window elapses.
  function showBtn() {
    btn.classList.remove("hidden");
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
  }
  function hideBtn() { btn.classList.add("hidden"); }
  function armFallbackBtn() {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(function () {
      fallbackTimer = null;
      if (!captured && !capturing) showBtn();
    }, ${AUTO_FALLBACK_BTN_MS});
  }

  function readyStatus() {
    if (autoCapture) {
      setStatus("Position your face in the frame — verifying automatically…");
    } else {
      setStatus("Center your face and tap " + ${JSON.stringify(captureLabel)});
    }
  }

  function stopAuto() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    autoHits = 0;
  }

  // Cheap face-presence poll (detector only — no landmarks/descriptor).
  // After ${AUTO_CONSECUTIVE_HITS} consecutive confident hits we run the
  // full capture automatically.
  async function autoPoll() {
    if (!autoCapture || !modelsReady || capturing || captured) return;
    try {
      var det = await faceapi.detectSingleFace(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
      );
      if (!autoCapture || capturing || captured) return;
      if (det && det.score >= 0.5) {
        autoHits++;
        setStatus("Face detected — capturing…");
        if (autoHits >= ${AUTO_CONSECUTIVE_HITS}) {
          autoHits = 0;
          capture();
          return;
        }
      } else {
        autoHits = 0;
        readyStatus();
      }
    } catch (_) { /* model hiccup — keep polling */ }
    autoTimer = setTimeout(autoPoll, ${AUTO_POLL_MS});
  }

  function scheduleAuto() {
    stopAuto();
    if (!autoCapture || !modelsReady || capturing || captured) return;
    // Fire the first detection poll immediately — waiting a full interval
    // before even starting added avoidable lag to the auto login.
    autoTimer = setTimeout(autoPoll, 0);
  }

  async function start() {
    try {
      if (typeof faceapi === "undefined") {
        showError("Could not load face library. Check your connection.");
        return;
      }
      setStatus("Starting camera…");
      // Run the model download and the camera warm-up IN PARALLEL — they're
      // independent, and doing them sequentially used to add several seconds
      // on first use (models are ~6 MB over the CDN).
      var modelsP = Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);
      var cameraP = navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false
      }).then(function (s) {
        stream = s;
        video.srcObject = s;
        return video.play();
      });
      await Promise.all([modelsP, cameraP]);
      modelsReady = true;
      readyStatus();
      btn.disabled = false;
      if (autoCapture) { hideBtn(); armFallbackBtn(); } else { showBtn(); }
      scheduleAuto();
    } catch (e) {
      showError((e && e.message) ? e.message : "Camera access failed. Allow camera permission.");
    }
  }

  async function capture() {
    if (!modelsReady || capturing) return;
    capturing = true;
    stopAuto();
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> ${capturingLabel}';
    setStatus("Detecting face…");
    errEl.style.display = "none";
    try {
      var det = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks(true)
        .withFaceDescriptor();
      if (!det || !det.descriptor) {
        setStatus("");
        showError("No face detected. Ensure good lighting and try again.");
        btn.disabled = false;
        btn.textContent = ${JSON.stringify(captureLabel)};
        showBtn();
        capturing = false;
        scheduleAuto();
        return;
      }
      var descriptor = Array.prototype.slice.call(det.descriptor);
      captured = true;
      capturing = false;
      post({ type: "descriptor", descriptor: descriptor });
      setStatus("Captured ✓");
    } catch (e) {
      showError((e && e.message) ? e.message : "Face detection failed. Try again.");
      btn.disabled = false;
      btn.textContent = ${JSON.stringify(captureLabel)};
      showBtn();
      capturing = false;
      scheduleAuto();
    }
  }

  function resetButton() {
    btn.disabled = false;
    btn.textContent = ${JSON.stringify(captureLabel)};
    readyStatus();
  }

  function handleRnMessage(ev) {
    try {
      var msg = JSON.parse(ev.data);
      if (!msg) return;
      if (msg.type === "reset") {
        // Re-arm after a failed submit. "auto" (when present) toggles the
        // auto-capture loop — RN disables it after the first server
        // rejection so a mismatch doesn't auto-retry into the
        // face-attempt rate limit. When auto is off the manual button is
        // revealed ("auto login failed → show the manual verify button").
        captured = false;
        capturing = false;
        if (typeof msg.auto === "boolean") autoCapture = msg.auto;
        resetButton();
        if (autoCapture) { hideBtn(); armFallbackBtn(); } else { showBtn(); }
        scheduleAuto();
      } else if (msg.type === "setAuto") {
        if (typeof msg.auto === "boolean") autoCapture = msg.auto;
        if (autoCapture) {
          if (!captured && !capturing) { hideBtn(); armFallbackBtn(); }
          scheduleAuto();
        } else {
          stopAuto();
          showBtn();
          if (modelsReady && !capturing && !captured) readyStatus();
        }
      }
    } catch (_) {}
  }

  // RN → WebView messages (Android fires on document, iOS on window).
  document.addEventListener("message", handleRnMessage);
  window.addEventListener("message", handleRnMessage);

  btn.addEventListener("click", capture);
  start();
</script>
</body>
</html>`;
}

export default function FaceCaptureWebView({
  captureLabel = "Capture",
  capturingLabel = "Processing…",
  onCapture,
  onError,
  disabled,
  autoCapture = false,
  resetNonce = 0,
}: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Capture the initial autoCapture value once — later changes are pushed
  // into the live WebView via postMessage instead of re-building the HTML
  // (which would remount the WebView and restart the camera).
  const initialAutoRef = useRef(autoCapture);
  const html = useMemo(
    () => buildHtml(theme, captureLabel, capturingLabel, initialAutoRef.current),
    [theme, captureLabel, capturingLabel],
  );

  // Re-arm the in-WebView capture button after a failed submit. The parent
  // bumps `resetNonce`; we forward the (possibly updated) autoCapture flag so
  // the auto loop is disabled after the first server rejection.
  const lastResetRef = useRef(resetNonce);
  useEffect(() => {
    if (resetNonce === lastResetRef.current) return;
    lastResetRef.current = resetNonce;
    webRef.current?.postMessage(
      JSON.stringify({ type: "reset", auto: autoCapture }),
    );
  }, [resetNonce, autoCapture]);

  // Keep the in-WebView auto-capture flag in sync when it changes without a
  // reset (e.g. the parent toggles it off).
  const lastAutoRef = useRef(autoCapture);
  useEffect(() => {
    if (autoCapture === lastAutoRef.current) return;
    lastAutoRef.current = autoCapture;
    webRef.current?.postMessage(
      JSON.stringify({ type: "setAuto", auto: autoCapture }),
    );
  }, [autoCapture]);

  // `onPermissionRequest` is an Android-only prop not present in the shipped
  // type defs — pass it through an untyped object spread.
  const androidPermissionProps = {
    onPermissionRequest: (event: any) => {
      try {
        event?.nativeEvent?.grant?.(event.nativeEvent.resources);
      } catch {
        /* ignore */
      }
    },
  } as Record<string, unknown>;

  function handleMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === "descriptor" && Array.isArray(msg.descriptor)) {
        onCapture(msg.descriptor as number[]);
      } else if (msg.type === "error") {
        setError(msg.message || "Face capture failed");
        onError?.(msg.message || "Face capture failed");
      }
    } catch {
      /* ignore malformed messages */
    }
  }

  // Re-arm the in-WebView capture button (call after a failed submit).
  function reset() {
    webRef.current?.postMessage(
      JSON.stringify({ type: "reset", auto: autoCapture }),
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={{ html, baseUrl: "https://localhost/" }}
        onMessage={handleMessage}
        onLoadEnd={() => setLoading(false)}
        javaScriptEnabled
        domStorageEnabled
        // Cache the CDN-served face-api library + model weights so repeat
        // clock-ins skip the ~6 MB download entirely.
        cacheEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        style={styles.webview}
        {...androidPermissionProps}
      />
      {loading ? (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : null}
      {error ? (
        <View style={styles.errorBar}>
          <AlertTriangle size={14} color={theme.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            onPress={() => {
              setError(null);
              reset();
            }}
            disabled={disabled}
          >
            <Text style={styles.retry}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  container: {
    width: "100%",
    height: 440,
    borderRadius: theme.radiusLg,
    overflow: "hidden",
    backgroundColor: theme.bg,
  },
  webview: { flex: 1, backgroundColor: theme.bg },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.bg,
  },
  errorBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
    backgroundColor: theme.surface,
  },
  errorText: { flex: 1, color: theme.danger, fontSize: 12 },
  retry: { color: theme.primary, fontSize: 13, fontWeight: "700" },
});