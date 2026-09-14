package com.pathors.parley.cloud

import androidx.annotation.StringRes
import com.pathors.parley.R
import com.pathors.parley.kit.BatchTranscriptionException
import java.io.IOException

/**
 * Why a hosted transcription did not happen, in terms a person can act on.
 *
 * The whole point of the mapping is that "sign in", "you're out of quota" and
 * "this file is simply too big" are three different actions — sharing wording
 * between them would hide that. Ported from `parley_batch_error` in
 * `src-tauri/src/replay.rs` by way of iOS `CloudError.batchTranscriptionMessage`.
 *
 * The enum carries no display copy, which is the Android half of the split: the
 * strings live in both `strings.xml` files (see [BatchTranscriptionProblem] for
 * how a caller gets at them), and this stays a plain value that a JVM unit test
 * can classify without a resource table.
 */
enum class BatchTranscriptionFailure {
    /** 401 — the session is dead. */
    SIGNED_OUT,

    /** 402 — the monthly hosted transcription allowance is spent. */
    QUOTA_EXHAUSTED,

    /**
     * 429 — the cloud caps how many transcriptions one account can have in
     * flight, counting live meetings too. So this usually means "you're
     * recording right now", which is a wait, not a failure.
     */
    TOO_MANY_IN_FLIGHT,

    /** 413 — the file is past what hosted transcription will take. */
    TOO_LARGE,

    /** 502 — the cloud is up but the transcription vendor behind it is not. */
    UPSTREAM_UNREACHABLE,

    /** The request never reached the server at all. */
    OFFLINE,

    /** The job ran and the cloud reported it failed; the reason is the detail. */
    JOB_FAILED,

    /** The poll cap ran out with the job still unsettled. */
    TIMED_OUT,

    /** Anything else, reported with its status and the cloud's own error code. */
    UNKNOWN,
}

/**
 * A [BatchTranscriptionFailure] plus what it takes to say something specific
 * about it — the HTTP status and the cloud's `{ "error": code }`, or the reason
 * a job gave for failing.
 *
 * Unrecognized statuses keep both so a bug report still carries detail; an
 * unhelpful body (an HTML error page, an empty one) simply yields no code and
 * the message falls back to the bare status.
 */
data class BatchTranscriptionProblem(
    val failure: BatchTranscriptionFailure,
    /** The HTTP status, or 0 for a failure that never reached HTTP. */
    val status: Int = 0,
    /** The cloud's error code, or a failed job's reason. Null when there is none. */
    val detail: String? = null,
) {

    /**
     * The string to put in front of the user. Pair it with [messageArgs]:
     *
     * ```kotlin
     * stringResource(problem.messageRes(), *problem.messageArgs())
     * ```
     */
    @StringRes
    fun messageRes(): Int = when (failure) {
        BatchTranscriptionFailure.SIGNED_OUT -> R.string.batch_error_signed_out
        BatchTranscriptionFailure.QUOTA_EXHAUSTED -> R.string.batch_error_quota
        BatchTranscriptionFailure.TOO_MANY_IN_FLIGHT -> R.string.batch_error_too_many
        BatchTranscriptionFailure.TOO_LARGE -> R.string.batch_error_too_large
        BatchTranscriptionFailure.UPSTREAM_UNREACHABLE -> R.string.batch_error_upstream
        BatchTranscriptionFailure.OFFLINE -> R.string.batch_error_offline
        BatchTranscriptionFailure.JOB_FAILED -> R.string.batch_error_job_failed
        BatchTranscriptionFailure.TIMED_OUT -> R.string.batch_error_timed_out
        BatchTranscriptionFailure.UNKNOWN ->
            if (detail.isNullOrEmpty()) {
                R.string.batch_error_http
            } else {
                R.string.batch_error_http_code
            }
    }

    /** The format arguments [messageRes] expects, in order. Often empty. */
    fun messageArgs(): Array<Any> = when (failure) {
        BatchTranscriptionFailure.JOB_FAILED -> arrayOf(detail.orEmpty())
        BatchTranscriptionFailure.UNKNOWN ->
            if (detail.isNullOrEmpty()) arrayOf(status) else arrayOf(status, detail)
        else -> emptyArray()
    }
}

/**
 * Classify whatever a backfill or an import threw.
 *
 * A [CloudException] carries its own status; a bare [IOException] is a socket or
 * DNS failure that never reached the cloud, which on a phone is nearly always
 * "no signal" and is worth saying so rather than reporting as a mystery.
 */
fun Throwable.asBatchTranscriptionProblem(): BatchTranscriptionProblem = when (this) {
    is BatchTranscriptionException.JobFailed ->
        BatchTranscriptionProblem(BatchTranscriptionFailure.JOB_FAILED, detail = reason)

    is BatchTranscriptionException.TimedOut ->
        BatchTranscriptionProblem(BatchTranscriptionFailure.TIMED_OUT)

    is CloudException -> when (status) {
        401 -> BatchTranscriptionProblem(BatchTranscriptionFailure.SIGNED_OUT, status)
        402 -> BatchTranscriptionProblem(BatchTranscriptionFailure.QUOTA_EXHAUSTED, status)
        429 -> BatchTranscriptionProblem(BatchTranscriptionFailure.TOO_MANY_IN_FLIGHT, status)
        413 -> BatchTranscriptionProblem(BatchTranscriptionFailure.TOO_LARGE, status)
        502 -> BatchTranscriptionProblem(BatchTranscriptionFailure.UPSTREAM_UNREACHABLE, status)
        // Status 0 is this client's marker for "never reached HTTP".
        0 -> BatchTranscriptionProblem(BatchTranscriptionFailure.OFFLINE)
        else -> BatchTranscriptionProblem(BatchTranscriptionFailure.UNKNOWN, status, code)
    }

    is IOException -> BatchTranscriptionProblem(BatchTranscriptionFailure.OFFLINE)

    else -> BatchTranscriptionProblem(BatchTranscriptionFailure.UNKNOWN)
}
