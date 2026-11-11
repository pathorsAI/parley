import { useMemo } from "react";
import { Square } from "lucide-react";
import { useStore } from "../../lib/store";
import { navigateTo } from "../../lib/nav/navigate";
import { carryOverDraft, uncoveredAgenda } from "../../lib/meeting/agenda";
import { log } from "../../lib/log";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";

/**
 * 後續行動's 沒談到的議程: the meeting draft's agenda items the meeting never
 * got to (HistoryEntry.agenda, ridden in on the replay session), and a button
 * that files them as a new meeting draft for the follow-up. Nothing for a
 * recording without an agenda, or one that covered all of it.
 *
 * Drafts are this device's own list, so the button works for a read-only org
 * recording too: the new draft is the viewer's, nothing is written to the
 * shared copy.
 */
export function AgendaNotCovered() {
  const { t } = useI18n();
  const agenda = useStore((s) => s.replay?.agenda);
  const name = useStore((s) => s.replay?.name ?? "");
  const left = useMemo(() => uncoveredAgenda(agenda), [agenda]);
  if (left.length === 0) return null;

  // The study page's prep fields are the open recording's (loadHistory), so
  // the draft is filed straight into the list (addDraft leaves the prep
  // alone) and opened from 總覽, the way ⌘N's 新增會議草稿 leaves this page.
  function carryOver() {
    const title = name.trim() ? t("agenda.carryTitle", { title: name.trim() }) : "";
    const draft = useStore.getState().addDraft(carryOverDraft(title, left));
    log.info("study: uncovered agenda carried into a draft", { id: draft.id, items: left.length });
    void navigateTo({ kind: "home" }).then((outcome) => {
      if (outcome.status === "applied") useStore.getState().editDraft(draft.id);
    });
  }

  return (
    <section className="mt-8">
      <h2 className="mb-2 text-xs font-semibold text-muted-foreground">{t("agenda.notCovered")}</h2>
      <ul className="flex flex-col gap-1.5">
        {left.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-sm leading-snug">
            <Square aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">{item.text}</span>
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" className="mt-3" onClick={carryOver}>
        {t("agenda.carryOver")}
      </Button>
    </section>
  );
}
