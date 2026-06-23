/**
 * Config plugin: enable Android Picture-in-Picture (PiP) for the call screen.
 *
 * WHAT THIS DOES (Signal-Android parity):
 * Signal's WebRtcCallActivity declares `supportsPictureInPicture`, overrides
 * `onUserLeaveHint()` to call `enterPictureInPictureMode()` when a call is live,
 * and overrides `onPictureInPictureModeChanged()` to collapse/restore the UI.
 * WorkPulse is a single-Activity Expo app, so we apply the same to MainActivity:
 *
 *   1. AndroidManifest: add `android:supportsPictureInPicture="true"` to the
 *      MainActivity and merge the screen/orientation config-change flags so the
 *      OS does NOT recreate the Activity when it shrinks into the PiP window
 *      (a recreate would tear down the live WebRTC session).
 *
 *   2. MainActivity (.kt): inject
 *        • onUserLeaveHint()             → enter PiP when PipModule.isCallActive()
 *          (handles API 26–30; on API 31+ the module's setAutoEnterEnabled does
 *          this seamlessly, but the manual hint is a harmless safety net).
 *        • onPictureInPictureModeChanged → forward the boolean to
 *          PipModule.emitPipChanged() so JS can collapse/restore the call UI.
 *
 * The injected code calls into the local `modules/pip` native module
 * (expo.modules.pip.PipModule). Both edits are idempotent — re-running prebuild
 * detects the marker and skips re-injection.
 */
const {
    withAndroidManifest,
    withMainActivity,
    AndroidConfig,
} = require("expo/config-plugins");

const MARKER = "[withAndroidPip]";

// configChanges PiP needs so the Activity is NOT recreated when it resizes into
// the floating window. We MERGE these into whatever Expo already declares.
const PIP_CONFIG_CHANGES = [
    "screenSize",
    "smallestScreenSize",
    "screenLayout",
    "orientation",
];

function withPipManifest(config) {
    return withAndroidManifest(config, (config) => {
        const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(
            config.modResults,
        );
        mainActivity.$["android:supportsPictureInPicture"] = "true";

        // Merge the required configChanges with any existing value (dedup, order
        // preserved-ish). Expo typically declares a long list already.
        const existing = (mainActivity.$["android:configChanges"] || "")
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean);
        const merged = new Set(existing);
        for (const c of PIP_CONFIG_CHANGES) merged.add(c);
        mainActivity.$["android:configChanges"] = Array.from(merged).join("|");

        return config;
    });
}

function withPipMainActivity(config) {
    return withMainActivity(config, (config) => {
        let contents = config.modResults.contents;
        const isKotlin = config.modResults.language === "kt";

        if (contents.includes(MARKER)) {
            return config; // already injected
        }

        if (!isKotlin) {
            console.warn(
                `${MARKER} MainActivity is not Kotlin; PiP overrides not injected.`,
            );
            return config;
        }

        // Ensure the imports we need are present.
        const imports = [
            "import android.content.res.Configuration",
            "import android.os.Build",
            "import expo.modules.pip.PipModule",
        ];
        for (const imp of imports) {
            if (!contents.includes(imp)) {
                // Insert each import right after the package declaration line.
                contents = contents.replace(
                    /(^package .*$)/m,
                    `$1\n${imp}`,
                );
            }
        }

        // The overrides to inject inside the MainActivity class body.
        const overrides = `
  // ${MARKER} Picture-in-Picture: shrink the call into a floating window when
  // the user leaves the app mid-call (Signal-Android parity). Only enters PiP
  // when a call is active (PipModule.isCallActive()); otherwise leaving the app
  // behaves normally. The call screen sets/clears that flag via the JS bridge.
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && PipModule.isCallActive()) {
        // On API 31+ the OS auto-enters via setAutoEnterEnabled, so only call
        // enterPictureInPictureMode explicitly on API 26–30.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
          enterPictureInPictureMode(
            android.app.PictureInPictureParams.Builder()
              .setAspectRatio(PipModule.safeRatio(9, 16))
              .build()
          )
        }
      }
    } catch (e: Throwable) {
      // best-effort; never crash the leave-hint
    }
  }

  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    try {
      PipModule.emitPipChanged(isInPictureInPictureMode)
    } catch (e: Throwable) {
      // best-effort
    }
  }
`;

        // Insert the overrides right after the class declaration's opening brace.
        // Expo's Kotlin MainActivity looks like:
        //   class MainActivity : ReactActivity() {
        const classMatch = contents.match(
            /class MainActivity\s*:\s*ReactActivity\s*\(\s*\)\s*\{/,
        );
        if (classMatch) {
            const idx = classMatch.index + classMatch[0].length;
            contents = contents.slice(0, idx) + "\n" + overrides + contents.slice(idx);
        } else {
            // Fallback: insert after the first "{" following "class MainActivity".
            const fallback = contents.match(/class MainActivity[^{]*\{/);
            if (fallback) {
                const idx = fallback.index + fallback[0].length;
                contents =
                    contents.slice(0, idx) + "\n" + overrides + contents.slice(idx);
            } else {
                console.warn(
                    `${MARKER} could not locate MainActivity class body; skipped.`,
                );
                return config;
            }
        }

        config.modResults.contents = contents;
        return config;
    });
}

module.exports = function withAndroidPip(config) {
    config = withPipManifest(config);
    config = withPipMainActivity(config);
    return config;
};