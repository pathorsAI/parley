import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../i18n";
import {
  buildStageSet,
  readStageBundleFile,
  writeStageBundleFile,
  type ParsedBundleFile,
  type StageBundle,
} from "../lib/accounts/bundles";
import { EMPTY_BUNDLE_FILE } from "../lib/accounts/bundleFile";
import { SALES_STAGES, type SalesStage } from "../lib/accounts/types";
import { log } from "../lib/log";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * Settings stage editor (#155): the in-app way to maintain sales domain
 * know-how. Simple form only — stage name, goal, collect slots (label+hint),
 * exit criteria; slot queries and coach rules keep their effective values and
 * stay editable via the MCP server / JSON. Builtin edits become whole-stage
 * overrides (S9); untouched builtins keep shipped copy.
 */

interface SlotRow {
  id?: string;
  label: string;
  hint: string;
}

interface Draft {
  name: string;
  goal: string;
  slots: SlotRow[];
  exitText: string;
}

function draftFrom(bundle: StageBundle, name: string): Draft {
  return {
    name,
    goal: bundle.goal ?? "",
    slots: bundle.slots.map((s) => ({ id: s.id, label: s.label, hint: s.hint })),
    exitText: bundle.exitCriteria.join("\n"),
  };
}

let uniq = 0;
function newSlotId(stage: SalesStage): string {
  uniq += 1;
  return `${stage}.u${Date.now().toString(36)}${uniq}`;
}

export function StageBundleSettings() {
  const { t } = useI18n();
  const tr = (k: string) => t(k as TranslationKey);
  const [file, setFile] = useState<ParsedBundleFile>(EMPTY_BUNDLE_FILE);
  const [open, setOpen] = useState<SalesStage | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newName, setNewName] = useState("");
  const [newAfter, setNewAfter] = useState<SalesStage>(SALES_STAGES[SALES_STAGES.length - 1]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    readStageBundleFile({ fresh: true })
      .then(setFile)
      .catch(() => {});
  }, []);

  const set = useMemo(() => buildStageSet(tr, file), [t, file]); // eslint-disable-line react-hooks/exhaustive-deps
  const isBuiltin = (s: SalesStage) => (SALES_STAGES as string[]).includes(s);
  const isCustom = (s: SalesStage) => file.customStages.some((c) => c.id === s);

  function toggle(stage: SalesStage) {
    setConfirmDelete(false);
    if (open === stage) {
      setOpen(null);
      setDraft(null);
      return;
    }
    const bundle = set.bundles[stage];
    if (!bundle) return;
    setOpen(stage);
    setDraft(draftFrom(bundle, set.names[stage] ?? stage));
  }

  async function persist(next: ParsedBundleFile) {
    try {
      await writeStageBundleFile(next);
      setFile(next);
      toast.success(t("settings.stages.saved"));
    } catch (e) {
      log.warn("stage editor: write failed", { error: String(e) });
      toast.error(t("settings.stages.saveFailed"));
    }
  }

  async function save() {
    if (!open || !draft) return;
    const effective = set.bundles[open];
    if (!effective) return;
    const effectiveById = new Map(effective.slots.map((s) => [s.id, s]));
    const slots = draft.slots
      .filter((r) => r.label.trim() || r.hint.trim())
      .map((r) => {
        const prev = r.id ? effectiveById.get(r.id) : undefined;
        return {
          // Keep the id (claims stay attached, S3) and any advanced fields
          // (query/solidAt) the form doesn't surface.
          ...(prev ?? { query: { categories: [] } }),
          id: r.id ?? newSlotId(open),
          label: r.label.trim() || r.hint.trim(),
          hint: r.hint.trim() || r.label.trim(),
        };
      });
    const name = draft.name.trim() || (set.names[open] ?? open);
    const bundle: StageBundle = {
      ...effective,
      stage: open,
      boardTitle: effective.boardTitle || name,
      ...(isCustom(open) ? { name } : {}),
      goal: draft.goal.trim() || undefined,
      slots,
      exitCriteria: draft.exitText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    };
    const next: ParsedBundleFile = {
      customStages: isCustom(open)
        ? file.customStages.map((c) => (c.id === open ? { ...c, name, bundle } : c))
        : file.customStages,
      overrides: isCustom(open) ? file.overrides : { ...file.overrides, [open]: bundle },
    };
    if (isCustom(open)) delete next.overrides[open];
    await persist(next);
  }

  async function resetBuiltin() {
    if (!open) return;
    const overrides = { ...file.overrides };
    delete overrides[open];
    await persist({ ...file, overrides });
    setOpen(null);
    setDraft(null);
  }

  async function removeCustom() {
    if (!open) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    const overrides = { ...file.overrides };
    delete overrides[open];
    await persist({
      customStages: file.customStages.filter((c) => c.id !== open),
      overrides,
    });
    setOpen(null);
    setDraft(null);
  }

  async function addStage() {
    const name = newName.trim();
    if (!name) return;
    let id = `custom-${Date.now().toString(36)}`;
    while (set.bundles[id]) id += "x";
    const bundle: StageBundle = {
      stage: id,
      name,
      boardTitle: name,
      goal: "",
      slots: [],
      exitCriteria: [],
      coachRules: [],
    };
    await persist({
      ...file,
      customStages: [...file.customStages, { id, name, insertAfter: newAfter, bundle }],
    });
    setNewName("");
    setOpen(id);
    setDraft(draftFrom(bundle, name));
  }

  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted-foreground">{t("settings.stages.desc")}</p>

      <div className="flex flex-col gap-1.5">
        {set.order.map((stage) => {
          const opened = open === stage;
          return (
            <div key={stage} className="rounded-lg border">
              <button
                type="button"
                onClick={() => toggle(stage)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
              >
                {opened ? (
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                )}
                <span className="flex-1 font-medium">{set.names[stage] ?? stage}</span>
                {isCustom(stage) && (
                  <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                    {t("settings.stages.custom")}
                  </span>
                )}
                {isBuiltin(stage) && set.customized.has(stage) && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                    {t("settings.stages.modified")}
                  </span>
                )}
              </button>

              {opened && draft && (
                <div className="flex flex-col gap-3 border-t px-3 py-3">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">{t("settings.stages.name")}</span>
                    <Input
                      value={draft.name}
                      disabled={isBuiltin(stage)}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      className="h-8"
                    />
                  </label>

                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">{t("settings.stages.goal")}</span>
                    <Textarea
                      value={draft.goal}
                      rows={2}
                      placeholder={t("settings.stages.goalPh")}
                      onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
                    />
                  </label>

                  <div className="flex flex-col gap-1.5 text-xs">
                    <span className="text-muted-foreground">{t("settings.stages.slots")}</span>
                    {draft.slots.map((row, i) => (
                      <div key={row.id ?? `new-${i}`} className="flex items-start gap-1.5">
                        <Input
                          value={row.label}
                          placeholder={t("settings.stages.slotLabel")}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              slots: draft.slots.map((r, j) =>
                                j === i ? { ...r, label: e.target.value } : r
                              ),
                            })
                          }
                          className="h-8 w-36 shrink-0"
                        />
                        <Input
                          value={row.hint}
                          placeholder={t("settings.stages.slotHint")}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              slots: draft.slots.map((r, j) =>
                                j === i ? { ...r, hint: e.target.value } : r
                              ),
                            })
                          }
                          className="h-8 flex-1"
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
                          onClick={() =>
                            setDraft({ ...draft, slots: draft.slots.filter((_, j) => j !== i) })
                          }
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-fit text-xs"
                      onClick={() =>
                        setDraft({ ...draft, slots: [...draft.slots, { label: "", hint: "" }] })
                      }
                    >
                      <Plus className="size-3" />
                      {t("settings.stages.addSlot")}
                    </Button>
                  </div>

                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">{t("settings.stages.exit")}</span>
                    <Textarea
                      value={draft.exitText}
                      rows={3}
                      onChange={(e) => setDraft({ ...draft, exitText: e.target.value })}
                    />
                  </label>

                  <div className="flex items-center gap-2">
                    <Button size="sm" className="h-7 text-xs" onClick={() => void save()}>
                      {t("settings.stages.save")}
                    </Button>
                    {isBuiltin(stage) && set.customized.has(stage) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => void resetBuiltin()}
                      >
                        {t("settings.stages.reset")}
                      </Button>
                    )}
                    {isCustom(stage) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className={`h-7 text-xs ${confirmDelete ? "border-destructive text-destructive" : ""}`}
                        onClick={() => void removeCustom()}
                      >
                        {confirmDelete
                          ? t("settings.stages.deleteConfirm")
                          : t("settings.stages.delete")}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add a new custom stage. */}
      <div className="flex items-center gap-2 pt-1">
        <Input
          value={newName}
          placeholder={t("settings.stages.newName")}
          onChange={(e) => setNewName(e.target.value)}
          className="h-8 flex-1"
        />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          {t("settings.stages.insertAfter")}
          <select
            value={newAfter}
            onChange={(e) => setNewAfter(e.target.value)}
            className="h-8 rounded-md border bg-background px-1.5 text-xs"
          >
            {set.order.map((s) => (
              <option key={s} value={s}>
                {set.names[s] ?? s}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" className="h-8 text-xs" disabled={!newName.trim()} onClick={() => void addStage()}>
          <Plus className="size-3.5" />
          {t("settings.stages.add")}
        </Button>
      </div>
    </section>
  );
}
