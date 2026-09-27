package com.pathors.parley.cloud

import com.pathors.parley.kit.BatchJobStatus
import com.pathors.parley.kit.BatchTranscriptResponse
import com.pathors.parley.kit.BatchTranscriptionService
import com.pathors.parley.util.deleteQuietly
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * JSON codec for every cloud call.
 *
 * - `ignoreUnknownKeys`: the backend adds fields (llmTokensUsed, activeOrganizationId …)
 *   without a client release.
 * - `explicitNulls = false`: null properties are OMITTED on encode, matching
 *   Swift's synthesized `encodeIfPresent`. This is what keeps the pushed summary
 *   byte-identical to the one iOS sends.
 * - `encodeDefaults = true`: a field that happens to equal its default (e.g.
 *   `findingsCount = 0`) must still be sent — it is part of the contract.
 */
val CloudJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    isLenient = false
}

/**
 * The process-wide OkHttp client. One instance means one connection pool and one
 * dispatcher for auth, sync and uploads.
 *
 * No overall call timeout: a pending-upload PUT can legitimately take minutes on
 * a bad connection, and the read/write timeouts already bound a *stalled* socket.
 */
object ParleyHttp {
    val shared: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.MINUTES)
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}

/**
 * A non-2xx cloud response.
 *
 * The 401/403 discipline is the same on every Parley client: **401 means the
 * session is dead** (the caller signs out), **403 is resource-level** — signed in
 * but not allowed — and must NOT clear auth, or the next 403 would log the user
 * out. 402 means the hosted quota is exhausted; the request is not retryable
 * until the period resets.
 *
 * [status] is 0 for a failure that never reached HTTP (a malformed callback,
 * a body that would not parse).
 */
class CloudException(
    val status: Int,
    override val message: String,
    /** The backend's own error code (`{ code }` from Better Auth, `{ error }` from the worker). */
    val code: String? = null,
) : IOException(message) {
    val isAuthExpired: Boolean get() = status == 401
    val isForbidden: Boolean get() = status == 403
    val isQuotaExhausted: Boolean get() = status == 402
    val isNotFound: Boolean get() = status == 404

    /**
     * [CloudClient.deleteAccount] was refused because the account still owns at
     * least one shared organization.
     *
     * Its own flag rather than a generic 409, because it is the one deletion
     * failure the user can actually act on — the backend refuses on purpose
     * (cloud `src/index.ts`, `DELETE /me`): silently removing a shared workspace
     * would take its other members' recordings with it. The workspace has to be
     * transferred or deleted first, which today means the desktop app.
     */
    val ownsOrganizations: Boolean
        get() = status == 409 && code == OWNED_ORGANIZATIONS

    /**
     * Whether retrying the very same request could plausibly succeed: server
     * faults, rate limiting and request timeouts. A 4xx is otherwise the client's
     * fault and would fail identically forever.
     */
    val isRetryable: Boolean
        get() = status == 0 || status >= 500 || status == 408 || status == 429

    override fun toString(): String = "CloudException(status=$status, code=$code, message=$message)"

    companion object {
        /** The worker's `{ error }` value behind [ownsOrganizations]. */
        const val OWNED_ORGANIZATIONS = "owned_organizations"
    }
}

/**
 * HTTP client for the Parley cloud. Call-for-call the same contract as iOS
 * `ParleyKit/CloudClient.swift` and the desktop's `src/lib/cloud/{client,sync}.ts`
 * — the OSS app only ever speaks to the cloud over this public API.
 *
 * Scope note: this is the phone's slice of the contract — identity, usage,
 * personal recordings, folders, and the organization calls the library needs
 * (list, read, delete, re-file, share into). Creating and managing
 * organizations stays on the desktop.
 *
 * @param tokenProvider the current bearer token, re-read per request so a
 *   sign-out mid-flight is honoured. A null token sends no `Authorization`
 *   header at all — deliberately, because `GET /me` answers `{ user: null }`
 *   with a 200 in that case, which is how "am I signed in?" is asked.
 * @param onUnauthorized invoked exactly when a 401 comes back, before the
 *   [CloudException] is thrown. Wire it to `AuthManager::clearSession`.
 */
class CloudClient(
    baseUrl: String = DEFAULT_BASE_URL,
    private val http: OkHttpClient = ParleyHttp.shared,
    private val tokenProvider: suspend () -> String?,
    private val onUnauthorized: suspend () -> Unit = {},
) : BatchTranscriptionService {
    private val base: HttpUrl = baseUrl.trimEnd('/').toHttpUrl()

    /**
     * The same connection pool with one whole-call bound, for `POST /stt/batch`.
     *
     * [ParleyHttp.shared] deliberately has no call timeout, because a queued
     * upload may legitimately take minutes. A batch job is different: the
     * request does not finish when the last byte is written — the cloud has to
     * ingest and store the blob before it answers, which is a *read* wait after
     * a long *write*, and the shared 60-second read timeout would give up on a
     * large file that is doing nothing wrong. 300 seconds for the whole call is
     * what iOS `CloudClient.batchUploadTimeout` allows.
     */
    private val batchUploadHttp: OkHttpClient by lazy {
        http.newBuilder()
            .callTimeout(BATCH_UPLOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }

    // ── identity / usage ─────────────────────────────────────────────────────

    /** `GET /me`. Null when the token is missing or expired (a 200, not an error). */
    suspend fun me(): CloudUser? =
        CloudJson.decodeFromString(MeResponse.serializer(), getText(url("me"))).user

    /** `GET /me/usage` — plan + metered balances. Creates a default grant on first read. */
    suspend fun usage(): HostedQuota =
        CloudJson.decodeFromString(HostedQuota.serializer(), getText(url("me", "usage")))

    /**
     * `POST /auth/sign-out` — revoke the session server-side. Prefer
     * `AuthManager.signOut()`, which clears the local token first and then calls
     * this best-effort; a failed revoke must not leave the app looking signed in.
     */
    suspend fun signOut() {
        execute(Request.Builder().url(url("auth", "sign-out")).post(EMPTY_BODY)) { }
    }

    /**
     * `DELETE /me` — permanently erase the account: the user row and everything
     * that cascades from it (sessions, linked providers, usage, memberships,
     * personal folders) plus every recording blob under this user's R2 prefixes.
     * Irreversible; there is no undo and no tombstone to restore from.
     *
     * The session token is dead the moment this returns, so the caller must clear
     * local auth (and anything still queued for upload) rather than sign out.
     *
     * Throws [CloudException] with [CloudException.ownsOrganizations] when the
     * account still owns a shared organization — a refusal to explain, not a
     * failure to retry. Same contract as iOS `CloudClient.deleteAccount()`.
     */
    suspend fun deleteAccount() {
        execute(Request.Builder().url(url("me")).delete()) { }
    }

    // ── recordings (personal) ────────────────────────────────────────────────

    /** `GET /recordings` — this account's non-deleted personal recordings. */
    suspend fun listRecordings(): List<RecordingSummary> =
        CloudJson.decodeFromString(RecordingsResponse.serializer(), getText(url("recordings")))
            .recordings

    /** `GET /recordings/{id}/meta` — the full entry JSON, unknown fields preserved. */
    suspend fun recordingMeta(id: String): RecordingMeta {
        val text = getText(url("recordings", id, "meta"))
        val element = runCatching { CloudJson.parseToJsonElement(text) }.getOrNull()
        val obj = element as? JsonObject
            ?: throw CloudException(0, "bad_meta_json", code = "bad_meta_json")
        return RecordingMeta(obj)
    }

    /**
     * `GET /recordings/{id}/audio` — stream the Ogg/Opus blob straight to
     * [destination]. Written to a sibling `.part` file and renamed on success, so
     * an interrupted download never leaves a half file that looks playable.
     *
     * [onProgress] is called as bytes land, with the running total and the
     * `Content-Length` the server declared (**-1 when it declared none**, which
     * a chunked response legitimately does). It is invoked from the IO thread
     * doing the copy, so a UI caller has to hop back itself, and it is called at
     * most once per [PROGRESS_INTERVAL_BYTES] rather than per read — a callback
     * that recomposes a screen 20,000 times for a 40 MB file is a stutter, not
     * progress. The final call always reports the true total, so a progress bar
     * finishes at exactly 1.
     */
    suspend fun downloadAudio(
        id: String,
        destination: File,
        onProgress: ((bytesRead: Long, totalBytes: Long) -> Unit)? = null,
    ) {
        execute(Request.Builder().url(url("recordings", id, "audio")).get()) { response ->
            withContext(Dispatchers.IO) {
                destination.parentFile?.mkdirs()
                val part = File(destination.parentFile, destination.name + ".part")
                val body = response.body ?: throw CloudException(0, "empty_audio_response")
                val expected = body.contentLength()
                try {
                    body.byteStream().use { input ->
                        part.outputStream().use { output ->
                            copyReporting(input, output, expected, onProgress)
                        }
                    }
                } catch (e: Throwable) {
                    // The `.part` file is the whole point: a cancelled or broken
                    // download must not survive as something a later run could
                    // mistake for a complete blob.
                    part.deleteQuietly()
                    throw e
                }
                if (destination.exists()) destination.deleteQuietly()
                if (!part.renameTo(destination)) {
                    part.copyTo(destination, overwrite = true)
                    part.deleteQuietly()
                }
            }
        }
    }

    private fun copyReporting(
        input: InputStream,
        output: OutputStream,
        expected: Long,
        onProgress: ((Long, Long) -> Unit)?,
    ) {
        if (onProgress == null) {
            input.copyTo(output)
            return
        }
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0L
        var reported = 0L
        onProgress(0L, expected)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            total += read
            if (total - reported >= PROGRESS_INTERVAL_BYTES) {
                reported = total
                onProgress(total, expected)
            }
        }
        onProgress(total, if (expected >= 0) expected else total)
    }

    /**
     * `PUT /recordings/{id}/audio` with the raw file as the body
     * (`Content-Type: audio/ogg`).
     *
     * ORDER MATTERS: audio is uploaded BEFORE [pushRecording], on every client.
     * A summary row claiming `hasAudio` before its blob exists would 404 the
     * download on another device — and the push is what records the blob's size.
     */
    suspend fun uploadAudio(id: String, ogg: File) {
        val body = ogg.asRequestBody(AUDIO_OGG)
        execute(Request.Builder().url(url("recordings", id, "audio")).put(body)) { }
    }

    /**
     * `POST /recordings/{id}` with `{ summary, meta }` — an idempotent upsert
     * keyed by the recording's UUID. Returns the server's `updatedAt` (epoch ms).
     */
    suspend fun pushRecording(id: String, summary: RecordingSummary, meta: RecordingMeta): Double? {
        val payload = buildString {
            append("{\"summary\":")
            append(CloudJson.encodeToString(RecordingSummary.serializer(), summary))
            append(",\"meta\":")
            append(meta.raw.toString())
            append("}")
        }
        val request = Request.Builder()
            .url(url("recordings", id))
            .post(payload.toRequestBody(APPLICATION_JSON))
        val text = execute(request) { response -> bodyText(response) }
        return runCatching {
            CloudJson.decodeFromString(PushResponse.serializer(), text).updatedAt
        }.getOrNull()
    }

    /** `DELETE /recordings/{id}` — tombstone the row and drop its blobs. */
    suspend fun deleteRecording(id: String) {
        execute(Request.Builder().url(url("recordings", id)).delete()) { }
    }

    /**
     * File a personal recording under [folderId] (null = the personal root).
     *
     * There is no folder endpoint for a personal recording: the folder is a
     * field of the entry, so moving one is a full re-push of the meta the cloud
     * already holds with that one field changed — iOS `LibraryView.moveToFolder`
     * and the desktop's `useRefile` do the same. The meta is re-read first rather
     * than taken from the caller so that a field another device wrote since the
     * list was fetched (a desktop analysis, a rename) survives the move.
     *
     * Hand-built rather than through [pushRecording] for one reason: un-filing
     * has to put `"folderId": null` in the *summary* too, the way the desktop's
     * `buildSummary` always does, and [CloudJson] omits nulls on encode. A
     * summary that merely lacked the key would be read by a merging server as
     * "no change".
     *
     * `updatedAt` is dropped from the summary: it is the server's write clock,
     * and echoing the old value back would be asking the server to date this
     * write in the past.
     *
     * @param summary the library card, when the caller has one; derived from the
     *   meta otherwise (the detail screen fetches nothing else).
     */
    suspend fun refileRecording(
        id: String,
        folderId: String?,
        summary: RecordingSummary? = null,
    ) {
        val meta = recordingMeta(id)
        val card = (summary ?: RecordingSummary.fromMeta(meta)).copy(updatedAt = null)
        val summaryJson = CloudJson.encodeToJsonElement(RecordingSummary.serializer(), card)
            .let { it as JsonObject }
            .let { encoded ->
                buildJsonObject {
                    encoded.forEach { (key, value) -> if (key != "folderId") put(key, value) }
                    put("folderId", folderId?.let(::JsonPrimitive) ?: JsonNull)
                }
            }
        val payload = buildJsonObject {
            put("summary", summaryJson)
            put("meta", meta.withFolderId(folderId).raw)
        }
        postJson(url("recordings", id), payload)
    }

    /**
     * `POST /recordings/{id}/share` — a server-side COPY of a personal recording
     * into an organization, optionally straight into one of its folders. The
     * personal original is untouched.
     *
     * "Move to organization" is this followed by [deleteRecording], in that
     * order and never the other: a failure half-way must leave the original
     * where it was (the desktop's `moveRecordingToOrg`, iOS `shareToOrg`).
     *
     * Not idempotent: the server mints a new org-side id per call, so a retry
     * after a lost response makes a second copy. Callers retry only what they
     * know did not land.
     */
    suspend fun shareRecording(id: String, orgId: String, folderId: String? = null) {
        val payload = buildJsonObject {
            put("orgId", JsonPrimitive(orgId))
            if (folderId != null) put("folderId", JsonPrimitive(folderId))
        }
        postJson(url("recordings", id, "share"), payload)
    }

    // ── folders (personal) ───────────────────────────────────────────────────

    /**
     * `GET /folders` — this account's folders. May include org folders on some
     * backends; callers that want the personal ones filter on
     * [CloudFolder.orgId], as iOS does.
     */
    suspend fun listFolders(): List<CloudFolder> =
        CloudJson.decodeFromString(FoldersResponse.serializer(), getText(url("folders"))).folders

    /**
     * `POST /folders` — create a personal folder.
     *
     * The id is minted here, not by the server, matching the desktop's
     * `createCloudFolder` and iOS `createFolder`: personal folders are a registry
     * every device mirrors, so the id a device writes into a recording's meta has
     * to be the id the row gets. That also makes the call idempotent — a retry
     * after a timeout re-syncs the same folder instead of leaving a duplicate.
     *
     * The response body is used when it is a `{ folder }` envelope and ignored
     * otherwise (the desktop never reads it): the request succeeded, so the row
     * that was asked for is the row that now exists.
     */
    suspend fun createFolder(
        name: String,
        id: String = newCloudId(),
        createdAtMs: Long = System.currentTimeMillis(),
    ): CloudFolder {
        val payload = buildJsonObject {
            put("id", JsonPrimitive(id))
            put("name", JsonPrimitive(name))
            put("createdAt", JsonPrimitive(createdAtMs))
        }
        val text = postJson(url("folders"), payload)
        return runCatching { CloudJson.decodeFromString(FolderEnvelope.serializer(), text).folder }
            .getOrNull()
            ?: CloudFolder(
                id = id,
                name = name,
                orgId = null,
                createdAt = createdAtMs.toDouble(),
                updatedAt = createdAtMs.toDouble(),
            )
    }

    // ── organizations ────────────────────────────────────────────────────────

    /**
     * `GET /orgs/mine` — every organization this account belongs to, each with
     * the account's own role. A bare JSON array; anything else reads as "none",
     * the way the desktop's `listMyOrgs` treats it.
     */
    suspend fun myOrgs(): List<CloudOrg> {
        val text = getText(url("orgs", "mine"))
        val array = runCatching { CloudJson.parseToJsonElement(text) }.getOrNull() as? JsonArray
            ?: return emptyList()
        return array.mapNotNull { item ->
            runCatching { CloudJson.decodeFromJsonElement(CloudOrg.serializer(), item) }.getOrNull()
        }
    }

    /** `GET /orgs/{orgId}/recordings` — the organization's shared library. */
    suspend fun orgRecordings(orgId: String): List<RecordingSummary> =
        CloudJson.decodeFromString(
            RecordingsResponse.serializer(),
            getText(url("orgs", orgId, "recordings")),
        ).recordings

    /** `GET /orgs/{orgId}/recordings/{id}/meta` — an org recording's full entry. */
    suspend fun orgRecordingMeta(orgId: String, id: String): RecordingMeta {
        val text = getText(url("orgs", orgId, "recordings", id, "meta"))
        val obj = runCatching { CloudJson.parseToJsonElement(text) }.getOrNull() as? JsonObject
            ?: throw CloudException(0, "bad_meta_json", code = "bad_meta_json")
        return RecordingMeta(obj)
    }

    /** `GET /orgs/{orgId}/folders` — the organization's folders. */
    suspend fun orgFolders(orgId: String): List<CloudFolder> =
        CloudJson.decodeFromString(
            FoldersResponse.serializer(),
            getText(url("orgs", orgId, "folders")),
        ).folders

    /**
     * `DELETE /orgs/{orgId}/recordings/{id}`. The server allows it to the
     * uploader and to an owner or admin; everyone else gets a 403.
     */
    suspend fun deleteOrgRecording(orgId: String, id: String) {
        execute(Request.Builder().url(url("orgs", orgId, "recordings", id)).delete()) { }
    }

    /**
     * `PATCH /orgs/{orgId}/recordings/{id}/folder` with `{ folderId }` — an org
     * recording's folder is a column of its own, not a field of the entry, so
     * unlike a personal move this is one small call. `null` is the org root and
     * is sent as an explicit JSON null.
     */
    suspend fun moveOrgRecordingToFolder(orgId: String, id: String, folderId: String?) {
        val payload = buildJsonObject {
            put("folderId", folderId?.let(::JsonPrimitive) ?: JsonNull)
        }
        val request = Request.Builder()
            .url(url("orgs", orgId, "recordings", id, "folder"))
            .patch(payload.toString().toRequestBody(APPLICATION_JSON))
        execute(request) { }
    }

    // ── hosted batch transcription ───────────────────────────────────────────
    //
    // The four calls behind `BatchTranscriber`, which drives them. Same
    // endpoints and same contract as iOS `CloudClient` and the desktop's
    // `parley_batch`; see `kit/BatchTranscription.kt` for why the audio is a
    // file here and a byte array there.

    /**
     * `POST /stt/batch` — create a job from already-compressed audio; the
     * response is the job id.
     *
     * The hints parameter is omitted entirely when empty so the cloud
     * auto-detects, rather than being handed an empty list to interpret.
     */
    override suspend fun startBatchJob(
        audio: File,
        diarization: Boolean,
        languageHints: List<String>,
    ): String {
        val url = url("stt", "batch").newBuilder()
            .addQueryParameter("diarization", if (diarization) "1" else "0")
            .apply {
                if (languageHints.isNotEmpty()) {
                    addQueryParameter("language_hints", languageHints.joinToString(","))
                }
            }
            .build()
        val request = Request.Builder().url(url).post(audio.asRequestBody(OCTET_STREAM))
        val text = execute(request, client = batchUploadHttp) { response -> bodyText(response) }
        return CloudJson.decodeFromString(BatchJobCreated.serializer(), text).id
    }

    override suspend fun batchJobStatus(id: String): BatchJobStatus =
        CloudJson.decodeFromString(
            BatchJobStatus.serializer(),
            getText(url("stt", "batch", id)),
        )

    override suspend fun batchTranscript(id: String): BatchTranscriptResponse =
        CloudJson.decodeFromString(
            BatchTranscriptResponse.serializer(),
            getText(url("stt", "batch", id, "transcript")),
        )

    /**
     * Best-effort cleanup so the cloud isn't left holding the audio. The
     * transcript is already downloaded by the time this runs, so every failure
     * here — expired session, no network, job already gone — is swallowed.
     */
    override suspend fun deleteBatchJob(id: String) {
        runCatching { execute(Request.Builder().url(url("stt", "batch", id)).delete()) { } }
    }

    // ── plumbing ─────────────────────────────────────────────────────────────

    private fun url(vararg segments: String): HttpUrl =
        base.newBuilder().apply { segments.forEach { addPathSegment(it) } }.build()

    private suspend fun getText(url: HttpUrl): String =
        execute(Request.Builder().url(url).get()) { response -> bodyText(response) }

    /** `POST` a JSON object and hand back the response body. */
    private suspend fun postJson(url: HttpUrl, payload: JsonObject): String =
        execute(
            Request.Builder().url(url).post(payload.toString().toRequestBody(APPLICATION_JSON)),
        ) { response -> bodyText(response) }

    private suspend fun bodyText(response: Response): String =
        withContext(Dispatchers.IO) { response.body?.string().orEmpty() }

    /**
     * Send [builder] with the bearer header attached, map a non-2xx to a
     * [CloudException], and hand a still-open [Response] to [onSuccess]. The
     * response is always closed afterwards, including on failure.
     */
    private suspend fun <T> execute(
        builder: Request.Builder,
        client: OkHttpClient = http,
        onSuccess: suspend (Response) -> T,
    ): T {
        tokenProvider()?.let { builder.header("Authorization", "Bearer $it") }
        val response = await(client.newCall(builder.build()))
        try {
            if (!response.isSuccessful) {
                val text = bodyText(response)
                if (response.code == 401) onUnauthorized()
                throw errorFor(response.code, text)
            }
            return onSuccess(response)
        } finally {
            response.close()
        }
    }

    /** Suspend on an OkHttp call; cancelling the coroutine cancels the request. */
    private suspend fun await(call: Call): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { runCatching { call.cancel() } }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (!continuation.isCancelled) continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                continuation.resume(response)
            }
        })
    }

    /** Pull the backend's own `{ code, message }` / `{ error }` out of an error body. */
    private fun errorFor(status: Int, body: String): CloudException {
        val obj = runCatching { CloudJson.parseToJsonElement(body) as? JsonObject }.getOrNull()
        val code = obj?.stringOrNull("code") ?: obj?.stringOrNull("error")
        val message = obj?.stringOrNull("message")
        return CloudException(
            status = status,
            message = message ?: code ?: body.take(300).ifEmpty { "cloud $status" },
            code = code,
        )
    }

    companion object {
        /** The production cloud. Same default as iOS and the desktop. */
        const val DEFAULT_BASE_URL = "https://api.parley.tw"

        /**
         * A lowercase UUID — the one id shape every Parley client mints for the
         * cloud, so an id is never the same row written two ways.
         */
        fun newCloudId(): String = UUID.randomUUID().toString().lowercase(Locale.ROOT)

        /** How often [downloadAudio] reports progress. See its doc. */
        private const val PROGRESS_INTERVAL_BYTES = 64L * 1024L

        /** See [batchUploadHttp]. The same 300 seconds iOS allows. */
        private const val BATCH_UPLOAD_TIMEOUT_SECONDS = 300L

        private val APPLICATION_JSON = "application/json".toMediaType()
        private val AUDIO_OGG = "audio/ogg".toMediaType()
        private val OCTET_STREAM = "application/octet-stream".toMediaType()
        private val EMPTY_BODY: RequestBody = "".toRequestBody(null)
    }
}
