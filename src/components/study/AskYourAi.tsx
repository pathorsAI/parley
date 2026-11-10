import { toast } from "sonner";
import { Plug } from "lucide-react";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { clientLabel, useMcpActivity } from "../../lib/mcp/activity";
import { claudeCodeCommand, mcpClientConfigJson, useMcpEndpoint } from "../../lib/mcp/connect";
import { useHandoff } from "../../lib/onboarding/useHandoff";
import { CopyButton } from "../CopyButton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * 連接 AI, beside 複製: how to put this recording in front of the user's own
 * AI over MCP. Claude Code reads the whole library directly, so nothing is
 * copied and a follow-up can span recordings; Claude Desktop takes a config
 * block. The status line reads the same activity feed as the titlebar chip, so
 * the connection is seen landing without leaving the page, and the questions
 * name this recording so they work as pasted.
 *
 * Copy-and-paste into a chat (the transcript wrapped in the analysis prompt)
 * stays in the 複製 menu next door.
 */
export function AskYourAi() {
  const { t } = useI18n();
  const { mcpQuestions } = useHandoff();
  const endpoint = useMcpEndpoint();
  const { info } = useMcpActivity();
  const client = clientLabel(info?.client);
  const command = claudeCodeCommand(endpoint);

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(mcpClientConfigJson(endpoint));
      toast.success(t("settings.mcp.copied"));
    } catch (e) {
      log.warn("study: MCP config copy failed", { error: String(e) });
      toast.error(t("common.copyFailed"));
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5">
          <Plug className="size-3.5" />
          {t("study.ai")}
          {client && <span aria-hidden className="size-1.5 rounded-full bg-success-foreground" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[380px] flex-col gap-2.5 p-4">
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
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                client ? "bg-success-foreground" : "animate-pulse bg-muted-foreground/40"
              )}
            />
            {client ? t("study.handoff.connected", { client }) : t("study.handoff.waiting")}
          </p>
          <button
            type="button"
            onClick={() => void copyConfig()}
            className="cursor-pointer text-xs text-primary underline-offset-2 transition-colors hover:underline"
          >
            {t("study.handoff.desktopConfig")}
          </button>
        </div>

        <h3 className="mt-2 text-xs font-medium text-muted-foreground">{t("study.handoff.tryAsking")}</h3>
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
      </PopoverContent>
    </Popover>
  );
}
