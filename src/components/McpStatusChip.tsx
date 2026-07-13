import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Popover } from "radix-ui";
import { AlertCircle, Plug } from "lucide-react";
import { isTauri } from "../lib/tauriEvents";
import { useI18n } from "../i18n";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/CopyButton";

/** One tool call recorded by the MCP server (newest first in `recent`). */
export interface McpActivityEntry {
  at: number;
  tool: string;
  kind: "read" | "write";
  ok: boolean;
  error?: string;
}

export interface McpActivityInfo {
  client: { name?: string; version?: string } | null;
  lastRequestAt: number | null;
  recent: McpActivityEntry[];
}

/** Derived connection state. HTTP MCP has no persistent session, so this is
 *  recency of the last request: active (seconds), connected (minutes), idle
 *  (client seen before, quiet now), none (no client ever). */
export type McpConnState = "active" | "connected" | "idle" | "none";

export function connState(info: McpActivityInfo | null, now: number): McpConnState {
  const last = info?.lastRequestAt;
  if (!last) return "none";
  const age = now - last;
  if (age <= 15_000) return "active";
  if (age <= 5 * 60_000) return "connected";
  return "idle";
}

export function relativeTime(t: ReturnType<typeof useI18n>["t"], at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return t("mcp.time.justNow");
  if (s < 60) return t("mcp.time.sAgo", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("mcp.time.mAgo", { n: m });
  return t("mcp.time.hAgo", { n: Math.floor(m / 60) });
}

/**
 * Titlebar MCP indicator: a plug icon with a status dot (pulsing green = a
 * client is actively calling tools, green = recent traffic, grey = idle/none).
 * Clicking opens a popover with who's connected (clientInfo from initialize),
 * the endpoint, and the recent read/write tool calls — so MCP data access is
 * never invisible.
 */
export function McpStatusChip() {
  const { t } = useI18n();
  const [info, setInfo] = useState<McpActivityInfo | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    async function refresh() {
      try {
        const a = await invoke<McpActivityInfo>("get_mcp_activity");
        if (alive) {
          setInfo(a);
          setNow(Date.now());
        }
      } catch {
        /* server not up yet; retry next tick */
      }
    }
    refresh();
    // Faster while the panel is open so the feed reads live.
    const id = setInterval(refresh, open ? 1000 : 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [open]);

  useEffect(() => {
    if (!isTauri() || endpoint) return;
    invoke<{ endpoint: string }>("get_mcp_server_info")
      .then((i) => setEndpoint(i.endpoint))
      .catch(() => {});
  }, [endpoint]);

  if (!isTauri()) return null;

  const state = connState(info, now);
  const stateLabel = t(`mcp.state.${state}`);
  const dotClass =
    state === "active"
      ? "bg-emerald-500 animate-pulse"
      : state === "connected"
        ? "bg-emerald-500"
        : state === "idle"
          ? "bg-muted-foreground/50"
          : "bg-muted-foreground/25";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("mcp.panel.title")}
          title={`${t("mcp.panel.title")} · ${stateLabel}`}
          className="relative grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plug className="size-4" />
          <span className={cn("absolute right-1.5 top-1.5 size-1.5 rounded-full", dotClass)} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-[80] w-80 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <div className="flex items-center gap-2">
            <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
            <span className="text-xs font-semibold">{t("mcp.panel.title")}</span>
            <span className="ml-auto text-[11px] text-muted-foreground">{stateLabel}</span>
          </div>

          <div className="mt-2 space-y-1 text-[11px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="shrink-0 text-muted-foreground">{t("mcp.panel.client")}</span>
              <span className="truncate font-medium">
                {info?.client
                  ? `${info.client.name ?? "?"}${info.client.version ? ` v${info.client.version}` : ""}`
                  : t("mcp.panel.noClient")}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="shrink-0 text-muted-foreground">{t("mcp.panel.lastRequest")}</span>
              <span className="tabular-nums">
                {info?.lastRequestAt ? relativeTime(t, info.lastRequestAt, now) : "—"}
              </span>
            </div>
            {endpoint && (
              <div className="flex items-center justify-between gap-2">
                <span className="shrink-0 text-muted-foreground">Endpoint</span>
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-[10px] text-muted-foreground">{endpoint}</span>
                  <CopyButton
                    value={endpoint}
                    iconOnly
                    title={t("settings.mcp.copyUrl")}
                    className="size-5 shrink-0 text-muted-foreground"
                  />
                </span>
              </div>
            )}
          </div>

          <div className="mt-3 border-t pt-2">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t("mcp.panel.activity")}
            </div>
            {info?.recent?.length ? (
              <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                {info.recent.map((e) => (
                  <li key={`${e.at}-${e.tool}`} className="flex items-center gap-2 rounded px-1 py-0.5 text-[11px]">
                    <span
                      className={cn(
                        "w-6 shrink-0 rounded px-1 text-center text-[9.5px] font-semibold",
                        e.kind === "write"
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          : "bg-sky-500/15 text-sky-600 dark:text-sky-400",
                      )}
                    >
                      {t(`mcp.kind.${e.kind}`)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono">{e.tool}</span>
                    {!e.ok && (
                      <span title={e.error ?? t("mcp.panel.failed")}>
                        <AlertCircle className="size-3 shrink-0 text-destructive" />
                      </span>
                    )}
                    <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                      {relativeTime(t, e.at, now)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-1 text-[11px] text-muted-foreground">{t("mcp.panel.emptyActivity")}</p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
