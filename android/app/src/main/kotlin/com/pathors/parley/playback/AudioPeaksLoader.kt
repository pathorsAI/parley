package com.pathors.parley.playback

import android.content.Context
import android.net.Uri
import android.util.Log
import com.pathors.parley.audio.AudioFileDecoder
import com.pathors.parley.audio.DecodeEvent
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.withContext

private const val TAG = "AudioPeaksLoader"

/**
 * Gets the overview waveform for a recording: out of the cache if it is there,
 * out of the audio if it is not.
 *
 * ## Why there is no Ogg parser here
 *
 * iOS had to write one (`AudioPeaks.compute` drives `ExtAudioFile` by hand)
 * because nothing on that platform would hand it 16 kHz mono float from an Ogg.
 * Android already has exactly that: [AudioFileDecoder] demuxes, Opus-decodes and
 * resamples to 16 kHz mono s16le for the import path, which is the same audio
 * the peaks are measured from. So this file is a decode loop and a cache, and
 * all the arithmetic lives in the pure [AudioPeaks].
 *
 * Decoding an hour of Opus takes a few seconds, which is why the result is
 * cached beside the audio and why [load] reports progress.
 */
object AudioPeaksLoader {

    /**
     * The cached overview for [id], computing and caching one if there is none.
     *
     * Returns null when the audio is missing or will not decode — a recording
     * with no waveform is drawn as an empty strip, which is the honest answer
     * and still scrubs (the player, not the waveform, owns the duration).
     *
     * [onProgress] reports the compute pass in 0…1; it never fires on a cache
     * hit, because there is nothing to wait for.
     */
    suspend fun load(
        context: Context,
        store: LocalAudioStore,
        id: String,
        onProgress: ((Float) -> Unit)? = null,
    ): AudioPeaks.Overview? = withContext(Dispatchers.IO) {
        val audio = store.audioFile(id)
        if (!audio.isFile) return@withContext null

        cached(store, id, audio)?.let { return@withContext it }

        val computed = try {
            compute(context, audio, onProgress)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // A waveform is an affordance, not the feature. Anything that goes
            // wrong measuring one leaves the player working without it.
            Log.w(TAG, "could not compute peaks for $id", e)
            null
        }
        computed?.also { store.putPeaks(it, id) }
    }

    /**
     * A cache entry is only trusted while it is newer than the audio it claims
     * to describe. Recording ids are reused when a download replaces a file that
     * was already here, and drawing the old file's waveform over the new one's
     * timeline is the kind of wrong that looks like a seek bug.
     */
    private fun cached(
        store: LocalAudioStore,
        id: String,
        audio: File,
    ): AudioPeaks.Overview? {
        val peaksFile = store.peaksFile(id)
        if (!peaksFile.isFile || peaksFile.lastModified() < audio.lastModified()) return null
        return store.peaks(id)?.takeIf { !it.isEmpty }
    }

    private suspend fun compute(
        context: Context,
        audio: File,
        onProgress: ((Float) -> Unit)?,
    ): AudioPeaks.Overview? {
        val accumulator = AudioPeaks.Accumulator()
        var lastReported = -1f
        AudioFileDecoder.decodeWithProgress(context, Uri.fromFile(audio)).collect { event ->
            if (event !is DecodeEvent.Chunk) return@collect
            accumulator.add(event.pcm)
            val fraction = event.progress
            // Whole percent only: a callback that recomposes a screen 3,600
            // times for an hour-long file is a stutter, not progress.
            if (onProgress != null && fraction >= 0f && fraction - lastReported >= 0.01f) {
                lastReported = fraction
                onProgress(fraction)
            }
        }
        onProgress?.invoke(1f)
        return accumulator.finish()
    }
}
