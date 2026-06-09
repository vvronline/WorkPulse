/**
 * Thin wrapper around face-api.js for attendance verification.
 *
 * - Loads the lightweight TinyFaceDetector + FaceLandmark68 + FaceRecognitionNet
 *   models from /models (copied into client/public/models — see scripts/copy-face-models).
 * - Lazy-loads the face-api.js package on first call so the ~600 KB bundle
 *   doesn't ship to users who never visit the face enrollment / clock-in flow.
 * - Exposes `extractDescriptor(videoOrImg)` which returns a 128-float array
 *   or `null` if no face is detected.
 *
 * The face image itself NEVER leaves the browser — only the resulting
 * descriptor (a 128-dim embedding that is not reversible to a photo) is
 * sent to the server.
 */

// face-api has no bundled types for this fork; treat the dynamic import as
// a permissive namespace and tighten if/when @types become available.
type FaceApiModule = typeof import("@vladmandic/face-api");

let _faceapi: FaceApiModule | null = null;
let _modelsLoading: Promise<void> | null = null;
let _modelsLoaded = false;

// Public-facing folder served by Vite. Models are copied here at install
// time from `node_modules/@vladmandic/face-api/model/` — see
// `client/scripts/copy-face-models.mjs`. We deliberately serve them as
// same-origin static files (rather than streaming from a CDN) so that:
//   - The runtime manifest + .bin pair is guaranteed to come from the
//     same npm version that was bundled (CDNs sometimes serve a
//     manifest from one release alongside binaries from another, which
//     causes "tensor should have N values but has M" load errors).
//   - There is no extra CORS / CSP allowance to maintain.
//   - The face flow works offline once the SPA is loaded.
const MODEL_URL = "/models";

async function loadFaceApi(): Promise<FaceApiModule> {
    if (_faceapi) return _faceapi;
    // We use @vladmandic/face-api (an actively-maintained fork of
    // justadudewhohacks/face-api.js) because:
    //   - The original package was archived and its weights folder went
    //     offline, so the model files referenced from npm's package can
    //     no longer be downloaded.
    //   - The vladmandic fork ships a self-contained model set on jsDelivr
    //     (`@vladmandic/face-api/model/`), uses sharded `-shard1`/`-shard2`
    //     binaries that match its manifests, and tracks the latest
    //     TensorFlow.js — so it works on Node 20 + modern browsers without
    //     polyfills.
    _faceapi = await import("@vladmandic/face-api");
    return _faceapi;
}

/**
 * Load the three weights bundles we need. Memoised so repeated calls are
 * cheap. Throws if the network can't fetch the models.
 */
export async function loadFaceModels(): Promise<void> {
    if (_modelsLoaded) return;
    if (_modelsLoading) return _modelsLoading;

    _modelsLoading = (async () => {
        const faceapi = await loadFaceApi();
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
            faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
            faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        _modelsLoaded = true;
    })();

    try {
        await _modelsLoading;
    } finally {
        _modelsLoading = null;
    }
}

/**
 * Run detection on a <video> or <img> element and return the first face's
 * 128-float descriptor as a plain Array (so it's JSON-serialisable).
 * Returns `null` when no face is detected.
 */
export async function extractDescriptor(
    input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | null,
): Promise<number[] | null> {
    if (!input) return null;
    await loadFaceModels();
    const faceapi = await loadFaceApi();

    const detection = await faceapi
        .detectSingleFace(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

    if (!detection || !detection.descriptor) return null;
    return Array.from(detection.descriptor);
}

/**
 * Convenience: request webcam access. Caller is responsible for assigning
 * the returned stream to a <video> element and stopping it via stopStream().
 */
export async function getWebcamStream(): Promise<MediaStream> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera access is not supported by this browser");
    }
    return navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
    });
}

export function stopStream(stream: MediaStream | null): void {
    if (!stream) return;
    try {
        stream.getTracks().forEach(t => t.stop());
    } catch {
        // ignore
    }
}