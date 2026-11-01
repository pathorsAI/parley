import { create } from "zustand";
import { useStore, meetingBriefText } from "../../lib/store";
import { missingProviderRequirement, providerGateKey } from "../../lib/ai/settings";
import { translate } from "../../i18n";
import { log } from "../../lib/log";

export interface AskCard {
  id: string;
  question: string;
  answer: string;
  busy: boolean;
}

/** The quick questions the ask box offers on ↑ / ↓ (i18n keys). */
export const ASK_SUGGESTIONS = [
  "ask.suggestion.summary",
  "ask.suggestion.next",
  "ask.suggestion.agreed",
  "ask.suggestion.unanswered",
  "ask.suggestion.pushback",
] as const;

interface CoachAskState {
  cards: AskCard[];
  /** Ask the coach about the meeting so far; the answer streams into a card. */
  ask: (question: string) => Promise<void>;
  /** Forget this meeting's questions (a new meeting starts with none). */
  reset: () => void;
}

const patch = (cards: AskCard[], id: string, p: Partial<AskCard>) =>
  cards.map((c) => (c.id === id ? { ...c, ...p } : c));

/**
 * The coach's question-and-answer thread for the meeting on screen. A store of
 * its own rather than component state: the floating window asks from its
 * bottom bar, which outlives the 教練 tab the answers show in.
 */
export const useCoachAsk = create<CoachAskState>((set, get) => ({
  cards: [],
  reset: () => set({ cards: [] }),
  ask: async (raw) => {
    const question = raw.trim();
    if (!question || get().cards.some((c) => c.busy)) return;
    const id = crypto.randomUUID();
    set((s) => ({ cards: [...s.cards, { id, question, answer: "", busy: true }] }));
    const state = useStore.getState();
    const gate = providerGateKey(missingProviderRequirement(state.settings, "realtime"), "ask.missingKey");
    if (gate) {
      set((s) => ({ cards: patch(s.cards, id, { answer: translate(state.settings.language, gate), busy: false }) }));
      return;
    }
    try {
      const { askAboutMeeting } = await import("../../lib/ai/ask");
      await askAboutMeeting({
        settings: state.settings,
        segments: state.segments,
        question,
        meetingContext: meetingBriefText(state),
        names: state.speakerNames,
        onDelta: (chunk) =>
          set((s) => ({ cards: s.cards.map((c) => (c.id === id ? { ...c, answer: c.answer + chunk } : c)) })),
      });
    } catch (e) {
      log.error("feed: ask failed", { error: String(e) });
      set((s) => ({ cards: patch(s.cards, id, { answer: String(e) }) }));
    } finally {
      set((s) => ({ cards: patch(s.cards, id, { busy: false }) }));
    }
  },
}));
