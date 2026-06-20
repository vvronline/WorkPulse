package expo.modules.callringer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat

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
 * The service posts its OWN call notification (a FGS must show a notification)
 * with a full-screen intent + Answer/Decline actions, so it also surfaces the
 * incoming-call UI over the lock screen. The JS side passes the same action
 * PendingIntents via a launch Intent so taps route through the existing
 * Notifee/native handlers.
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

    private const val CHANNEL_ID = "call_ringer_fgs_v1"
    private const val NOTIFICATION_ID = 909090

    fun start(context: Context, extras: Map<String, String>) {
      val intent = Intent(context, CallRingService::class.java).apply {
        action = ACTION_START
        for ((k, v) in extras) putExtra(k, v)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
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

    // Post the foreground notification FIRST (required within ~5s of
    // startForegroundService or the OS throws). Build a content intent that
    // re-launches the app so a body tap opens the call UI.
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentPending = if (launchIntent != null) {
      PendingIntent.getActivity(
        this,
        0,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or
          (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0),
      )
    } else null

    val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(applicationInfo.icon)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setOngoing(true)
      .setAutoCancel(false)
      .apply {
        if (contentPending != null) {
          setContentIntent(contentPending)
          setFullScreenIntent(contentPending, true)
        }
      }
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
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