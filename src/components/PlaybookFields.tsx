import { useRef, useState, type ReactNode } from "react";
import { ArrowRight, Plus, X } from "lucide-react";
import { useStore } from "../lib/store";
import { MAX_PLAYBOOK_ITEMS, MAX_PLAYBOOK_TEXT, type PlaybookList } from "../lib/meeting/playbook";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldHint, FieldTitle } from "./FormSection";

/** The draft form's input look, as the agenda's add field has it. */
const INPUT_CLASS = "h-8 rounded-[8px] border-[#dadee5] text-sm dark:border-input";

/** One playbook row: its text and a hover-to-remove button, like an agenda row. */
function PlaybookRow({ list, id, children }: Readonly<{ list: PlaybookList; id: string; children: ReactNode }>) {
  const { t } = useI18n();
  const remove = useStore((s) => s.removePlaybookItem);
  return (
    <div className="group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
      <span className="min-w-0 flex-1 text-sm leading-snug break-words">{children}</span>
      <button
        type="button"
        aria-label={t("draft.playbook.remove")}
        title={t("draft.playbook.remove")}
        onClick={() => remove(list, id)}
        className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground focus-visible:text-muted-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function AddButton({ disabled }: Readonly<{ disabled: boolean }>) {
  const { t } = useI18n();
  return (
    <Button
      type="submit"
      size="icon"
      aria-label={t("draft.playbook.add")}
      title={t("draft.playbook.add")}
      className="size-8 shrink-0 rounded-[8px]"
      disabled={disabled}
    >
      <Plus className="size-4" />
    </Button>
  );
}

/** The topics: one line per item. */
function TopicList() {
  const { t } = useI18n();
  const label = t("draft.playbook.topics");
  const items = useStore((s) => s.meetingPlaybook.topics);
  const add = useStore((s) => s.addPlaybookItem);
  const [input, setInput] = useState("");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    add("topics", { text: input });
    setInput("");
  }
  return (
    <Field>
      <FieldTitle label={label} />
      {items.length > 0 && (
        <div className="-mx-1.5 flex flex-col gap-0.5">
          {items.map((x) => (
            <PlaybookRow key={x.id} list="topics" id={x.id}>
              {x.text}
            </PlaybookRow>
          ))}
        </div>
      )}
      {items.length < MAX_PLAYBOOK_ITEMS && (
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            value={input}
            maxLength={MAX_PLAYBOOK_TEXT}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("draft.playbook.topicsPlaceholder")}
            aria-label={label}
            className={INPUT_CLASS}
          />
          <AddButton disabled={!input.trim()} />
        </form>
      )}
    </Field>
  );
}

/** The branches: "when they say …, steer toward …" pairs. Enter with only the
 *  first half filled moves on to the second; a pair goes in once both are. */
function BranchList() {
  const { t } = useI18n();
  const items = useStore((s) => s.meetingPlaybook.branches);
  const add = useStore((s) => s.addPlaybookItem);
  const [when, setWhen] = useState("");
  const [then, setThen] = useState("");
  const whenRef = useRef<HTMLInputElement>(null);
  const thenRef = useRef<HTMLInputElement>(null);
  // The add button is disabled until both halves are filled, which also stops
  // Enter from submitting — so Enter on a filled first half moves on by hand.
  function onWhenKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.nativeEvent.isComposing && when.trim() && !then.trim()) {
      e.preventDefault();
      thenRef.current?.focus();
    }
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!when.trim() || !then.trim()) return;
    add("branches", { when, then });
    setWhen("");
    setThen("");
    whenRef.current?.focus();
  }
  return (
    <Field>
      <FieldTitle label={t("draft.playbook.branches")} />
      {items.length > 0 && (
        <div className="-mx-1.5 flex flex-col gap-0.5">
          {items.map((b) => (
            <PlaybookRow key={b.id} list="branches" id={b.id}>
              <span className="text-muted-foreground">{b.when}</span>
              <ArrowRight className="mx-1 inline size-3 align-[-1px] text-muted-foreground" />
              {b.then}
            </PlaybookRow>
          ))}
        </div>
      )}
      {items.length < MAX_PLAYBOOK_ITEMS && (
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            ref={whenRef}
            value={when}
            maxLength={MAX_PLAYBOOK_TEXT}
            onChange={(e) => setWhen(e.target.value)}
            onKeyDown={onWhenKey}
            placeholder={t("draft.playbook.when")}
            aria-label={t("draft.playbook.when")}
            className={INPUT_CLASS}
          />
          <Input
            ref={thenRef}
            value={then}
            maxLength={MAX_PLAYBOOK_TEXT}
            onChange={(e) => setThen(e.target.value)}
            placeholder={t("draft.playbook.then")}
            aria-label={t("draft.playbook.then")}
            className={INPUT_CLASS}
          />
          <AddButton disabled={!when.trim() || !then.trim()} />
        </form>
      )}
    </Field>
  );
}

/** The meeting draft's playbook: how to steer and where to go next (what to
 *  ask or cover is the agenda, above it in the sheet). Live suggestions pick
 *  from it while the meeting runs. */
export function PlaybookFields() {
  const { t } = useI18n();
  return (
    <>
      <FieldHint>{t("draft.playbook.hint")}</FieldHint>
      <BranchList />
      <TopicList />
    </>
  );
}
