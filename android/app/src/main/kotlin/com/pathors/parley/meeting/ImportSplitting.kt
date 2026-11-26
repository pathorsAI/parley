package com.pathors.parley.meeting

import android.content.Context
import android.net.Uri
import com.pathors.parley.audio.AudioFileDecoder
import com.pathors.parley.feedback.Log
import com.pathors.parley.kit.ImportSplit
import com.pathors.parley.kit.ImportSplitPlan
import com.pathors.parley.kit.PartTitleStyle
import kotlinx.coroutines.CancellationException

private const val TAG = "ImportSplitting"

/**
 * Whether the file at [uri] has to be imported in parts, read from its
 * container metadata (the track's `KEY_DURATION`, else `MediaMetadataRetriever`)
 * without decoding a sample — this runs right after the file is picked.
 *
 * Null when it imports whole: short enough for one hosted session, or of a
 * length the metadata does not say. A file that cannot even be opened is null
 * too, and the import reports that itself, exactly as before.
 */
suspend fun importSplitFor(context: Context, uri: Uri): ImportSplitPlan? {
    val durationMs = try {
        AudioFileDecoder.probe(context, uri).durationMs
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Log.w(TAG, "no duration for the picked file: ${e.message}")
        return null
    }
    return ImportSplit.plan(durationMs)
}

/**
 * The title of part [index] of [count] of an import named [name]: full-width
 * brackets in Chinese (`name（1/3）`), ASCII ones otherwise (`name (1/3)`).
 */
fun importPartTitle(context: Context, name: String, index: Int, count: Int): String {
    val language = context.resources.configuration.locales[0]?.language
    val style = if (language == "zh") PartTitleStyle.FULL_WIDTH else PartTitleStyle.ASCII
    return ImportSplit.partTitle(name, index, count, style)
}
