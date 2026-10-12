package com.pathors.parley.kit

/**
 * What kind of meeting a recording WAS — the desktop's `MeetingKind`
 * (`src/lib/types.ts`), stored on the recording's meta as `meetingKind`.
 * Detected once per recording by the cheap model, before the findings pass it
 * shapes; a hand-set kind (the desktop's report picker) is never overwritten.
 *
 * The kind picks two things, both read from `shared/prompts/study.json`: the
 * [lens] (the SHAPE of the findings and the brief) and the built-in evaluation
 * [template] (what the findings pass watches for).
 */
enum class MeetingKind(val wire: String) {
    INTERNAL("internal"),
    SALES("sales"),
    PRICING("pricing"),
    RIVALRY("rivalry"),
    ;

    /** The output shape this kind earns (`kinds.<kind>.lens`). */
    val lens: AnalysisLens get() = AnalysisLens.fromWire(StudyPrompts.KIND_LENS.getValue(wire))

    /** The built-in evaluation template this kind watches with (`kinds.<kind>.template`). */
    val template: String get() = StudyPrompts.KIND_TEMPLATE.getValue(wire)

    companion object {
        /** The kind a stored or model-written string names, or null for anything else. */
        fun fromWire(value: String?): MeetingKind? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * The SHAPE of an analysis — the desktop's `AnalysisLens` and the predicates of
 * `src/lib/analysis/lens.ts`, rule for rule.
 */
enum class AnalysisLens(val wire: String) {
    /** A working meeting: decided / open / fact, no sides, nothing to "resolve". */
    DECISION("decision"),

    /** A sales call: me/them lanes, but no "I rebutted the customer". */
    OPPORTUNITY("opportunity"),

    /** A negotiation: me/them lanes and resolved moments. */
    ADVERSARIAL("adversarial"),
    ;

    /** Whether findings carry a me/them `side`. */
    val hasSides: Boolean get() = this != DECISION

    /** Whether findings carry `resolved` / `resolution`. */
    val hasResolution: Boolean get() = this == ADVERSARIAL

    /** Whether findings are bucketed `decision` / `open` / `fact`. */
    val hasCategories: Boolean get() = this == DECISION

    companion object {
        fun fromWire(value: String): AnalysisLens = entries.first { it.wire == value }

        /**
         * The lens for a kind. Null — never classified, or detection failed —
         * reads as the decision lens: framing a design review as a negotiation
         * actively lies about it, framing a sales call as notes only loses advice.
         */
        fun of(kind: MeetingKind?): AnalysisLens = kind?.lens ?: DECISION
    }
}

/** One evaluation the findings pass watches for — the desktop's `EvalDef`, minus its description. */
data class EvalDef(val id: String, val name: String, val prompt: String)

/**
 * The built-in evaluation templates (`src/lib/evaluations/presets.ts`), from
 * `shared/prompts/study.json`: the model-facing prompt in English, the name in
 * the UI language — exactly what the desktop puts in the findings prompt and
 * the brief's rubric.
 */
object EvalPresets {
    /** What an unclassified recording watches with: the desktop's `defaultEvalDefs`. */
    const val DEFAULT_TEMPLATE = "tpl-internal"

    private val byId: Map<String, StudyPrompts.Eval> = StudyPrompts.EVALS.associateBy { it.id }

    /** One template's evaluations, in order; empty for an unknown id. */
    fun template(id: String, language: FilingLanguage): List<EvalDef> =
        StudyPrompts.TEMPLATES[id].orEmpty().map { evalDef(it, language) }

    /**
     * The evaluations a recording of [kind] is analysed with: its built-in
     * template, or the default set when the kind is unknown — what the desktop
     * runs on a fresh install, where the watchers follow the detected kind.
     */
    fun forKind(kind: MeetingKind?, language: FilingLanguage): List<EvalDef> =
        template(kind?.template ?: DEFAULT_TEMPLATE, language)

    /** The shared definitions the templates draw from (`buildPresetEvalDefs`). */
    fun core(language: FilingLanguage): List<EvalDef> = StudyPrompts.CORE_EVALS.map { evalDef(it, language) }

    private fun evalDef(id: String, language: FilingLanguage): EvalDef {
        val preset = byId.getValue(id)
        val name = if (language == FilingLanguage.ZH_TW) preset.nameZhTw else preset.nameEn
        return EvalDef(id = id, name = name, prompt = preset.prompt)
    }
}
