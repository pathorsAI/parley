import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Loader2,
  Plus,
  ShieldAlert,
  Sparkles,
  Square,
  Target,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { useAccounts, activeClaims, personsOf, threadsOf } from "../../lib/accounts/store";
import type { ExtractedOps } from "../../lib/accounts/store";
import { useMeetingSetup } from "./useMeetingSetup";
import { collectPrepFacts, prepHeadline, type PrepFacts } from "../../lib/preflight/facts";
import { hasProviderKey } from "../../lib/ai/settings";
import { AI_FAILURE_HINT_KEY, classifyAiFailure } from "../../lib/ai/failure";
import { toastAiFailure } from "../../lib/ai/failureToast";
import { useI18n, type TranslationKey } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { MeetingContextField } from "../MeetingContextField";
import { ReviewOpsPanel } from "../accounts/ReviewOpsPanel";
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
 * telling them what the claim base already knows, and everything else is
 * drafted and then corrected.
 *
 * The negotiation fields did NOT go away — they feed every analysis prompt and
 * the BATNA evaluation. They moved from a blank form to a drafted one.
 */
export function PrepCopilot() {
  const { t } = useI18n();
  const setup = useMeetingSetup();
  const acc = useAccounts();

  const settings = useStore((s) => s.settings);
  const target = useStore((s) => s.meetingTarget);
  const batna = useStore((s) => s.meetingBatna);
  const floor = useStore((s) => s.meetingFloor);
  const context = useStore((s) => s.meetingContext);
  const todos = useStore((s) => s.todos);
  const setMeetingContext = useStore((s) => s.setMeetingContext);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<null | "chat" | "draft" | "plan" | "extract">(null);
  const [pasted, setPasted] = useState<string | null>(null);
  /** Proposed ops kept WITH the text they came from — the attachment written on
   *  approval cites it, and the paste bar it came from may already be gone. */
  const [review, setReview] = useState<{ ops: ExtractedOps; source: string } | null>(null);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const company = setup.company;
  const chatReady = hasProviderKey(settings, "realtime");
  const deepReady = hasProviderKey(settings, "deep");

  // A different account is a different conversation — carrying the last one
  // over would have the coach confidently discussing the wrong customer.
  useEffect(() => {
    setMessages([]);
    setPasted(null);
  }, [setup.company?.id, setup.thread?.id]);

  // Destructured so the memo keys off the pieces, not the fresh object the hook
  // returns every render (which would make the memo a no-op).
  const { thread, attendees, claims, rows, stageLabel, meetings } = setup;
  const facts: PrepFacts | null = useMemo(() => {
    if (!company) return null;
    return collectPrepFacts({
      company,
      thread,
      attendees,
      claims,
      boardRows: rows,
      stageLabel,
      meetings: meetings.map((m) => ({ title: m.title, createdAt: m.createdAt })),
      prep: { target, batna, floor, context, agenda: todos.map((x) => x.text) },
      roleLabel: (role) => t(`accounts.role.${role}` as TranslationKey),
    });
  }, [
    company,
    thread,
    attendees,
    claims,
    rows,
    stageLabel,
    meetings,
    target,
    batna,
    floor,
    context,
    todos,
    t,
  ]);

  const head = facts ? prepHeadline(facts) : null;

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
    if (!q || busy || !facts) return;
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
   * The five-minute path (#189): one pass over the claim base and the stage
   * bundle, no conversation required, pressable the moment you land. The
   * thirty-minute path is `plan()` below, which reads what you and the coach
   * actually worked out.
   */
  async function draft() {
    const { company: co, scenario, stageId } = setup;
    if (busy || !co || !scenario || !stageId) return;
    setBusy("draft");
    try {
      const bundle = scenario.bundles[stageId];
      const { draftPrep } = await import("../../lib/ai/prepDraft");
      const result = await draftPrep({
        settings,
        input: {
          company: co,
          thread,
          attendees,
          claims,
          stageName: scenario.names[stageId] ?? stageId,
          stageGoal: bundle?.goal ?? "",
          exitCriteria: bundle?.exitCriteria ?? [],
          gaps: rows.map((r) => ({ label: r.slot.label, hint: r.slot.hint, state: r.state })),
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
    if (busy || !facts) return;
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

  /** Pasted material → proposed claims, reviewed one by one before anything lands. */
  async function extract(text: string) {
    if (busy || !company) return;
    setBusy("extract");
    try {
      const { extractClaimOps } = await import("../../lib/accounts/extract");
      const proposed = await extractClaimOps({
        settings,
        company,
        persons: personsOf(acc, company.id),
        threads: threadsOf(acc, company.id),
        existingClaims: activeClaims(acc, company.id),
        sourceText: text,
        sourceLabel: "pre-meeting notes pasted by the user",
      });
      setReview({ ops: proposed, source: text });
    } catch (e) {
      toastAiFailure("preflight: copilot extract", e, "deep");
    } finally {
      setBusy(null);
    }
  }

  function applyOps(approved: ExtractedOps) {
    if (!company || !review) return;
    const store = useAccounts.getState();
    const attachment = store.addAttachment({
      companyId: company.id,
      name: t("preflight.copilot.pasteName"),
      kind: "note",
      text: review.source,
    });
    store.applyExtractedOps({
      companyId: company.id,
      threadId: setup.thread?.id,
      ops: approved,
      provenance: { kind: "import", attachmentId: attachment.id },
    });
    const n = approved.newPersons.length + approved.newClaims.length + approved.claimUpdates.length;
    toast.success(t("accounts.review.applied", { n }));
    setReview(null);
    setPasted(null);
    setInput("");
  }

  /**
   * Lock a line the coach just surfaced (or one you typed) as a red line, so
   * the live guardrail fires on it. Goes straight in as a user-authored claim —
   * the review gate exists for what the MODEL proposes, and this is the user's
   * own sentence; the same path CompanyPage's claim list uses.
   */
  function asRedline(text: string) {
    if (!company) return;
    useAccounts.getState().addClaim({
      companyId: company.id,
      threadId: setup.thread?.id,
      subjects: [company.id],
      category: "redline",
      text: text.trim(),
      provenance: [{ kind: "user" }],
      confidence: "confirmed",
    });
    setInput("");
    setPasted(null);
    toast.success(t("preflight.copilot.redlineAdded"));
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
                    disabled={!company || !deepReady || !!busy}
                    title={!company ? t("preflight.copilot.needCompany") : undefined}
                    onClick={() => void extract(pasted)}
                  >
                    {busy === "extract" ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Sparkles className="size-3" />
                    )}
                    {t("preflight.copilot.pasteExtract")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
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
                disabled={!facts || !deepReady || !!busy}
                onClick={() => void plan()}
              >
                {busy === "plan" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
                {t("preflight.copilot.draftPlan")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-[11px] text-muted-foreground"
                disabled={!input.trim() || !company}
                title={t("preflight.copilot.redlineHint")}
                onClick={() => asRedline(input)}
              >
                <ShieldAlert className="size-3" />
                {t("preflight.copilot.redline")}
              </Button>
              <span className="flex-1" />
              <Button
                type="submit"
                size="icon"
                className="size-7 shrink-0"
                disabled={!input.trim() || !!busy || !facts || !chatReady}
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
      {!company || !head || !facts ? (
        <div className="h-full px-4 py-3">
          <EmptyState
            glyph="notes"
            title={t("preflight.copilot.emptyTitle")}
            hint={
              setup.hasScenario
                ? t("preflight.copilot.emptyHint")
                : t("preflight.review.emptyHintGeneral")
            }
          />
        </div>
      ) : (
        <>
          {/* What the system knows, stated before anything is asked of the user.
              Deterministic — no key, no spinner, no network. */}
          <div className="sticky top-0 z-10 flex flex-col gap-1 border-b bg-background px-4 py-2">
            <p className="text-xs leading-snug">
              {t("preflight.copilot.nth", { company: company.name, n: head.nth })}
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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
              {head.redlines > 0 && (
                <span className="text-red-600 dark:text-red-400">
                  ⚠ {t("preflight.copilot.redlines", { n: head.redlines })}
                </span>
              )}
              {head.openQuestions > 0 && (
                <span>{t("preflight.copilot.openq", { n: head.openQuestions })}</span>
              )}
              {head.emptyGaps.length > 0 && (
                <span>
                  {t("preflight.copilot.gaps", { n: head.emptyGaps.length })}
                  {" "}
                  <span className="text-foreground/70">{head.emptyGaps.join("、")}</span>
                </span>
              )}
              {head.redlines === 0 && head.openQuestions === 0 && head.emptyGaps.length === 0 && (
                <span>{t("preflight.copilot.allClear")}</span>
              )}
            </div>
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

      {review && company && (
        <Sheet open onOpenChange={(o) => !o && setReview(null)}>
          <SheetContent
            className="max-w-xl"
            closeLabel={t("common.close")}
            title={t("accounts.review.title")}
          >
            <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
              <ReviewOpsPanel
                ops={review.ops}
                existingClaims={activeClaims(acc, company.id)}
                onApply={applyOps}
                onCancel={() => setReview(null)}
              />
            </div>
          </SheetContent>
        </Sheet>
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
