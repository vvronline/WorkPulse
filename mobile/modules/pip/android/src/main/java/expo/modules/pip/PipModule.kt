package expo.modules.pip

import android.app.PictureInPictureParams
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * PipModule
 *
 * Exposes Android Picture-in-Picture (PiP) to JS so the call screen can shrink
 * into a floating window when the user leaves the app mid-call (Home press /
 * switch to another app) — the Signal-Android behaviour, replacing the old
 * "Ongoing call — Return" banner.
 *
 * Signal-Android model (WebRtcCallActivity):
 *   • Activity declares android:supportsPictureInPicture="true" + a broad
 *     configChanges so the OS does NOT recreate it when it shrinks (see the
 *     withAndroidPip config plugin).
 *   • onUserLeaveHint() → enterPictureInPictureMode(params) when a call is live.
 *   • onPictureInPictureModeChanged(isInPip) → collapse/restore the UI.
 *   • API 31+ also sets setAutoEnterEnabled(true) for a seamless transition.
 *
 * WorkPulse is a single-Activity Expo app, so PiP shrinks MainActivity — while a
 * call is active the call screen is on top, so the PiP window shows the call.
 *
 * The MainActivity overrides (injected by the config plugin) call back into this
 * module through the static helpers below:
 *   • PipModule.isCallActive()  — read by onUserLeaveHint to decide whether to
 *     auto-enter PiP.
 *   • PipModule.emitPipChanged(isInPip) — called from onPictureInPictureModeChanged
 *     to forward the mode change to JS.
 *
 * Everything is a safe no-op when there is no current Activity or the device /
 * OS does not support PiP (API < 26 / no FEATURE_PICTURE_IN_PICTURE).
 */
class PipModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Pip")

    // Emitted with { isInPip: Boolean } whenever the OS enters/leaves PiP for
    // our Activity (driven by MainActivity.onPictureInPictureModeChanged).
    Events("onPipModeChanged")

    OnCreate {
      // Register this module instance so the static helper can forward the
      // MainActivity PiP-mode callback into JS.
      instance = this@PipModule
    }

    OnDestroy {
      if (instance === this@PipModule) instance = null
    }

    // True on API 26+ devices that advertise the PiP system feature.
    Function("isPipSupported") {
      val activity = appContext.currentActivity ?: return@Function false
      pipSupported(activity)
    }

    // Mark whether a call is currently active. When true the injected
    // onUserLeaveHint enters PiP as the user leaves the app. Cleared by the
    // call screen on teardown/unmount so leaving the app afterwards behaves
    // normally (no stray PiP).
    Function("setCallActive") { active: Boolean ->
      callActive = active
    }

    // Explicitly request PiP right now (e.g. a manual "minimize" button). Builds
    // params with the requested aspect ratio (video → 9:16, voice → 1:1).
    Function("enterPip") { aspectW: Int, aspectH: Int ->
      val activity = appContext.currentActivity ?: return@Function false
      if (!pipSupported(activity)) return@Function false
      try {
        activity.runOnUiThread {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.enterPictureInPictureMode(buildParams(aspectW, aspectH))
          }
        }
        true
      } catch (e: Throwable) {
        false
      }
    }

    // API 31+: have the OS AUTO-enter PiP when the user leaves the app, with no
    // explicit onUserLeaveHint call (smoothest, matches Signal). On API 26–30
    // this is a no-op and the injected onUserLeaveHint handles the transition.
    Function("setAutoEnter") { enabled: Boolean, aspectW: Int, aspectH: Int ->
      val activity = appContext.currentActivity ?: return@Function
      if (!pipSupported(activity)) return@Function
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function
      try {
        activity.runOnUiThread {
          val params = PictureInPictureParams.Builder()
            .setAspectRatio(safeRatio(aspectW, aspectH))
            .setAutoEnterEnabled(enabled)
            .build()
          activity.setPictureInPictureParams(params)
        }
      } catch (e: Throwable) {
        // best-effort
      }
    }
  }

  private fun pipSupported(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    return context.packageManager.hasSystemFeature(
      PackageManager.FEATURE_PICTURE_IN_PICTURE,
    )
  }

  private fun buildParams(aspectW: Int, aspectH: Int): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder()
      .setAspectRatio(safeRatio(aspectW, aspectH))
    return builder.build()
  }

  companion object {
    // The currently-mounted module instance (set in OnCreate). Used by the
    // MainActivity override to push PiP-mode changes into JS.
    @Volatile
    private var instance: PipModule? = null

    // Read by the injected MainActivity.onUserLeaveHint to decide whether to
    // enter PiP. Volatile because it is written from JS (module thread) and read
    // from the Android main thread.
    @Volatile
    @JvmStatic
    var callActive: Boolean = false

    /** Called from MainActivity.onUserLeaveHint(). */
    @JvmStatic
    fun isCallActive(): Boolean = callActive

    /** Called from MainActivity.onPictureInPictureModeChanged(). */
    @JvmStatic
    fun emitPipChanged(isInPip: Boolean) {
      try {
        instance?.sendEvent("onPipModeChanged", mapOf("isInPip" to isInPip))
      } catch (e: Throwable) {
        // best-effort; never crash the Activity callback
      }
    }

    /**
     * Clamp the aspect ratio to Android's allowed PiP bounds. The OS rejects
     * ratios outside roughly [1:2.39 .. 2.39:1] with an IllegalArgumentException
     * that would crash the PiP transition. Falls back to 1:1 on bad input.
     */
    @JvmStatic
    fun safeRatio(w: Int, h: Int): Rational {
      val safeW = if (w > 0) w else 1
      val safeH = if (h > 0) h else 1
      val ratio = safeW.toDouble() / safeH.toDouble()
      // Android max is 2.39 (≈239:100); min is its reciprocal.
      val maxR = 2.39
      val minR = 1.0 / maxR
      return when {
        ratio > maxR -> Rational(239, 100)
        ratio < minR -> Rational(100, 239)
        else -> Rational(safeW, safeH)
      }
    }
  }
}