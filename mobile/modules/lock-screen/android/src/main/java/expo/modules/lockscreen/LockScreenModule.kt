package expo.modules.lockscreen

import android.content.Context
import android.os.Build
import android.os.PowerManager
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
 *
 * WAKING THE SCREEN: `setTurnScreenOn(true)` only turns the display on the next
 * time the Activity is (re)shown, and on many OEM skins (Xiaomi/Oppo/OnePlus/
 * Samsung) it is unreliable when the call screen mounts while the display is
 * already OFF (the "screen doesn't wake up during a call on a locked device"
 * bug). To force the display on we ALSO briefly acquire a PowerManager wake lock
 * with ACQUIRE_CAUSES_WAKEUP — exactly what Signal-Android does for an incoming
 * ring. The lock auto-releases (timeout) so it can never pin the screen on; once
 * awake, the call screen's FLAG_KEEP_SCREEN_ON (expo-keep-awake) holds it.
 *
 * All work is marshalled onto the UI thread (window/activity mutations must run
 * there). Safe no-op when there is no current Activity.
 */
class LockScreenModule : Module() {
  private var wakeLock: PowerManager.WakeLock? = null

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

        if (enable) {
          forceScreenOn(activity)
        } else {
          releaseWakeLock()
        }
      }
    }
  }

  /**
   * Briefly acquire a wake lock that turns the display on if it is currently
   * off. Best-effort: a missing permission / OEM quirk must never crash the
   * call screen. Auto-releases after a short timeout so it never holds the
   * screen on by itself.
   */
  private fun forceScreenOn(context: Context) {
    try {
      val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
      if (pm.isInteractive) return // screen already on — nothing to do.
      releaseWakeLock()
      @Suppress("DEPRECATION")
      val lock = pm.newWakeLock(
        PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
          PowerManager.ACQUIRE_CAUSES_WAKEUP or
          PowerManager.ON_AFTER_RELEASE,
        "WorkPulse:CallScreenWake",
      )
      lock.setReferenceCounted(false)
      // 15s is plenty to wake + hand off to FLAG_KEEP_SCREEN_ON; it auto-releases.
      lock.acquire(15_000L)
      wakeLock = lock
    } catch (_: Throwable) {
      // best-effort
    }
  }

  private fun releaseWakeLock() {
    try {
      wakeLock?.let { if (it.isHeld) it.release() }
    } catch (_: Throwable) {
      // best-effort
    }
    wakeLock = null
  }
}
