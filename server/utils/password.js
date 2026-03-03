/**
 * Shared password validation utility.
 * Enforces complexity rules across registration, reset, and change flows.
 */

/**
 * Validate password meets complexity requirements.
 * @param {string} password
 * @returns {string|null} Error message or null if valid
 */
function validatePassword(password) {
    if (!password) return 'Password is required';
    if (password.length < 8) return 'Password must be at least 8 characters';
    if (password.length > 72) return 'Password must be 72 characters or less';
    if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
    if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
    if (!/[0-9]/.test(password)) return 'Password must contain at least one digit';
    if (!/[^a-zA-Z0-9]/.test(password)) return 'Password must contain at least one special character';
    return null;
}

/**
 * Validate username format.
 * Allowed: letters, digits, underscores, hyphens, dots. No spaces or HTML.
 * @param {string} username
 * @returns {string|null} Error message or null if valid
 */
function validateUsername(username) {
    if (!username) return 'Username is required';
    if (username.length < 3 || username.length > 50) return 'Username must be 3-50 characters';
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) return 'Username can only contain letters, numbers, dots, hyphens and underscores';
    return null;
}

module.exports = { validatePassword, validateUsername };
