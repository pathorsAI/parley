package com.pathors.parley.cloud

import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
     * Whether retrying the very same request could plausibly succeed: server
     * faults, rate limiting and request timeouts. A 4xx is otherwise the client's
     * fault and would fail identically forever.
     */
    val isRetryable: Boolean
        get() = status == 0 || status >= 500 || status == 408 || status == 429

    override fun toString(): String = "CloudException(status=$status, code=$code, message=$message)"
}

/**
 * HTTP client for the Parley cloud. Call-for-call the same contract as iOS
 * `ParleyKit/CloudClient.swift` and the desktop's `src/lib/cloud/{client,sync}.ts`
 * — the OSS app only ever speaks to the cloud over this public API.
 *
 * Scope note: this is the phone's slice of the contract (identity, usage,
 * personal recordings). Folders and organizations exist on the backend and on
 * iOS, but the Android app does not surface them yet; they are additive and can
 * be added here without touching callers.
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
) {
    private val base: HttpUrl = baseUrl.trimEnd('/').toHttpUrl()

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
     */
    suspend fun downloadAudio(id: String, destination: File) {
        execute(Request.Builder().url(url("recordings", id, "audio")).get()) { response ->
            withContext(Dispatchers.IO) {
                destination.parentFile?.mkdirs()
                val part = File(destination.parentFile, destination.name + ".part")
                val body = response.body ?: throw CloudException(0, "empty_audio_response")
                body.byteStream().use { input ->
                    part.outputStream().use { output -> input.copyTo(output) }
                }
                if (destination.exists()) destination.delete()
                if (!part.renameTo(destination)) {
                    part.copyTo(destination, overwrite = true)
                    part.delete()
                }
            }
        }
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

    // ── plumbing ─────────────────────────────────────────────────────────────

    private fun url(vararg segments: String): HttpUrl =
        base.newBuilder().apply { segments.forEach { addPathSegment(it) } }.build()

    private suspend fun getText(url: HttpUrl): String =
        execute(Request.Builder().url(url).get()) { response -> bodyText(response) }

    private suspend fun bodyText(response: Response): String =
        withContext(Dispatchers.IO) { response.body?.string().orEmpty() }

    /**
     * Send [builder] with the bearer header attached, map a non-2xx to a
     * [CloudException], and hand a still-open [Response] to [onSuccess]. The
     * response is always closed afterwards, including on failure.
     */
    private suspend fun <T> execute(
        builder: Request.Builder,
        onSuccess: suspend (Response) -> T,
    ): T {
        tokenProvider()?.let { builder.header("Authorization", "Bearer $it") }
        val response = await(http.newCall(builder.build()))
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

        private val APPLICATION_JSON = "application/json".toMediaType()
        private val AUDIO_OGG = "audio/ogg".toMediaType()
        private val EMPTY_BODY: RequestBody = "".toRequestBody(null)
    }
}
