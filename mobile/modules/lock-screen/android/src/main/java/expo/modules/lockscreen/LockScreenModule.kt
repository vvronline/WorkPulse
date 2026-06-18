package expo.modules.lockscreen

import android.os.Build
import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * LockScreenModule
 *
 * Exposes a single function, `setShowWhenLocked(enable)`, that toggles the
 * current Activity's ability to display OVER the lock screen and to turn the
 * screen on. This is the RUNTIME equivalent of the old (buggy) permanent
 * `setShowWhenLocked(true)` that the config plugin used to bake into
 * MainActivity.onCreate — that made the app usable over the lock screen even
 * AFTER a call ended. By toggling at runtime we only surface the app over the
 * lock screen WHILE the call UI is mounted, and return it behind the lock
 * screen once the call ends.
 *
 * API 27+ (O_MR1) uses the first-class Activity.setShowWhenLocked /
 * setTurnScreenOn APIs. Older devices fall back to the deprecated window flags.
 * All work is marshalled onto the UI thread (window/activity mutations must run
 * there). Safe no-op when there is no current Activity.
 */
class LockScreenModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LockScreen")

    Function("setShowWhenLocked") { enable: Boolean ->
      val activity = appContext.currentActivity ?: return@Function
      activity.runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          activity.setShowWhenLocked(enable)
          activity.setTurnScreenOn(enable)
        } else {
          @Suppress("DEPRECATION")
          val flags = (
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
              WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
              WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
          )
          if (enable) {
            activity.window.addFlags(flags)
          } else {
            activity.window.clearFlags(flags)
          }
        }
      }
    }
  }
}