package com.pathors.parley.voicetyping

import com.pathors.parley.kit.TranscriptSegment

/** The live transcript, split the way [TranscriptCommitter] needs it. */
data class DictationText(val settled: String = "", val tail: String = "")

/**
 * Flattens the relay's diarized segment stream into plain dictation text.
 *
 * Two rules, both inherited from
 * [SegmentBuilder][com.pathors.parley.kit.SegmentBuilder]:
 *
 * * a segment whose id ends in `-tail` is the **tentative tail** — one value,
 *   replaced wholesale on every frame;
 * * every other segment is a **settled run**, upserted by id (a run is re-emitted
 *   under the same id as it grows) and joined in arrival order.
 *
 * Dictation does not care who spoke, so speaker labels are dropped — the same
 * flattening iOS `DictationCoordinator` does with its `runs` array, extracted here
 * so it can be tested against real protocol frames without a socket or a
 * microphone.
 *
 * Not thread-safe: feed it from one thread (the relay's single reader).
 */
class DictationTextAssembler {
    private val runs = LinkedHashMap<String, String>()
    private var tail = ""

    /** Current text. */
    var text = DictationText()
        private set

    /** Fold one segment in and return the updated text. */
    fun accept(segment: TranscriptSegment): DictationText {
        if (segment.id.endsWith(TAIL_SUFFIX)) {
            tail = segment.text
        } else {
            runs[segment.id] = segment.text
        }
        text = DictationText(settled = runs.values.joinToString(""), tail = tail)
        return text
    }

    /**
     * End of session: the tentative tail becomes settled text, so nothing said
     * just before the stop is lost. `DictationCoordinator.finishUp`'s contract.
     */
    fun foldTail(): DictationText {
        if (tail.isNotEmpty()) {
            text = DictationText(settled = text.settled + tail, tail = "")
            tail = ""
        }
        return text
    }

    private companion object {
        /** `SegmentBuilder` names the tentative tail `{source}-tail`. */
        const val TAIL_SUFFIX = "-tail"
    }
}
