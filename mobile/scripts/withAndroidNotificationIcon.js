/**
 * Config plugin: copy the bundled monochrome notification SMALL icon into the
 * Android `res/drawable` resource directory at prebuild.
 *
 * WHY THIS EXISTS:
 * An Android notification's small icon MUST be a STATIC, compile-time `drawable`
 * resource, and a notification posted with NO resolvable small icon is DROPPED
 * SILENTLY — the channel sound still plays (the "ding") but NO status-bar /
 * lockscreen entry ever appears. This was the root cause of "messages: sound but
 * no notification": notifeeService.displayMessage pointed `smallIcon` at
 * "ic_launcher", which only exists as an ADAPTIVE `mipmap` (rejected by Android
 * as a small icon). The native call path worked because CallRingService uses
 * `applicationInfo.icon` (a pre-resolved resource int).
 *
 * This plugin places `assets/notification/notification_icon.png` (a white-on-
 * transparent silhouette of the brand logo) into
 * `android/app/src/main/res/drawable/` so Notifee can always resolve
 * `smallIcon: "notification_icon"`. Regenerate it via `npm run generate-icons`
 * (mobile) whenever the brand logo changes.
 *
 * Safe + idempotent: re-running prebuild just overwrites the copy. If the source
 * file is missing it logs and skips rather than failing the build.
 */
const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

const ICON_NAME = "notification_icon.png";

module.exports = function withAndroidNotificationIcon(config) {
  return withDangerousMod(config, [
    "android",
    (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const platformRoot = config.modRequest.platformProjectRoot;
      const src = path.join(projectRoot, "assets", "notification", ICON_NAME);
      const drawableDir = path.join(
        platformRoot,
        "app",
        "src",
        "main",
        "res",
        "drawable",
      );

      try {
        fs.mkdirSync(drawableDir, { recursive: true });
      } catch (err) {
        console.warn(
          "[withAndroidNotificationIcon] could not create res/drawable:",
          err && err.message,
        );
        return config;
      }

      if (!fs.existsSync(src)) {
        console.warn(`[withAndroidNotificationIcon] source missing: ${src}`);
        return config;
      }

      try {
        fs.copyFileSync(src, path.join(drawableDir, ICON_NAME));
        console.log(
          `[withAndroidNotificationIcon] copied ${ICON_NAME} → res/drawable`,
        );
      } catch (err) {
        console.warn(
          `[withAndroidNotificationIcon] failed to copy ${ICON_NAME}:`,
          err && err.message,
        );
      }

      return config;
    },
  ]);
};
