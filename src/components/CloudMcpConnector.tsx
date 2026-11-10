import { useI18n } from "../i18n";
import { log } from "../lib/log";
import { isTauri } from "../lib/tauriEvents";
import { CLOUD_MCP_GUIDE_URL, CLOUD_MCP_URL, claudeCodeCommand } from "../lib/mcp/connect";
import { CopyButton } from "./CopyButton";

/** Open the public connect-Claude guide in the user's browser (the system
 *  opener under Tauri; a new tab in plain-browser dev). */
export function openCloudMcpGuide(): void {
  if (!isTauri()) {
    globalThis.open(CLOUD_MCP_GUIDE_URL, "_blank", "noopener");
    return;
  }
  import("@tauri-apps/plugin-opener")
    .then(({ openUrl }) => openUrl(CLOUD_MCP_GUIDE_URL))
    .catch((error) => log.warn("mcp: open cloud guide failed", { error: String(error) }));
}

/** One string to paste, in a muted mono row with its copy button. */
function CopyLine({ value, title }: Readonly<{ value: string; title: string }>) {
  return (
    <div className="flex items-center gap-1 rounded-md bg-muted/60 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
        {value}
      </code>
      <CopyButton iconOnly value={value} title={title} className="size-7 shrink-0 text-muted-foreground" />
    </div>
  );
}

/**
 * How to reach Parley's cloud MCP server (the cloud route), for the 連接 AI
 * popover and the first-run guide's hand-off step: the Claude Code command,
 * then the custom-connector steps Claude on the web, desktop and phone take,
 * with the URL to paste. The remote server reports no live connection status
 * to the app, so unlike the local panel there is no "waiting for a
 * connection" line — only the plain fact that it sees synced recordings.
 */
export function CloudMcpConnector({ lead = true }: Readonly<{ lead?: boolean }>) {
  const { t } = useI18n();
  const command = claudeCodeCommand(CLOUD_MCP_URL);
  return (
    <div className="flex flex-col gap-2.5">
      {lead && <p className="text-sm">{t("mcp.cloud.lead")}</p>}
      <CopyLine value={command} title={t("settings.mcp.copyCommand")} />
      <h3 className="mt-1 text-xs font-medium text-muted-foreground">{t("mcp.cloud.connector")}</h3>
      <p className="text-xs leading-relaxed">{t("mcp.cloud.connectorSteps", { url: CLOUD_MCP_URL })}</p>
      <CopyLine value={CLOUD_MCP_URL} title={t("mcp.cloud.copyUrl")} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-xs text-muted-foreground">{t("mcp.cloud.synced")}</p>
        <button
          type="button"
          onClick={openCloudMcpGuide}
          className="cursor-pointer text-xs text-primary underline-offset-2 transition-colors hover:underline"
        >
          {t("mcp.cloud.guide")}
        </button>
      </div>
    </div>
  );
}
