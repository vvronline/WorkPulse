package expo.modules.callringer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person as PersonCompat

/**
 * CallRingService
 *
 * A short-lived FOREGROUND SERVICE that drives the incoming-call ring in EVERY
 * app state (foreground, background, locked, killed) — the Signal/Teams model.
 *
 * WHY A FOREGROUND SERVICE INSTEAD OF THE NOTIFICATION CHANNEL SOUND:
 * An Android notification channel's sound is IMMUTABLE once created and is
 * subject to per-channel user overrides; relying on it makes the "selected
 * ringtone" brittle and gives no precise control over when the ring stops. By
 * owning a MediaPlayer (looping the selected ringtone) + a Vibrator (repeating
 * pattern) in a foreground service we get:
 *   • the user's SELECTED ringtone, played consistently in all states,
 *   • a guaranteed buzz pattern, and
 *   • an INSTANT, deterministic stop the moment the call is answered/declined/
 *     cancelled (just stopService) — no lingering ring.
 *
 * The service posts its OWN call notification using the Android CALL STYLE
 * template (NotificationCompat.CallStyle.forIncomingCall) so the system renders
 * a branded incoming-call UI with a GREEN "Answer" button and a RED "Decline"
 * button, plus a full-screen intent that surfaces the call over the lock screen.
 * The action buttons fire PendingIntent.getActivity() PendingIntents handled by
 * CallActionActivity (a transparent trampoline), which stops the ring and deep-
 * links into the JS call screen (single accept/reject path). Routing through an
 * Activity — NOT a BroadcastReceiver — is what makes "Answer" reliably bring the
 * app forward (a background BroadcastReceiver cannot startActivity() on Android
 * 10+ due to background-activity-start restrictions). This is what fixes both
 * "no Answer/Decline buttons in the status bar" and "Answer stops the ring but
 * the call screen never opens — I have to open the app manually".
 */
class CallRingService : Service() {

  private var mediaPlayer: MediaPlayer? = null
  private var vibrator: Vibrator? = null

  companion object {
    const val ACTION_START = "expo.modules.callringer.START"
    const val ACTION_STOP = "expo.modules.callringer.STOP"

    const val EXTRA_RINGTONE_RES = "ringtoneRes" // raw resource name, or empty
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    const val EXTRA_VIBRATE = "vibrate" // "1" / "0"
    const val EXTRA_SILENT = "silent" // "1" → no sound (muteAll / none)

    // Caller / call identity used to build the CallStyle UI + action deep links.
    const val EXTRA_CALL_ID = "callId"
    const val EXTRA_CONVERSATION_ID = "conversationId"
    const val EXTRA_CALLER_ID = "callerId"
    const val EXTRA_CALLER_NAME = "callerName"
    const val EXTRA_CALLER_AVATAR = "callerAvatar"
    // Bearer auth token (the user's JWT). The caller avatar lives behind the
    // server's `/uploads` auth middleware, so AvatarLoader must send it as an
    // Authorization header or the fetch 401s and no photo is shown.
    const val EXTRA_TOKEN = "token"
    const val EXTRA_CALL_TYPE = "callType"
    const val EXTRA_SCHEME = "scheme"

    private const val CHANNEL_ID = "call_ringer_fgs_v2"
    const val NOTIFICATION_ID = 909090

    // WorkPulse brand green used to theme the CallStyle notification accent.
    private val BRAND_COLOR = Color.parseColor("#22C55E")

    /**
     * Start the incoming-call ring foreground service.
     *
     * Returns TRUE when the (foreground) service start request was accepted by
     * the OS, FALSE when it was REFUSED. On Android 12+ (API 31+) calling
     * startForegroundService() from a BACKGROUNDED-but-alive process throws
     * ForegroundServiceStartNotAllowedException (background FGS-start
     * restriction). We surface that as `false` so the caller (notifeeService)
     * can FALL BACK to the Notifee full-screen-intent call notification — which
     * needs no foreground service — instead of leaving the incoming call with
     * no surface at all (the "desktop→android calls silently dropped while the
     * phone is backgrounded" regression).
     */
    fun start(context: Context, extras: Map<String, String>): Boolean {
      val intent = Intent(context, CallRingService::class.java).apply {
        action = ACTION_START
        for ((k, v) in extras) putExtra(k, v)
      }
      return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        true
      } catch (_: Throwable) {
        // ForegroundServiceStartNotAllowedException (API 31+) when started from
        // the background, or any OEM-specific refusal. Report failure so the
        // caller can fall back to the Notifee full-screen-intent notification.
        false
      }
    }

    fun stop(context: Context) {
      val intent = Intent(context, CallRingService::class.java).apply {
        action = ACTION_STOP
      }
      try {
        context.startService(intent)
      } catch (_: Throwable) {
        // If the service isn't running startService may throw on some OEMs —
        // fall back to a direct stop.
        context.stopService(Intent(context, CallRingService::class.java))
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopEverything()
        return START_NOT_STICKY
      }
      else -> {
        startRinging(intent)
      }
    }
    // Do NOT restart automatically if killed — a stale ring must never resurrect.
    return START_NOT_STICKY
  }

  private fun startRinging(intent: Intent?) {
    ensureChannel()

    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Incoming call"
    val body = intent?.getStringExtra(EXTRA_BODY) ?: ""
    val silent = intent?.getStringExtra(EXTRA_SILENT) == "1"
    val vibrate = intent?.getStringExtra(EXTRA_VIBRATE) != "0"
    val ringtoneRes = intent?.getStringExtra(EXTRA_RINGTONE_RES) ?: ""

    val callId = intent?.getStringExtra(EXTRA_CALL_ID) ?: ""
    val conversationId = intent?.getStringExtra(EXTRA_CONVERSATION_ID) ?: ""
    val callerId = intent?.getStringExtra(EXTRA_CALLER_ID) ?: ""
    val callerName = intent?.getStringExtra(EXTRA_CALLER_NAME) ?: title
    val callerAvatar = intent?.getStringExtra(EXTRA_CALLER_AVATAR) ?: ""
    val token = intent?.getStringExtra(EXTRA_TOKEN) ?: ""
    val callType = intent?.getStringExtra(EXTRA_CALL_TYPE) ?: "voice"
    val scheme = intent?.getStringExtra(EXTRA_SCHEME) ?: "workpulse"

    // Post the foreground notification FIRST, with NO avatar bitmap yet
    // (required within ~5s of startForegroundService or the OS throws — a
    // network avatar fetch must never block this). The avatar is loaded
    // asynchronously below and the notification is re-posted once it lands.
    val notification = buildCallNotification(
      title = title,
      body = body,
      callId = callId,
      conversationId = conversationId,
      callerId = callerId,
      callerName = callerName,
      callerAvatar = callerAvatar,
      callType = callType,
      scheme = scheme,
      avatarBitmap = null,
    )

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    // CALLER AVATAR (Signal-Android parity): load the caller's chat avatar off
    // the main thread, then RE-POST the same notification id with the avatar set
    // as the CallStyle Person icon + largeIcon. Best-effort: any failure just
    // leaves the already-posted text/icon notification untouched. Skipped when
    // no avatar URL was supplied.
    if (callerAvatar.isNotBlank()) {
      Thread {
        val bitmap = AvatarLoader.load(applicationContext, callerAvatar, token)
        if (bitmap != null) {
          try {
            val withAvatar = buildCallNotification(
              title = title,
              body = body,
              callId = callId,
              conversationId = conversationId,
              callerId = callerId,
              callerName = callerName,
              callerAvatar = callerAvatar,
              callType = callType,
              scheme = scheme,
              avatarBitmap = bitmap,
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager?.notify(NOTIFICATION_ID, withAvatar)
          } catch (_: Throwable) {
            // Re-notify is best-effort; the original notification still shows.
          }
        }
      }.apply { isDaemon = true }.start()
    }

    // Start the ringtone (unless silent).
    if (!silent) {
      startRingtone(ringtoneRes)
    }
    // Start vibration (unless silent or explicitly disabled).
    if (!silent && vibrate) {
      startVibration()
    }
  }

  /**
   * Builds the incoming-call notification using the Android CallStyle template so
   * the system renders the standard branded incoming-call UI with a green Answer
   * button and a red Decline button. Falls back to a plain ongoing notification
   * with explicit Answer/Decline actions on older platforms where CallStyle is
   * unavailable.
   */
  private fun buildCallNotification(
    title: String,
    body: String,
    callId: String,
    conversationId: String,
    callerId: String,
    callerName: String,
    callerAvatar: String,
    callType: String,
    scheme: String,
    // Pre-loaded, circular caller avatar bitmap (or null on the first text-only
    // pass / when no avatar is available). When present it is set as both the
    // CallStyle Person icon AND the notification largeIcon so the caller's chat
    // photo shows in the status-bar/lock-screen call UI (Signal-Android parity).
    avatarBitmap: Bitmap?,
  ): Notification {
    // Content (body tap) + FULL-SCREEN intent → open the app's call screen in
    // the RINGING (incoming) state WITHOUT auto-answering, so the user still
    // chooses Accept/Decline when the FSI auto-launches over the lock screen.
    val contentPending = openActivityPendingIntent(
      callId, conversationId, callerId, callerName, callerAvatar, callType, scheme,
      requestCode = 1000,
    )

    val answerPending = answerPendingIntent(
      callId, conversationId, callerId, callerName, callerAvatar, callType, scheme,
      requestCode = 1001,
    )
    val declinePending = declinePendingIntent(
      callId, conversationId, callerId, callerName, callerAvatar, callType, scheme,
      requestCode = 1002,
    )

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(callerName.ifEmpty { title })
      .setContentText(
        body.ifEmpty {
          if (callType == "video") "Incoming video call" else "Incoming voice call"
        },
      )
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setOngoing(true)
      .setAutoCancel(false)
      .setColor(BRAND_COLOR)
      .setColorized(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setFullScreenIntent(contentPending, true)

    // Caller's chat avatar as the notification largeIcon (collapsed/expanded
    // contact photo). Only set when the bitmap has been loaded (the async
    // re-notify pass) — the first text-only pass passes null so the foreground
    // service starts within the OS deadline.
    if (avatarBitmap != null) {
      builder.setLargeIcon(avatarBitmap)
    }

    // Prefer the CallStyle template (API 23+ via NotificationCompat). It renders
    // the system's branded green Answer / red Decline buttons.
    try {
      val personBuilder = PersonCompat.Builder()
        .setName(callerName.ifEmpty { title })
        .setImportant(true)
      // Attach the caller's chat avatar to the Person so the CallStyle template
      // shows the contact photo (Signal-Android CallNotificationBuilder parity).
      if (avatarBitmap != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        try {
          personBuilder.setIcon(
            androidx.core.graphics.drawable.IconCompat.createWithBitmap(avatarBitmap),
          )
        } catch (_: Throwable) {
          // Icon attach is best-effort; the name-only Person still renders.
        }
      }
      val caller = personBuilder.build()
      val callStyle = NotificationCompat.CallStyle.forIncomingCall(
        caller,
        declinePending,
        answerPending,
      )
      builder.setStyle(callStyle)
    } catch (_: Throwable) {
      // Fallback: explicit action buttons so Answer/Decline still appear.
      builder.setContentIntent(contentPending)
      builder.addAction(0, "Decline", declinePending)
      builder.addAction(0, "Answer", answerPending)
    }

    return builder.build()
  }

  /**
   * Content / full-screen PendingIntent that opens the JS call screen in the
   * RINGING (incoming) state WITHOUT auto-answering. Uses an ACTIVITY intent
   * (full-screen intents must target an activity) via the app deep link.
   */
  private fun openActivityPendingIntent(
    callId: String,
    conversationId: String,
    callerId: String,
    callerName: String,
    callerAvatar: String,
    callType: String,
    scheme: String,
    requestCode: Int,
  ): PendingIntent {
    val sb = StringBuilder()
    sb.append(scheme).append("://call/").append(conversationId)
    sb.append("?mode=incoming")
    sb.append("&callId=").append(Uri.encode(callId))
    sb.append("&callType=").append(Uri.encode(callType))
    sb.append("&peerId=").append(Uri.encode(callerId))
    sb.append("&peerName=").append(Uri.encode(callerName))
    sb.append("&peerAvatar=").append(Uri.encode(callerAvatar))

    val viewIntent = Intent(Intent.ACTION_VIEW, Uri.parse(sb.toString())).apply {
      setPackage(packageName)
      addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_CLEAR_TOP,
      )
    }
    return PendingIntent.getActivity(
      this,
      requestCode,
      viewIntent,
      pendingIntentFlags(),
    )
  }

  // Answer/Decline are backed by PendingIntent.getActivity() targeting the
  // transparent CallActionActivity trampoline — NOT getBroadcast() to a
  // BroadcastReceiver. A BroadcastReceiver cannot reliably startActivity() in
  // the background on Android 10+ (BAL restrictions), which caused "Answer in
  // the status bar stops the ring but never opens the call screen — I have to
  // open the app manually". An Activity launched by a notification action is
  // foreground-privileged and reliably brings the app forward in every state.
  private fun answerPendingIntent(
    callId: String,
    conversationId: String,
    callerId: String,
    callerName: String,
    callerAvatar: String,
    callType: String,
    scheme: String,
    requestCode: Int,
  ): PendingIntent {
    val intent = Intent(this, CallActionActivity::class.java).apply {
      action = CallActionActivity.ACTION_ANSWER
      addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_CLEAR_TOP,
      )
      putExtra(CallActionActivity.EXTRA_CALL_ID, callId)
      putExtra(CallActionActivity.EXTRA_CONVERSATION_ID, conversationId)
      putExtra(CallActionActivity.EXTRA_CALLER_ID, callerId)
      putExtra(CallActionActivity.EXTRA_CALLER_NAME, callerName)
      putExtra(CallActionActivity.EXTRA_CALLER_AVATAR, callerAvatar)
      putExtra(CallActionActivity.EXTRA_CALL_TYPE, callType)
      putExtra(CallActionActivity.EXTRA_SCHEME, scheme)
    }
    return PendingIntent.getActivity(
      this,
      requestCode,
      intent,
      pendingIntentFlags(),
    )
  }

  private fun declinePendingIntent(
    callId: String,
    conversationId: String,
    callerId: String,
    callerName: String,
    callerAvatar: String,
    callType: String,
    scheme: String,
    requestCode: Int,
  ): PendingIntent {
    val intent = Intent(this, CallActionActivity::class.java).apply {
      action = CallActionActivity.ACTION_DECLINE
      addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_CLEAR_TOP,
      )
      putExtra(CallActionActivity.EXTRA_CALL_ID, callId)
      putExtra(CallActionActivity.EXTRA_CONVERSATION_ID, conversationId)
      putExtra(CallActionActivity.EXTRA_CALLER_ID, callerId)
      putExtra(CallActionActivity.EXTRA_CALLER_NAME, callerName)
      putExtra(CallActionActivity.EXTRA_CALLER_AVATAR, callerAvatar)
      putExtra(CallActionActivity.EXTRA_CALL_TYPE, callType)
      putExtra(CallActionActivity.EXTRA_SCHEME, scheme)
    }
    return PendingIntent.getActivity(
      this,
      requestCode,
      intent,
      pendingIntentFlags(),
    )
  }

  private fun pendingIntentFlags(): Int {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
  }

  private fun startRingtone(ringtoneRes: String) {
    stopMediaPlayer()
    try {
      val uri: Uri = resolveRingtoneUri(ringtoneRes)
      val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
      mediaPlayer = MediaPlayer().apply {
        setDataSource(this@CallRingService, uri)
        setAudioAttributes(attrs)
        isLooping = true
        setOnPreparedListener { start() }
        // If preparation/playback fails, do not crash the service.
        setOnErrorListener { _, _, _ -> true }
        prepareAsync()
      }
    } catch (_: Throwable) {
      // Fall back to the system default ringtone if our bundled resource fails.
      try {
        val fallback = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        mediaPlayer = MediaPlayer().apply {
          setDataSource(this@CallRingService, fallback)
          isLooping = true
          setOnPreparedListener { start() }
          setOnErrorListener { _, _, _ -> true }
          prepareAsync()
        }
      } catch (_: Throwable) {
        // Give up silently — the notification still surfaces the call.
      }
    }
  }

  /**
   * Resolve a bundled res/raw resource name (e.g. "ringtone_classic") to a
   * content URI. Falls back to the system default ringtone when the name is
   * empty or the resource cannot be found.
   */
  private fun resolveRingtoneUri(ringtoneRes: String): Uri {
    if (ringtoneRes.isNotEmpty()) {
      val resId = resources.getIdentifier(ringtoneRes, "raw", packageName)
      if (resId != 0) {
        return Uri.parse("android.resource://$packageName/$resId")
      }
    }
    return RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
  }

  private fun startVibration() {
    try {
      val vib = obtainVibrator()
      vibrator = vib
      // Repeating real-call cadence: wait 0, buzz 700, pause 1000, repeat from
      // index 1 (so it loops the buzz/pause until cancelled).
      val timings = longArrayOf(0, 700, 1000)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val amplitudes = intArrayOf(0, VibrationEffect.DEFAULT_AMPLITUDE, 0)
        vib.vibrate(VibrationEffect.createWaveform(timings, amplitudes, 1))
      } else {
        @Suppress("DEPRECATION")
        vib.vibrate(timings, 1)
      }
    } catch (_: Throwable) {
      // best-effort
    }
  }

  private fun obtainVibrator(): Vibrator {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val manager =
        getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
      manager.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    // SILENT channel — the SOUND + VIBRATION are driven by the service's
    // MediaPlayer/Vibrator, NOT the channel, so the channel itself must be
    // silent to avoid a double-ring.
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Incoming call",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "Active incoming call ring"
      setSound(null, null)
      enableVibration(false)
      setBypassDnd(true)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    manager.createNotificationChannel(channel)
  }

  private fun stopMediaPlayer() {
    try {
      mediaPlayer?.let {
        if (it.isPlaying) it.stop()
        it.release()
      }
    } catch (_: Throwable) {
      // ignore
    }
    mediaPlayer = null
  }

  private fun stopVibration() {
    try {
      vibrator?.cancel()
    } catch (_: Throwable) {
      // ignore
    }
    vibrator = null
  }

  private fun stopEverything() {
    stopMediaPlayer()
    stopVibration()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
    } catch (_: Throwable) {
      // ignore
    }
    stopSelf()
  }

  override fun onDestroy() {
    stopMediaPlayer()
    stopVibration()
    super.onDestroy()
  }
}