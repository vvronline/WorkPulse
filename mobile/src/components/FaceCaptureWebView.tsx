import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { AlertTriangle } from "lucide-react-native";
import { theme } from "../theme";

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
 *   2. On "Capture", it runs TinyFaceDetector + FaceLandmark68 +
 *      FaceRecognitionNet and posts a 128-length number[] back to RN via
 *      window.ReactNativeWebView.postMessage.
 *   3. RN forwards it to `onCapture(descriptor)`.
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

function buildHtml(captureLabel: string, capturingLabel: string): string {
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
  <button id="btn" disabled>${captureLabel}</button>
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

  async function start() {
    try {
      if (typeof faceapi === "undefined") {
        showError("Could not load face library. Check your connection.");
        return;
      }
      setStatus("Loading face models…");
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);
      modelsReady = true;

      setStatus("Starting camera…");
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      setStatus("Center your face and tap " + ${JSON.stringify(captureLabel)});
      btn.disabled = false;
    } catch (e) {
      showError((e && e.message) ? e.message : "Camera access failed. Allow camera permission.");
    }
  }

  async function capture() {
    if (!modelsReady) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> ${capturingLabel}';
    setStatus("Detecting face…");
    errEl.style.display = "none";
    try {
      var det = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!det || !det.descriptor) {
        setStatus("");
        showError("No face detected. Ensure good lighting and try again.");
        btn.disabled = false;
        btn.textContent = ${JSON.stringify(captureLabel)};
        return;
      }
      var descriptor = Array.prototype.slice.call(det.descriptor);
      post({ type: "descriptor", descriptor: descriptor });
      setStatus("Captured ✓");
    } catch (e) {
      showError((e && e.message) ? e.message : "Face detection failed. Try again.");
      btn.disabled = false;
      btn.textContent = ${JSON.stringify(captureLabel)};
    }
  }

  function resetButton() {
    btn.disabled = false;
    btn.textContent = ${JSON.stringify(captureLabel)};
    setStatus("Center your face and tap " + ${JSON.stringify(captureLabel)});
  }

  // Allow RN to re-arm the button after a failed submit.
  document.addEventListener("message", function (ev) {
    try {
      var msg = JSON.parse(ev.data);
      if (msg && msg.type === "reset") resetButton();
    } catch (_) {}
  });
  window.addEventListener("message", function (ev) {
    try {
      var msg = JSON.parse(ev.data);
      if (msg && msg.type === "reset") resetButton();
    } catch (_) {}
  });

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
}: Props) {
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const html = buildHtml(captureLabel, capturingLabel);

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
    webRef.current?.postMessage(JSON.stringify({ type: "reset" }));
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

const styles = StyleSheet.create({
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