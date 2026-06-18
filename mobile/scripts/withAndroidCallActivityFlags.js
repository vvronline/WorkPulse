/**
 * Config plugin: (NO-OP as of the runtime lock-screen rework).
 *
 * HISTORY / WHY THIS IS NOW A NO-OP:
 * This plugin USED TO bake a PERMANENT `setShowWhenLocked(true)` +
 * `setTurnScreenOn(true)` into `MainActivity.onCreate`. That was a BUG: once the
 * flags were set in onCreate they stayed on for the entire process lifetime, so
 * AFTER an incoming call ended the app remained usable OVER the lock screen
 * (anyone could pick up the phone and use the app without unlocking).
 *
 * The fix replaces that permanent baked-in behaviour with a local Expo native
 * module (`modules/lock-screen`, exposing `setShowWhenLocked(enable)`) that the
 * call screen toggles at RUNTIME: ON when the call UI mounts, OFF when it ends /
 * unmounts. So the app only surfaces over the lock screen WHILE a call is up and
 * returns behind the lock screen the moment the call ends.
 *
 * We keep this plugin as a harmless no-op (and also actively STRIP any
 * previously-injected block) so:
 *   1. `expo prebuild` on a checkout that already has the old injected block in
 *      a non-gitignored MainActivity gets cleaned up automatically.
 *   2. The plugin reference in app.config.ts doesn't need to be removed in the
 *      same change (avoids a config error if a cached android/ dir lingers).
 */
const { withMainActivity } = require("expo/config-plugins");

// Matches the comment marker the OLD version of this plugin injected, through to
// the end of its inserted if/else block, so we can remove it idempotently.
const LEGACY_BLOCK = /\n\s*\/\/ \[withAndroidCallActivityFlags\][\s\S]*?\n\s*\}\)?\s*\}/;

module.exports = function withAndroidCallActivityFlags(config) {
    return withMainActivity(config, (config) => {
        let contents = config.modResults.contents;

        // Strip any previously-injected permanent lock-screen block. If none is
        // present this is a no-op. We intentionally DO NOT inject anything new —
        // the flags are now toggled at runtime by the lock-screen native module.
        if (contents.includes("[withAndroidCallActivityFlags]")) {
            contents = contents.replace(LEGACY_BLOCK, "");
            config.modResults.contents = contents;
        }

        return config;
    });
};