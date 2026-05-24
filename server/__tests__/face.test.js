const {
    isValidDescriptor,
    parseDescriptor,
    euclideanDistance,
    compareDescriptors,
    FACE_DESCRIPTOR_LENGTH,
    DEFAULT_MATCH_THRESHOLD,
} = require('../utils/face');

function makeDescriptor(seed = 0.1) {
    return Array.from({ length: FACE_DESCRIPTOR_LENGTH }, (_, i) => seed + i * 0.001);
}

describe('face utils', () => {
    describe('isValidDescriptor', () => {
        test('accepts a 128-float array', () => {
            expect(isValidDescriptor(makeDescriptor())).toBe(true);
        });
        test('rejects wrong length', () => {
            expect(isValidDescriptor(new Array(127).fill(0))).toBe(false);
            expect(isValidDescriptor(new Array(129).fill(0))).toBe(false);
        });
        test('rejects non-numeric entries', () => {
            const arr = makeDescriptor();
            arr[10] = 'not a number';
            expect(isValidDescriptor(arr)).toBe(false);
        });
        test('rejects null/undefined/objects', () => {
            expect(isValidDescriptor(null)).toBe(false);
            expect(isValidDescriptor(undefined)).toBe(false);
            expect(isValidDescriptor({ length: 128 })).toBe(false);
        });
    });

    describe('parseDescriptor', () => {
        test('parses a plain array', () => {
            const d = makeDescriptor();
            expect(parseDescriptor(d)).toHaveLength(FACE_DESCRIPTOR_LENGTH);
        });
        test('parses a JSON string', () => {
            const d = makeDescriptor();
            expect(parseDescriptor(JSON.stringify(d))).toHaveLength(FACE_DESCRIPTOR_LENGTH);
        });
        test('parses an array-like (Float32Array-style)', () => {
            const d = makeDescriptor();
            const f32 = { length: FACE_DESCRIPTOR_LENGTH };
            for (let i = 0; i < FACE_DESCRIPTOR_LENGTH; i++) f32[i] = d[i];
            const parsed = parseDescriptor(f32);
            expect(parsed).toHaveLength(FACE_DESCRIPTOR_LENGTH);
        });
        test('returns null on garbage', () => {
            expect(parseDescriptor('not json')).toBeNull();
            expect(parseDescriptor(null)).toBeNull();
            expect(parseDescriptor([1, 2, 3])).toBeNull();
        });
    });

    describe('euclideanDistance', () => {
        test('zero for identical descriptors', () => {
            const d = makeDescriptor();
            expect(euclideanDistance(d, d)).toBeCloseTo(0);
        });

        test('positive for different descriptors', () => {
            const a = makeDescriptor(0.1);
            const b = makeDescriptor(0.2);
            expect(euclideanDistance(a, b)).toBeGreaterThan(0);
        });

        test('NaN for invalid input', () => {
            expect(euclideanDistance(null, makeDescriptor())).toBeNaN();
        });
    });

    describe('compareDescriptors', () => {
        test('match: identical descriptors', () => {
            const d = makeDescriptor();
            const r = compareDescriptors(d, d);
            expect(r.match).toBe(true);
            expect(r.distance).toBeCloseTo(0);
            expect(r.threshold).toBe(DEFAULT_MATCH_THRESHOLD);
        });

        test('mismatch: far-apart descriptors', () => {
            const a = makeDescriptor(0.0);
            const b = makeDescriptor(5.0); // large offset → huge L2
            const r = compareDescriptors(a, b);
            expect(r.match).toBe(false);
            expect(r.distance).toBeGreaterThan(r.threshold);
        });

        test('custom threshold honoured', () => {
            const a = makeDescriptor(0.1);
            const b = makeDescriptor(0.10001); // very tiny diff
            const r = compareDescriptors(a, b, 0.001);
            expect(r.threshold).toBe(0.001);
            expect(r.match).toBe(true);
        });

        test('invalid input → no match', () => {
            const r = compareDescriptors(null, makeDescriptor());
            expect(r.match).toBe(false);
            expect(r.distance).toBeNaN();
        });
    });
});