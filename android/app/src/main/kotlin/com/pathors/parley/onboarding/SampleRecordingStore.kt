package com.pathors.parley.onboarding

import android.content.Context
import android.util.Log
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.RecordingSource
import com.pathors.parley.cloud.RecordingSummary
import com.pathors.parley.kit.GettingStartedStep
import com.pathors.parley.kit.SampleManifest
import com.pathors.parley.playback.LocalAudioStore
import com.pathors.parley.screenshot.DemoMode
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val TAG = "SampleRecording"

/**
 * The bundled sample recording — a two-minute first sales call — as a
 * **local-only** entry in the library. iOS `SampleRecordingStore`.
 *
 * ## Why local, and what that costs
 *
 * The library is the account's cloud recordings and nothing else, so the obvious
 * way in would be to upload the sample like an import. That would put a
 * fictional meeting into the user's account, sync it to their Mac, spend
 * transcription on words that are already written down, and leave them to
 * delete it everywhere. Instead the sample never leaves the phone:
 *
 * - the audio and the manifest are APK assets (`public/sample/`, shared with the
 *   desktop and iOS and copied in at build time — see `app/build.gradle.kts`);
 * - whether it is in the library, when it was added and which folder it is filed
 *   in are three values in DataStore;
 * - the library merges the one entry into the personal list, the detail screen
 *   reads its transcript from the manifest instead of the cloud, and the player
 *   reads the bundled audio.
 *
 * Filing works, locally: moving the sample into a folder records the folder's id
 * here, so the row shows under that folder exactly as a real recording would —
 * but nothing is written to the cloud. The cloud-only actions (download,
 * re-transcribe, share to an organization, delete from the cloud) are not offered
 * on it.
 *
 * Recognised everywhere by its id prefix, `sample-` ([SampleManifest.isSample]),
 * the same rule the desktop and iOS use.
 */
class SampleRecordingStore(
    context: Context,
    private val store: DataStore<Preferences>,
    scope: CoroutineScope,
    private val gettingStarted: GettingStartedStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val context = context.applicationContext

    /**
     * What is stored about the entry. The manifest itself is not — it is read
     * from the APK — so a later build that re-renders the sample updates the text
     * of an entry that is already in the library.
     */
    @Serializable
    data class Entry(
        /**
         * Which manifest was loaded, `zh-TW` or `en`. Kept so a phone whose
         * language changes keeps the recording it already has, rather than
         * swapping the meeting out from under a folder it was filed in.
         */
        val lang: String,
        /** Epoch ms. When it was added, which is what it sorts by. */
        val addedAtMs: Double,
        val folderId: String? = null,
    )

    /** The entry, or null when the sample is not in the library. */
    val entry: StateFlow<Entry?> =
        combine(DemoMode.enabled, DemoMode.sampleEntry, store.data) { demo, demoEntry, preferences ->
            if (demo) demoEntry else decode(preferences[ENTRY_KEY])
        }.stateIn(scope, SharingStarted.Eagerly, null)

    /**
     * Where the player finds the audio: a copy of the asset in the cache, made
     * on demand. The cache because it is derived from the APK and can always be
     * made again; its own directory so the account sheet's storage readout — and
     * its "remove downloaded audio" — never count or delete it.
     */
    val audioStore: LocalAudioStore = LocalAudioStore(File(this.context.cacheDir, AUDIO_DIRECTORY))

    private val manifests = mutableMapOf<String, SampleManifest?>()

    // ── the bundle ───────────────────────────────────────────────────────────

    /** The manifest for [lang], or null when this build does not carry it. Cached. */
    @Synchronized
    fun manifest(lang: String): SampleManifest? = manifests.getOrPut(lang) {
        runCatching {
            context.assets.open("$ASSET_DIRECTORY/sample.$lang.json")
                .bufferedReader()
                .use { SampleManifest.decode(it.readText()) }
        }.onFailure { Log.w(TAG, "no sample manifest for $lang", it) }.getOrNull()
    }

    /**
     * Whether this build carries the sample at all. False only for a build made
     * without the `public/sample` assets, where "Load sample" is not offered
     * rather than offered and broken.
     */
    fun isBundled(language: String): Boolean = manifest(SampleManifest.langFor(language)) != null

    /** The manifest of the entry in the library, if there is one. */
    fun manifestOf(entry: Entry?): SampleManifest? = entry?.let { manifest(it.lang) }

    // ── the entry ────────────────────────────────────────────────────────────

    /** The library row, or null when the sample is not in the library. */
    fun summary(entry: Entry?): RecordingSummary? {
        if (entry == null) return null
        val manifest = manifest(entry.lang) ?: return null
        return summaryOf(manifest, entry)
    }

    /** The transcript for the detail screen, when [id] is the sample's. */
    fun meta(id: String): RecordingMeta? {
        val entry = entry.value ?: return null
        val manifest = manifestOf(entry)?.takeIf { it.id == id } ?: return null
        return metaOf(manifest, entry)
    }

    /**
     * Put the sample in the library, in the language of [language]. Returns the
     * row, or null when this build does not carry it. Loading twice keeps the
     * first entry — its folder and its place in the list.
     *
     * Ticks "recorded": the checklist's first item is "have a recording to work
     * with", and the sample is offered as exactly that.
     */
    suspend fun load(language: String): RecordingSummary? {
        val existing = entry.value
        val loaded = existing ?: run {
            val lang = SampleManifest.langFor(language)
            if (manifest(lang) == null) return null
            Entry(lang = lang, addedAtMs = clock().toDouble()).also { save(it) }
        }
        val summary = summary(loaded) ?: return null
        gettingStarted.mark(GettingStartedStep.RECORDED)
        return summary
    }

    /** File the sample. Local only — see the class doc. */
    suspend fun setFolder(folderId: String?) {
        val current = entry.value ?: return
        save(current.copy(folderId = folderId))
    }

    /** Take the sample out of the library. The APK keeps the files, so the checklist can offer it again. */
    suspend fun remove() {
        if (DemoMode.isActive) {
            DemoMode.setSampleEntry(null)
            return
        }
        runCatching { store.edit { it.remove(ENTRY_KEY) } }
            .onFailure { Log.w(TAG, "could not remove the sample", it) }
        withContext(Dispatchers.IO) { audioStore.removeAll() }
    }

    /**
     * Make sure the player has the sample's audio to open: copy the asset into
     * [audioStore] if the cache does not hold it (first play, or the system
     * cleared the cache). Returns whether the file is there.
     */
    suspend fun ensureAudio(manifest: SampleManifest): Boolean = withContext(Dispatchers.IO) {
        val target = audioStore.audioFile(manifest.id)
        if (target.isFile && target.length() > 0L) return@withContext true
        val temp = File(target.parentFile, "${target.name}.tmp")
        try {
            target.parentFile?.mkdirs()
            context.assets.open("$ASSET_DIRECTORY/${manifest.audio}").use { input ->
                temp.outputStream().use { input.copyTo(it) }
            }
            temp.renameTo(target)
        } catch (e: IOException) {
            Log.w(TAG, "could not unpack the sample audio", e)
            temp.delete()
            false
        }
    }

    private suspend fun save(entry: Entry) {
        if (DemoMode.isActive) {
            DemoMode.setSampleEntry(entry)
            return
        }
        runCatching { store.edit { it[ENTRY_KEY] = json.encodeToString(Entry.serializer(), entry) } }
            .onFailure { Log.w(TAG, "could not save the sample", it) }
        // Let the flow catch up before the caller reads it back.
        store.data.first()
    }

    companion object {
        /** Where the build puts `public/sample` inside the APK's assets. */
        const val ASSET_DIRECTORY = "sample"
        private const val AUDIO_DIRECTORY = "SampleAudio"
        private const val SPEAKER_COUNT = 2

        private val ENTRY_KEY = stringPreferencesKey("sample-recording.entry")
        private val json = Json { ignoreUnknownKeys = true }

        private fun decode(value: String?): Entry? =
            value?.let { runCatching { json.decodeFromString(Entry.serializer(), it) }.getOrNull() }

        /** The library row for the sample. */
        internal fun summaryOf(manifest: SampleManifest, entry: Entry): RecordingSummary =
            RecordingSummary(
                id = manifest.id,
                title = manifest.title,
                source = RecordingSource.UPLOAD,
                createdAt = entry.addedAtMs,
                durationMs = manifest.durationMs,
                speakerCount = SPEAKER_COUNT,
                findingsCount = manifest.findings?.size,
                actionItemsCount = manifest.actionItems?.size,
                hasAudio = true,
                snippet = manifest.segments.firstOrNull()?.text,
                folderId = entry.folderId,
            )

        /**
         * A [RecordingMeta] shaped like a synced recording's, so the detail screen
         * reads the sample through exactly the code a real recording goes through.
         */
        internal fun metaOf(manifest: SampleManifest, entry: Entry): RecordingMeta =
            RecordingMeta(
                buildJsonObject {
                    put("id", manifest.id)
                    put("title", manifest.title)
                    put("source", RecordingSource.UPLOAD)
                    put("createdAt", entry.addedAtMs)
                    put("durationMs", manifest.durationMs)
                    put("audio", manifest.audio)
                    put("segments", segmentsJson(manifest))
                    put(
                        "speakerNames",
                        buildJsonObject { manifest.speakerNames.forEach { (key, name) -> put(key, name) } },
                    )
                    put("meetingContext", manifest.context.orEmpty())
                    manifest.meetingKind?.let { put("meetingKind", it) }
                    manifest.brief?.let { put("brief", it) }
                    put("findings", manifest.findings ?: JsonArray(emptyList()))
                    put("actionItems", manifest.actionItems ?: JsonArray(emptyList()))
                    put("folderId", entry.folderId?.let(::JsonPrimitive) ?: JsonNull)
                },
            )

        private fun segmentsJson(manifest: SampleManifest): JsonArray = buildJsonArray {
            manifest.transcriptSegments.forEach { segment ->
                add(
                    buildJsonObject {
                        put("id", segment.id)
                        put("source", segment.source)
                        put("speaker", segment.speaker)
                        put("text", segment.text)
                        put("isFinal", true)
                        put("startMs", segment.startMs)
                        put("endMs", segment.endMs)
                    },
                )
            }
        }
    }
}
