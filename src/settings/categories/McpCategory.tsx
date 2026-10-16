import { ChevronRight, ScrollText } from "lucide-react";
import { appLogDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";
import { InfoTip } from "@/components/ui/info-tip";
import { log } from "../../lib/log";
import { isMac } from "../../lib/platform";
import { isTauri } from "../../lib/tauriEvents";
import { openDiagnosticsWindow } from "../../lib/diagnostics";
import { claudeCodeCommand, mcpClientConfigJson, type McpServerInfo } from "../../lib/mcp/connect";
import { clientLabel, connState, relativeTime, type McpActivityInfo } from "../../components/McpStatusChip";
import { useI18n } from "../../i18n";
import { CachesPanel } from "../CachesPanel";
import { Section } from "../fields";
import type { SettingsPanelProps } from "./types";

/** Settings › MCP: the server, who is talking to it, how to connect — and, on
 *  Windows, the logs and caches panels (macOS keeps those in the menu bar). */
export function McpCategory({
  settings,
  patch,
  mcpInfo,
  mcpActivity,
  templatesPath,
  logPath,
}: Readonly<
  SettingsPanelProps & {
    mcpInfo: McpServerInfo | null;
    mcpActivity: McpActivityInfo | null;
    templatesPath: string;
    logPath: string;
  }
>) {
  return (
    <>
      <McpServerSection settings={settings} patch={patch} mcpInfo={mcpInfo} mcpActivity={mcpActivity} templatesPath={templatesPath} />
      {/* Logs and caches are system-level chores: on macOS they live in the
          menu bar's Diagnostics menu (menu.rs). Windows draws no menu bar, so
          there this page is still their only door. */}
      {!isMac() && <LogsSection logPath={logPath} />}
      {!isMac() && <CachesSection />}
    </>
  );
}

function McpServerSection({
  settings,
  patch,
  mcpInfo,
  mcpActivity,
  templatesPath,
}: Readonly<
  SettingsPanelProps & {
    mcpInfo: McpServerInfo | null;
    mcpActivity: McpActivityInfo | null;
    templatesPath: string;
  }
>) {
  const { t } = useI18n();
  return (
    <Section title={t("settings.mcp.title")} info={t("settings.mcp.description")}>
      {/* One card: is the server up, where is it, who is talking to it.
          The recent-activity list (same data as the titlebar chip, so MCP
          data access stays auditable) folds away until asked for. */}
      <div className="flex max-w-xl flex-col gap-2 rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${
              mcpInfo?.running ? "bg-success-foreground" : "bg-warning-foreground"
            }`}
          />
          <span className="text-sm font-medium">
            {mcpInfo?.running ? t("settings.mcp.running") : t("settings.mcp.starting")}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {mcpInfo?.endpoint || t("settings.mcp.endpointPending")}
          </span>
          {mcpInfo?.endpoint && (
            <CopyButton
              iconOnly
              value={mcpInfo.endpoint}
              title={t("settings.mcp.copyUrl")}
              className="size-6 shrink-0 text-muted-foreground"
            />
          )}
        </div>
        <details className="group text-[11px] text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-1.5">
            <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
            <span>
              {clientLabel(mcpActivity?.client) ?? t("mcp.panel.noClient")}
              {" · "}
              {t(`mcp.state.${connState(mcpActivity, Date.now())}`)}
              {mcpActivity?.lastRequestAt
                ? ` · ${relativeTime(t, mcpActivity.lastRequestAt, Date.now())}`
                : ""}
            </span>
          </summary>
          {mcpActivity?.recent?.length ? (
            <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto">
              {mcpActivity.recent.map((e) => (
                <li key={`${e.at}-${e.tool}`} className="flex items-center gap-2">
                  <span
                    className={`w-6 shrink-0 rounded px-1 text-center text-[9.5px] font-semibold ${
                      e.kind === "write"
                        ? "bg-warning text-warning-foreground"
                        : "bg-info text-info-foreground"
                    }`}
                  >
                    {t(`mcp.kind.${e.kind}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground">{e.tool}</span>
                  {!e.ok && <span className="shrink-0 text-destructive">{t("mcp.panel.failed")}</span>}
                  <span className="shrink-0 tabular-nums text-[10px]">
                    {relativeTime(t, e.at, Date.now())}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2">{t("mcp.panel.emptyActivity")}</p>
          )}
        </details>
      </div>

      {/* Connecting is a copy-and-paste job, so each way in is one row with
          one copy button; the command and JSON themselves are what the
          button copies, not something to read on this page. */}
      <div className="flex max-w-xl flex-col divide-y rounded-lg border">
        <CopyRow
          label={t("settings.mcp.claudeCodeInstructions")}
          info={t("settings.mcp.claudeCodeHelp")}
          value={() => claudeCodeCommand(mcpInfo?.endpoint)}
          copyLabel={t("settings.mcp.copyCommand")}
        />
        <CopyRow
          label={t("settings.mcp.configInstructions")}
          info={t("settings.mcp.configHelp")}
          value={() => mcpClientConfigJson(mcpInfo?.endpoint)}
          copyLabel={t("settings.mcp.copyConfig")}
        />
        <CopyRow
          label={t("settings.mcp.sharedFile")}
          info={templatesPath || mcpInfo?.templates_path || ""}
          value={templatesPath || mcpInfo?.templates_path || ""}
          copyLabel={t("settings.mcp.copyPath")}
        />
      </div>

      {/* Lives on the MCP panel because turning it OFF is what hands
          analysis to the external AI connected here. */}
      <label className="flex max-w-xl items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          checked={settings.autoStudyAnalysis}
          onChange={(e) => patch({ autoStudyAnalysis: e.target.checked })}
        />
        {t("settings.autoStudyAnalysis.title")}
        <InfoTip label={t("settings.info")}>{t("settings.autoStudyAnalysis.desc")}</InfoTip>
      </label>
    </Section>
  );
}

function LogsSection({ logPath }: Readonly<{ logPath: string }>) {
  const { t } = useI18n();
  return (
    <Section title={t("settings.logs.title")}>
      <p className="text-[11px] text-muted-foreground">{t("settings.logs.help")}</p>
      {logPath && (
        <pre className="overflow-x-auto rounded border bg-muted p-2.5 font-mono text-xs text-foreground">
          {logPath}
        </pre>
      )}
      <div className="flex items-center gap-2">
        {/* The Field Log window used to be reachable only from the native
            Diagnostics menu, which Windows never draws (the main window
            is undecorated) — so on Windows the log had no door at all.
            This button is that door on both platforms. */}
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() =>
            openDiagnosticsWindow().catch((e) =>
              log.error("logs: open field log failed", { error: String(e) }),
            )
          }
        >
          <ScrollText className="size-3.5" />
          {t("settings.logs.openFieldLog")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!isTauri()}
          onClick={async () => {
            try {
              const dir = await appLogDir();
              const file = await join(dir, "parley.log");
              log.info("logs: reveal requested");
              await revealItemInDir(file);
            } catch (e) {
              log.error("logs: reveal failed", { error: String(e) });
            }
          }}
        >
          {t("settings.logs.reveal")}
        </Button>
        {logPath && <CopyButton value={logPath} label={t("settings.logs.copyPath")} />}
      </div>
    </Section>
  );
}

function CachesSection() {
  const { t } = useI18n();
  return (
    <Section title={t("settings.caches.title")}>
      <CachesPanel />
    </Section>
  );
}

/** One way to connect: a label, its explanation on hover, and a copy button. */
function CopyRow({
  label,
  info,
  value,
  copyLabel,
}: Readonly<{ label: string; info: string; value: string | (() => string); copyLabel: string }>) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="text-xs font-medium">{label}</span>
      {info && <InfoTip label={t("settings.info")}>{info}</InfoTip>}
      <CopyButton
        className="ml-auto h-7 shrink-0 gap-1 text-[11px]"
        value={value}
        label={copyLabel}
        disabled={typeof value === "string" && !value}
      />
    </div>
  );
}
