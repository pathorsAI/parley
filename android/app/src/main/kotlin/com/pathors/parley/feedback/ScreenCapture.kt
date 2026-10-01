package com.pathors.parley.feedback

import android.app.Activity
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import androidx.core.graphics.createBitmap
import androidx.core.graphics.scale
import androidx.core.view.drawToBitmap
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/**
 * A picture of the app's own window, for a report: the bitmap the report sheet
 * previews, and the JPEG that is sent if the person keeps it.
 */
class CapturedScreen(val preview: Bitmap, val jpeg: File) {
    /** "Remove screenshot", a closed sheet, an expired prompt: the file goes. */
    fun discard() {
        runCatching { jpeg.delete() }
    }
}

/**
 * Takes [CapturedScreen]s.
 *
 * **Only ever the app's own window**, never the screenshot the person just
 * took: that one is in their photo library, and reading it would need a media
 * permission and would reach into something that is theirs, not ours. What the
 * app can see of itself is what it drew, which is what a report needs anyway.
 *
 * `PixelCopy` rather than `View.drawToBitmap` where it works, because it reads
 * the composited window — including surfaces and hardware layers a software
 * draw of the view tree leaves blank. `drawToBitmap` is the fallback for a
 * window PixelCopy refuses (not yet attached, or already gone).
 *
 * Scaled so the long side is at most [MAX_SIDE_PX] and encoded as JPEG at
 * [JPEG_QUALITY], per spec §5; re-encoded smaller if that still exceeds the
 * cloud's 1.5 MB limit, and dropped rather than sent if even that does not fit.
 */
object ScreenCapture {

    const val MAX_SIDE_PX = 1600
    const val JPEG_QUALITY = 70
    private const val FALLBACK_QUALITY = 50
    const val MAX_BYTES = 1_500_000L

    suspend fun capture(activity: Activity): CapturedScreen? {
        val raw = copyWindow(activity) ?: return null
        return withContext(Dispatchers.Default) {
            val scaled = scaleToFit(raw)
            if (scaled !== raw) raw.recycle()
            val file = File(activity.cacheDir, "feedback-screen-${UUID.randomUUID()}.jpg")
            val written = runCatching {
                encode(scaled, file, JPEG_QUALITY)
                if (file.length() > MAX_BYTES) encode(scaled, file, FALLBACK_QUALITY)
                file.length() in 1..MAX_BYTES
            }.getOrDefault(false)
            if (written) {
                CapturedScreen(scaled, file)
            } else {
                file.delete()
                null
            }
        }
    }

    private suspend fun copyWindow(activity: Activity): Bitmap? {
        val window = activity.window ?: return null
        val view = window.decorView
        val width = view.width
        val height = view.height
        if (width <= 0 || height <= 0) return null
        val bitmap = createBitmap(width, height)
        val copied = suspendCancellableCoroutine { continuation ->
            try {
                PixelCopy.request(
                    window,
                    bitmap,
                    { result -> continuation.resume(result == PixelCopy.SUCCESS) },
                    Handler(Looper.getMainLooper()),
                )
            } catch (_: IllegalArgumentException) {
                continuation.resume(false)
            }
        }
        if (copied) return bitmap
        bitmap.recycle()
        return withContext(Dispatchers.Main) {
            runCatching { view.drawToBitmap() }.getOrNull()
        }
    }

    /** The long side down to [MAX_SIDE_PX]; never scaled up. */
    fun targetSize(width: Int, height: Int): Pair<Int, Int> {
        val longest = maxOf(width, height)
        if (longest <= MAX_SIDE_PX) return width to height
        val scale = MAX_SIDE_PX.toDouble() / longest
        return (width * scale).toInt().coerceAtLeast(1) to (height * scale).toInt().coerceAtLeast(1)
    }

    private fun scaleToFit(bitmap: Bitmap): Bitmap {
        val (width, height) = targetSize(bitmap.width, bitmap.height)
        if (width == bitmap.width && height == bitmap.height) return bitmap
        return bitmap.scale(width, height)
    }

    private fun encode(bitmap: Bitmap, file: File, quality: Int) {
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, quality, it) }
    }

    /** Whether this Android can tell the app a screenshot was taken (14+). */
    val detectsScreenshots: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
}
