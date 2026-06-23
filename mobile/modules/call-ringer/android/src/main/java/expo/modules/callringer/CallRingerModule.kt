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

    // Returns TRUE when the ring foreground service actually started, FALSE when
    // the OS refused it (e.g. Android 12+ background FGS-start restriction) or no
    // context is available. The JS caller (notifeeService.displayIncomingCall)
    // uses this to FALL BACK to the Notifee full-screen-intent call notification
    // when the service couldn't start, so a backgrounded-but-alive incoming call
    // is never left with no surface (the "desktop→android call silently dropped
    // while the phone is backgrounded" regression).
    Function("startRinging") { options: Map<String, Any?>? ->
      val context = appContext.reactContext ?: return@Function false
      val extras = HashMap<String, String>()
      options?.forEach { (k, v) ->
        if (v != null) extras[k] = v.toString()
      }
      try {
        CallRingService.start(context, extras)
      } catch (_: Throwable) {
        // never throw across the bridge; report failure so JS can fall back
        false
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

    // Start the ONGOING-CALL foreground service (ActiveCallService) for the
    // lifetime of a connected call. Keeps the process at foreground priority so
    // the OS does not throttle the app mid-call (a cause of video stutter/lag/
    // freeze). See ActiveCallService for the full rationale.
    Function("startActiveCall") { options: Map<String, Any?>? ->
      val context = appContext.reactContext
      if (context != null) {
        val extras = HashMap<String, String>()
        options?.forEach { (k, v) ->
          if (v != null) extras[k] = v.toString()
        }
        try {
          ActiveCallService.start(context, extras)
        } catch (_: Throwable) {
          // best-effort; never throw across the bridge
        }
      }
    }

    // Stop the ongoing-call foreground service (call ended / screen unmounted).
    Function("stopActiveCall") {
      val context = appContext.reactContext
      if (context != null) {
        try {
          ActiveCallService.stop(context)
        } catch (_: Throwable) {
          // best-effort
        }
      }
    }

    // Return the Answer/Decline choice the user made on the native CallStyle
    // status-bar notification (written by CallActionActivity) so the JS layer
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
