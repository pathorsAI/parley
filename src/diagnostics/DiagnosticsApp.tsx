import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appLogDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, Search } from "lucide-react";
import { useThemePreference } from "../lib/theme";
import { isTauri } from "../lib/tauriEvents";
import { log } from "../lib/log";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Levels we colour + filter on. "all" = no level filter. */
type Level = "error" | "warn" | "info" | "debug";
type Filter = "all" | Level;

const FILTERS: Filter[] = ["all", "error", "warn", "info", "debug"];
const RANK: Record<Level, number> = { error: 4, warn: 3, info: 2, debug: 1 };
const LEVEL_CLASS: Record<Level, string> = {
  error: "text-red-400",
  warn: "text-amber-400",
  info: "text-foreground/80",
  debug: "text-muted-foreground",
};

/** Read the last ~200 KB of the log so the viewer stays snappy on big files. */
const TAIL_BYTES = 200_000;
const POLL_MS = 1500;

interface LogLine {
  raw: string;
  level: Level;
}

/**
 * tauri-plugin-log lines carry a bracketed level token, e.g.
 *   [2026-06-21][12:34:56][parley::lib][INFO] app: starting up
 * Pull it out for colouring + filtering; default to "info" when absent.
 */
function parseLevel(line: string): Level {
  const m = line.match(/\[(ERROR|WARN|INFO|DEBUG|TRACE)\]/i) ?? line.match(/\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/i);
  switch (m?.[1]?.toUpperCase()) {
    case "ERROR":
      return "error";
    case "WARN":
      return "warn";
    case "DEBUG":
    case "TRACE":
      return "debug";
    default:
      return "info";
  }
}

/**
 * Standalone, movable Field Log window (Tauri multi-window, like Settings).
 * Tails the rotating `parley.log` written by tauri-plugin-log, with a level
 * filter, search, autoscroll, and a "reveal in Finder" affordance.
 */
export function DiagnosticsApp() {
  useThemePreference();
  const { t } = useI18n();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [autoscroll, setAutoscroll] = useState(true);
  const [logPath, setLogPath] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Resolve the on-disk log path once (for the reveal affordance).
  useEffect(() => {
    if (!isTauri()) return;
    appLogDir()
      .then((d) => join(d, "parley.log"))
      .then(setLogPath)
      .catch(() => {});
  }, []);

  // Poll the log tail. Re-reading the whole tail keeps it dead simple and is
  // cheap at 200 KB; the diff is invisible to the user.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const tick = () => {
      invoke<string>("read_log_tail", { maxBytes: TAIL_BYTES })
        .then((text) => {
          if (!alive) return;
          const parsed = text
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((raw) => ({ raw, level: parseLevel(raw) }));
          setLines(parsed);
        })
        .catch((e) => log.warn("diagnostics: read_log_tail failed", { error: String(e) }));
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => {
      if (filter !== "all" && RANK[l.level] < RANK[filter]) return false;
      if (q && !l.raw.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [lines, filter, query]);

  // Stick to the bottom as new lines arrive (when enabled).
  useEffect(() => {
    if (!autoscroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, autoscroll]);

  if (!isTauri()) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
        {t("logs.browserOnly")}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="grid grid-cols-5 rounded-md bg-muted p-0.5 text-[11px]">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-[5px] px-2 py-1 capitalize transition-colors ${
                filter === f ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(`logs.level.${f}` as const)}
            </button>
          ))}
        </div>

        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("logs.search")}
            className="h-8 pl-7 text-xs"
          />
        </div>

        <label className="flex shrink-0 select-none items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(e) => setAutoscroll(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          {t("logs.autoscroll")}
        </label>

        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 text-xs"
          onClick={async () => {
            try {
              const dir = await appLogDir();
              const file = await join(dir, "parley.log");
              log.info("diagnostics: reveal requested");
              await revealItemInDir(file);
            } catch (e) {
              log.error("diagnostics: reveal failed", { error: String(e) });
            }
          }}
        >
          <FolderOpen className="size-3.5" />
          {t("settings.logs.reveal")}
        </Button>
      </div>

      {/* Log body */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-muted/20 px-3 py-2 font-mono text-[11px] leading-relaxed">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">{t("logs.empty")}</div>
        ) : (
          visible.map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap break-words ${LEVEL_CLASS[l.level]}`}>
              {l.raw}
            </div>
          ))
        )}
      </div>

      {/* Footer: log path + line count */}
      <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="truncate font-mono">{logPath}</span>
        <span className="ml-auto shrink-0 tabular-nums">{t("logs.lineCount", { count: visible.length })}</span>
      </div>
    </div>
  );
}
