package com.pathors.parley.cloud

import com.pathors.parley.kit.BatchTranscriptionException
import java.io.IOException
import java.net.UnknownHostException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The three iOS `BatchTranscriptionTests` cases about user-facing wording, which
 * on Android live here rather than in `:parleykit`: the copy is in `strings.xml`
 * and the kit has no resources.
 *
 * What is asserted is the *classification*, not the words — the words are in two
 * files and a test that pinned them would have to be rewritten in two languages
 * every time somebody improved a sentence. What must not change is that the
 * statuses map to distinct outcomes, because the whole point is that "sign in",
 * "you're out of quota" and "this file is too big" are three different actions.
 */
class BatchTranscriptionFailureTest {

    @Test
    fun `each failure status names a different next step`() {
        val statuses = listOf(401, 402, 413, 429, 502)
        val failures = statuses.map {
            CloudException(it, "").asBatchTranscriptionProblem().failure
        }

        assertEquals(statuses.size, failures.toSet().size)
        assertTrue(failures.none { it == BatchTranscriptionFailure.UNKNOWN })
    }

    @Test
    fun `an unrecognized status keeps the status and the cloud's error code`() {
        val problem = CloudException(500, "upstream_dead", code = "upstream_dead")
            .asBatchTranscriptionProblem()

        assertEquals(BatchTranscriptionFailure.UNKNOWN, problem.failure)
        assertEquals(500, problem.status)
        assertEquals("upstream_dead", problem.detail)
        assertEquals(listOf<Any>(500, "upstream_dead"), problem.messageArgs().toList())
    }

    @Test
    fun `an unrecognized status survives a body that is not JSON`() {
        // An HTML error page or an empty body yields no error code, so the
        // message has to fall back to one that carries only the status — and to
        // a *different* string, because the two have different placeholders and
        // formatting the wrong one would throw at the point of display.
        val bare = CloudException(503, "<html>nope</html>").asBatchTranscriptionProblem()
        val withCode = CloudException(503, "x", code = "upstream_dead")
            .asBatchTranscriptionProblem()

        assertEquals(BatchTranscriptionFailure.UNKNOWN, bare.failure)
        assertEquals(listOf<Any>(503), bare.messageArgs().toList())
        assertNotEquals(bare.messageRes(), withCode.messageRes())
        assertEquals(bare.messageArgs().size + 1, withCode.messageArgs().size)
    }

    // ── the failures iOS reports through a different channel ─────────────────

    @Test
    fun `a job that failed carries the reason the cloud gave`() {
        val problem = BatchTranscriptionException.JobFailed("audio too short")
            .asBatchTranscriptionProblem()

        assertEquals(BatchTranscriptionFailure.JOB_FAILED, problem.failure)
        assertEquals(listOf<Any>("audio too short"), problem.messageArgs().toList())
    }

    @Test
    fun `a job that never settled is a timeout, not a mystery`() {
        val problem = BatchTranscriptionException.TimedOut(800).asBatchTranscriptionProblem()

        assertEquals(BatchTranscriptionFailure.TIMED_OUT, problem.failure)
        assertTrue(problem.messageArgs().isEmpty())
    }

    /**
     * A phone loses signal mid-upload far more often than a server 500s. Both a
     * raw socket failure and this client's status-0 marker have to read as "no
     * network", or the copy would blame the cloud for the lift being out of
     * range.
     */
    @Test
    fun `a request that never reached the cloud reads as offline`() {
        assertEquals(
            BatchTranscriptionFailure.OFFLINE,
            UnknownHostException("api.parley.tw").asBatchTranscriptionProblem().failure,
        )
        assertEquals(
            BatchTranscriptionFailure.OFFLINE,
            CloudException(0, "boom").asBatchTranscriptionProblem().failure,
        )
        assertEquals(
            BatchTranscriptionFailure.OFFLINE,
            IOException("socket closed").asBatchTranscriptionProblem().failure,
        )
    }
}
