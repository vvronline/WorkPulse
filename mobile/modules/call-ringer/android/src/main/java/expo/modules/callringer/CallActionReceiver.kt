package expo.modules.callringer

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * CallActionReceiver
 *
 * Receives the Answer / Decline action taps fired by the CallStyle incoming-call
 * notification posted by [CallRingService]. It:
 *   1. STOPS the foreground-service ring immediately (so the ringtone/vibration
 *      end the instant the user acts — no lingering ring), and
 *   2. LAUNCHES the app via a deep link so the JS call screen takes over:
 *        • Answer  → /call/<id>?…&autoAnswer=1  (acceptIncoming runs on mount)
 *        • Decline → /call/<id>?…&action=decline (rejectIncoming runs on mount;
 *          it has a WS + HTTP reject fallback so the caller always stops ringing,
 *          even from a cold/locked launch).
 *
 * Routing both actions through the existing deep-link path keeps a SINGLE accept/
 * reject code path (the call screen) instead of duplicating WebRTC/answer logic
 * natively, which is what kept the call state machine consistent.
 */
class CallActionReceiver : BroadcastReceiver() {

  companion object {
    const val ACTION_ANSWER = "expo.modules.callringer.ANSWER"
    const val ACTION_DECLINE = "expo.modules.callringer.DECLINE"

    const val EXTRA_CALL_ID = "callId"
    const val EXTRA_CONVERSATION_ID = "conversationId"
    const val EXTRA_CALLER_ID = "callerId"
    const val EXTRA_CALLER_NAME = "callerName"
    const val EXTRA_CALLER_AVATAR = "callerAvatar"
    const val EXTRA_CALL_TYPE = "callType"
    const val EXTRA_SCHEME = "scheme"
  }

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return

    val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
    val conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID) ?: ""
    val callerId = intent.getStringExtra(EXTRA_CALLER_ID) ?: ""
    val callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: ""
    val callerAvatar = intent.getStringExtra(EXTRA_CALLER_AVATAR) ?: ""
    val callType = intent.getStringExtra(EXTRA_CALL_TYPE) ?: "voice"
    val scheme = intent.getStringExtra(EXTRA_SCHEME) ?: "workpulse"

    if (conversationId.isEmpty() || callId.isEmpty()) {
      // No valid call identity — still stop any running ring before bailing.
      stopRing(context)
      return
    }

    val isAnswer = action == ACTION_ANSWER

    // Record the user's CHOICE durably so a COLD-launched JS layer can apply it.
    // On a cold start the proven routing path (app/index.tsx) reads the
    // SecureStore-PERSISTED pending-call route, which was written at RING time
    // with autoAnswer="0"/no action and therefore wins over the deep-link's
    // action params below — opening the call screen in plain RINGING mode so
    // Answer never connects and Decline never rejects. notifeeService merges
    // this stored action into the pending route at boot to fix that. (No-op for
    // the warm app, which routes via the deep link / answer-intent bridge.)
    try {
      PendingCallActionStore.write(
        context,
        if (isAnswer) "answer" else "decline",
        callId,
        conversationId,
      )
    } catch (_: Throwable) {
      // best-effort
    }

    // Build the deep link the JS call screen understands (mirrors the JS
    // Linking.createURL(`/call/...`) format used elsewhere).
    val sb = StringBuilder()
    sb.append(scheme).append("://call/").append(conversationId)
    sb.append("?mode=incoming")
    sb.append("&callId=").append(Uri.encode(callId))
    sb.append("&callType=").append(Uri.encode(callType))
    sb.append("&peerId=").append(Uri.encode(callerId))
    sb.append("&peerName=").append(Uri.encode(callerName))
    sb.append("&peerAvatar=").append(Uri.encode(callerAvatar))
    if (isAnswer) {
      sb.append("&autoAnswer=1")
    } else {
      sb.append("&action=decline")
    }

    // CRITICAL ORDERING (fixes "Answer/Decline does nothing — call never
    // connects and the caller keeps ringing"):
    // We MUST launch the Activity BEFORE stopping the foreground service. On
    // Android 12+ (strictly enforced on 14/15) a BroadcastReceiver may only
    // start an Activity from the background while the app holds a
    // background-activity-start (BAL) exemption. The running CallRingService —
    // a foregroundServiceType="phoneCall" FGS — IS that exemption. If we stop
    // the service first (the old order), the exemption is gone by the time we
    // call startActivity(), so the launch is SILENTLY BLOCKED: the ring stops
    // but the JS call screen never opens, so Answer never sends `accept` and
    // Decline never sends `reject` (the caller's dialer keeps ringing). Launch
    // first (while still exempt), THEN stop the ring/notification.
    try {
      val viewIntent = Intent(Intent.ACTION_VIEW, Uri.parse(sb.toString())).apply {
        setPackage(context.packageName)
        addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_SINGLE_TOP or
            Intent.FLAG_ACTIVITY_CLEAR_TOP,
        )
      }
      context.startActivity(viewIntent)
    } catch (_: Throwable) {
      // Fallback: at least bring the app to the foreground so the user can act.
      try {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        launch?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (launch != null) context.startActivity(launch)
      } catch (_: Throwable) {
        // give up silently
      }
    }

    // Now that the Activity launch has been dispatched (while we still held the
    // FGS-based BAL exemption), stop the ring + dismiss the FGS notification.
    // The JS call screen also calls stopRinging() on mount, so the ring is
    // guaranteed to end regardless; this just makes it instant.
    stopRing(context)
  }

  /** Stop the foreground-service ring + remove its notification. Best-effort. */
  private fun stopRing(context: Context) {
    try {
      CallRingService.stop(context)
    } catch (_: Throwable) {
      // best-effort
    }
    try {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      nm?.cancel(CallRingService.NOTIFICATION_ID)
    } catch (_: Throwable) {
      // best-effort
    }
  }
}