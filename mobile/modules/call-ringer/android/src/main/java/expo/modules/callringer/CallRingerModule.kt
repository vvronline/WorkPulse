package expo.modules.callringer

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * CallRingerModule
 *
 * JS bridge for the CallRingService foreground service. Exposes:
 *   • startRinging(options) — start the looping selected-ringtone + vibration
 *     foreground service for an incoming call.
 *   • stopRinging()         — stop it immediately (answered/declined/cancelled).
 *
 * options keys (all optional, strings so they marshal cleanly):
 *   ringtoneRes — bundled res/raw resource name, e.g. "ringtone_classic".
 *   title       — notification title (caller name / "Incoming call").
 *   body        — notification body.
 *   vibrate     — "0" to disable vibration (default vibrates).
 *   silent      — "1" to suppress sound + vibration (muteAll / "none" ringtone).
 *
 * Safe no-op when there is no application context. All real work + lifecycle is
 * owned by CallRingService so this module stays a thin, crash-proof bridge.
 */
class CallRingerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CallRinger")

    Function("startRinging") { options: Map<String, Any?>? ->
      val context = appContext.reactContext ?: return@Function
      val extras = HashMap<String, String>()
      options?.forEach { (k, v) ->
        if (v != null) extras[k] = v.toString()
      }
      try {
        CallRingService.start(context, extras)
      } catch (_: Throwable) {
        // best-effort; never throw across the bridge
      }
    }

    Function("stopRinging") {
      val context = appContext.reactContext ?: return@Function
      try {
        CallRingService.stop(context)
      } catch (_: Throwable) {
        // best-effort
      }
    }
  }
}