import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, Mic, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearVoiceEntries,
  deleteVoiceEntry,
  listVoiceEntries,
  updateVoiceEntryText,
  type VoiceEntry,
} from "../lib/voiceTyping/history";
import { detectCorrection } from "../lib/dictionary/diffCorrection";
import { addEntry, isIgnoredTwice, whenDictionaryReady } from "../lib/dictionary";

/**
 * Past voice-typing dictations: search, copy, delete one, clear all — and fix
 * one after the fact. An edit here runs the same diff the overlay does when the
 * user corrects a word in place, so a mishearing noticed later still teaches
 * the dictionary.
 */
export function VoiceTypingHistory({ locale }: Readonly<{ locale: string }>) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<VoiceEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** The correction an edit just revealed, offered on the row that produced it. */
  const [learn, setLearn] = useState<{ entryId: string; from: string; to: string } | null>(null);

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

  function startEdit(e: VoiceEntry) {
    setLearn(null);
    setDraft(e.text);
    setEditingId(e.id);
  }

  /** Save the edited text, then ask whether the change was a mishearing worth
   *  learning. The dictated text is both the baseline and what was "inserted" —
   *  the whole entry is ours, so the diff may land anywhere in it. */
  async function commitEdit(e: VoiceEntry) {
    const next = draft.trim();
    setEditingId(null);
    if (!next || next === e.text) return;
    await updateVoiceEntryText(e.id, next);
    refresh();
    // Both the "already declined this" check and the add that may follow need
    // the real dictionary, not this window's pre-hydration blank.
    await whenDictionaryReady();
    const hit = detectCorrection(e.text, next, e.text);
    if (hit && !isIgnoredTwice(hit.from, hit.to)) setLearn({ entryId: e.id, ...hit });
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
              {editingId === e.id ? (
                <Input
                  autoFocus
                  value={draft}
                  onChange={(ev) => setDraft(ev.target.value)}
                  onBlur={() => {
                    commitEdit(e).catch((error) =>
                      log.warn("voice typing history: edit commit failed", {
                        id: e.id,
                        error: String(error),
                      }),
                    );
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") {
                      ev.preventDefault();
                      ev.currentTarget.blur();
                    } else if (ev.key === "Escape") {
                      ev.preventDefault();
                      setEditingId(null);
                    }
                  }}
                  className="h-8 text-sm"
                />
              ) : (
                <p className="select-text whitespace-pre-wrap break-words text-sm leading-snug">
                  {e.text}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">{fmt.format(e.ts)}</span>
                {e.appBundleId && (
                  <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                    {e.appBundleId}
                  </span>
                )}
              </div>
              {/* The edit looked like a mishearing — offer it to the dictionary
                  once, right where it happened. */}
              {learn?.entryId === e.id && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 transition-colors hover:bg-sky-500/20 dark:text-sky-300"
                    onClick={() => {
                      addEntry({
                        phrase: learn.to,
                        variants: [learn.from],
                        source: "correction",
                      });
                      setLearn(null);
                      toast.success(t("history.voiceTyping.learned"));
                    }}
                  >
                    <Plus className="size-3" />
                    {t("history.voiceTyping.learn", { from: learn.from, to: learn.to })}
                  </button>
                  <button
                    type="button"
                    aria-label={t("history.voiceTyping.learnDismiss")}
                    title={t("history.voiceTyping.learnDismiss")}
                    className="grid size-5 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                    onClick={() => setLearn(null)}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={t("history.voiceTyping.edit")}
                title={t("history.voiceTyping.edit")}
                onClick={() => startEdit(e)}
              >
                <Pencil className="size-3.5" />
              </Button>
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
