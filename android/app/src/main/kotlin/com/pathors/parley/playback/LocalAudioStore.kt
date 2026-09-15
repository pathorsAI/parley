package com.pathors.parley.playback

import android.content.Context
import com.pathors.parley.util.deleteQuietly
import java.io.File

/**
 * The audio this phone is holding on to, keyed by recording id.
 *
 * Until now the phone was a write-only device: a finished meeting's Ogg was
 * uploaded and then deleted (`PendingUploadQueue.remove`), so nothing recorded
 * here could ever be played back here. This is where the file lives instead —
 * one flat directory of `<recordingId>.ogg` under `filesDir`, the same container
 * the pending-upload queue already uses, and for the same reason: it survives
 * relaunches and is not swept by the system the way `cacheDir` is.
 *
 * Two kinds of file end up here and they are deliberately indistinguishable: a
 * recording made on this phone that was kept after uploading, and one made
 * somewhere else that was downloaded. "Is the audio on this phone" is the only
 * question anything asks, so there is only one answer to keep.
 *
 * The Android counterpart of iOS `ParleyKit/LocalAudioStore.swift`, with the
 * same layout and the same two file kinds. Backup exclusion is not done per
 * directory here because the manifest already sets `android:allowBackup="false"`
 * for the whole app.
 *
 * Every method does blocking file I/O; callers dispatch it off the main thread.
 */
class LocalAudioStore(private val directory: File) {

    /** Where this recording's audio would be, whether or not it is there. */
    fun audioFile(id: String): File = File(directory, "${fileName(id)}.ogg")

    fun has(id: String): Boolean = audioFile(id).isFile

    /**
     * Where this recording's overview waveform is cached — `<id>.peaks`, beside
     * the audio it was computed from.
     *
     * Here rather than in a cache directory of its own precisely so it shares
     * the audio's lifetime: the file is derived from the Ogg and is worthless
     * without it, so [remove] takes both and nothing can leave a stale waveform
     * behind to be drawn over the next file that reuses the id.
     */
    fun peaksFile(id: String): File = File(directory, "${fileName(id)}.peaks")

    /** A cached overview, or null if there is none or it will not parse. */
    fun peaks(id: String): AudioPeaks.Overview? {
        val file = peaksFile(id)
        if (!file.isFile) return null
        return runCatching { AudioPeaks.decode(file.readBytes()) }.getOrNull()
    }

    fun putPeaks(overview: AudioPeaks.Overview, id: String) {
        directory.mkdirs()
        val target = peaksFile(id)
        val temp = File(directory, "${fileName(id)}.peaks.tmp")
        runCatching {
            temp.writeBytes(AudioPeaks.encode(overview))
            if (target.exists()) target.deleteQuietly()
            if (!temp.renameTo(target)) {
                temp.copyTo(target, overwrite = true)
                temp.deleteQuietly()
            }
        }.onFailure { temp.deleteQuietly() }
    }

    /**
     * Take ownership of an Ogg: a **move**, not a copy.
     *
     * The callers are the upload path, which is done with the file, and the
     * download path, which wrote it to a temporary location. Copying would leave
     * two copies of an hour of audio on a phone, and whichever of them was
     * forgotten would be the one that never gets cleaned up.
     *
     * @return whether the file is now in the store. A false means the caller
     *   still owns [source] and has to decide what to do with it.
     */
    fun put(id: String, source: File): Boolean {
        if (!source.isFile) return false
        directory.mkdirs()
        val destination = audioFile(id)
        if (source.absolutePath == destination.absolutePath) return true
        if (destination.exists()) destination.deleteQuietly()
        if (source.renameTo(destination)) return true
        // Different filesystem (cacheDir → filesDir on some devices): copy.
        return runCatching {
            source.copyTo(destination, overwrite = true)
            source.deleteQuietly()
            true
        }.getOrDefault(false)
    }

    /** The audio and everything derived from it. See [peaksFile]. */
    fun remove(id: String) {
        audioFile(id).deleteQuietly()
        peaksFile(id).deleteQuietly()
    }

    /**
     * Everything, for the "remove downloaded audio" action in the account sheet.
     * The directory itself goes too — [put] recreates it, and an empty directory
     * left behind would make [totalBytes] and a fresh install disagree about
     * nothing.
     */
    fun removeAll() {
        directory.deleteRecursively()
    }

    /** How many recordings have their audio here. */
    fun count(): Int =
        directory.listFiles { file -> file.isFile && file.name.endsWith(".ogg") }?.size ?: 0

    /**
     * What the store costs, in bytes. Summed on demand rather than tracked:
     * files arrive by two paths and leave by three, and a counter that drifted
     * would be worse than a directory scan a settings sheet runs once.
     */
    fun totalBytes(): Long =
        directory.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L

    companion object {
        /** Same directory name as iOS: `<app files>/Audio`. */
        const val DIRECTORY_NAME = "Audio"

        fun default(context: Context): LocalAudioStore =
            LocalAudioStore(File(context.applicationContext.filesDir, DIRECTORY_NAME))

        /**
         * Recording ids are minted as lowercased UUIDs, so this is a no-op for
         * every id the app produces. It exists because the id reaches here from
         * a server response too, and an id carrying a `/` or a leading `.` would
         * otherwise write outside the store — a path, not a file name.
         */
        internal fun fileName(id: String): String {
            val safe = buildString(id.length) {
                id.forEach { character ->
                    append(
                        if (character.isLetterOrDigit() || character == '-' || character == '_') {
                            character
                        } else {
                            '-'
                        }
                    )
                }
            }
            return safe.ifEmpty { "unnamed" }
        }
    }
}
