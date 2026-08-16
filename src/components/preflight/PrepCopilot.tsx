import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Target,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../../lib/store";
import { useMeetingSetup } from "./useMeetingSetup";
import { collectPrepFacts, prepHeadline, type PrepFacts } from "../../lib/preflight/facts";
import { hasProviderKey } from "../../lib/ai/settings";
import { AI_FAILURE_HINT_KEY, classifyAiFailure } from "../../lib/ai/failure";
import { toastAiFailure } from "../../lib/ai/failureToast";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MeetingContextField } from "../MeetingContextField";
import { splitObjection } from "../../lib/preflight/objections";
import { PlanCard, type PlanView } from "./PlanCard";
import { Column, EmptyState, SectionTitle } from "./bits";

/** A paste this long is source material, not a sentence someone typed. */
const PASTE_THRESHOLD = 200;

type Msg =
  | { id: string; kind: "text"; role: "user" | "assistant"; content: string; reasoning?: string }
  | { id: string; kind: "plan"; plan: PlanView };

/**
 * Pre-flight column ③: the coach, not the form.
 *
 * The old column asked for a BATNA, a bottom line and an agenda — all of which
 * are what you have AFTER thinking, not before. The three things the user
 * actually arrives with are who the call is with, what kind of call it is, and
 * a lump of background from wherever they just were. So this column opens by
 * saying what it already knows, and everything else is drafted and corrected.
 *
 * The negotiation fields did NOT go away — they feed every analysis prompt and
 * the BATNA evaluation. They moved from a blank form to a drafted one.
 */
export function PrepCopilot() {
  const { t } = useI18n();
  const setup = useMeetingSetup();

  const settings = useStore((s) => s.settings);
  const target = useStore((s) => s.meetingTarget);
  const batna = useStore((s) => s.meetingBatna);
  const floor = useStore((s) => s.meetingFloor);
  const context = useStore((s) => s.meetingContext);
  const todos = useStore((s) => s.todos);
  const setMeetingContext = useStore((s) => s.setMeetingContext);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<null | "chat" | "draft" | "plan">(null);
  const [pasted, setPasted] = useState<string | null>(null);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const chatReady = hasProviderKey(settings, "realtime");
  const deepReady = hasProviderKey(settings, "deep");

  // A different customer is a different conversation — carrying the last one
  // over would have the coach confidently discussing the wrong one.
  useEffect(() => {
    setMessages([]);
    setPasted(null);
  }, [setup.folder?.id]);

  // Destructured so the memo keys off the pieces, not the fresh object the hook
  // returns every render (which would make the memo a no-op).
  const { folder, scenario, stageId, slots, stageLabel, meetings } = setup;
  const bundle = stageId ? scenario?.bundles[stageId] : undefined;
  const facts: PrepFacts = useMemo(
    () =>
      collectPrepFacts({
        folder: folder?.name ?? null,
        scenarioName: scenario?.name ?? null,
        stageLabel,
        exitCriteria: bundle?.exitCriteria ?? [],
        slots,
        meetings: meetings.map((m) => ({ title: m.title, createdAt: m.createdAt })),
        prep: { target, batna, floor, context, agenda: todos.map((x) => x.text) },
      }),
    [folder, scenario, stageLabel, bundle, slots, meetings, target, batna, floor, context, todos]
  );

  const head = prepHeadline(facts);

  /** Text turns only — the goal chips and the plan card aren't dialogue. */
  const history = messages
    .filter((m): m is Extract<Msg, { kind: "text" }> => m.kind === "text" && !!m.content)
    .map((m) => ({ role: m.role, content: m.content }));

  function push(msg: Msg) {
    setMessages((m) => [...m, msg]);
  }

  function scrollDown() {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  async function send(raw: string) {
    const q = raw.trim();
    if (!q || busy) return;
    setInput("");
    setPasted(null);
    const answerId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      { id: crypto.randomUUID(), kind: "text", role: "user", content: q },
      { id: answerId, kind: "text", role: "assistant", content: "" },
    ]);
    setBusy("chat");
    try {
      const { streamPrepChat } = await import("../../lib/ai/prep");
      await streamPrepChat({
        settings,
        facts,
        history,
        question: q,
        onDelta: (chunk) => {
          setMessages((m) =>
            m.map((x) =>
              x.id === answerId && x.kind === "text" ? { ...x, content: x.content + chunk } : x
            )
          );
          scrollDown();
        },
        onReasoningDelta: (chunk) => {
          setMessages((m) =>
            m.map((x) =>
              x.id === answerId && x.kind === "text"
                ? { ...x, reasoning: (x.reasoning ?? "") + chunk }
                : x
            )
          );
        },
      });
    } catch (e) {
      // The half-written answer bubble stays put and carries the actionable
      // line; the toast carries the provider's detail plus the way to Settings.
      const failure = classifyAiFailure(e, settings, "realtime");
      toastAiFailure("preflight: copilot chat", e, "realtime");
      setMessages((m) =>
        m.map((x) =>
          x.id === answerId && x.kind === "text"
            ? {
                ...x,
                content: t(AI_FAILURE_HINT_KEY[failure.kind], { provider: failure.providerLabel }),
              }
            : x
        )
      );
    } finally {
      setBusy(null);
    }
  }

  /**
   * The five-minute path (#189): one pass over the stage bundle, no
   * conversation required, pressable the moment you land. The thirty-minute
   * path is `plan()` below, which reads what you and the coach actually worked
   * out.
   */
  async function draft() {
    if (busy || !scenario || !stageId) return;
    setBusy("draft");
    try {
      const { draftPrep } = await import("../../lib/ai/prepDraft");
      const result = await draftPrep({
        settings,
        input: {
          folder: folder?.name ?? null,
          stageName: scenario.names[stageId] ?? stageId,
          stageGoal: bundle?.goal ?? "",
          exitCriteria: bundle?.exitCriteria ?? [],
          slots,
          meetings: meetings.map((m) => ({ title: m.title, createdAt: m.createdAt })),
          context,
        },
      });
      push({
        id: crypto.randomUUID(),
        kind: "plan",
        plan: {
          goals: result.goals,
          agenda: result.agenda,
          idealPath: [],
          edgeCases: result.objections.map(splitObjection),
          target: "",
          batna: result.batna,
          floor: result.floor,
        },
      });
      scrollDown();
    } catch (e) {
      toastAiFailure("preflight: copilot draft", e, "deep");
    } finally {
      setBusy(null);
    }
  }

  async function plan() {
    if (busy) return;
    setBusy("plan");
    try {
      const { draftPlan } = await import("../../lib/ai/prep");
      const drafted = await draftPlan({ settings, facts, history });
      push({ id: crypto.randomUUID(), kind: "plan", plan: drafted });
      scrollDown();
    } catch (e) {
      toastAiFailure("preflight: copilot plan", e, "deep");
    } finally {
      setBusy(null);
    }
  }

  function asBackground(text: string) {
    setMeetingContext(context.trim() ? `${context.trim()}\n\n${text}` : text);
    setPasted(null);
    setInput("");
    setFieldsOpen(true);
  }

  const summary = [
    t("preflight.copilot.sum.agenda", { n: todos.length }),
    target ? t("preflight.copilot.sum.targetSet") : t("preflight.copilot.sum.targetOpen"),
    floor ? t("preflight.copilot.sum.floorSet") : t("preflight.copilot.sum.floorOpen"),
  ].join(" · ");

  return (
    <Column
      step="③"
      title={t("preflight.copilot.title")}
      bodyClassName=""
      footer={
        <div className="flex flex-col">
          {pasted && (
            <div className="flex items-start gap-2 border-b bg-muted/40 px-3 py-2">
              <ClipboardPaste className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t("preflight.copilot.pasteOffer", { n: pasted.length })}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    className="h-6 text-[11px]"
                    onClick={() => asBackground(pasted)}
                  >
                    {t("preflight.copilot.pasteBackground")}
                  </Button>
                </div>
              </div>
              <button
                type="button"
                aria-label={t("common.close")}
                onClick={() => setPasted(null)}
                className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {/* The fields the coach drafts into — collapsed, because reading the
              summary is enough until something needs correcting. */}
          <button
            type="button"
            onClick={() => setFieldsOpen((v) => !v)}
            className="flex cursor-pointer items-center gap-1.5 border-b px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {fieldsOpen ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{summary}</span>
          </button>
          {fieldsOpen && (
            <div className="flex max-h-72 flex-col gap-3 overflow-y-auto border-b px-3 py-3">
              <MeetingContextField rows={4} />
              <AgendaList />
            </div>
          )}

          <form
            className="flex flex-col gap-1.5 p-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text");
                if (text.trim().length >= PASTE_THRESHOLD) setPasted(text.trim());
              }}
              onKeyDown={(e) => {
                // Never hijack keys mid-IME-composition — Enter commits the
                // candidate, and stealing it eats the word being typed.
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              // Never disabled, even with no API key: pasting background in is
              // the one thing the user always does by hand, and "keep as
              // background" needs no model at all. Only the AI paths are gated.
              placeholder={t("preflight.copilot.placeholder")}
              aria-label={t("preflight.copilot.placeholder")}
              className="max-h-32 min-h-9 resize-none text-xs"
            />
            {!chatReady && (
              <p className="px-0.5 text-[10px] leading-snug text-muted-foreground">
                {t("preflight.copilot.noKey")}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                disabled={!deepReady || !!busy}
                onClick={() => void plan()}
              >
                {busy === "plan" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
                {t("preflight.copilot.draftPlan")}
              </Button>
              <span className="flex-1" />
              <Button
                type="submit"
                size="icon"
                className="size-7 shrink-0"
                disabled={!input.trim() || !!busy || !chatReady}
              >
                {busy === "chat" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="size-3.5" />
                )}
              </Button>
            </div>
          </form>
        </div>
      }
    >
      {!folder && !setup.hasScenario ? (
        <div className="h-full px-4 py-3">
          <EmptyState
            glyph="notes"
            title={t("preflight.copilot.emptyTitle")}
            hint={t("preflight.copilot.emptyHint")}
          />
        </div>
      ) : (
        <>
          {/* What the system knows, stated before anything is asked of the user.
              Deterministic — no key, no spinner, no network. */}
          <div className="sticky top-0 z-10 flex flex-col gap-1 border-b bg-background px-4 py-2">
            <p className="text-xs leading-snug">
              {folder
                ? t("preflight.copilot.nth", { company: folder.name, n: head.nth })
                : t("preflight.copilot.unfiled")}
              {head.lastMeeting && (
                <span className="text-muted-foreground">
                  {" · "}
                  {t("preflight.copilot.lastTime", {
                    date: new Date(head.lastMeeting.at).toLocaleDateString(),
                    title: head.lastMeeting.title,
                  })}
                </span>
              )}
            </p>
            {stageLabel && head.boardSlots > 0 && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                <span>
                  {t("preflight.copilot.board", { stage: stageLabel, n: head.boardSlots })}
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="text-xs leading-relaxed">{t("preflight.copilot.opener")}</p>
            {messages.length === 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 self-start text-[11px]"
                disabled={!deepReady || !!busy || !setup.stageId}
                title={!setup.stageId ? t("preflight.copilot.needStage") : undefined}
                onClick={() => void draft()}
              >
                {busy === "draft" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Target className="size-3" />
                )}
                {t("preflight.copilot.draftNow")}
              </Button>
            )}

            {messages.map((m) => {
              if (m.kind === "plan") return <PlanCard key={m.id} plan={m.plan} />;
              if (m.role === "user") {
                return (
                  <p
                    key={m.id}
                    className="ml-auto max-w-[92%] select-text whitespace-pre-wrap rounded-lg bg-primary px-2.5 py-1.5 text-xs leading-relaxed text-primary-foreground"
                  >
                    {m.content}
                  </p>
                );
              }
              return (
                <div key={m.id} className="w-full">
                  {m.content ? (
                    <div className="prose prose-sm max-w-none select-text text-xs text-foreground dark:prose-invert prose-p:my-1.5 prose-headings:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">…</p>
                  )}
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        </>
      )}

    </Column>
  );
}

/** The agenda the live coach ticks off, editable where it's drafted. */
function AgendaList() {
  const { t } = useI18n();
  const todos = useStore((s) => s.todos);
  const addTodo = useStore((s) => s.addTodo);
  const toggleTodo = useStore((s) => s.toggleTodo);
  const removeTodo = useStore((s) => s.removeTodo);
  const [draft, setDraft] = useState("");

  return (
    <div className="flex flex-col gap-1.5 border-t pt-3">
      <SectionTitle>{t("preflight.prep.agenda")}</SectionTitle>
      {todos.map((todo) => (
        <div key={todo.id} className="group flex items-start gap-2 rounded-md px-1 py-0.5 hover:bg-muted/50">
          <button
            type="button"
            aria-label={todo.text}
            onClick={() => toggleTodo(todo.id)}
            className="mt-0.5 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
          >
            {todo.done ? (
              <Check className="size-3.5 text-emerald-500" />
            ) : (
              <Square className="size-3.5" />
            )}
          </button>
          <span
            className={`min-w-0 flex-1 text-xs leading-snug ${todo.done ? "text-muted-foreground line-through" : ""}`}
          >
            {todo.text}
          </span>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => removeTodo(todo.id)}
            className="shrink-0 cursor-pointer text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          addTodo(draft);
          setDraft("");
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("todos.addPlaceholder")}
          className="h-7 text-xs"
        />
        <Button type="submit" size="icon" className="size-7 shrink-0" disabled={!draft.trim()}>
          <Plus className="size-3.5" />
        </Button>
      </form>
    </div>
  );
}
