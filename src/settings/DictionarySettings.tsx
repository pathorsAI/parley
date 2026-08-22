//! Settings › Dictionary — the phrase list that biases recognition and rewrites
//! the variants that slip through anyway.
//!
//! Edits go straight through lib/dictionary (a shared JSON file), NOT through
//! the zustand settings object: the local MCP server writes the same file, so
//! the file has to stay the source of truth. That's also why this panel
//! re-reads on the dictionary's broadcast — an entry added by an external tool
//! (or by the correction bubble in another window) shows up here on focus.

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import {
  addEntry,
  listEntries,
  listenForDictionaryUpdated,
  removeEntry,
  updateEntry,
  whenDictionaryReady,
  VOCABULARY_LIMIT,
  type DictionaryEntry,
} from "../lib/dictionary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Variants are edited as one comma-separated field — a dictation user thinks
 *  in "these all mean Parley", not in rows. Both comma shapes split, because a
 *  zh keyboard produces the full-width one. */
function parseVariants(value: string): string[] {
  return value
    .split(/[,、，]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * One editable row. Keystrokes stay local and only commit on blur: writing
 * every keystroke through the dictionary would re-render the row from the
 * canonical value and eat the comma the user is halfway through typing.
 */
function EntryRow({
  entry,
  onCommit,
  onDelete,
}: Readonly<{
  entry: DictionaryEntry;
  onCommit: (p: Partial<Pick<DictionaryEntry, "phrase" | "variants">>) => void;
  onDelete: () => void;
}>) {
  const { t } = useI18n();
  const joined = entry.variants.join(", ");
  const [phrase, setPhrase] = useState(entry.phrase);
  const [variants, setVariants] = useState(joined);
  // Follow the entry when it changes underneath us (an MCP edit, the correction
  // bubble in another window). Keyed on the STRING, not the array, so an
  // identical refresh doesn't stomp on what's being typed.
  useEffect(() => setPhrase(entry.phrase), [entry.phrase]);
  useEffect(() => setVariants(joined), [joined]);

  return (
    <div className="flex items-start gap-2">
      <Input
        value={phrase}
        onChange={(ev) => setPhrase(ev.target.value)}
        onBlur={() => {
          // An emptied phrase would orphan its variants — put it back.
          if (!phrase.trim()) setPhrase(entry.phrase);
          else if (phrase !== entry.phrase) onCommit({ phrase });
        }}
        placeholder={t("settings.dictionary.phrasePlaceholder")}
        className="h-8 max-w-[180px] text-sm"
      />
      <Input
        value={variants}
        onChange={(ev) => setVariants(ev.target.value)}
        onBlur={() => {
          if (variants !== joined) onCommit({ variants: parseVariants(variants) });
        }}
        placeholder={t("settings.dictionary.variantsPlaceholder")}
        className="h-8 flex-1 text-sm"
      />
      <Button
        size="icon"
        variant="ghost"
        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={t("settings.dictionary.delete")}
        title={t("settings.dictionary.delete")}
        onClick={onDelete}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

export function DictionarySettings() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<DictionaryEntry[]>(() => listEntries());
  const [newPhrase, setNewPhrase] = useState("");
  const [newVariants, setNewVariants] = useState("");

  const refresh = useCallback(() => setEntries(listEntries()), []);

  useEffect(() => {
    // The list is empty until this window has read the file, and editing an
    // empty list would write over the real one — wait for the read.
    whenDictionaryReady()
      .then(refresh)
      .catch((error) => log.warn("dictionary: settings hydrate failed", { error: String(error) }));
    let active = true;
    let unlisten: (() => void) | undefined;
    listenForDictionaryUpdated(refresh)
      .then((un) => {
        if (active) unlisten = un;
        else un();
      })
      .catch((error) => log.warn("dictionary: settings listener failed", { error: String(error) }));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [refresh]);

  function patch(id: string, p: Partial<Pick<DictionaryEntry, "phrase" | "variants">>) {
    updateEntry(id, p);
    refresh();
  }

  return (
    <>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.dictionary.intro")}
      </p>

      <div className="flex flex-col gap-2">
        {entries.map((e) => (
          <EntryRow
            key={e.id}
            entry={e}
            onCommit={(p) => patch(e.id, p)}
            onDelete={() => {
              removeEntry(e.id);
              refresh();
            }}
          />
        ))}
        {entries.length === 0 && (
          <p className="text-[11px] text-muted-foreground">{t("settings.dictionary.empty")}</p>
        )}
      </div>

      {/* New row. Committing through the Add button (rather than dropping a
          blank row in the list) keeps the phrase unique-able: adding a phrase
          that already exists merges its variants instead of duplicating it. */}
      <div className="flex items-start gap-2">
        <Input
          value={newPhrase}
          onChange={(ev) => setNewPhrase(ev.target.value)}
          placeholder={t("settings.dictionary.phrasePlaceholder")}
          className="h-8 max-w-[180px] text-sm"
        />
        <Input
          value={newVariants}
          onChange={(ev) => setNewVariants(ev.target.value)}
          placeholder={t("settings.dictionary.variantsPlaceholder")}
          className="h-8 flex-1 text-sm"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0"
          disabled={!newPhrase.trim()}
          onClick={() => {
            addEntry({
              phrase: newPhrase,
              variants: parseVariants(newVariants),
              source: "manual",
            });
            setNewPhrase("");
            setNewVariants("");
            refresh();
          }}
        >
          <Plus className="size-3.5" /> {t("settings.dictionary.add")}
        </Button>
      </div>

      {entries.length > VOCABULARY_LIMIT && (
        <p className="text-[11px] text-muted-foreground">
          {t("settings.dictionary.limitNote", { limit: VOCABULARY_LIMIT })}
        </p>
      )}

      <p className="max-w-md rounded-md border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.dictionary.privacy")}
      </p>
    </>
  );
}
