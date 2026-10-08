#!/usr/bin/env node
// Generate the Android copy of shared/prompts/study.json — the study-pipeline
// prompts (meeting kind, timeline findings, action items, brief, delivery) and
// the built-in evaluation presets. Desktop imports the JSON directly; the phone
// cannot, so it gets generated constants instead. Only what the phone sends is
// emitted: the live-meeting variants stay desktop-only.
//
//   node scripts/gen-study-prompt.mjs           write the file
//   node scripts/gen-study-prompt.mjs --check   exit 1 if it is stale
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "shared/prompts/study.json";
export const TARGETS = {
  kotlin: "android/parleykit/src/main/kotlin/com/pathors/parley/kit/StudyPrompts.kt",
};

const HEADER = `GENERATED from ${SOURCE} by scripts/gen-study-prompt.mjs — do not edit.`;
const LENSES = ["decision", "opportunity", "adversarial"];

function escapeCommon(s) {
  return s
    .replaceAll("\\", String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll("\n", String.raw`\n`)
    .replaceAll("\r", String.raw`\r`)
    .replaceAll("\t", String.raw`\t`);
}
// Kotlin string templates make a bare `$` live, so it is escaped too.
const KOTLIN_DOLLAR = String.raw`\$`;
const kt = (s) => `"${escapeCommon(s).replaceAll("$", KOTLIN_DOLLAR)}"`;

const str = (name, v) => `    const val ${name}: String = ${kt(v)}`;
const int = (name, v) => `    const val ${name}: Int = ${v}`;
const list = (items, indent) => items.map((s) => `${indent}${kt(s)},`).join("\n");
const stringList = (name, items) => `    val ${name}: List<String> = listOf(\n${list(items, "        ")}\n    )`;
const byLens = (name, obj) => {
  const entries = LENSES.map((l) => `        "${l}" to ${kt(obj[l])},`).join("\n");
  const doc = `    /** Keyed by lens: ${LENSES.join(", ")}. */`;
  return `${doc}\n    val ${name}: Map<String, String> = mapOf(\n${entries}\n    )`;
};
const stringMap = (name, entries) => {
  const body = entries.map(([k, v]) => `        ${kt(k)} to ${kt(v)},`).join("\n");
  return `    val ${name}: Map<String, String> = mapOf(\n${body}\n    )`;
};

export function renderKotlin(p) {
  const evals = Object.entries(p.evals).map(
    ([id, e]) => `        Eval(\n            id = ${kt(id)},\n            prompt = ${kt(e.prompt)},\n            nameZhTw = ${kt(e.name["zh-TW"])},\n            nameEn = ${kt(e.name.en)},\n        ),`,
  );
  const templates = Object.entries(p.templates).map(
    ([id, ids]) => `        ${kt(id)} to listOf(${ids.map(kt).join(", ")}),`,
  );
  const kinds = Object.entries(p.kinds);
  return `// ${HEADER}
package com.pathors.parley.kit

/**
 * The shared study-pipeline prompts and evaluation presets. See ${SOURCE}.
 * \`{{name}}\` marks a placeholder ([StudyPromptBuilder.fill] fills them in one pass).
 */
object StudyPrompts {
    /** One built-in evaluation: what to watch for, and its name in each UI language. */
    data class Eval(val id: String, val prompt: String, val nameZhTw: String, val nameEn: String)

${str("MODEL_MEETING_KIND", p.models.meetingKind)}
${str("MODEL_FINDINGS", p.models.findings)}
${str("MODEL_ACTION_ITEMS", p.models.actionItems)}
${str("MODEL_BRIEF", p.models.brief)}
${str("MODEL_DELIVERY", p.models.delivery)}

${int("TIMEOUT_SECONDS_MEETING_KIND", p.phone.timeoutSeconds.meetingKind)}
${int("TIMEOUT_SECONDS_FINDINGS", p.phone.timeoutSeconds.findings)}
${int("TIMEOUT_SECONDS_ACTION_ITEMS", p.phone.timeoutSeconds.actionItems)}
${int("TIMEOUT_SECONDS_BRIEF", p.phone.timeoutSeconds.brief)}
${int("TIMEOUT_SECONDS_DELIVERY", p.phone.timeoutSeconds.delivery)}

${str("SCHEMA_PREFIX", p.phone.schemaPrefix)}
${str("SCHEMA_MEETING_KIND", p.phone.schema.meetingKind)}
${byLens("SCHEMA_TIMELINE", p.phone.schema.timeline)}
${str("SCHEMA_ACTION_ITEMS", p.phone.schema.actionItems)}
${str("SCHEMA_DELIVERY", p.phone.schema.delivery)}

${str("JSON_MODE_INSTRUCTION", p.jsonModeInstruction)}
${str("OUTPUT_LANGUAGE_TEMPLATE", p.outputLanguage.template)}
${str("OUTPUT_LANGUAGE_NAME_ZH_TW", p.outputLanguage.names["zh-TW"])}
${str("OUTPUT_LANGUAGE_NAME_EN", p.outputLanguage.names.en)}
${str("MEETING_CONTEXT_PREFIX", p.meetingContextPrefix)}
${str("NO_SPEECH", p.noSpeech)}

${str("MEETING_KIND_SYSTEM", p.meetingKind.system)}
${str("MEETING_KIND_TRANSCRIPT_HEADER", p.meetingKind.transcriptHeader)}

${str("TIMELINE_SYSTEM_TEMPLATE", p.timeline.systemTemplate)}
${str("TIMELINE_TENSE_REPLAY", p.timeline.tense.replay)}
${byLens("TIMELINE_INTRO", p.timeline.intro)}
${byLens("TIMELINE_SELECTION_RULE", p.timeline.selectionRule)}
${byLens("TIMELINE_FIELD_GUIDE", p.timeline.fieldGuide)}
${byLens("TIMELINE_SEVERITY_RULE", p.timeline.severityRule)}
${byLens("TIMELINE_INTERPRETATION", p.timeline.interpretation)}
${str("TIMELINE_RESOLVED_FIELDS", p.timeline.resolvedFields)}
${str("TIMELINE_RESOLVED_BLOCK", p.timeline.resolvedBlock)}
${byLens("TIMELINE_MODE_REPLAY", p.timeline.mode.replay)}
${str("TIMELINE_EVALS_HEADER", p.timeline.evalsHeader)}
${str("TIMELINE_NO_EVALS", p.timeline.noEvals)}
${str("TIMELINE_EVAL_ENTRY", p.timeline.evalEntry)}
${str("TIMELINE_TRANSCRIPT_LABEL_REPLAY", p.timeline.transcriptLabel.replay)}

${str("ACTION_ITEMS_SYSTEM_TEMPLATE", p.actionItems.systemTemplate)}
${byLens("ACTION_ITEMS_INTRO", p.actionItems.intro)}
${str("ACTION_ITEMS_FLAVOUR_DECISION", p.actionItems.flavour.decision)}
${str("ACTION_ITEMS_FLAVOUR_DEFAULT", p.actionItems.flavour.default)}
${str("ACTION_ITEMS_FINDINGS_HEADER", p.actionItems.findingsHeader)}
${str("ACTION_ITEMS_NO_FINDINGS", p.actionItems.noFindings)}
${str("ACTION_ITEMS_FINDING_ENTRY", p.actionItems.findingEntry)}
${str("ACTION_ITEMS_FINDING_TAG_FALLBACK", p.actionItems.findingTagFallback)}
${str("ACTION_ITEMS_TRANSCRIPT_HEADER", p.actionItems.transcriptHeader)}

${str("BRIEF_SYSTEM_TEMPLATE", p.brief.systemTemplate)}
${byLens("BRIEF_INTRO", p.brief.intro)}
${byLens("BRIEF_SECTIONS", p.brief.sections)}
${str("BRIEF_RUBRIC_HEADER", p.brief.rubricHeader)}
${str("BRIEF_RUBRIC_ENTRY", p.brief.rubricEntry)}
${str("BRIEF_CHECKLIST_HEADER", p.brief.checklistHeader)}
${str("BRIEF_CHECKLIST_ENTRY", p.brief.checklistEntry)}
${str("BRIEF_TRANSCRIPT_HEADER", p.brief.transcriptHeader)}

${str("DELIVERY_SYSTEM_TEMPLATE", p.delivery.systemTemplate)}
${str("DELIVERY_SETTING_POST", p.delivery.setting.post)}
${str("DELIVERY_MEASURED_RATE_TEMPLATE", p.delivery.measuredRateTemplate)}
${str("DELIVERY_WATCHLIST_TEMPLATE", p.delivery.watchlistTemplate)}
${str("DELIVERY_TRANSCRIPT_LABEL_POST", p.delivery.transcriptLabel.post)}

${stringList("FILLER_WORDS_ZH_TW", p.fillerWords["zh-TW"])}
${stringList("FILLER_WORDS_EN", p.fillerWords.en)}

    /** Meeting kind → the lens its findings and brief are written in. */
${stringMap("KIND_LENS", kinds.map(([k, v]) => [k, v.lens]))}

    /** Meeting kind → the built-in evaluation template it watches with. */
${stringMap("KIND_TEMPLATE", kinds.map(([k, v]) => [k, v.template]))}

${stringList("CORE_EVALS", p.coreEvals)}

    /** Template id → its evaluation ids, in order. */
    val TEMPLATES: Map<String, List<String>> = mapOf(
${templates.join("\n")}
    )

    val EVALS: List<Eval> = listOf(
${evals.join("\n")}
    )
}
`;
}

export function rendered() {
  const p = JSON.parse(readFileSync(join(root, SOURCE), "utf8"));
  return { kotlin: renderKotlin(p) };
}

function main() {
  const check = process.argv.includes("--check");
  const out = rendered();
  let stale = false;
  for (const [key, rel] of Object.entries(TARGETS)) {
    const path = join(root, rel);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === out[key]) continue;
    if (check) {
      console.error(`stale: ${rel} — run node scripts/gen-study-prompt.mjs`);
      stale = true;
    } else {
      writeFileSync(path, out[key]);
      console.log(`wrote ${rel}`);
    }
  }
  if (stale) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
