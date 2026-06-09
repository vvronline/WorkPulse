/**
 * Face descriptor utilities for attendance verification.
 *
 * Face *detection* and *descriptor extraction* happen client-side via
 * face-api.js — the browser captures a webcam frame, runs the model
 * locally, and POSTs only the resulting 128-float embedding to the API.
 * The server's only job is to compare two descriptors with a Euclidean
 * distance threshold.
 *
 * Threshold: face-api.js' authors recommend 0.6 as the default cutoff
 * between "same person" and "different person" for the 128D embedding
 * produced by the FaceRecognitionNet. We use 0.55 as a slightly stricter
 * default for an attendance flow; can be tuned via env if needed.
 */

const FACE_DESCRIPTOR_LENGTH = 128;
const DEFAULT_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD) || 0.55;

type DescriptorInput = number[] | Float32Array | string | null | undefined;

interface CompareResult {
    match: boolean;
    distance: number;
    threshold: number;
}

/**
 * Returns true if `d` looks like a valid 128-float face descriptor
 * (an array of 128 finite numbers).
 */
function isValidDescriptor(d: unknown): d is number[] {
    if (!Array.isArray(d) || d.length !== FACE_DESCRIPTOR_LENGTH) return false;
    for (let i = 0; i < d.length; i++) {
        const n = Number(d[i]);
        if (!Number.isFinite(n)) return false;
    }
    return true;
}

/**
 * Coerce a descriptor input (array / Float32Array / JSON) into a plain
 * array of 128 numbers, or null if it can't be parsed cleanly. Used when
 * loading enrolled descriptors out of JSONB columns.
 */
function parseDescriptor(input: DescriptorInput): number[] | null {
    if (input == null) return null;
    let arr: unknown = input;
    if (typeof input === "string") {
        try { arr = JSON.parse(input); } catch { return null; }
    }
    if (arr && typeof arr === "object" && !Array.isArray(arr) && "length" in arr) {
        arr = Array.from(arr as ArrayLike<number>);
    }
    if (!Array.isArray(arr) || arr.length !== FACE_DESCRIPTOR_LENGTH) return null;
    const out = new Array<number>(FACE_DESCRIPTOR_LENGTH);
    for (let i = 0; i < FACE_DESCRIPTOR_LENGTH; i++) {
        const n = Number(arr[i]);
        if (!Number.isFinite(n)) return null;
        out[i] = n;
    }
    return out;
}

/**
 * Euclidean distance between two 128D descriptors. Returns NaN if either
 * descriptor is invalid.
 */
function euclideanDistance(a: unknown, b: unknown): number {
    if (!isValidDescriptor(a) || !isValidDescriptor(b)) return NaN;
    let sum = 0;
    for (let i = 0; i < FACE_DESCRIPTOR_LENGTH; i++) {
        const diff = Number(a[i]) - Number(b[i]);
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}

/**
 * Compare two descriptors. Returns:
 *   { match: boolean, distance: number, threshold: number }
 * `match` is true when `distance <= threshold`.
 * If either descriptor is invalid, returns `{ match: false, distance: NaN, threshold }`.
 */
function compareDescriptors(enrolled: unknown, candidate: unknown, threshold: number = DEFAULT_MATCH_THRESHOLD): CompareResult {
    const t = Number(threshold);
    const safeThreshold = Number.isFinite(t) && t > 0 ? t : DEFAULT_MATCH_THRESHOLD;
    const dist = euclideanDistance(enrolled, candidate);
    if (!Number.isFinite(dist)) {
        return { match: false, distance: NaN, threshold: safeThreshold };
    }
    return { match: dist <= safeThreshold, distance: dist, threshold: safeThreshold };
}

export {
    FACE_DESCRIPTOR_LENGTH,
    DEFAULT_MATCH_THRESHOLD,
    isValidDescriptor,
    parseDescriptor,
    euclideanDistance,
    compareDescriptors,
};