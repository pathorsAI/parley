/**
 * The loaded study session, seen as something to hand off: the prompt + report
 * builders fed from the store, and the copy action shared by the transcript copy
 * menu, the recording page header's copy menu and the guided lap — so all copy exactly the
 * same text and all tick the getting-started step. Also the per-tab text the
 * page header's "copy this page" copies.
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
  buildDeliveryMarkdown,
  buildHandoffPrompt,
  buildReportMarkdown,
  formatHandoffDate,
  meetingKindLabel,
  resolveMeName,
  speakerDisplayNames,
} from "./handoff";
import { handoffQuestions, type HandoffQuestions } from "./handoffQuestions";
import { meetingBackgroundOf, meetingNotesOf } from "../history/meetingNotes";
import type { StudyTab } from "../store/study";
import { actionItemsPageText } from "../analysis/actionItemSides";
import { ownerDisplayName } from "../speakers/owners";
import { displayLabelerOf, relabelFromState } from "../speakers/useRelabel";

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
  const label = displayLabelerOf(s, lang);
  return buildHandoffPrompt(
    {
      title: subj.title,
      dateLabel: formatHandoffDate(subj.createdAt, lang),
      kindLabel: meetingKindLabel(s.meetingKind, lang),
      context: s.meetingContext,
      speakerNames: speakerDisplayNames(s.segments, s.speakerNames, label),
      meName: resolveMeName(
        s.segments,
        s.speakerNames,
        s.settings.userName ?? "",
        translate(lang, "speaker.you"),
        label,
      ),
      transcript: transcriptWithTimestamps(s.segments, s.speakerNames, label),
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
  // AI-written items cite speakers by the names they had when written.
  const relabel = relabelFromState(s, lang);
  return buildReportMarkdown(
    {
      title: subj.title,
      createdAt: subj.createdAt,
      meetingKind: s.meetingKind,
      meetingContext: s.meetingContext,
      folderName,
      brief: s.brief ? relabel(s.brief) : s.brief,
      actionItems: s.actionItems.map((a) => ({ ...a, text: relabel(a.text) })),
      findings: s.findings.map((f) => ({ ...f, title: relabel(f.title), detail: relabel(f.detail) })),
    },
    lang
  );
}

/** The 後續行動 tab as the page shows it: grouped by side under the same names
 *  (your company / the folder), owners by the speakers' current names. */
function actionItemsTextFromState(s: StoreState, lang: AppLanguage): string {
  const label = displayLabelerOf(s, lang);
  const relabel = relabelFromState(s, lang);
  const items = s.actionItems.map((a) => {
    const owner = ownerDisplayName(a, s.segments, s.speakerNames, label);
    return { ...a, text: relabel(a.text), owner: owner === a.owner && owner ? relabel(owner) : owner };
  });
  const folderName = s.replayFolderId
    ? (listLocalFolders().find((f) => f.id === s.replayFolderId)?.name.trim() ?? "")
    : "";
  const sideNames = { us: s.settings.userCompany.trim(), them: folderName };
  return actionItemsPageText(
    items,
    (side) =>
      translate(lang, "actionItems.copy.header", {
        name: sideNames[side] || translate(lang, side === "us" ? "actionItems.side.us" : "actionItems.side.them"),
      }),
    (owner) => translate(lang, "actionItems.copy.owner", { owner }),
  );
}

/**
 * One tab of the recording page as plain text / markdown — what "copy this
 * page" puts on the clipboard. The replay tab is the transcript (speaker
 * labels + timestamps). "" when the tab has nothing to copy yet.
 */
export function studyPageTextFromState(
  s: StoreState,
  tab: StudyTab,
  lang: AppLanguage = s.settings.language,
): string {
  switch (tab) {
    case "summary":
      return s.brief ? relabelFromState(s, lang)(s.brief).trim() : "";
    case "actions":
      return actionItemsTextFromState(s, lang);
    case "notes":
      return meetingNotesOf(s.meetingContext);
    case "context":
      return meetingBackgroundOf(s.meetingContext);
    case "delivery":
      return relabelFromState(s, lang)(buildDeliveryMarkdown(s.deliveryAssessment, lang));
    case "replay":
      return transcriptWithTimestamps(s.segments, s.speakerNames, displayLabelerOf(s, lang));
  }
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
  /** Anything to copy: a spoken transcript. A shared org recording copies too —
   *  its plain transcript always could, and the prompt is that same text. */
  canCopy: boolean;
  copyPrompt: () => Promise<boolean>;
  /** Evaluated at click time so the export always reflects the live report. */
  reportMarkdown: () => string;
}

export function useHandoff(): HandoffState {
  const lang = useStore((s) => s.settings.language);
  const id = useStore((s) => s.replay?.id ?? s.loadedHistoryId ?? "");
  const title = useStore((s) => s.replay?.name ?? "");
  const hasSpoken = useStore((s) => hasSpokenSegment(s.segments));
  const { questions, mcpQuestions } = handoffQuestions({ id, title }, lang);
  const reportMarkdown = useCallback(() => reportMarkdownFromState(useStore.getState()), []);
  return {
    questions,
    mcpQuestions,
    canCopy: hasSpoken,
    copyPrompt: copyHandoffPrompt,
    reportMarkdown,
  };
}
