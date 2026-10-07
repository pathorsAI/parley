package com.pathors.parley.study

import android.content.Context
import com.pathors.parley.cloud.CloudClient
import com.pathors.parley.cloud.CloudException
import com.pathors.parley.cloud.RecordingMeta
import com.pathors.parley.cloud.TranscriptSegmentDto
import com.pathors.parley.filing.FilingPass
import com.pathors.parley.kit.ActionItem
import com.pathors.parley.kit.AnalysisLens
import com.pathors.parley.kit.ChatCompletions
import com.pathors.parley.kit.CloudChat
import com.pathors.parley.kit.DeliveryAssessment
import com.pathors.parley.kit.EvalPresets
import com.pathors.parley.kit.FilingLanguage
import com.pathors.parley.kit.MeetingKind
import com.pathors.parley.kit.SpeakerLabel
import com.pathors.parley.kit.StageStatus
import com.pathors.parley.kit.StudyArtifact
import com.pathors.parley.kit.StudyFacts
import com.pathors.parley.kit.StudyMapping
import com.pathors.parley.kit.StudyPipeline
import com.pathors.parley.kit.StudyProgress
import com.pathors.parley.kit.StudyPromptBuilder
import com.pathors.parley.kit.StudyPrompts
import com.pathors.parley.kit.TimelineEvent
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.kit.ArtifactDisplay
import com.pathors.parley.ui.speakerStrings
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement

/** Why a stage failed — a code, so the screen owns the bilingual copy. */
enum class StudyFailure {
    /** The model did not answer within the stage's time limit. */
    TIMEOUT,

    /** The request never reached the cloud. */
    NETWORK,

    /** The hosted quota is used up (402). */
    QUOTA,

    /** The session is dead (401). */
    SIGNED_OUT,

    /** The cloud answered with an error. */
    SERVER,

    /** The model answered, but not with anything usable (no JSON, an empty brief). */
    UNREADABLE,
}

/**
 * Where the study stands for one recording: what the screen draws and what
 * the scheduler decides on. [facts] is the same value the desktop's
 * `factsOf` produces, so the chip, the sections and the scheduler agree.
 */
data class RecordingStudy(
    val statuses: Map<StudyArtifact, StageStatus>,
    val failures: Map<StudyArtifact, StudyFailure> = emptyMap(),
    /** Spoken content to analyse. */
    val hasTranscript: Boolean,
    /** "Analyse recordings automatically" was on when the recording was opened. */
    val autoAnalysis: Boolean,
    /** Somebody asked for a regeneration by hand — that runs whatever the switch says. */
    val manual: Boolean = false,
    /** The hosted model can be asked right now (signed in). */
    val canSpend: Boolean = true,
    /** Stages asked for by hand: they run even over a result that is already there. */
    val forced: Set<StudyArtifact> = emptySet(),
    /** "Regenerate all": once the forced findings pass succeeds, everything downstream reruns. */
    val cascade: Boolean = false,
    /** The newest meta a stage wrote or adopted, for the screen to show; null before any. */
    val meta: RecordingMeta? = null,
) {
    val facts: StudyFacts
        get() = StudyFacts(
            hasTranscript = hasTranscript,
            canSpend = canSpend,
            autoAnalyze = autoAnalysis || manual,
            statuses = statuses,
        )

    val progress: StudyProgress get() = StudyPipeline.progress(facts)

    fun display(artifact: StudyArtifact): ArtifactDisplay = StudyPipeline.display(facts, artifact)

    /** One pass at a time: regenerating anything while another output is being made would race the chain. */
    val anyRunning: Boolean get() = statuses.values.any { it == StageStatus.RUNNING }
}

/** The two cloud calls the pass needs besides the model — a seam for the tests. */
interface StudyCloud {
    suspend fun meta(recordingId: String): RecordingMeta

    /**
     * One read-modify-write of the recording's meta; [edit] may decline (null),
     * in which case nothing is pushed and null comes back. See
     * [CloudClient.editRecordingIf].
     */
    suspend fun editIf(recordingId: String, edit: (RecordingMeta) -> RecordingMeta?): RecordingMeta?
}

/**
 * The study pipeline on the phone: the four report artifacts the desktop
 * produces — findings (the timeline), action items, the brief, the delivery
 * read — generated on the hosted model and written into the recording's meta
 * in exactly the desktop's fields, so the desktop, iOS and Android all read
 * one shape. One per process (`AppContainer.study`), so a pass that outlives
 * the screen still lands, and reopening the recording finds it running rather
 * than starting a second one.
 *
 * ## The order (the desktop's `studyPipeline.ts`)
 *
 * ```
 * findings ──done──▶ action items ──settled──▶ brief
 *      └────done──▶ delivery
 * ```
 *
 * The topology itself is parleykit's pure [StudyPipeline]; this class is the
 * part that spends.
 *
 * ## Spend once, persist at once, back off if it is already done
 *
 * Each stage, like the filing pass:
 *
 * 1. re-reads the meta, and adopts a result another device has already
 *    written instead of spending (a stage asked for by hand skips this — it
 *    exists to replace the result);
 * 2. asks the model, with a per-call time limit;
 * 3. writes the result through one read-modify-write that RE-READS the meta
 *    first and declines when the field changed since step 1 — another device
 *    got there while this one was thinking, and its result is kept rather
 *    than overwritten by a competitor.
 *
 * A failure or a timeout always lands as [StageStatus.ERROR] with a
 * [StudyFailure]; nothing is ever left running. Only a failed brief is
 * persisted (`briefFailed`), as on the desktop, so it is retried by hand
 * rather than on every open.
 */
class StudyPass(
    private val cloud: StudyCloud,
    private val chat: ChatCompletions,
    private val scope: CoroutineScope,
    /** The app's UI language, read when a stage runs: the prose is written in it. */
    private val language: () -> FilingLanguage,
    /** The label for a speaker nobody has named — display copy, from the app's string table. */
    private val fallbackSpeakerLabel: (source: String, speaker: Int) -> String,
    /** "Analyse recordings automatically". */
    private val autoAnalysis: suspend () -> Boolean,
    /** Whether the hosted model can be asked (a stored session); read when a recording is opened. */
    private val canSpend: suspend () -> Boolean,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    /** Per-call time limits; the generated defaults, shorter in tests. */
    private val timeoutMs: (Call) -> Long = Call::defaultTimeoutMs,
) {
    /** One model call, for its time limit. */
    enum class Call(private val seconds: Int) {
        MEETING_KIND(StudyPrompts.TIMEOUT_SECONDS_MEETING_KIND),
        FINDINGS(StudyPrompts.TIMEOUT_SECONDS_FINDINGS),
        ACTION_ITEMS(StudyPrompts.TIMEOUT_SECONDS_ACTION_ITEMS),
        BRIEF(StudyPrompts.TIMEOUT_SECONDS_BRIEF),
        DELIVERY(StudyPrompts.TIMEOUT_SECONDS_DELIVERY),
        ;

        fun defaultTimeoutMs(): Long = seconds * MS_PER_SECOND
    }

    private val _state = MutableStateFlow<Map<String, RecordingStudy>>(emptyMap())

    /** Every recording the pass knows about this process, by id. */
    val state: StateFlow<Map<String, RecordingStudy>> = _state.asStateFlow()

    /**
     * The recording screen opened [recordingId] (a personal, cloud-synced
     * recording) with [meta]: take the stages' statuses from what the meta
     * holds — the desktop's `restoredStudyStatuses` — and start whatever is
     * owed. A stage running from an earlier visit stays running; a result
     * that arrived meanwhile (another device) wins over a failure remembered
     * from this process.
     */
    fun open(recordingId: String, meta: RecordingMeta) {
        scope.launch {
            val auto = try {
                autoAnalysis()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                true
            }
            val spend = canSpend()
            val restored = restoredStatuses(meta)
            _state.update { all ->
                val previous = all[recordingId]
                val statuses = restored.mapValues { (artifact, status) ->
                    val before = previous?.statuses?.get(artifact)
                    when {
                        before == StageStatus.RUNNING -> StageStatus.RUNNING
                        status == StageStatus.DONE -> StageStatus.DONE
                        before == StageStatus.ERROR -> StageStatus.ERROR
                        else -> status
                    }
                }
                all + (
                    recordingId to RecordingStudy(
                        statuses = statuses,
                        failures = previous?.failures.orEmpty().filterKeys { statuses[it] == StageStatus.ERROR },
                        hasTranscript = meta.segments.any { it.isFinal && it.text.isNotBlank() },
                        autoAnalysis = auto,
                        manual = previous?.manual ?: false,
                        canSpend = spend,
                        forced = previous?.forced.orEmpty(),
                        cascade = previous?.cascade ?: false,
                        meta = previous?.meta,
                    )
                    )
            }
            dispatch(recordingId)
        }
    }

    /**
     * Regenerate one artifact by hand: reset it and let the scheduler run it
     * in dependency order. A no-op while anything for the recording is running.
     */
    fun regenerate(recordingId: String, artifact: StudyArtifact) {
        var changed = false
        _state.update { all ->
            val study = all[recordingId]
            if (study == null || study.anyRunning) {
                changed = false
                return@update all
            }
            changed = true
            all + (
                recordingId to study.copy(
                    statuses = study.statuses + (artifact to StageStatus.IDLE),
                    failures = study.failures - artifact,
                    forced = study.forced + artifact,
                    manual = true,
                )
                )
        }
        if (changed) dispatch(recordingId)
    }

    /**
     * "Regenerate all" — the desktop's `reanalyzeAll`: one fresh findings
     * pass, then everything downstream again, but only if that pass
     * succeeded (a failed pass must not wipe good outputs).
     */
    fun regenerateAll(recordingId: String) {
        var changed = false
        _state.update { all ->
            val study = all[recordingId]
            if (study == null || study.anyRunning) {
                changed = false
                return@update all
            }
            changed = true
            all + (
                recordingId to study.copy(
                    statuses = study.statuses + (StudyArtifact.FINDINGS to StageStatus.IDLE),
                    failures = study.failures - StudyArtifact.FINDINGS,
                    forced = study.forced + StudyArtifact.FINDINGS,
                    manual = true,
                    cascade = true,
                )
                )
        }
        if (changed) dispatch(recordingId)
    }

    /** Start every stage whose prerequisites are met, marking them running in the same step. */
    private fun dispatch(recordingId: String) {
        var ready: List<StudyArtifact> = emptyList()
        _state.update { all ->
            val study = all[recordingId]
            if (study == null) {
                ready = emptyList()
                return@update all
            }
            ready = StudyPipeline.evaluateStages(study.facts)
            all + (
                recordingId to study.copy(
                    statuses = study.statuses + ready.associateWith { StageStatus.RUNNING },
                    failures = study.failures - ready.toSet(),
                )
                )
        }
        for (artifact in ready) {
            scope.launch {
                val outcome = try {
                    runStage(recordingId, artifact)
                } catch (e: CancellationException) {
                    finish(recordingId, artifact, Outcome.Failed(StudyFailure.TIMEOUT))
                    throw e
                }
                finish(recordingId, artifact, outcome)
            }
        }
    }

    private sealed interface Outcome {
        /** Done; [meta] is the meta now in the cloud, when the stage read or wrote one. */
        data class Done(val meta: RecordingMeta?) : Outcome

        data class Failed(val failure: StudyFailure, val meta: RecordingMeta? = null) : Outcome
    }

    private fun finish(recordingId: String, artifact: StudyArtifact, outcome: Outcome) {
        _state.update { all ->
            val study = all[recordingId] ?: return@update all
            val done = outcome is Outcome.Done
            var statuses = study.statuses + (artifact to if (done) StageStatus.DONE else StageStatus.ERROR)
            var failures = when (outcome) {
                is Outcome.Done -> study.failures - artifact
                is Outcome.Failed -> study.failures + (artifact to outcome.failure)
            }
            var forced = study.forced - artifact
            var cascade = study.cascade
            if (artifact == StudyArtifact.FINDINGS && cascade) {
                cascade = false
                if (done) {
                    val downstream = listOf(StudyArtifact.ACTIONS, StudyArtifact.BRIEF, StudyArtifact.DELIVERY)
                    statuses = statuses + downstream.associateWith { StageStatus.IDLE }
                    failures = failures - downstream.toSet()
                    forced = forced + downstream
                }
            }
            val meta = when (outcome) {
                is Outcome.Done -> outcome.meta
                is Outcome.Failed -> outcome.meta
            } ?: study.meta
            all + (
                recordingId to study.copy(
                    statuses = statuses,
                    failures = failures,
                    forced = forced,
                    cascade = cascade,
                    meta = meta,
                )
                )
        }
        dispatch(recordingId)
    }

    // ── the stages ───────────────────────────────────────────────────────────

    private suspend fun runStage(recordingId: String, artifact: StudyArtifact): Outcome {
        val forced = _state.value[recordingId]?.forced?.contains(artifact) == true
        return try {
            val meta = cloud.meta(recordingId)
            val input = Input(meta, language())
            when (artifact) {
                StudyArtifact.FINDINGS -> findings(recordingId, input, forced)
                StudyArtifact.ACTIONS -> actionItems(recordingId, input, forced)
                StudyArtifact.BRIEF -> brief(recordingId, input, forced)
                StudyArtifact.DELIVERY -> delivery(recordingId, input, forced)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: StageFailure) {
            Outcome.Failed(e.failure)
        } catch (e: Throwable) {
            Outcome.Failed(classify(e))
        }
    }

    /** What every stage reads off the freshly fetched meta. */
    private inner class Input(val meta: RecordingMeta, val language: FilingLanguage) {
        val segments: List<TranscriptSegment> = meta.segments.map { it.toKit() }
        private val label: (TranscriptSegment) -> String = { segment ->
            meta.speakerNames["${segment.source}-${segment.speaker}"]?.takeIf { it.isNotEmpty() }
                ?: fallbackSpeakerLabel(segment.source, segment.speaker)
        }
        val timestamped: String = StudyPromptBuilder.transcriptWithTimestamps(segments, label)
        val plain: String get() = StudyPromptBuilder.transcriptAsText(segments, label)
        val brief: String = StudyPromptBuilder.meetingBrief(
            meta.meetingContext,
            meta.meetingBatna,
            meta.meetingTarget,
            meta.meetingFloor,
        )
        val kind: MeetingKind? = MeetingKind.fromWire(meta.meetingKind)
    }

    private suspend fun findings(recordingId: String, input: Input, forced: Boolean): Outcome {
        val meta = input.meta
        if (!forced && (meta.analyzed || meta.findingsCount > 0)) return Outcome.Done(meta)
        val before = meta.raw[FINDINGS]
        // A kind set by hand (or by an earlier pass) is kept; only a missing one
        // is detected, and a failed detection reads as the decision lens.
        val kind = input.kind ?: detectKind(input)
        val lens = AnalysisLens.of(kind)
        val evals = EvalPresets.forKind(kind, input.language)
        val answer = ask(
            Call.FINDINGS,
            StudyPromptBuilder.request(
                StudyPrompts.MODEL_FINDINGS,
                StudyPromptBuilder.timelineSystem(lens, input.language) +
                    StudyPromptBuilder.phoneSchema(StudyPrompts.SCHEMA_TIMELINE.getValue(lens.wire)),
                StudyPromptBuilder.timelinePrompt(input.brief, evals, input.timestamped),
            ),
        )
        val events = StudyMapping.timelineEvents(answer, input.segments, evals, lens) { newId() }
            ?: throw StageFailure(StudyFailure.UNREADABLE)
        val written = cloud.editIf(recordingId) { fresh ->
            if (fresh.raw[FINDINGS] != before) null else fresh.withFindings(TimelineEvent.listToJson(events), kind?.wire)
        }
        return Outcome.Done(written ?: cloud.meta(recordingId))
    }

    /** The cheap classification the findings pass is shaped by; null when it fails. */
    private suspend fun detectKind(input: Input): MeetingKind? = try {
        StudyMapping.meetingKind(
            ask(
                Call.MEETING_KIND,
                StudyPromptBuilder.request(
                    StudyPrompts.MODEL_MEETING_KIND,
                    StudyPromptBuilder.meetingKindSystem() +
                        StudyPromptBuilder.phoneSchema(StudyPrompts.SCHEMA_MEETING_KIND),
                    StudyPromptBuilder.meetingKindPrompt(input.brief, input.timestamped),
                ),
            ),
        )
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        null
    }

    private suspend fun actionItems(recordingId: String, input: Input, forced: Boolean): Outcome {
        val meta = input.meta
        if (!forced && (meta.analyzed || meta.actionItemsCount > 0)) return Outcome.Done(meta)
        val before = meta.raw[ACTION_ITEMS]
        val findings = TimelineEvent.listFromJson(meta.raw[FINDINGS])
        val lens = AnalysisLens.of(input.kind)
        val answer = ask(
            Call.ACTION_ITEMS,
            StudyPromptBuilder.request(
                StudyPrompts.MODEL_ACTION_ITEMS,
                StudyPromptBuilder.actionItemsSystem(lens, input.language) +
                    StudyPromptBuilder.phoneSchema(StudyPrompts.SCHEMA_ACTION_ITEMS),
                StudyPromptBuilder.actionItemsPrompt(input.brief, findings, input.timestamped),
            ),
        )
        val items = StudyMapping.actionItems(answer, findings) { newId() }
            ?: throw StageFailure(StudyFailure.UNREADABLE)
        val written = cloud.editIf(recordingId) { fresh ->
            if (fresh.raw[ACTION_ITEMS] != before) null else fresh.withActionItems(ActionItem.listToJson(items))
        }
        return Outcome.Done(written ?: cloud.meta(recordingId))
    }

    private suspend fun brief(recordingId: String, input: Input, forced: Boolean): Outcome {
        val meta = input.meta
        if (!forced && meta.brief.isNotEmpty()) return Outcome.Done(meta)
        val before = meta.raw[BRIEF]
        val lens = AnalysisLens.of(input.kind)
        val text = try {
            ask(
                Call.BRIEF,
                StudyPromptBuilder.request(
                    StudyPrompts.MODEL_BRIEF,
                    StudyPromptBuilder.briefSystem(lens, input.language),
                    StudyPromptBuilder.briefPrompt(
                        input.brief,
                        EvalPresets.forKind(input.kind, input.language),
                        ActionItem.listFromJson(meta.raw[ACTION_ITEMS]),
                        input.timestamped,
                    ),
                ),
            ).takeIf { it.isNotBlank() } ?: throw StageFailure(StudyFailure.UNREADABLE)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // An empty or failed brief is persisted as such: it restores as an
            // error, retried by hand, instead of re-running on every open.
            val failure = (e as? StageFailure)?.failure ?: classify(e)
            val marked = runCatching {
                cloud.editIf(recordingId) { fresh -> if (fresh.raw[BRIEF] != before) null else fresh.withBriefFailed() }
            }.getOrNull()
            return Outcome.Failed(failure, marked)
        }
        val written = cloud.editIf(recordingId) { fresh ->
            if (fresh.raw[BRIEF] != before) null else fresh.withBrief(text)
        }
        return Outcome.Done(written ?: cloud.meta(recordingId))
    }

    private suspend fun delivery(recordingId: String, input: Input, forced: Boolean): Outcome {
        val meta = input.meta
        if (!forced && meta.deliveryAssessment != null) return Outcome.Done(meta)
        val before: JsonElement? = meta.raw[DELIVERY]
        val answer = ask(
            Call.DELIVERY,
            StudyPromptBuilder.request(
                StudyPrompts.MODEL_DELIVERY,
                StudyPromptBuilder.deliverySystem(input.language) +
                    StudyPromptBuilder.phoneSchema(StudyPrompts.SCHEMA_DELIVERY),
                StudyPromptBuilder.deliveryPrompt(input.brief, meta.speechRateHz, input.language, input.plain),
            ),
        )
        val assessment: DeliveryAssessment = StudyMapping.deliveryAssessment(answer)
            ?: throw StageFailure(StudyFailure.UNREADABLE)
        val written = cloud.editIf(recordingId) { fresh ->
            if (fresh.raw[DELIVERY] != before) null else fresh.withDeliveryAssessment(assessment.toJson())
        }
        return Outcome.Done(written ?: cloud.meta(recordingId))
    }

    /** One model call within its time limit; the assistant's text, or a failure. */
    private suspend fun ask(call: Call, request: CloudChat.Request): String {
        val response = withTimeoutOrNull(timeoutMs(call)) { chat.chatCompletion(CloudChat.encode(request)) }
            ?: throw StageFailure(StudyFailure.TIMEOUT)
        return CloudChat.content(response) ?: throw StageFailure(StudyFailure.UNREADABLE)
    }

    private class StageFailure(val failure: StudyFailure) : Exception(failure.name)

    companion object {
        private const val MS_PER_SECOND = 1000L
        private const val FINDINGS = "findings"
        private const val ACTION_ITEMS = "actionItems"
        private const val BRIEF = "brief"
        private const val DELIVERY = "deliveryAssessment"
        private const val HTTP_PAYMENT_REQUIRED = 402
        private const val HTTP_UNAUTHORIZED = 401

        /** The statuses [meta] restores to — the desktop's `restoredStudyStatuses`. */
        fun restoredStatuses(meta: RecordingMeta): Map<StudyArtifact, StageStatus> =
            StudyPipeline.restoredStatuses(
                analyzed = meta.analyzed,
                findingsCount = meta.findingsCount,
                actionItemsCount = meta.actionItemsCount,
                hasDelivery = meta.deliveryAssessment != null,
                hasBrief = meta.brief.isNotEmpty(),
                briefFailed = meta.briefFailed,
            )

        fun classify(error: Throwable): StudyFailure = when (error) {
            is CloudException -> when (error.status) {
                HTTP_PAYMENT_REQUIRED -> StudyFailure.QUOTA
                HTTP_UNAUTHORIZED -> StudyFailure.SIGNED_OUT
                else -> StudyFailure.SERVER
            }
            is IOException -> StudyFailure.NETWORK
            else -> StudyFailure.SERVER
        }

        /** The pass as the app runs it: the cloud client, its string table, its UI language. */
        fun create(
            context: Context,
            cloud: CloudClient,
            scope: CoroutineScope,
            settings: StudySettings,
            canSpend: suspend () -> Boolean,
        ): StudyPass {
            val app = context.applicationContext
            return StudyPass(
                cloud = object : StudyCloud {
                    override suspend fun meta(recordingId: String): RecordingMeta = cloud.recordingMeta(recordingId)

                    override suspend fun editIf(
                        recordingId: String,
                        edit: (RecordingMeta) -> RecordingMeta?,
                    ): RecordingMeta? = cloud.editRecordingIf(recordingId, null, edit)
                },
                chat = cloud.studyChat,
                scope = scope,
                language = { FilingPass.uiLanguage(app) },
                fallbackSpeakerLabel = { source, speaker -> SpeakerLabel.fallback(source, speaker, speakerStrings(app)) },
                autoAnalysis = settings::autoAnalysisNow,
                canSpend = canSpend,
            )
        }
    }
}

/** A stored segment as the kit reads it. */
private fun TranscriptSegmentDto.toKit(): TranscriptSegment = TranscriptSegment(
    id = id,
    source = source,
    speaker = speaker,
    text = text,
    isFinal = isFinal,
    startMs = startMs,
    endMs = endMs,
)
