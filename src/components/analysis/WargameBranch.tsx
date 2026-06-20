import { useEffect, useRef, useState } from "react";
import { ArrowUp, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { FindingMove, WargameBranchTurn } from "../../lib/types";

/**
 * An inline, chat-like roleplay of one chosen corrective move: ME plays the move,
 * THEM (the opponent) reacts, and ME can keep replying to pressure-test it.
 * Mirrors the AskPanel bubble styling: ME on the right (primary), THEM on the
 * left (muted). The first opponent turn is fetched on mount.
 */
export function WargameBranch({
  situation,
  sourceQuote,
  move,
  onCollapse,
}: {
  situation: string;
  sourceQuote?: string;
  move: FindingMove;
  onCollapse: () => void;
}) {
  const { t } = useI18n();
  const [turns, setTurns] = useState<WargameBranchTurn[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  async function advance(userReply?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { settings, meetingContext } = useStore.getState();
    try {
      const { simulateBranch } = await import("../../lib/ai/wargame");
      const newTurns = await simulateBranch({
        settings,
        situation,
        sourceQuote,
        move,
        history: turns,
        userReply,
        meetingContext,
      });
      setTurns((prev) => [...prev, ...newTurns]);
    } catch (err) {
      setError(t("wargame.branchFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  // Kick off the first opponent turn once.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void advance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, busy]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = reply.trim();
    if (!text || busy) return;
    setReply("");
    void advance(text);
  }

  return (
    <div className="mt-2 rounded-lg border bg-background/60 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t(`wargame.kind.${move.kind}` as const)}
        </span>
        <button
          type="button"
          onClick={onCollapse}
          className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3" />
          {t("wargame.collapseBranch")}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {turns.map((turn, i) =>
          turn.role === "me" ? (
            <div
              key={i}
              className="select-text ml-auto max-w-[92%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground"
            >
              {turn.text}
            </div>
          ) : (
            <div
              key={i}
              className="prose prose-invert prose-sm select-text mr-auto max-w-[92%] rounded-lg bg-muted px-3 py-2 text-foreground prose-p:my-1.5"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown>
            </div>
          )
        )}
        {busy && (
          <div className="mr-auto rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">…</div>
        )}
        {error && <div className="text-[11px] text-red-400">{error}</div>}
        <div ref={endRef} />
      </div>

      <form onSubmit={submit} className="mt-2 flex items-end gap-2">
        <Textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit(e);
            }
          }}
          rows={1}
          placeholder={t("wargame.yourReply")}
          className="max-h-32 min-h-9 resize-none text-sm"
        />
        <Button type="submit" size="icon" className="size-9 shrink-0" disabled={!reply.trim() || busy}>
          <ArrowUp className="size-4" />
        </Button>
      </form>
      <p className="mt-1 px-0.5 text-[10px] text-muted-foreground">{t("wargame.continueBranch")}</p>
    </div>
  );
}
