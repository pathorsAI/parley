package com.pathors.parley.kit

/**
 * The four report artifacts — the desktop's `StudyArtifactKey`, in the order
 * its generation chip lists them.
 */
enum class StudyArtifact { FINDINGS, ACTIONS, BRIEF, DELIVERY }

/** Where one stage stands — the desktop's `AsyncTaskStatus`. */
enum class StageStatus { IDLE, RUNNING, DONE, ERROR }

/** What the screen says about an artifact: a status, plus the derived "queued". */
enum class ArtifactDisplay { IDLE, QUEUED, RUNNING, DONE, ERROR }

/**
 * Everything the pipeline's decisions depend on, as plain values — the phone's
 * slice of the desktop's `StudyPipelineFacts`. The phone has no live mode, no
 * ingest wizard and no post-save diarization, so those facts are absent.
 */
data class StudyFacts(
    /** Spoken content to analyse. */
    val hasTranscript: Boolean,
    /** The hosted model can be asked: a personal cloud recording, signed in. */
    val canSpend: Boolean,
    /** "Analyse recordings automatically" is on, or this recording was asked for by hand. */
    val autoAnalyze: Boolean,
    val statuses: Map<StudyArtifact, StageStatus>,
) {
    fun status(artifact: StudyArtifact): StageStatus = statuses[artifact] ?: StageStatus.IDLE
}

/** The generation chip's whole read — the desktop's `StudyPipelineState`. */
data class StudyProgress(
    val displays: Map<StudyArtifact, ArtifactDisplay>,
    val done: Int,
    val errors: Int,
    /** Anything queued or generating right now. */
    val active: Boolean,
) {
    val total: Int get() = displays.size
}

/**
 * The study pipeline's topology and its display derivation — a port of the
 * pure half of the desktop's `src/lib/analysis/studyPipeline.ts`:
 *
 * ```
 * findings ──done──▶ action items ──settled──▶ brief
 *      └────done──▶ delivery
 * ```
 *
 * Both functions read the same [StudyFacts], so the scheduler and the screen
 * can never disagree about what is coming.
 */
object StudyPipeline {

    /**
     * The statuses a recording restores to from what its meta holds — the
     * desktop's `restoredStudyStatuses`:
     *
     * - findings and action items are decided separately; `analyzed` (both
     *   completed) marks even an EMPTY result as done, otherwise each falls back
     *   to its own content;
     * - a brief that failed last time (and none saved since) restores as an
     *   error, so it is retried by hand rather than on every open.
     */
    fun restoredStatuses(
        analyzed: Boolean,
        findingsCount: Int,
        actionItemsCount: Int,
        hasDelivery: Boolean,
        hasBrief: Boolean,
        briefFailed: Boolean,
    ): Map<StudyArtifact, StageStatus> {
        fun pick(done: Boolean, failed: Boolean = false) = when {
            done -> StageStatus.DONE
            failed -> StageStatus.ERROR
            else -> StageStatus.IDLE
        }
        return mapOf(
            StudyArtifact.FINDINGS to pick(analyzed || findingsCount > 0),
            StudyArtifact.ACTIONS to pick(analyzed || actionItemsCount > 0),
            StudyArtifact.BRIEF to pick(hasBrief, briefFailed),
            StudyArtifact.DELIVERY to pick(hasDelivery),
        )
    }

    private fun settled(status: StageStatus) = status == StageStatus.DONE || status == StageStatus.ERROR

    /** Which stages should START now — the whole topology, in one place. */
    fun evaluateStages(f: StudyFacts): List<StudyArtifact> {
        if (!f.hasTranscript || !f.autoAnalyze || !f.canSpend) return emptyList()
        val out = mutableListOf<StudyArtifact>()
        val findings = f.status(StudyArtifact.FINDINGS)
        val actions = f.status(StudyArtifact.ACTIONS)
        val analysisDone = findings == StageStatus.DONE
        if (findings == StageStatus.IDLE) out += StudyArtifact.FINDINGS
        if (analysisDone && actions == StageStatus.IDLE) out += StudyArtifact.ACTIONS
        if (analysisDone && f.status(StudyArtifact.DELIVERY) == StageStatus.IDLE) out += StudyArtifact.DELIVERY
        // The brief folds the action items in, so it waits for them to SETTLE —
        // done or error alike (an empty checklist is still a brief).
        if (analysisDone && settled(actions) && f.status(StudyArtifact.BRIEF) == StageStatus.IDLE) {
            out += StudyArtifact.BRIEF
        }
        return out
    }

    /**
     * One artifact as the screen should show it: an untouched ("idle") stage
     * reads QUEUED while a run is still coming — for the findings while one can
     * run at all, for the stages chained off it while the findings have not
     * failed (a failed analysis kills the chain).
     */
    fun display(f: StudyFacts, artifact: StudyArtifact): ArtifactDisplay {
        val status = f.status(artifact)
        val runPossible = f.autoAnalyze && f.canSpend && f.hasTranscript
        val queued = if (artifact == StudyArtifact.FINDINGS) {
            runPossible
        } else {
            runPossible && f.status(StudyArtifact.FINDINGS) != StageStatus.ERROR
        }
        return when (status) {
            StageStatus.IDLE -> if (queued) ArtifactDisplay.QUEUED else ArtifactDisplay.IDLE
            StageStatus.RUNNING -> ArtifactDisplay.RUNNING
            StageStatus.DONE -> ArtifactDisplay.DONE
            StageStatus.ERROR -> ArtifactDisplay.ERROR
        }
    }

    /** The chip's counts — the desktop's `deriveStudyPipeline`. */
    fun progress(f: StudyFacts): StudyProgress {
        val displays = StudyArtifact.entries.associateWith { display(f, it) }
        return StudyProgress(
            displays = displays,
            done = displays.values.count { it == ArtifactDisplay.DONE },
            errors = displays.values.count { it == ArtifactDisplay.ERROR },
            active = displays.values.any { it == ArtifactDisplay.QUEUED || it == ArtifactDisplay.RUNNING },
        )
    }
}
