const { validatePassword, validateUsername } = require('../utils/password');

describe('validatePassword', () => {
    test('rejects empty password', () => {
        expect(validatePassword('')).toBe('Password is required');
        expect(validatePassword(null)).toBe('Password is required');
    });

    test('rejects short password', () => {
        expect(validatePassword('Ab1!xyz')).toMatch(/at least 8/);
    });

    test('rejects password over 72 bytes', () => {
        const long = 'Aa1!' + 'x'.repeat(69);
        expect(validatePassword(long)).toMatch(/72 bytes/);
    });

    test('rejects password without lowercase', () => {
        expect(validatePassword('ABCDEFG1!')).toMatch(/lowercase/);
    });

    test('rejects password without uppercase', () => {
        expect(validatePassword('abcdefg1!')).toMatch(/uppercase/);
    });

    test('rejects password without digit', () => {
        expect(validatePassword('Abcdefgh!')).toMatch(/digit/);
    });

    test('rejects password without special char', () => {
        expect(validatePassword('Abcdefg1')).toMatch(/special/);
    });

    test('accepts valid password', () => {
        expect(validatePassword('StrongP@ss1')).toBeNull();
    });
});

describe('validateUsername', () => {
    test('rejects empty username', () => {
        expect(validateUsername('')).toBe('Username is required');
    });

    test('rejects too short', () => {
        expect(validateUsername('ab')).toMatch(/3-50/);
    });

    test('rejects too long', () => {
        expect(validateUsername('a'.repeat(51))).toMatch(/3-50/);
    });

    test('rejects spaces', () => {
        expect(validateUsername('user name')).toMatch(/letters, numbers/);
    });

    test('rejects HTML characters', () => {
        expect(validateUsername('user<script>')).toMatch(/letters, numbers/);
    });

    test('accepts valid usernames', () => {
        expect(validateUsername('john_doe')).toBeNull();
        expect(validateUsername('jane-doe.123')).toBeNull();
    });
});
