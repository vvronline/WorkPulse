/**
 * Pure-function tests for meetingPermissions. No DB, no HTTP — the module
 * is intentionally side-effect free so every rule can be exercised by
 * feeding handcrafted meeting / user objects through `can()`.
 */
const perms = require('../utils/meetingPermissions');

const HOST = { userId: 42 };
const OTHER = { userId: 99 };

function meeting(extraSettings = {}) {
    return {
        id: 1,
        created_by: HOST.userId,
        status: 'active',
        settings: extraSettings,
    };
}

describe('meetingPermissions', () => {
    describe('input safety (closed-by-default)', () => {
        test('missing user / meeting / action → false', () => {
            expect(perms.can(null, meeting(), perms.ACTIONS.EDIT)).toBe(false);
            expect(perms.can(HOST, null, perms.ACTIONS.EDIT)).toBe(false);
            expect(perms.can(HOST, meeting(), null)).toBe(false);
        });

        test('user without userId → false', () => {
            expect(perms.can({}, meeting(), perms.ACTIONS.EDIT)).toBe(false);
        });

        test('unknown action → false', () => {
            expect(perms.can(HOST, meeting(), 'definitely-not-an-action')).toBe(false);
        });

        test('unknown preset name silently falls back to standard', () => {
            const m = meeting({ preset: 'i-do-not-exist' });
            // standard.EDIT is host-only → HOST allowed, OTHER not
            expect(perms.can(HOST, m, perms.ACTIONS.EDIT)).toBe(true);
            expect(perms.can(OTHER, m, perms.ACTIONS.EDIT)).toBe(false);
            // describePreset reports the resolved-to name
            expect(perms.describePreset(m).name).toBe(perms.DEFAULT_PRESET);
        });
    });

    describe('standard preset (default — matches pre-Phase-3 behaviour)', () => {
        const m = meeting();
        test('host can edit / end / add / mute / start broadcast', () => {
            for (const a of [
                perms.ACTIONS.EDIT,
                perms.ACTIONS.END_FOR_ALL,
                perms.ACTIONS.ADD_PARTICIPANT,
                perms.ACTIONS.MUTE_OTHERS,
                perms.ACTIONS.START_BROADCAST,
            ]) {
                expect(perms.can(HOST, m, a)).toBe(true);
            }
        });

        test('non-host CANNOT edit / end / add / mute / broadcast', () => {
            for (const a of [
                perms.ACTIONS.EDIT,
                perms.ACTIONS.END_FOR_ALL,
                perms.ACTIONS.ADD_PARTICIPANT,
                perms.ACTIONS.MUTE_OTHERS,
                perms.ACTIONS.START_BROADCAST,
            ]) {
                expect(perms.can(OTHER, m, a)).toBe(false);
            }
        });

        test('everyone can unmute self / share screen / send chat', () => {
            for (const a of [perms.ACTIONS.UNMUTE_SELF, perms.ACTIONS.SHARE_SCREEN, perms.ACTIONS.SEND_CHAT]) {
                expect(perms.can(HOST, m, a)).toBe(true);
                expect(perms.can(OTHER, m, a)).toBe(true);
            }
        });

        test('allowAnyBroadcaster=true override lets non-hosts start broadcast', () => {
            const m2 = meeting({ allowAnyBroadcaster: true });
            expect(perms.can(OTHER, m2, perms.ACTIONS.START_BROADCAST)).toBe(true);
            // And the host of course still can.
            expect(perms.can(HOST, m2, perms.ACTIONS.START_BROADCAST)).toBe(true);
        });

        test('allowAnyBroadcaster=false override is just the host-only default', () => {
            const m2 = meeting({ allowAnyBroadcaster: false });
            expect(perms.can(OTHER, m2, perms.ACTIONS.START_BROADCAST)).toBe(false);
            expect(perms.can(HOST, m2, perms.ACTIONS.START_BROADCAST)).toBe(true);
        });
    });

    describe('webinar preset (attendee-locked)', () => {
        const m = meeting({ preset: 'webinar' });
        test('describePreset reports the correct preset', () => {
            expect(perms.describePreset(m).name).toBe('webinar');
        });

        test('attendees cannot unmute themselves, share screen, or broadcast', () => {
            for (const a of [
                perms.ACTIONS.UNMUTE_SELF,
                perms.ACTIONS.SHARE_SCREEN,
                perms.ACTIONS.START_BROADCAST,
            ]) {
                expect(perms.can(OTHER, m, a)).toBe(false);
            }
        });

        test('attendees CAN send chat (webinar Q&A use case)', () => {
            expect(perms.can(OTHER, m, perms.ACTIONS.SEND_CHAT)).toBe(true);
        });

        test('host can do everything', () => {
            for (const a of Object.values(perms.ACTIONS)) {
                expect(perms.can(HOST, m, a)).toBe(true);
            }
        });
    });

    describe('open preset (community-style)', () => {
        const m = meeting({ preset: 'open' });

        test('every joined user can add participants + mute + broadcast', () => {
            for (const a of [
                perms.ACTIONS.ADD_PARTICIPANT,
                perms.ACTIONS.MUTE_OTHERS,
                perms.ACTIONS.START_BROADCAST,
                perms.ACTIONS.UNMUTE_SELF,
                perms.ACTIONS.SHARE_SCREEN,
                perms.ACTIONS.SEND_CHAT,
            ]) {
                expect(perms.can(OTHER, m, a)).toBe(true);
            }
        });

        test('only host can still EDIT and END_FOR_ALL', () => {
            expect(perms.can(OTHER, m, perms.ACTIONS.EDIT)).toBe(false);
            expect(perms.can(OTHER, m, perms.ACTIONS.END_FOR_ALL)).toBe(false);
            expect(perms.can(HOST, m, perms.ACTIONS.EDIT)).toBe(true);
            expect(perms.can(HOST, m, perms.ACTIONS.END_FOR_ALL)).toBe(true);
        });
    });

    describe('shape contract', () => {
        test('ACTIONS values are all unique strings', () => {
            const values = Object.values(perms.ACTIONS);
            expect(new Set(values).size).toBe(values.length);
            for (const v of values) expect(typeof v).toBe('string');
        });

        test('every preset has a rule for every action — no silent gaps', () => {
            for (const presetName of perms.listPresets()) {
                const ruleMap = perms.PRESETS[presetName];
                for (const action of Object.values(perms.ACTIONS)) {
                    expect(ruleMap[action]).toBeDefined();
                }
            }
        });

        test('DEFAULT_PRESET is one of the known presets', () => {
            expect(perms.listPresets()).toContain(perms.DEFAULT_PRESET);
        });
    });
});