/**
 * Config plugin: copy the bundled call ringtone WAV files into the Android
 * `res/raw` resource directory at prebuild.
 *
 * WHY THIS EXISTS:
 * An Android notification CHANNEL can only ring with a real bundled resource
 * (`res/raw/<name>`), NOT a JS data-URI. Our in-app call screen plays a
 * synthesized data-URI tone, but the killed/background full-screen-intent call
 * notification (posted BEFORE the screen mounts) rings via its channel — which
 * without a bundled file falls back to the SYSTEM DEFAULT notification tone (the
 * "status bar uses the wrong ringtone" bug). This plugin places our generated
 * `ringtone.wav` / `ringback.wav` (see scripts/generate-call-sounds.cjs) into
 * `android/app/src/main/res/raw` so notifeeService can set the calls channel
 * `sound` to `ringtone` and the call rings with the WorkPulse tone in every
 * state.
 *
 * Android raw resource names must be lowercase, start with a letter, and contain
 * only [a-z0-9_]. `ringtone` / `ringback` satisfy that. The resource is then
 * referenced by name WITHOUT the extension.
 *
 * Safe + idempotent: re-running prebuild just overwrites the copies. If a source
 * file is missing (generator not run) it logs and skips rather than failing the
 * build.
 */
const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

module.exports = function withAndroidRingtoneAssets(config) {
    return withDangerousMod(config, [
        "android",
        (config) => {
            const projectRoot = config.modRequest.projectRoot;
            const platformRoot = config.modRequest.platformProjectRoot;
            const srcDir = path.join(projectRoot, "assets", "sounds");
            const rawDir = path.join(
                platformRoot,
                "app",
                "src",
                "main",
                "res",
                "raw",
            );

            try {
                fs.mkdirSync(rawDir, { recursive: true });
            } catch (err) {
                console.warn(
                    "[withAndroidRingtoneAssets] could not create res/raw:",
                    err && err.message,
                );
                return config;
            }

            // Copy EVERY generated call sound (one per ringtone option:
            // ringtone_<id>.wav, plus ringtone.wav + ringback.wav) so the
            // per-tone notification channels in notifeeService can each point at
            // their matching res/raw resource. Android raw resource names must be
            // lowercase [a-z0-9_] and our generator already emits compliant names.
            let sources = [];
            try {
                sources = fs
                    .readdirSync(srcDir)
                    .filter((f) => /^ring(tone|back).*\.wav$/i.test(f));
            } catch (err) {
                console.warn(
                    `[withAndroidRingtoneAssets] could not read ${srcDir}; run \`node scripts/generate-call-sounds.cjs\``,
                    err && err.message,
                );
                return config;
            }

            if (sources.length === 0) {
                console.warn(
                    `[withAndroidRingtoneAssets] no ring*.wav in ${srcDir}; run \`node scripts/generate-call-sounds.cjs\``,
                );
                return config;
            }

            for (const file of sources) {
                const from = path.join(srcDir, file);
                const to = path.join(rawDir, file);
                try {
                    fs.copyFileSync(from, to);
                    console.log(`[withAndroidRingtoneAssets] copied ${file} → res/raw`);
                } catch (err) {
                    console.warn(
                        `[withAndroidRingtoneAssets] failed to copy ${file}:`,
                        err && err.message,
                    );
                }
            }

            return config;
        },
    ]);
};
