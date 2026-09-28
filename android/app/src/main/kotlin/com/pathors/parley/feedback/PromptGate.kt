package com.pathors.parley.feedback

import com.pathors.parley.cloud.CloudJson
import com.pathors.parley.util.deleteQuietly
import java.io.File
import kotlinx.serialization.Serializable

/**
 * When the app may ask "send us diagnostics?" — the client-side frequency
 * limits every self-raised prompt goes through.
 *
 * Two rules, both from the shared spec (§4):
 *
 * 1. **Two brush-offs buy thirty days of quiet.** When somebody closes or
 *    ignores a kind of prompt twice, that kind is not shown again for 30 days.
 *    A prompt people have learned to swat is worse than none: it trains them
 *    to swat the next one too, including the one that matters.
 * 2. **One recording, one ask.** A given prompt is shown at most once for a
 *    given recording — whatever the answer was. Re-opening a broken recording
 *    to read it must not become a nag.
 *
 * [FeedbackTrigger.CRASH] and [FeedbackTrigger.MANUAL] are never limited: the
 * first is not a prompt (it is sent on its own, or offered once per crash), and
 * the second is somebody who came looking.
 *
 * A pure value with its transitions, so the rules are a unit test rather than a
 * behaviour spread across five screens; [PromptGateStore] keeps it on disk.
 *
 * "Ignored" is decided by the caller, and means the same thing everywhere: the
 * prompt was on screen and went away without being acted on — the × on an
 * inline prompt, a transient prompt timing out or being swiped, or the screen
 * holding an inline prompt being left with it still unanswered.
 */
@Serializable
data class PromptGate(
    /** Per trigger wire string: brush-offs since the last suppression. */
    val ignoredCounts: Map<String, Int> = emptyMap(),
    /** Per trigger wire string: epoch ms until which it stays quiet. */
    val quietUntil: Map<String, Long> = emptyMap(),
    /**
     * `"<trigger>:<recordingId>"` for every prompt already shown, oldest first,
     * capped at [MAX_REMEMBERED] — a phone with more broken recordings than
     * that has bigger problems than being asked twice about the oldest.
     */
    val shown: List<String> = emptyList(),
) {

    /** Whether [trigger] may be raised now, for [recordingId] when it is about one. */
    fun canShow(trigger: FeedbackTrigger, recordingId: String?, nowMs: Long): Boolean {
        if (!trigger.isRateLimited) return true
        val until = quietUntil[trigger.wire]
        if (until != null && nowMs < until) return false
        return recordingId == null || key(trigger, recordingId) !in shown
    }

    /** [trigger] was put on screen for [recordingId]; it will not be again. */
    fun markShown(trigger: FeedbackTrigger, recordingId: String?): PromptGate {
        if (!trigger.isRateLimited || recordingId == null) return this
        val entry = key(trigger, recordingId)
        if (entry in shown) return this
        return copy(shown = (shown + entry).takeLast(MAX_REMEMBERED))
    }

    /**
     * [trigger] was brushed off. The second time since the last quiet spell
     * starts a new one, and the count starts again from zero after it.
     */
    fun markIgnored(trigger: FeedbackTrigger, nowMs: Long): PromptGate {
        if (!trigger.isRateLimited) return this
        val count = (ignoredCounts[trigger.wire] ?: 0) + 1
        return if (count >= IGNORES_BEFORE_QUIET) {
            copy(
                ignoredCounts = ignoredCounts - trigger.wire,
                quietUntil = quietUntil + (trigger.wire to nowMs + QUIET_MS),
            )
        } else {
            copy(ignoredCounts = ignoredCounts + (trigger.wire to count))
        }
    }

    companion object {
        /** Brush-offs that start a quiet spell. */
        const val IGNORES_BEFORE_QUIET = 2

        /** How long a quiet spell lasts: 30 days. */
        const val QUIET_MS = 30L * 24 * 60 * 60 * 1000

        const val MAX_REMEMBERED = 500

        private fun key(trigger: FeedbackTrigger, recordingId: String) = "${trigger.wire}:$recordingId"
    }
}

/**
 * [PromptGate] on disk, in the feedback directory. Read-modify-write under a
 * lock on every change: prompts are rare and the file is small, and a cached
 * copy that went stale across two screens would ask twice.
 *
 * An unreadable file reads as a fresh gate. The cost is at most one extra
 * prompt per recording; the other direction — a corrupt file that silenced
 * every prompt forever — would cost the reports this whole feature is for.
 *
 * Blocking file I/O; callers dispatch it.
 */
class PromptGateStore(private val file: File) {
    private val lock = Any()

    fun read(): PromptGate = synchronized(lock) { readUnlocked() }

    /** Apply [change] and persist the result, which is also returned. */
    fun update(change: (PromptGate) -> PromptGate): PromptGate = synchronized(lock) {
        val next = change(readUnlocked())
        write(next)
        next
    }

    private fun readUnlocked(): PromptGate =
        runCatching { CloudJson.decodeFromString(PromptGate.serializer(), file.readText()) }
            .getOrDefault(PromptGate())

    private fun write(gate: PromptGate) {
        val directory = file.parentFile
        directory?.mkdirs()
        val temp = File(directory, "${file.name}.tmp")
        runCatching {
            temp.writeText(CloudJson.encodeToString(PromptGate.serializer(), gate))
            if (!temp.renameTo(file)) {
                temp.copyTo(file, overwrite = true)
                temp.deleteQuietly()
            }
        }.onFailure { temp.deleteQuietly() }
    }
}
