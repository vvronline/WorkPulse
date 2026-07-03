/**
 * Config plugin: forward notification-tap intents to Notifee when the app is
 * ALREADY RUNNING (the root cause of "tapping a message notification only opens
 * the correct chat sometimes / opens the dashboard").
 *
 * THE BUG (proven from logcat):
 *   MainActivity is launched `singleTask`. When the app process is still alive
 *   (backgrounded / cached), tapping a Notifee notification does NOT create a
 *   fresh Activity — Android routes the launch intent to the EXISTING instance
 *   via `onNewIntent()` (ActivityTaskManager: START ... LAUNCH_SINGLE_TASK,
 *   numActivities=1). Notifee only reads the notification from the Activity's
 *   *launch* intent (onCreate). In an Expo app Notifee is NOT registered as an
 *   onNewIntent lifecycle listener, so:
 *     • no PRESS event fires (onBackgroundEvent/onForegroundEvent only see the
 *       DELIVERED event when the message arrives), and
 *     • notifee.getInitialNotification() keeps returning the STALE launch intent
 *       (never conv=39).
 *   Result: the tapped conversation is lost and the app just resumes to whatever
 *   screen it was on (the dashboard).
 *
 * THE FIX (standard React-Native/Notifee remedy):
 *   Override `MainActivity.onNewIntent` to call `setIntent(intent)` so the
 *   freshly-tapped notification intent BECOMES the Activity's current intent.
 *   `notifee.getInitialNotification()` reads `getCurrentActivity().getIntent()`,
 *   so after setIntent it returns the tapped notification. The JS side re-reads
 *   it on foreground (see notificationDispatcher.recheckOnForeground) and routes
 *   to the exact chat via the existing pendingChat store + PendingChatNavigator.
 *
 * Idempotent: re-running `expo prebuild` detects the marker and skips.
 */
const { withMainActivity } = require("expo/config-plugins");

const MARKER = "[withAndroidNewIntent]";

module.exports = function withAndroidNewIntent(config) {
    return withMainActivity(config, (config) => {
        let contents = config.modResults.contents;
        const isKotlin = config.modResults.language === "kt";

        if (contents.includes(MARKER)) {
            return config; // already injected
        }

        if (!isKotlin) {
            console.warn(
                `${MARKER} MainActivity is not Kotlin; onNewIntent override not injected.`,
            );
            return config;
        }

        // Ensure the android.content.Intent import is present.
        const imp = "import android.content.Intent";
        if (!contents.includes(imp)) {
            contents = contents.replace(/(^package .*$)/m, `$1\n${imp}`);
        }

        const override = `
  // ${MARKER} Route notification-tap intents to Notifee when the app is already
  // running. MainActivity is singleTask, so a tap on an EXISTING instance is
  // delivered here (onNewIntent) instead of onCreate. setIntent() makes the
  // fresh notification intent the current one so notifee.getInitialNotification()
  // returns it and the JS side can open the exact chat (see
  // notificationDispatcher.recheckOnForeground).
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
  }
`;

        // Insert the override right after the MainActivity class opening brace.
        const classMatch = contents.match(
            /class MainActivity\s*:\s*ReactActivity\s*\(\s*\)\s*\{/,
        );
        if (classMatch) {
            const idx = classMatch.index + classMatch[0].length;
            contents = contents.slice(0, idx) + override + contents.slice(idx);
        } else {
            console.warn(
                `${MARKER} Could not locate MainActivity class declaration; onNewIntent not injected.`,
            );
            return config;
        }

        config.modResults.contents = contents;
        return config;
    });
};
