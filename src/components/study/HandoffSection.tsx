import { toast } from "sonner";
import { ClipboardCopy } from "lucide-react";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { clientLabel, useMcpActivity } from "../../lib/mcp/activity";
import { claudeCodeCommand, mcpClientConfigJson, useMcpEndpoint } from "../../lib/mcp/connect";
import { useHandoff } from "../../lib/onboarding/useHandoff";
import { CopyButton } from "../CopyButton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 交給你的 AI — the report's last section: how to get this recording in front
 * of the user's own AI, with questions worth asking once it is there.
 *
 * Primary: connect Claude Code over MCP. It reads the whole library directly,
 * so nothing is copied and follow-up questions can span recordings. The status
 * line reads the same activity feed as the titlebar chip, so the user sees the
 * connection land without leaving the page.
 *
 * Secondary: copy the transcript wrapped in an analysis prompt (the same text
 * as the transcript copy menu's first item), or the report itself, for pasting
 * into ChatGPT or Claude. Read-only org copies and empty transcripts keep the
 * section but disable the copy buttons.
 */
export function HandoffSection() {
  const { t } = useI18n();
  const { questions, mcpQuestions, canCopy, copyPrompt, reportMarkdown } = useHandoff();
  const endpoint = useMcpEndpoint();
  const { info } = useMcpActivity();
  const client = clientLabel(info?.client);
  const command = claudeCodeCommand(endpoint);

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(mcpClientConfigJson(endpoint));
      toast.success(t("settings.mcp.copied"));
    } catch (e) {
      log.warn("handoff: config copy failed", { error: String(e) });
      toast.error(t("common.copyFailed"));
    }
  };

  return (
    <div className="flex flex-col">
      {/* Primary: Claude Code over MCP. */}
      <div data-handoff="mcp" className="flex flex-col gap-2.5">
        <p className="text-sm">{t("study.handoff.mcpLead")}</p>
        <div className="flex items-center gap-1 rounded-md bg-muted/60 py-1 pl-3 pr-1">
          <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
            {command}
          </code>
          <CopyButton
            iconOnly
            value={command}
            title={t("settings.mcp.copyCommand")}
            className="size-7 shrink-0 text-muted-foreground"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <McpStatusLine client={client} />
          <button
            type="button"
            onClick={() => void copyConfig()}
            className="cursor-pointer text-xs text-primary underline-offset-2 transition-colors hover:underline"
          >
            {t("study.handoff.desktopConfig")}
          </button>
        </div>

        <h3 className="mt-3 text-xs font-medium text-muted-foreground">{t("study.handoff.tryAsking")}</h3>
        <ul className="flex flex-col">
          {mcpQuestions.map((q) => (
            <li key={q} className="flex items-start gap-2 py-1">
              <span className="min-w-0 flex-1 pt-0.5 text-sm">{q}</span>
              <CopyButton
                iconOnly
                value={q}
                title={t("study.handoff.copyQuestion")}
                className="size-6 shrink-0 text-muted-foreground"
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="my-5 h-px bg-border" />

      {/* Secondary: copy and paste. */}
      <div data-handoff="copy" className="flex flex-col gap-2.5">
        <p className="text-sm text-muted-foreground">{t("study.handoff.copyLead")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={!canCopy}
            onClick={() => void copyPrompt()}
          >
            <ClipboardCopy className="size-3.5" />
            {t("study.handoff.copyPrompt")}
          </Button>
          <CopyButton
            value={reportMarkdown}
            label={t("study.handoff.copyReport")}
            disabled={!canCopy}
            className="gap-1"
          />
        </div>
        <h3 className="mt-2 text-xs font-medium text-muted-foreground">{t("study.handoff.thenAsk")}</h3>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
          {questions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** "Waiting…" until an MCP client has introduced itself, then who it is. */
function McpStatusLine({ client }: Readonly<{ client: string | null }>) {
  const { t } = useI18n();
  return (
    <p
      data-mcp-status={client ? "connected" : "waiting"}
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          client ? "bg-success-foreground" : "animate-pulse bg-muted-foreground/40"
        )}
      />
      {client ? t("study.handoff.connected", { client }) : t("study.handoff.waiting")}
    </p>
  );
}
