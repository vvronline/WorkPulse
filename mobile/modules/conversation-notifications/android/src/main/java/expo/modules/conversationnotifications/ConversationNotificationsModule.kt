package expo.modules.conversationnotifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest

/**
 * Registers Android platform conversation metadata used by System UI to promote
 * MessagingStyle notifications into the native conversation template.
 *
 * The notification itself remains owned by Notifee. This module only creates:
 *   1. a stable, long-lived dynamic shortcut, and
 *   2. on Android 11+, a child notification channel linked to that shortcut.
 *
 * Every operation is best-effort and failures return null so message delivery can
 * continue through WorkPulse's normal parent channel.
 */
class ConversationNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ConversationNotifications")

    AsyncFunction("ensureConversation") { options: Map<String, String> ->
      val context = appContext.reactContext ?: return@AsyncFunction null

      val conversationId = options["conversationId"].orEmpty().trim()
      val title = options["title"].orEmpty().trim().ifEmpty { "Conversation" }
      val senderId = options["senderId"].orEmpty().trim()
      val senderName = options["senderName"].orEmpty().trim().ifEmpty { title }
      val avatarUri = options["avatarUri"].orEmpty().trim()
      val parentChannelId = options["parentChannelId"].orEmpty().trim()

      if (conversationId.isEmpty() || parentChannelId.isEmpty()) {
        return@AsyncFunction null
      }

      try {
        val stableSuffix = stableId(conversationId)
        val shortcutId = "wp-conversation-$stableSuffix"
        val channelId = "messages_v3_conversation_$stableSuffix"

        val personBuilder = Person.Builder()
          .setKey(
            if (senderId.isNotEmpty()) {
              "aino-user-$senderId"
            } else {
              "aino-conversation-$stableSuffix"
            }
          )
          .setName(senderName)

        loadLocalIcon(avatarUri)?.let { personBuilder.setIcon(it) }
        val person = personBuilder.build()

        val launchIntent = context.packageManager
          .getLaunchIntentForPackage(context.packageName)
          ?.apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse("aino://chat/$conversationId")
            putExtra("conversationId", conversationId)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
          }
          ?: Intent(Intent.ACTION_VIEW, Uri.parse("aino://chat/$conversationId")).apply {
            setPackage(context.packageName)
            putExtra("conversationId", conversationId)
          }

        val shortcutBuilder = ShortcutInfoCompat.Builder(context, shortcutId)
          .setShortLabel(title.take(40))
          .setLongLabel(title.take(80))
          .setIntent(launchIntent)
          .setLongLived(true)
          .setPersons(arrayOf(person))
          .setCategories(setOf("android.shortcut.conversation"))

        loadLocalIcon(avatarUri)?.let { shortcutBuilder.setIcon(it) }

        ShortcutManagerCompat.pushDynamicShortcut(context, shortcutBuilder.build())

        // Android 11 introduced platform conversation channels. The parent
        // channel must already exist; Notifee creates messages_v3 before calling
        // this module. Older Android versions still benefit from shortcutId on
        // the NotificationCompat builder and continue using the parent channel.
        val conversationChannelReady =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ensureConversationChannel(
              context = context,
              channelId = channelId,
              channelName = title,
              parentChannelId = parentChannelId,
              shortcutId = shortcutId,
            )
          } else {
            false
          }

        mapOf(
          "shortcutId" to shortcutId,
          "channelId" to if (conversationChannelReady) channelId else parentChannelId,
        )
      } catch (_: Throwable) {
        null
      }
    }
  }

  private fun ensureConversationChannel(
    context: Context,
    channelId: String,
    channelName: String,
    parentChannelId: String,
    shortcutId: String,
  ): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false

    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val parent = manager.getNotificationChannel(parentChannelId) ?: return false

    val existing = manager.getNotificationChannel(channelId)
    if (
      existing != null &&
      existing.parentChannelId == parentChannelId &&
      existing.conversationId == shortcutId
    ) {
      return true
    }

    val channel = NotificationChannel(
      channelId,
      channelName,
      parent.importance,
    ).apply {
      description = "Messages from $channelName"
      setConversationId(parentChannelId, shortcutId)
      setShowBadge(parent.canShowBadge())
      enableLights(parent.shouldShowLights())
      lightColor = parent.lightColor
      enableVibration(parent.shouldVibrate())
      vibrationPattern = parent.vibrationPattern
      lockscreenVisibility = parent.lockscreenVisibility
      setBypassDnd(parent.canBypassDnd())
      setSound(parent.sound, parent.audioAttributes)
    }

    manager.createNotificationChannel(channel)

    val created = manager.getNotificationChannel(channelId)
    return created?.parentChannelId == parentChannelId &&
      created.conversationId == shortcutId
  }

  private fun loadLocalIcon(uriString: String): IconCompat? {
    if (uriString.isBlank()) return null

    return try {
      val uri = Uri.parse(uriString)
      val path = when (uri.scheme?.lowercase()) {
        "file" -> uri.path
        null, "" -> uriString
        else -> null
      } ?: return null

      val file = File(path)
      if (!file.exists() || !file.isFile) return null

      val bitmap = BitmapFactory.decodeFile(file.absolutePath) ?: return null
      IconCompat.createWithAdaptiveBitmap(bitmap)
    } catch (_: Throwable) {
      null
    }
  }

  private fun stableId(value: String): String {
    val readable = value
      .lowercase()
      .replace(Regex("[^a-z0-9_-]"), "-")
      .trim('-')
      .take(32)

    if (readable.isNotEmpty()) return readable

    val digest = MessageDigest.getInstance("SHA-256")
      .digest(value.toByteArray())
      .take(8)
      .joinToString("") { byte -> "%02x".format(byte) }

    return digest
  }
}