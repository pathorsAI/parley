/**
 * Hand-off builders: the text a user carries out of Parley to their own AI.
 *
 * `buildHandoffPrompt` wraps a transcript in a short analysis brief — who is in
 * the room, which side is "me", three ready-made questions — so pasting it into
 * ChatGPT or Claude gets a useful answer on the first try instead of a summary
 * nobody asked for. `buildReportMarkdown` exports the finished report page.
 *
 * Pure functions: every label comes from the i18n dictionaries via `translate`,
 * so the output follows the app language and stays testable without React.
 */
import { translate } from "../../i18n/messages";
import { formatClock, speakerKey, speakerLabel } from "../store";
import type { ActionItem, AppLanguage, MeetingKind, TimelineEvent, TranscriptSegment } from "../types";

export interface HandoffPromptInput {
  title: string;
  /** Already formatted for display, e.g. via {@link formatHandoffDate}. */
  dateLabel: string;
  /** Translated meeting kind, or "" when the kind is unknown. */
  kindLabel: string;
  /** Free-text meeting context; "" renders as "not given". */
  context: string;
  /** Distinct speaker display names, in first-appearance order. */
  speakerNames: string[];
  /** Which of those names is the user. */
  meName: string;
  /** Transcript with speaker labels and [m:ss] timestamps. */
  transcript: string;
  questions: string[];
}

/** The analysis prompt followed by the full transcript, ready to paste. */
export function buildHandoffPrompt(input: HandoffPromptInput, lang: AppLanguage): string {
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string>) =>
    translate(lang, key, vars);
  const title = input.title.trim();
  const meeting = input.kindLabel
    ? t("transcript.handoffPrompt.meeting", { title, date: input.dateLabel, kind: input.kindLabel })
    : t("transcript.handoffPrompt.meetingNoKind", { title, date: input.dateLabel });
  const context = t("transcript.handoffPrompt.context", {
    context: input.context.trim() || t("transcript.handoffPrompt.noContext"),
  });
  const speakers = input.speakerNames.length
    ? [
        t("transcript.handoffPrompt.speakers", {
          names: input.speakerNames.join(t("transcript.handoffPrompt.nameSeparator")),
          me: input.meName,
        }),
      ]
    : [];
  const lines: string[] = [
    t("transcript.handoffPrompt.intro"),
    ...input.questions.map((q, i) => `${i + 1}. ${q}`),
    t("transcript.handoffPrompt.cite"),
    "",
    meeting,
    context,
    ...speakers,
    "",
    t("transcript.handoffPrompt.transcript"),
    input.transcript.trim(),
    "",
  ];
  return lines.join("\n");
}

/** Recording date as shown in a hand-off, in the app language. */
export function formatHandoffDate(ms: number, lang: AppLanguage): string {
  return new Date(ms).toLocaleString(lang === "zh-TW" ? "zh-TW" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Translated meeting kind, or "" when it is unknown. */
export function meetingKindLabel(kind: MeetingKind | null | undefined, lang: AppLanguage): string {
  return kind ? translate(lang, `meetingKind.${kind}`) : "";
}

/** Distinct speaker display names in first-appearance order (spoken lines only). */
export function speakerDisplayNames(
  segments: TranscriptSegment[],
  names: Record<string, string>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    if (!s.isFinal || !s.text.trim()) continue;
    const key = speakerKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(speakerLabel(s, names));
  }
  return out;
}

/**
 * The name the transcript uses for the user. Prefers the user's own name when a
 * speaker carries it, then the primary mic voice (the only speaker Parley knows
 * is "me" on a live call), then the name from settings, then `fallback`.
 */
export function resolveMeName(
  segments: TranscriptSegment[],
  names: Record<string, string>,
  userName: string,
  fallback: string
): string {
  const own = userName.trim();
  if (own && speakerDisplayNames(segments, names).includes(own)) return own;
  const mic = segments.find(
    (s) => s.source === "me" && (s.speaker || 1) <= 1 && s.isFinal && s.text.trim()
  );
  if (mic) return speakerLabel(mic, names);
  return own || fallback;
}

/** One finding as a markdown bullet — the same shape the live meeting's copy
 *  button writes (MeetingView's buildMarkdown), so both exports read alike. */
export function findingMarkdownLine(f: TimelineEvent): string {
  const tag = [f.side ?? f.category, f.severity].filter(Boolean).join(", ");
  return `- [${formatClock(f.atMs)}] **${f.title}** (${tag}): ${f.detail}`;
}

function actionItemMarkdownLine(a: ActionItem): string {
  const at = a.atMs == null ? "" : ` [${formatClock(a.atMs)}]`;
  return `- [${a.done ? "x" : " "}] ${a.text.trim()}${at}`;
}

/** What the report export needs — a saved entry, or the loaded study session. */
export interface HandoffReportEntry {
  title: string;
  createdAt: number;
  meetingKind?: MeetingKind | null;
  meetingContext?: string;
  /** Display name of the folder it is filed in; null/absent = unfiled. */
  folderName?: string | null;
  brief?: string | null;
  actionItems: ActionItem[];
  findings: TimelineEvent[];
}

/** The report page as markdown: meta, brief, action items, key moments. */
export function buildReportMarkdown(entry: HandoffReportEntry, lang: AppLanguage): string {
  const t = (key: Parameters<typeof translate>[1]) => translate(lang, key);
  const lines = [`# ${entry.title.trim()}`, ""];
  lines.push(`- ${t("study.report.date")}: ${formatHandoffDate(entry.createdAt, lang)}`);
  const kind = meetingKindLabel(entry.meetingKind, lang);
  if (kind) lines.push(`- ${t("meetingKind.label")}: ${kind}`);
  if (entry.folderName) lines.push(`- ${t("study.report.folder")}: ${entry.folderName}`);
  const context = entry.meetingContext?.trim();
  if (context) lines.push(`- ${t("study.link.context")}: ${context}`);
  lines.push("");

  const brief = entry.brief?.trim();
  if (brief) lines.push(`## ${t("study.brief")}`, "", brief, "");

  if (entry.actionItems.length) {
    lines.push(`## ${t("actionItems.title")}`, "", ...entry.actionItems.map(actionItemMarkdownLine), "");
  }

  if (entry.findings.length) {
    const sorted = [...entry.findings].sort((a, b) => a.atMs - b.atMs);
    lines.push(`## ${t("study.report.findings")}`, "", ...sorted.map(findingMarkdownLine), "");
  }

  lines.push("---", "", `_${t("study.report.footer")}_`, "");
  return lines.join("\n");
}
