import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useStore } from "../lib/store";
import { MAX_OPENING_SCRIPT, MAX_SMALL_TALK_ITEMS, MAX_SMALL_TALK_TEXT } from "../lib/meeting/opening";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldTitle, FORM_INPUT_CLASS } from "./FormSection";

/** The small-talk lines: one sentence per row, like the playbook's topics. */
function SmallTalkList() {
  const { t } = useI18n();
  const label = t("draft.opening.smallTalk");
  const items = useStore((s) => s.meetingOpening.smallTalk);
  const add = useStore((s) => s.addSmallTalk);
  const remove = useStore((s) => s.removeSmallTalk);
  const [input, setInput] = useState("");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    add(input);
    setInput("");
  }
  return (
    <Field>
      <FieldTitle label={label} />
      {items.length > 0 && (
        <div className="-mx-1.5 flex flex-col gap-0.5">
          {items.map((line, i) => (
            <div key={line} className="group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
              <span className="min-w-0 flex-1 text-sm leading-snug break-words">{line}</span>
              <button
                type="button"
                aria-label={t("draft.playbook.remove")}
                title={t("draft.playbook.remove")}
                onClick={() => remove(i)}
                className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground focus-visible:text-muted-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {items.length < MAX_SMALL_TALK_ITEMS && (
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            value={input}
            maxLength={MAX_SMALL_TALK_TEXT}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("draft.opening.smallTalkPlaceholder")}
            aria-label={label}
            className="h-8 rounded-[8px] border-[#dadee5] text-sm dark:border-input"
          />
          <Button
            type="submit"
            size="icon"
            aria-label={t("draft.playbook.add")}
            title={t("draft.playbook.add")}
            className="size-8 shrink-0 rounded-[8px]"
            disabled={!input.trim()}
          >
            <Plus className="size-4" />
          </Button>
        </form>
      )}
    </Field>
  );
}

/** The meeting draft's opening: small talk, then the standard opening. The
 *  meeting shows both from its first second (live/OpeningCard). */
export function OpeningFields() {
  const { t } = useI18n();
  const script = useStore((s) => s.meetingOpening.script);
  const setScript = useStore((s) => s.setOpeningScript);
  return (
    <>
      <SmallTalkList />
      <Field>
        <FieldTitle label={t("draft.opening.script")} htmlFor="draft-opening-script" />
        <textarea
          id="draft-opening-script"
          rows={3}
          value={script}
          maxLength={MAX_OPENING_SCRIPT}
          onChange={(e) => setScript(e.target.value)}
          placeholder={t("draft.opening.scriptPlaceholder")}
          className={`${FORM_INPUT_CLASS} resize-y py-2 leading-snug`}
        />
      </Field>
    </>
  );
}
