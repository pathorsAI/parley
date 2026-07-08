import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, Mic, Search, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearVoiceEntries,
  deleteVoiceEntry,
  listVoiceEntries,
  type VoiceEntry,
} from "../lib/voiceTyping/history";

/** Past voice-typing dictations: search, copy, delete one, clear all. */
export function VoiceTypingHistory({ locale }: Readonly<{ locale: string }>) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<VoiceEntry[] | null>(null);
  const [query, setQuery] = useState("");

  const refresh = useCallback(() => {
    listVoiceEntries()
      .then(setEntries)
      .catch((error) =>
        log.warn("voice typing history: list failed", { error: String(error) }),
      );
  }, []);
  useEffect(refresh, [refresh]);

  const fmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  const filtered = useMemo(() => {
    if (!entries) return null;
    const q = query.trim().toLowerCase();
    return q ? entries.filter((e) => e.text.toLowerCase().includes(q)) : entries;
  }, [entries, query]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("history.voiceTyping.copied"));
    } catch {
      /* ignore */
    }
  }

  async function remove(id: string) {
    await deleteVoiceEntry(id);
    refresh();
  }

  async function clearAll() {
    await clearVoiceEntries();
    refresh();
  }

  let content;
  if (filtered === null) {
    content = (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("history.loading")}
      </div>
    );
  } else if (filtered.length === 0) {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <Mic className="size-8 opacity-40" />
        <p className="text-sm">{t("history.voiceTyping.empty")}</p>
        <p className="max-w-xs text-xs opacity-70">{t("history.voiceTyping.emptyHint")}</p>
      </div>
    );
  } else {
    content = (
      <div className="flex flex-col gap-2">
        {filtered.map((e) => (
          <div key={e.id} className="group/row flex items-start gap-3 rounded-lg border p-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="select-text whitespace-pre-wrap break-words text-sm leading-snug">
                {e.text}
              </p>
              <span className="text-[11px] text-muted-foreground">{fmt.format(e.ts)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={t("history.voiceTyping.copy")}
                title={t("history.voiceTyping.copy")}
                onClick={() => {
                  copy(e.text).catch((error) =>
                    log.warn("voice typing history: copy failed", {
                      id: e.id,
                      error: String(error),
                    }),
                  );
                }}
              >
                <Copy className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label={t("history.voiceTyping.delete")}
                title={t("history.voiceTyping.delete")}
                onClick={() => {
                  remove(e.id).catch((error) =>
                    log.warn("voice typing history: delete failed", {
                      id: e.id,
                      error: String(error),
                    }),
                  );
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <h1 className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-tight">
          <Mic className="size-4 text-sky-500" />
          {t("history.voiceTyping.title")}
        </h1>
        {entries && (
          <span className="text-[11px] text-muted-foreground">
            {t("history.count", { count: entries.length })}
          </span>
        )}
        {entries && entries.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-8 gap-1.5 px-2 text-[11px] text-muted-foreground"
            onClick={() => {
              clearAll().catch((error) =>
                log.warn("voice typing history: clear failed", { error: String(error) }),
              );
            }}
          >
            <Trash2 className="size-3.5" />
            {t("history.voiceTyping.clearAll")}
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {entries && entries.length > 0 && (
          <div className="relative mb-3 max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("history.voiceTyping.search")}
              className="h-8 pl-8 text-sm"
            />
          </div>
        )}

        {content}
      </div>
    </>
  );
}
