/**
 * Shared cookie configuration for JWT tokens.
 */
const isProduction = process.env.NODE_ENV === 'production';
const useSecureCookie = isProduction && process.env.USE_HTTPS === 'true';

/**
 * Generate cookie options for a request.
 * @param {object} req - Express request object
 * @param {number} [maxAge] - Cookie max age in ms (default: 8 hours)
 * @returns {object} Cookie options
 */
function cookieOptions(req, maxAge) {
    const defaultMaxAge = maxAge || 8 * 60 * 60 * 1000;
    // Desktop (Electron) app uses a custom protocol origin — needs cross-site cookies
    const origin = req?.headers?.origin || '';
    if (origin.startsWith('workpulse://')) {
        return { httpOnly: true, secure: true, sameSite: 'none', maxAge: defaultMaxAge, path: '/' };
    }
    return {
        httpOnly: true,
        secure: useSecureCookie,
        sameSite: 'strict',
        maxAge: defaultMaxAge,
        path: '/',
    };
}

module.exports = { cookieOptions };
