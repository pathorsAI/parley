package com.pathors.parley.feedback

/**
 * Why a problem report was sent — the `trigger` field of `POST /feedback`.
 *
 * The wire strings are a contract shared with iOS and the cloud, which refuses
 * anything outside this list with a 400; a report that 400s is dropped from the
 * offline queue and never arrives. So [wire] is spelled out per entry rather
 * than derived from the enum name, and a test pins every one of them.
 *
 * Every trigger but [CRASH] and [MANUAL] is a *prompt* the app raises on its
 * own, at the moment it knows something went wrong, and those are subject to
 * the client-side frequency limits in [PromptGate]. [CRASH] is sent
 * automatically (or offered once on the next launch), and [MANUAL] is somebody
 * who went looking for the report form — neither is ever held back.
 */
enum class FeedbackTrigger(val wire: String) {
    /** A recording of 20 s or more came back with no transcript at all. */
    EMPTY_TRANSCRIPT("empty_transcript"),

    /** A recording of 3 min or more whose transcript stops before half-way. */
    TRUNCATED_TRANSCRIPT("truncated_transcript"),

    /** One recording failed to sync three times running, or has waited a day. */
    SYNC_FAILED("sync_failed"),

    /** The microphone had to be recovered five or more times in one recording. */
    MIC_RECOVERY("mic_recovery"),

    /** A re-transcription finished; the chips ask what was wrong with the last one. */
    RETRANSCRIBE("retranscribe"),

    /** A recording that looked broken (empty or truncated) was just deleted. */
    DELETE_FAILED("delete_failed"),

    /** The last process crashed or hit an ANR. */
    CRASH("crash"),

    /** The system saw a screenshot of the app (Android 14+). */
    SCREENSHOT("screenshot"),

    /** "Report a problem" in the account sheet. */
    MANUAL("manual"),
    ;

    /** Whether [PromptGate]'s limits apply — everything the app raises by itself. */
    val isRateLimited: Boolean get() = this != CRASH && this != MANUAL

    companion object {
        fun fromWire(wire: String): FeedbackTrigger? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * The answers to "what was wrong last time?" after a re-transcription — the
 * `tags` of a [FeedbackTrigger.RETRANSCRIBE] report. Ids are the shared
 * contract; the copy is the app's own (`retranscribe_tag_*`).
 */
enum class RetranscribeTag(val id: String) {
    MISHEARD("misheard"),
    MISSING("missing"),
    SPEAKERS("speakers"),
    OTHER("other"),
}
