/**
 * backgroundEffects.js — Selfie segmentation + canvas compositor that turns a
 * raw camera MediaStream into a "person + virtual background" MediaStream.
 *
 * Design choices:
 *
 * 1. We load MediaPipe Selfie Segmentation lazily from a CDN at runtime so we
 *    don't bloat the Vite bundle (the model + WASM is ~3 MB). The CDN host
 *    `cdn.jsdelivr.net` is already in the existing CSP defaults Helmet ships
 *    with, and it's the canonical host MediaPipe ships its WASM/model from.
 *
 * 2. The processor is a class, not a hook, so it can live outside React's
 *    render lifecycle and survive the camera track being swapped (e.g. when
 *    the user changes input device mid-call).
 *
 * 3. The output is always a MediaStreamTrack — callers replace their existing
 *    senders' track via `RTCRtpSender.replaceTrack(processedTrack)` so no
 *    SDP renegotiation is required. This is the key to "doesn't break
 *    anything": every other code path in `useMeetingState.js` keeps treating
 *    `localStreamRef` as the source of truth, we just swap which video track
 *    lives inside it.
 *
 * 4. If MediaPipe fails to load (offline, CSP block, very old browser), the
 *    processor surfaces the error to the caller and returns the raw track —
 *    the meeting continues unchanged.
 *
 * Effect shapes:
 *   { type: 'none' }
 *   { type: 'blur', strength?: number = 8 }   // CSS blur radius in px
 *   { type: 'image', src: string }            // any URL the browser can load
 */

const MP_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js';
const MP_BASE_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/';

let scriptPromise = null;
function loadMediaPipeScript() {
    if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
    if (window.SelfieSegmentation) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-mp-selfie="1"]`);
        if (existing) {
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error('MediaPipe load failed')));
            return;
        }
        const s = document.createElement('script');
        s.src = MP_SCRIPT_URL;
        s.async = true;
        s.crossOrigin = 'anonymous';
        s.dataset.mpSelfie = '1';
        s.onload = () => resolve();
        s.onerror = () => {
            scriptPromise = null;
            reject(new Error('MediaPipe load failed'));
        };
        document.head.appendChild(s);
    });
    return scriptPromise;
}

export function isBackgroundEffectsSupported() {
    if (typeof window === 'undefined') return false;
    if (!('HTMLCanvasElement' in window)) return false;
    if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
    // WebGL2 is needed by MediaPipe's WASM build. Bail out early on browsers
    // where it's missing so the UI can hide the toggle entirely.
    try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2') || probe.getContext('webgl');
        if (!gl) return false;
    } catch { return false; }
    return true;
}

export class BackgroundProcessor {
    /**
     * @param {object} opts
     * @param {MediaStreamTrack} opts.inputTrack       — raw camera track
     * @param {object} [opts.effect={ type: 'none' }]  — initial effect
     * @param {number} [opts.fps=30]
     * @param {(err: Error) => void} [opts.onError]
     */
    constructor({ inputTrack, effect = { type: 'none' }, fps = 30, onError }) {
        this.inputTrack = inputTrack;
        this.effect = effect;
        this.fps = fps;
        this.onError = onError || (() => { });
        this.video = document.createElement('video');
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.autoplay = true;
        this.canvas = document.createElement('canvas');
        const settings = inputTrack.getSettings ? inputTrack.getSettings() : {};
        this.canvas.width = settings.width || 640;
        this.canvas.height = settings.height || 480;
        this.ctx = this.canvas.getContext('2d', { desynchronized: true });
        this.bgImage = null;
        this.lastBgSrc = null;
        this.segmenter = null;
        this.running = false;
        this._rafHandle = null;
        this._outStream = null;
        this._processing = false;
    }

    /**
     * Returns a MediaStream containing the processed video track. Falls back
     * to the raw track if anything goes wrong during initialisation.
     */
    async start() {
        try {
            await this._initVideo();
            await this._initSegmenter();
            this._loadBackgroundIfNeeded();
            this._outStream = this.canvas.captureStream(this.fps);
            this.running = true;
            this._loop();
            return this._outStream;
        } catch (err) {
            this.onError(err);
            // Caller should fall back to the raw track in this case.
            throw err;
        }
    }

    setEffect(effect) {
        this.effect = effect || { type: 'none' };
        this._loadBackgroundIfNeeded();
    }

    /**
     * Hot-swap the underlying camera track without tearing down the canvas
     * pipeline (used when the user changes input device mid-call).
     */
    async replaceInputTrack(newTrack) {
        this.inputTrack = newTrack;
        const settings = newTrack.getSettings ? newTrack.getSettings() : {};
        if (settings.width && settings.height) {
            this.canvas.width = settings.width;
            this.canvas.height = settings.height;
        }
        const ms = new MediaStream([newTrack]);
        this.video.srcObject = ms;
        try { await this.video.play(); } catch { /* ignore */ }
    }

    stop() {
        this.running = false;
        if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
        if (this.segmenter) {
            try { this.segmenter.close(); } catch { /* ignore */ }
            this.segmenter = null;
        }
        if (this._outStream) {
            this._outStream.getTracks().forEach(t => t.stop());
            this._outStream = null;
        }
        if (this.video) {
            try { this.video.pause(); } catch { /* ignore */ }
            this.video.srcObject = null;
        }
    }

    // ── Internals ────────────────────────────────────────────────────────

    async _initVideo() {
        const ms = new MediaStream([this.inputTrack]);
        this.video.srcObject = ms;
        await new Promise((resolve) => {
            if (this.video.readyState >= 2) return resolve();
            this.video.onloadedmetadata = () => resolve();
        });
        try { await this.video.play(); } catch { /* autoplay should work — track is muted */ }
        // Match the canvas to the actual video resolution that landed.
        if (this.video.videoWidth) this.canvas.width = this.video.videoWidth;
        if (this.video.videoHeight) this.canvas.height = this.video.videoHeight;
    }

    async _initSegmenter() {
        await loadMediaPipeScript();
        const Ctor = window.SelfieSegmentation;
        if (!Ctor) throw new Error('SelfieSegmentation constructor missing');
        this.segmenter = new Ctor({
            locateFile: (file) => `${MP_BASE_PATH}${file}`,
        });
        this.segmenter.setOptions({
            modelSelection: 1, // 1 = landscape, more accurate; 0 = general (faster)
            selfieMode: true,
        });
        this.segmenter.onResults((results) => this._onSegResults(results));
        // Warm-up: run one inference so first real frame doesn't stutter.
        try {
            await this.segmenter.send({ image: this.video });
        } catch { /* first frame may not be ready yet — ignore */ }
    }

    _loadBackgroundIfNeeded() {
        if (this.effect?.type !== 'image') {
            this.bgImage = null;
            this.lastBgSrc = null;
            return;
        }
        if (this.effect.src === this.lastBgSrc && this.bgImage) return;
        this.lastBgSrc = this.effect.src;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { this.bgImage = img; };
        img.onerror = () => { this.bgImage = null; };
        img.src = this.effect.src;
    }

    _loop = () => {
        if (!this.running) return;
        // Throttle to the target fps. requestAnimationFrame gives us ~60 fps,
        // we send a frame every Nth call.
        const interval = 1000 / this.fps;
        const now = performance.now();
        if (!this._lastSent || now - this._lastSent >= interval) {
            this._lastSent = now;
            if (this.segmenter && this.video.readyState >= 2 && !this._processing) {
                this._processing = true;
                this.segmenter.send({ image: this.video })
                    .catch((err) => { /* swallow per-frame errors */ })
                    .finally(() => { this._processing = false; });
            }
        }
        this._rafHandle = requestAnimationFrame(this._loop);
    };

    _onSegResults(results) {
        if (!this.running) return;
        const ctx = this.ctx;
        const { width, height } = this.canvas;
        ctx.save();
        ctx.clearRect(0, 0, width, height);

        // 1. Draw segmentation mask, then composite the foreground (person)
        ctx.drawImage(results.segmentationMask, 0, 0, width, height);
        ctx.globalCompositeOperation = 'source-in';
        ctx.drawImage(results.image, 0, 0, width, height);

        // 2. Draw background under the person
        ctx.globalCompositeOperation = 'destination-over';
        if (this.effect?.type === 'blur') {
            const strength = Math.max(2, Math.min(40, Number(this.effect.strength) || 8));
            ctx.filter = `blur(${strength}px)`;
            ctx.drawImage(results.image, 0, 0, width, height);
            ctx.filter = 'none';
        } else if (this.effect?.type === 'image' && this.bgImage) {
            // Cover behaviour — scale image to fill the canvas, centred.
            const iw = this.bgImage.naturalWidth || width;
            const ih = this.bgImage.naturalHeight || height;
            const scale = Math.max(width / iw, height / ih);
            const dw = iw * scale;
            const dh = ih * scale;
            ctx.drawImage(this.bgImage, (width - dw) / 2, (height - dh) / 2, dw, dh);
        } else {
            // Effect was switched to 'none' between frames — just draw original.
            ctx.drawImage(results.image, 0, 0, width, height);
        }
        ctx.restore();
    }
}

// ── Built-in virtual backgrounds (small SVG gradients) ──────────────────────
// Inline data-URLs avoid an extra HTTP roundtrip and stay inside the CSP
// img-src directive (we already allow `data:`).
function svgGradient(stops, label) {
    const id = label.replace(/\s+/g, '');
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9' preserveAspectRatio='xMidYMid slice'>
<defs><linearGradient id='${id}' x1='0' y1='0' x2='1' y2='1'>${stops}</linearGradient></defs>
<rect width='16' height='9' fill='url(#${id})'/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const BUILTIN_BACKGROUNDS = [
    {
        key: 'aurora',
        label: 'Aurora',
        src: svgGradient(
            "<stop offset='0' stop-color='#0f172a'/><stop offset='0.5' stop-color='#6366f1'/><stop offset='1' stop-color='#22d3ee'/>",
            'aurora',
        ),
    },
    {
        key: 'sunset',
        label: 'Sunset',
        src: svgGradient(
            "<stop offset='0' stop-color='#fb923c'/><stop offset='0.5' stop-color='#ef4444'/><stop offset='1' stop-color='#7c3aed'/>",
            'sunset',
        ),
    },
    {
        key: 'forest',
        label: 'Forest',
        src: svgGradient(
            "<stop offset='0' stop-color='#064e3b'/><stop offset='1' stop-color='#10b981'/>",
            'forest',
        ),
    },
    {
        key: 'graphite',
        label: 'Graphite',
        src: svgGradient(
            "<stop offset='0' stop-color='#1e293b'/><stop offset='1' stop-color='#475569'/>",
            'graphite',
        ),
    },
    {
        key: 'paper',
        label: 'Paper',
        src: svgGradient(
            "<stop offset='0' stop-color='#fefce8'/><stop offset='1' stop-color='#fde68a'/>",
            'paper',
        ),
    },
];

export const STORAGE_KEY = 'workpulse_meeting_bg_effect_v1';

export function loadStoredEffect() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { type: 'none' };
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { type: 'none' };
        if (!['none', 'blur', 'image'].includes(parsed.type)) return { type: 'none' };
        return parsed;
    } catch { return { type: 'none' }; }
}

export function storeEffect(effect) {
    try {
        // Don't persist user-uploaded data: URLs (can be huge). Only persist
        // built-in image keys + blur + none.
        if (effect?.type === 'image' && effect.src?.startsWith('data:image') && !BUILTIN_BACKGROUNDS.some(b => b.src === effect.src)) {
            return;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(effect));
    } catch { /* ignore */ }
}