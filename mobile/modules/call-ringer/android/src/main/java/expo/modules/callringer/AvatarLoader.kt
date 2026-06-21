package expo.modules.callringer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * AvatarLoader
 *
 * A tiny, dependency-free image loader for the caller's chat avatar used by the
 * CallStyle incoming-call notification (Signal-Android's CallNotificationBuilder
 * shows the contact photo as the notification's large icon / Person icon).
 *
 * Why hand-rolled instead of Glide/Coil:
 *   • The call-ringer module is a small local Expo module — pulling a full image
 *     library in just to fetch one bitmap would bloat the build and risk version
 *     clashes with the host app's own image stack.
 *   • We only need: download → decode → downscale → circular-crop → cache.
 *
 * Everything here is best-effort: any failure returns null and the notification
 * simply falls back to the app icon (no crash, no blocked ring).
 *
 * IMPORTANT: load() does BLOCKING network/disk I/O. Callers MUST invoke it from
 * a background thread (CallRingService spins one up and re-notifies on success),
 * never from the main thread.
 */
object AvatarLoader {

  // Target size for the notification large icon. Android shows it small, so a
  // 256px circle is plenty and keeps memory/decoding cheap.
  private const val TARGET_PX = 256
  // Network timeouts kept short so a slow avatar host can never delay the ring.
  private const val CONNECT_TIMEOUT_MS = 4000
  private const val READ_TIMEOUT_MS = 4000
  // Cache entries older than this are re-fetched (avatars can change).
  private const val CACHE_TTL_MS = 24L * 60L * 60L * 1000L // 24h

  /**
   * Loads [url] into a circular [Bitmap] sized for a notification large icon.
   * Returns null on any error (empty URL, network failure, decode failure).
   * Results are cached to the app cache dir keyed by a hash of the URL.
   *
   * [token] is the user's Bearer JWT. The avatar is served from the server's
   * `/uploads` route behind auth middleware, so without an
   * `Authorization: Bearer <token>` header the request 401s and no avatar is
   * shown. Pass an empty string for public/unauthenticated URLs.
   */
  fun load(context: Context, url: String?, token: String? = null): Bitmap? {
    if (url.isNullOrBlank()) return null
    return try {
      val cacheFile = cacheFileFor(context, url)
      val cached = readFreshCache(cacheFile)
      val raw = cached ?: downloadToCache(url, cacheFile, token)
      raw ?: return null
      circularCrop(raw)
    } catch (_: Throwable) {
      null
    }
  }

  private fun cacheFileFor(context: Context, url: String): File {
    val dir = File(context.cacheDir, "call_avatars").apply { mkdirs() }
    return File(dir, hash(url) + ".png")
  }

  private fun readFreshCache(file: File): Bitmap? {
    if (!file.exists()) return null
    if (System.currentTimeMillis() - file.lastModified() > CACHE_TTL_MS) return null
    return try {
      BitmapFactory.decodeFile(file.absolutePath)
    } catch (_: Throwable) {
      null
    }
  }

  private fun downloadToCache(url: String, cacheFile: File, token: String?): Bitmap? {
    var connection: HttpURLConnection? = null
    return try {
      connection = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        instanceFollowRedirects = true
        requestMethod = "GET"
        // The avatar lives behind the server's `/uploads` auth middleware, which
        // returns 401 without a Bearer token. Attach the user's JWT so the
        // notification can actually fetch the contact photo (mirrors the in-app
        // AuthedImage component, which sends the same header).
        if (!token.isNullOrBlank()) {
          setRequestProperty("Authorization", "Bearer $token")
        }
      }
      val code = connection.responseCode
      if (code !in 200..299) return null
      val bytes = connection.inputStream.use { it.readBytes() }
      if (bytes.isEmpty()) return null

      // Decode with downsampling so a large source photo doesn't allocate a huge
      // bitmap just to be scaled down to the notification icon size.
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
      val sample = computeInSampleSize(bounds.outWidth, bounds.outHeight, TARGET_PX)
      val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sample }
      val decoded =
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOpts) ?: return null

      val scaled = scaleToSquare(decoded, TARGET_PX)

      // Persist the (square, scaled) bitmap to cache for subsequent rings.
      try {
        cacheFile.outputStream().use { out ->
          scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
      } catch (_: Throwable) {
        // Cache write is best-effort.
      }
      scaled
    } catch (_: Throwable) {
      null
    } finally {
      try {
        connection?.disconnect()
      } catch (_: Throwable) {
        // ignore
      }
    }
  }

  private fun computeInSampleSize(width: Int, height: Int, target: Int): Int {
    if (width <= 0 || height <= 0) return 1
    var sample = 1
    var halfW = width / 2
    var halfH = height / 2
    while (halfW >= target && halfH >= target) {
      sample *= 2
      halfW /= 2
      halfH /= 2
    }
    return sample.coerceAtLeast(1)
  }

  private fun scaleToSquare(src: Bitmap, size: Int): Bitmap {
    // Center-crop to a square, then scale to the target size.
    val dim = minOf(src.width, src.height)
    val xOffset = (src.width - dim) / 2
    val yOffset = (src.height - dim) / 2
    val square =
      try {
        Bitmap.createBitmap(src, xOffset, yOffset, dim, dim)
      } catch (_: Throwable) {
        src
      }
    return try {
      Bitmap.createScaledBitmap(square, size, size, true)
    } catch (_: Throwable) {
      square
    }
  }

  private fun circularCrop(src: Bitmap): Bitmap {
    val size = minOf(src.width, src.height)
    val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(output)
    val paint = Paint().apply {
      isAntiAlias = true
      shader = BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
    }
    val rect = RectF(0f, 0f, size.toFloat(), size.toFloat())
    canvas.drawOval(rect, paint)
    // Defensive: ensure source rect matches (no-op when src is already square).
    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
    canvas.drawBitmap(src, Rect(0, 0, src.width, src.height), rect, paint)
    return output
  }

  private fun hash(input: String): String {
    return try {
      val digest = MessageDigest.getInstance("SHA-1").digest(input.toByteArray())
      digest.joinToString("") { "%02x".format(it) }
    } catch (_: Throwable) {
      input.hashCode().toString()
    }
  }
}