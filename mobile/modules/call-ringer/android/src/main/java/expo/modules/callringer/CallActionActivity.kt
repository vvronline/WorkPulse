package expo.modules.callringer

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle

/**
 * CallActionActivity
 *
 * A NO-UI, transparent TRAMPOLINE activity that handles the Answer / Decline
 * action-button taps on the CallStyle incoming-call notification posted by
 * [CallRingService].
 *
 * WHY AN ACTIVITY TRAMPOLINE INSTEAD OF A BROADCAST RECEIVER (the bug this fixes):
 * The previous implementation routed Answer/Decline through a BroadcastReceiver
 * (the now-removed CallActionReceiver) which then called `startActivity()` to open the JS call
 * screen. On Android 10+ — and STRICTLY enforced on 12/13/14/15 — starting an
 * Activity from a BACKGROUND BroadcastReceiver is SILENTLY BLOCKED by the
 * background-activity-start (BAL) restrictions, EVEN with a phoneCall foreground
 * service running. The observable symptom was exactly: "I tap Answer in the
 * status bar, the ring stops, but the app never comes forward — I have to open it
 * manually to see the call/video screen."
 *
 * An ACTIVITY launched by a notification action's PendingIntent.getActivity()
 * does NOT hit that restriction: the user's tap on a notification action grants
 * the launch, and once THIS activity is running it is foreground-privileged and
 * may freely start the real call activity (MainActivity via the app deep link).
 * This is the model Signal-Android uses for its CallStyle answer/decline actions.
 *
 * On launch it:
 *   1. RECORDS the user's choice durably ([PendingCallActionStore]) so a COLD
 *      start applies answer/decline correctly (notifeeService.captureInitialCallRoute
 *      merges it into the pending route at boot).
 *   2. LAUNCHES the JS call screen via the existing deep link (single accept/
 *      reject code path):
 *        • Answer  → aino://call/<id>?…&autoAnswer=1   (acceptIncoming on mount)
 *        • Decline → aino://call/<id>?…&action=decline (rejectIncoming on mount)
 *   3. STOPS the foreground-service ring + dismisses the notification.
 *   4. finish()es immediately (it has no UI of its own).
 *
 * It is declared with showWhenLocked + turnScreenOn so answering works over the
 * lock screen.
 */
class CallActionActivity : Activity() {

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

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Make sure this trampoline can run + dismiss the keyguard so the launched
    // call screen surfaces over the lock screen on answer.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
      try {
        val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        keyguard?.requestDismissKeyguard(this, null)
      } catch (_: Throwable) {
        // best-effort
      }
    }

    handle(intent)
    finish()
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    handle(intent)
    finish()
  }

  private fun handle(intent: Intent?) {
    val action = intent?.action
    if (action == null) {
      stopRing()
      return
    }

    val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
    val conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID) ?: ""
    val callerId = intent.getStringExtra(EXTRA_CALLER_ID) ?: ""
    val callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: ""
    val callerAvatar = intent.getStringExtra(EXTRA_CALLER_AVATAR) ?: ""
    val callType = intent.getStringExtra(EXTRA_CALL_TYPE) ?: "voice"
    val scheme = intent.getStringExtra(EXTRA_SCHEME) ?: "aino"

    if (conversationId.isEmpty() || callId.isEmpty()) {
      // No valid call identity — still stop any running ring before bailing.
      stopRing()
      return
    }

    val isAnswer = action == ACTION_ANSWER

    // Record the user's CHOICE durably so a COLD-launched JS layer can apply it.
    // On a cold start app/index.tsx reads the SecureStore-PERSISTED pending-call
    // route (written at RING time with autoAnswer="0"); notifeeService
    // .captureInitialCallRoute merges this stored action into that route at boot
    // so Answer connects and Decline rejects even from a killed launch.
    try {
      PendingCallActionStore.write(
        this,
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

    // Launch the JS call screen. Because WE are a (foreground) Activity started
    // by the notification action's PendingIntent.getActivity(), starting another
    // Activity here is ALWAYS permitted — no background-activity-start block. The
    // app reliably comes forward into the call/video screen in every app state
    // (foreground, background, locked, killed). This is the core fix for "Answer
    // from the status bar requires opening the app manually".
    try {
      val viewIntent = Intent(Intent.ACTION_VIEW, Uri.parse(sb.toString())).apply {
        setPackage(packageName)
        addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_SINGLE_TOP or
            Intent.FLAG_ACTIVITY_CLEAR_TOP,
        )
      }
      startActivity(viewIntent)
    } catch (_: Throwable) {
      // Fallback: at least bring the app to the foreground so the user can act.
      try {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        launch?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (launch != null) startActivity(launch)
      } catch (_: Throwable) {
        // give up silently
      }
    }

    // Stop the ring + dismiss the FGS notification. The JS call screen also calls
    // stopRinging() on mount, so the ring is guaranteed to end regardless; this
    // just makes it instant.
    stopRing()
  }

  /** Stop the foreground-service ring + remove its notification. Best-effort. */
  private fun stopRing() {
    try {
      CallRingService.stop(this)
    } catch (_: Throwable) {
      // best-effort
    }
    try {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? android.app.NotificationManager
      nm?.cancel(CallRingService.NOTIFICATION_ID)
    } catch (_: Throwable) {
      // best-effort
    }
  }
}