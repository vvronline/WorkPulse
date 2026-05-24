const { haversineMeters, isWithinGeofence, isValidLat, isValidLng } = require('../utils/geo');

describe('geo utils', () => {
    describe('haversineMeters', () => {
        test('returns 0 for identical points', () => {
            expect(haversineMeters(40.0, -73.0, 40.0, -73.0)).toBeCloseTo(0, 3);
        });

        test('roughly matches known distance (NYC → Los Angeles ≈ 3935 km)', () => {
            const d = haversineMeters(40.7128, -74.0060, 34.0522, -118.2437);
            // Should be ~3935 km; allow 1% tolerance.
            expect(d).toBeGreaterThan(3900000);
            expect(d).toBeLessThan(3970000);
        });

        test('handles small distances (1 degree latitude ≈ 111 km)', () => {
            const d = haversineMeters(0, 0, 1, 0);
            expect(d).toBeGreaterThan(110000);
            expect(d).toBeLessThan(112000);
        });

        test('returns NaN for invalid inputs', () => {
            expect(haversineMeters('a', 0, 0, 0)).toBeNaN();
            expect(haversineMeters(null, undefined, 0, 0)).toBeNaN();
        });
    });

    describe('isWithinGeofence', () => {
        test('point at office is inside any positive radius', () => {
            expect(isWithinGeofence(40.0, -73.0, 40.0, -73.0, 100)).toBe(true);
        });

        test('point just outside the radius returns false', () => {
            // Move ~2 km north of the office; with radius 1 km should be outside.
            expect(isWithinGeofence(40.018, -73.0, 40.0, -73.0, 1000)).toBe(false);
        });

        test('point just inside the radius returns true', () => {
            // Move ~50 m north; with radius 200 m should be inside.
            expect(isWithinGeofence(40.00045, -73.0, 40.0, -73.0, 200)).toBe(true);
        });

        test('rejects invalid latitudes/longitudes', () => {
            expect(isWithinGeofence(91, 0, 0, 0, 100)).toBe(false);
            expect(isWithinGeofence(0, 181, 0, 0, 100)).toBe(false);
        });

        test('rejects non-positive radius', () => {
            expect(isWithinGeofence(40.0, -73.0, 40.0, -73.0, 0)).toBe(false);
            expect(isWithinGeofence(40.0, -73.0, 40.0, -73.0, -10)).toBe(false);
        });
    });

    describe('isValidLat / isValidLng', () => {
        test('lat boundaries', () => {
            expect(isValidLat(0)).toBe(true);
            expect(isValidLat(90)).toBe(true);
            expect(isValidLat(-90)).toBe(true);
            expect(isValidLat(90.1)).toBe(false);
            expect(isValidLat('foo')).toBe(false);
        });

        test('lng boundaries', () => {
            expect(isValidLng(0)).toBe(true);
            expect(isValidLng(180)).toBe(true);
            expect(isValidLng(-180)).toBe(true);
            expect(isValidLng(180.0001)).toBe(false);
            expect(isValidLng(NaN)).toBe(false);
        });
    });
});