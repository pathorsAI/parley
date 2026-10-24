package com.pathors.parley.ui

import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/**
 * Hands a not-yet-uploaded recording's Ogg to the share sheet — the way out for
 * a recording the cloud keeps refusing (too large, say): save it to Files,
 * Drive, or send it on, instead of it being trapped on the phone.
 *
 * Served through the app's FileProvider (`<package>.audiofiles`, scoped to the
 * upload queue directory in `res/xml/shared_audio_paths.xml`) with a one-off
 * read grant, so nothing else can reach the queue.
 */
object PendingAudioShare {
    private const val AUTHORITY_SUFFIX = ".audiofiles"
    private const val OGG_MIME = "audio/ogg"

    /** @return false when the share sheet could not be shown. */
    fun share(context: Context, audio: File, title: String, chooserTitle: String): Boolean {
        val uri = runCatching {
            FileProvider.getUriForFile(context, context.packageName + AUTHORITY_SUFFIX, audio)
        }.getOrNull() ?: return false
        val send = Intent(Intent.ACTION_SEND)
            .setType(OGG_MIME)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .putExtra(Intent.EXTRA_TITLE, title)
            .putExtra(Intent.EXTRA_SUBJECT, title)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        // ClipData too, so the read grant reaches the chosen target and not
        // just the chooser.
        send.clipData = ClipData.newRawUri(title, uri)
        val chooser = Intent.createChooser(send, chooserTitle)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return runCatching { context.startActivity(chooser) }.isSuccess
    }
}
