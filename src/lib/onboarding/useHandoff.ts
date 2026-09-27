/**
 * The loaded study session, seen as something to hand off: the prompt + report
 * builders fed from the store, and the copy action shared by the transcript copy
 * menu and the report's "hand off to your AI" section — so both copy exactly the
 * same text and both tick the getting-started step.
 */
import { useCallback } from "react";
import { toast } from "sonner";
import { translate } from "../../i18n/messages";
import { listLocalFolders } from "../history/folders";
import { log } from "../log";
import { hasSpokenSegment, transcriptWithTimestamps, useStore } from "../store";
import type { AppLanguage } from "../types";
import { markGettingStarted } from "./gettingStarted";
import {
  buildHandoffPrompt,
  buildReportMarkdown,
  formatHandoffDate,
  meetingKindLabel,
  resolveMeName,
  speakerDisplayNames,
} from "./handoff";
import { handoffQuestions, type HandoffQuestions } from "./handoffQuestions";

type StoreState = ReturnType<typeof useStore.getState>;

/** The recording the questions are about; the live meeting has no replay. */
function subject(s: StoreState): { id: string; title: string; createdAt: number } {
  return {
    id: s.replay?.id ?? s.loadedHistoryId ?? "",
    title: s.replay?.name ?? "",
    createdAt: s.replay?.createdAt ?? s.meetingStartedAt ?? Date.now(),
  };
}

/** The paste-ready prompt + transcript for the loaded session. */
export function handoffPromptFromState(s: StoreState, lang: AppLanguage = s.settings.language): string {
  const subj = subject(s);
  return buildHandoffPrompt(
    {
      title: subj.title,
      dateLabel: formatHandoffDate(subj.createdAt, lang),
      kindLabel: meetingKindLabel(s.meetingKind, lang),
      context: s.meetingContext,
      speakerNames: speakerDisplayNames(s.segments, s.speakerNames),
      meName: resolveMeName(s.segments, s.speakerNames, s.settings.userName ?? "", translate(lang, "speaker.you")),
      transcript: transcriptWithTimestamps(s.segments, s.speakerNames),
      questions: handoffQuestions(subj, lang).questions,
    },
    lang
  );
}

/** The report page of the loaded session as markdown. */
export function reportMarkdownFromState(s: StoreState, lang: AppLanguage = s.settings.language): string {
  const subj = subject(s);
  const folderName = s.replayFolderId
    ? (listLocalFolders().find((f) => f.id === s.replayFolderId)?.name ?? null)
    : null;
  return buildReportMarkdown(
    {
      title: subj.title,
      createdAt: subj.createdAt,
      meetingKind: s.meetingKind,
      meetingContext: s.meetingContext,
      folderName,
      brief: s.brief,
      actionItems: s.actionItems,
      findings: s.findings,
    },
    lang
  );
}

/** Copy the hand-off prompt; on success say what to do next and tick the step. */
export async function copyHandoffPrompt(): Promise<boolean> {
  const s = useStore.getState();
  const lang = s.settings.language;
  try {
    await navigator.clipboard.writeText(handoffPromptFromState(s, lang));
  } catch (e) {
    log.warn("handoff: clipboard copy failed", { error: String(e) });
    toast.error(translate(lang, "common.copyFailed"));
    return false;
  }
  toast.success(translate(lang, "transcript.copyHandoffDone"));
  markGettingStarted("handedOff");
  return true;
}

export interface HandoffState extends HandoffQuestions {
  /** Anything to copy: spoken transcript, and not a read-only org copy. */
  canCopy: boolean;
  copyPrompt: () => Promise<boolean>;
  /** Evaluated at click time so the export always reflects the live report. */
  reportMarkdown: () => string;
}

export function useHandoff(): HandoffState {
  const lang = useStore((s) => s.settings.language);
  const id = useStore((s) => s.replay?.id ?? s.loadedHistoryId ?? "");
  const title = useStore((s) => s.replay?.name ?? "");
  const readOnly = useStore((s) => s.replayReadOnly);
  const hasSpoken = useStore((s) => hasSpokenSegment(s.segments));
  const { questions, mcpQuestions } = handoffQuestions({ id, title }, lang);
  const reportMarkdown = useCallback(() => reportMarkdownFromState(useStore.getState()), []);
  return {
    questions,
    mcpQuestions,
    canCopy: hasSpoken && !readOnly,
    copyPrompt: copyHandoffPrompt,
    reportMarkdown,
  };
}
