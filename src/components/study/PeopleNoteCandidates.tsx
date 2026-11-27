import { Check, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { candidatesFor, withNoteKept, withoutNote } from "../../lib/people/notes";
import { mutatePeople, usePeople } from "../../lib/people/store";
import { useI18n } from "../../i18n";

/**
 * The small-talk candidates read from this recording (people/extractRun.ts):
 * who, and the one thing worth remembering, each kept or dropped with one
 * click. Kept ones are what an assistant reads before the next meeting with
 * that person. Nothing at all when the recording has none left to decide.
 */
export function PeopleNoteCandidates() {
  const { t } = useI18n();
  const recordingId = useStore((s) => s.loadedHistoryId);
  const doc = usePeople();
  const candidates = doc && recordingId ? candidatesFor(doc, recordingId) : [];
  if (candidates.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-1 text-xs font-semibold text-muted-foreground">{t("people.candidates.title")}</h2>
      <ul className="flex flex-col">
        {candidates.map(({ person, note }) => (
          <li key={note.id} className="flex items-start gap-2 py-1 text-sm leading-snug" title={note.quote}>
            <span className="shrink-0 font-medium">{person.name}</span>
            <span className="min-w-0 flex-1 text-foreground/90">{note.text}</span>
            <button
              type="button"
              aria-label={t("people.candidates.keep")}
              title={t("people.candidates.keep")}
              onClick={() => void mutatePeople((d) => withNoteKept(d, person.id, note.id, Date.now()))}
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Check className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={t("people.candidates.drop")}
              title={t("people.candidates.drop")}
              onClick={() => void mutatePeople((d) => withoutNote(d, person.id, note.id))}
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
