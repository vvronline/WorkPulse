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
      val context = appContext.reactContext
      if (context != null) {
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
    }

    Function("stopRinging") {
      val context = appContext.reactContext
      if (context != null) {
        try {
          CallRingService.stop(context)
        } catch (_: Throwable) {
          // best-effort
        }
      }
    }

    // Return the Answer/Decline choice the user made on the native CallStyle
    // status-bar notification (written by CallActionReceiver) so the JS layer
    // can MERGE it into the cold-start pending-call route. Returns null when
    // absent/stale/invalid. See PendingCallActionStore for the why.
    Function("getPendingCallAction") {
      val context = appContext.reactContext ?: return@Function null
      try {
        PendingCallActionStore.read(context)
      } catch (_: Throwable) {
        null
      }
    }

    // Clear the stored pending action once the JS layer has consumed it so a
    // stale tap can never auto-answer a later unrelated call.
    Function("clearPendingCallAction") {
      val context = appContext.reactContext
      if (context != null) {
        try {
          PendingCallActionStore.clear(context)
        } catch (_: Throwable) {
          // best-effort
        }
      }
    }
  }
}
