package expo.modules.callringer

import android.content.Context
import org.json.JSONObject

/**
 * PendingCallActionStore
 *
 * A tiny durable bridge that records the user's Answer/Decline CHOICE made on the
 * native CallStyle status-bar notification (see [CallActionActivity]) so the JS
 * layer can apply it after a COLD start.
 *
 * WHY THIS EXISTS:
 * When the app is killed and the user taps Answer/Decline on the foreground-
 * service call notification, [CallActionActivity] launches a deep link
 * (`aino://call/<id>?…&autoAnswer=1` / `&action=decline`). But on a cold
 * launch the proven routing path (`app/index.tsx`) reads the SecureStore-
 * PERSISTED pending-call route — which was written at RING time with
 * autoAnswer="0" and no action (the call was only ringing then). That persisted
 * route wins and redirects to the call screen in plain RINGING mode, discarding
 * the deep link's action params — so Answer never connects and Decline never
 * rejects.
 *
 * To fix that, the trampoline writes the chosen action HERE (plain
 * SharedPreferences — readable from any process, including a freshly relaunched
 * one). At JS boot the call-ringer module exposes it so notifeeService can MERGE
 * the real choice into the pending route, making the call screen's existing
 * autoAnswer / autoDecline effects fire acceptIncoming() / rejectIncoming().
 *
 * Entries are timestamped and TTL-guarded (mirrors the JS 60s pending-call TTL)
 * so a stale tap can never auto-answer a later unrelated call.
 */
object PendingCallActionStore {
  private const val PREFS_NAME = "wp_call_ringer_prefs"
  private const val KEY_ACTION = "pending_call_action"
  private const val TTL_MS = 60_000L

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  /** Record the user's Answer/Decline choice for the given call. */
  fun write(
    context: Context,
    action: String,
    callId: String,
    conversationId: String,
  ) {
    try {
      val json = JSONObject().apply {
        put("action", action)
        put("callId", callId)
        put("conversationId", conversationId)
        put("timestamp", System.currentTimeMillis())
      }
      prefs(context).edit().putString(KEY_ACTION, json.toString()).apply()
    } catch (_: Throwable) {
      // best-effort
    }
  }

  /**
   * Read the pending action as a plain map (or null when absent/stale/invalid).
   * Stale/invalid entries are cleared as a side effect. Does NOT clear a fresh
   * entry — the JS layer clears it explicitly after consuming.
   */
  fun read(context: Context): Map<String, String>? {
    return try {
      val raw = prefs(context).getString(KEY_ACTION, null) ?: return null
      val json = JSONObject(raw)
      val ts = json.optLong("timestamp", 0L)
      if (System.currentTimeMillis() - ts > TTL_MS) {
        clear(context)
        return null
      }
      val action = json.optString("action", "")
      val callId = json.optString("callId", "")
      val conversationId = json.optString("conversationId", "")
      if (action.isEmpty() || callId.isEmpty() || conversationId.isEmpty()) {
        clear(context)
        return null
      }
      mapOf(
        "action" to action,
        "callId" to callId,
        "conversationId" to conversationId,
      )
    } catch (_: Throwable) {
      clear(context)
      null
    }
  }

  /** Remove any recorded pending action. */
  fun clear(context: Context) {
    try {
      prefs(context).edit().remove(KEY_ACTION).apply()
    } catch (_: Throwable) {
      // best-effort
    }
  }
}