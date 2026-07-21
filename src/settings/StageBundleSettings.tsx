import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../i18n";
import {
  buildScenarioSet,
  readStageBundleFile,
  writeStageBundleFile,
  type ParsedBundleFile,
  type Scenario,
  type StageBundle,
} from "../lib/accounts/bundles";
import { EMPTY_BUNDLE_FILE, type CustomStageDef } from "../lib/accounts/bundleFile";
import { SALES_STAGES, type SalesStage } from "../lib/accounts/types";
import { useStore } from "../lib/store";
import { log } from "../lib/log";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * Scenario editor (scenario system): the in-app way to maintain meeting
 * know-how — every scenario (builtin 銷售/談判/合作 + user-defined) is a list
 * of stages, each a board of slots. Simple form only — names, goal, collect
 * slots (label+hint), exit criteria; slot queries and coach rules keep their
 * effective values and stay editable via the MCP server / JSON. Builtin edits
 * become whole-stage overrides (S9); untouched builtins keep shipped copy.
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
function newSlotId(stage: string): string {
  uniq += 1;
  return `${stage}.u${Date.now().toString(36)}${uniq}`;
}
function newId(prefix: string): string {
  uniq += 1;
  return `${prefix}-${Date.now().toString(36)}${uniq}`;
}

function emptyStage(id: string, name: string): CustomStageDef {
  return {
    id,
    name,
    bundle: { stage: id, name, boardTitle: name, goal: "", slots: [], exitCriteria: [], coachRules: [] },
  };
}

function patchSlotRow(d: Draft, i: number, patch: Partial<SlotRow>): Draft {
  return { ...d, slots: d.slots.map((r, j) => (j === i ? { ...r, ...patch } : r)) };
}

function dropSlotRow(d: Draft, i: number): Draft {
  return { ...d, slots: d.slots.filter((_, j) => j !== i) };
}

/** The per-stage edit form — top-level so the editor's scenario→stage maps
 *  stay shallow. Simple fields only; queries/coach rules stay MCP/JSON-side. */
function StageDraftForm({
  draft,
  setDraft,
  nameLocked,
  canReset,
  canDelete,
  confirmingDelete,
  onSave,
  onReset,
  onDelete,
}: Readonly<{
  draft: Draft;
  setDraft: (d: Draft) => void;
  nameLocked: boolean;
  canReset: boolean;
  canDelete: boolean;
  confirmingDelete: boolean;
  onSave: () => void;
  onReset: () => void;
  onDelete: () => void;
}>) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 border-t px-3 py-3">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t("settings.stages.name")}</span>
        <Input
          value={draft.name}
          disabled={nameLocked}
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
              onChange={(e) => setDraft(patchSlotRow(draft, i, { label: e.target.value }))}
              className="h-8 w-36 shrink-0"
            />
            <Input
              value={row.hint}
              placeholder={t("settings.stages.slotHint")}
              onChange={(e) => setDraft(patchSlotRow(draft, i, { hint: e.target.value }))}
              className="h-8 flex-1"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0"
              onClick={() => setDraft(dropSlotRow(draft, i))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-fit text-xs"
          onClick={() => setDraft({ ...draft, slots: [...draft.slots, { label: "", hint: "" }] })}
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
        <Button size="sm" className="h-7 text-xs" onClick={onSave}>
          {t("settings.stages.save")}
        </Button>
        {canReset && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onReset}>
            {t("settings.stages.reset")}
          </Button>
        )}
        {canDelete && (
          <Button
            size="sm"
            variant="outline"
            className={`h-7 text-xs ${confirmingDelete ? "border-destructive text-destructive" : ""}`}
            onClick={onDelete}
          >
            {confirmingDelete ? t("settings.stages.deleteConfirm") : t("settings.stages.delete")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ScenarioSettings() {
  const { t } = useI18n();
  const tr = (k: string) => t(k as TranslationKey);
  const evalTemplates = useStore((s) => s.settings.evalTemplates);
  const [file, setFile] = useState<ParsedBundleFile>(EMPTY_BUNDLE_FILE);
  const [openScenario, setOpenScenario] = useState<string | null>(null);
  const [openStage, setOpenStage] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newStageName, setNewStageName] = useState("");
  const [newAfter, setNewAfter] = useState<SalesStage>(SALES_STAGES[SALES_STAGES.length - 1]);
  const [newScenarioName, setNewScenarioName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    readStageBundleFile({ fresh: true })
      .then(setFile)
      .catch(() => {});
  }, []);

  const set = useMemo(() => buildScenarioSet(tr, file), [t, file]); // eslint-disable-line react-hooks/exhaustive-deps
  const isBuiltinSalesStage = (s: string) => (SALES_STAGES as string[]).includes(s);
  const isCustomSalesStage = (s: string) => file.customStages.some((c) => c.id === s);
  const customScenarioOf = (stageId: string) =>
    file.customScenarios.find((sc) => sc.stages.some((st) => st.id === stageId));

  async function persist(next: ParsedBundleFile) {
    try {
      await writeStageBundleFile(next);
      setFile(next);
      toast.success(t("settings.stages.saved"));
    } catch (e) {
      log.warn("scenario editor: write failed", { error: String(e) });
      toast.error(t("settings.stages.saveFailed"));
    }
  }

  function toggleScenario(id: string) {
    setConfirmDelete(null);
    setOpenStage(null);
    setDraft(null);
    setOpenScenario(openScenario === id ? null : id);
  }

  function toggleStage(scenario: Scenario, stageId: string) {
    setConfirmDelete(null);
    if (openStage === stageId) {
      setOpenStage(null);
      setDraft(null);
      return;
    }
    const bundle = scenario.bundles[stageId];
    if (!bundle) return;
    setOpenStage(stageId);
    setDraft(draftFrom(bundle, scenario.names[stageId] ?? stageId));
  }

  /** Where a stage's edits land: sales customs → customStages; custom-scenario
   *  stages → that scenario's list; everything builtin → overrides (S9). */
  async function saveStage(scenario: Scenario) {
    if (!openStage || !draft) return;
    const effective = scenario.bundles[openStage];
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
          id: r.id ?? newSlotId(openStage),
          label: r.label.trim() || r.hint.trim(),
          hint: r.hint.trim() || r.label.trim(),
        };
      });
    const name = draft.name.trim() || (scenario.names[openStage] ?? openStage);
    const ownScenario = customScenarioOf(openStage);
    const isCustomStage = isCustomSalesStage(openStage) || !!ownScenario;
    const bundle: StageBundle = {
      ...effective,
      stage: openStage,
      boardTitle: effective.boardTitle || name,
      ...(isCustomStage ? { name } : {}),
      goal: draft.goal.trim() || undefined,
      slots,
      exitCriteria: draft.exitText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    };
    let next: ParsedBundleFile;
    if (ownScenario) {
      next = {
        ...file,
        customScenarios: file.customScenarios.map((sc) =>
          sc.id !== ownScenario.id
            ? sc
            : {
                ...sc,
                stages: sc.stages.map((st) =>
                  st.id === openStage ? { ...st, name, bundle } : st
                ),
              }
        ),
      };
    } else if (isCustomSalesStage(openStage)) {
      next = {
        ...file,
        customStages: file.customStages.map((c) =>
          c.id === openStage ? { ...c, name, bundle } : c
        ),
      };
    } else {
      next = { ...file, overrides: { ...file.overrides, [openStage]: bundle } };
    }
    await persist(next);
  }

  async function resetBuiltinStage() {
    if (!openStage) return;
    const overrides = { ...file.overrides };
    delete overrides[openStage];
    await persist({ ...file, overrides });
    setOpenStage(null);
    setDraft(null);
  }

  async function removeStage() {
    if (!openStage) return;
    if (confirmDelete !== openStage) {
      setConfirmDelete(openStage);
      setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    const overrides = { ...file.overrides };
    delete overrides[openStage];
    const ownScenario = customScenarioOf(openStage);
    await persist(
      ownScenario
        ? {
            ...file,
            overrides,
            customScenarios: file.customScenarios.map((sc) =>
              sc.id === ownScenario.id
                ? { ...sc, stages: sc.stages.filter((st) => st.id !== openStage) }
                : sc
            ),
          }
        : {
            ...file,
            overrides,
            customStages: file.customStages.filter((c) => c.id !== openStage),
          }
    );
    setOpenStage(null);
    setDraft(null);
  }

  async function addSalesStage() {
    const name = newStageName.trim();
    if (!name) return;
    let id = newId("custom");
    while (set.byId.sales.bundles[id]) id += "x";
    const def = emptyStage(id, name);
    await persist({
      ...file,
      customStages: [...file.customStages, { ...def, insertAfter: newAfter }],
    });
    setNewStageName("");
    setOpenStage(id);
    setDraft(draftFrom(def.bundle, name));
  }

  async function addScenarioStage(scenarioId: string) {
    const sc = file.customScenarios.find((x) => x.id === scenarioId);
    if (!sc) return;
    const name = `${sc.name} ${sc.stages.length + 1}`;
    const def = emptyStage(newId("st"), name);
    await persist({
      ...file,
      customScenarios: file.customScenarios.map((x) =>
        x.id === scenarioId ? { ...x, stages: [...x.stages, def] } : x
      ),
    });
    setOpenStage(def.id);
    setDraft(draftFrom(def.bundle, name));
  }

  async function addScenario() {
    const name = newScenarioName.trim();
    if (!name) return;
    const id = newId("sc");
    // A scenario is born with one stage carrying its name — single-stage
    // scenarios never show a stage row, so this is invisible until they split.
    await persist({
      ...file,
      customScenarios: [
        ...file.customScenarios,
        { id, name, icon: "🎯", stages: [emptyStage(newId("st"), name)] },
      ],
    });
    setNewScenarioName("");
    setOpenScenario(id);
  }

  async function removeScenario(id: string) {
    if (confirmDelete !== `sc:${id}`) {
      setConfirmDelete(`sc:${id}`);
      setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    const sc = file.customScenarios.find((x) => x.id === id);
    const overrides = { ...file.overrides };
    for (const st of sc?.stages ?? []) delete overrides[st.id];
    await persist({
      ...file,
      overrides,
      customScenarios: file.customScenarios.filter((x) => x.id !== id),
    });
    setOpenScenario(null);
  }

  async function patchScenarioMeta(
    id: string,
    patch: Partial<{ name: string; icon: string; evalTemplateId: string }>
  ) {
    await persist({
      ...file,
      customScenarios: file.customScenarios.map((sc) => {
        if (sc.id !== id) return sc;
        const next = { ...sc, ...patch };
        if (patch.evalTemplateId === "") delete next.evalTemplateId;
        return next;
      }),
    });
  }

  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("settings.scenarios.desc")}
      </p>

      <div className="flex flex-col gap-1.5">
        {set.list.map((sc) => {
          const scOpened = openScenario === sc.id;
          const scDelKey = `sc:${sc.id}`;
          const custom = !sc.builtin;
          const fileDef = file.customScenarios.find((x) => x.id === sc.id);
          return (
            <div key={sc.id} className="rounded-lg border">
              <button
                type="button"
                onClick={() => toggleScenario(sc.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
              >
                {scOpened ? (
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                )}
                <span className="flex-1 font-medium">
                  {sc.icon} {sc.name}
                </span>
                {custom && (
                  <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                    {t("settings.stages.custom")}
                  </span>
                )}
              </button>

              {scOpened && (
                <div className="flex flex-col gap-2 border-t px-3 py-3">
                  {/* Custom scenario meta: name / icon / eval template / delete. */}
                  {custom && fileDef && (
                    <div className="flex flex-wrap items-end gap-2 pb-1">
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">{t("settings.scenarios.name")}</span>
                        <Input
                          defaultValue={fileDef.name}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== fileDef.name) void patchScenarioMeta(sc.id, { name: v });
                          }}
                          className="h-8 w-40"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">{t("settings.scenarios.icon")}</span>
                        <Input
                          defaultValue={fileDef.icon ?? "🎯"}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== fileDef.icon) void patchScenarioMeta(sc.id, { icon: v });
                          }}
                          className="h-8 w-14 text-center"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">
                          {t("settings.scenarios.evalTemplate")}
                        </span>
                        <select
                          value={fileDef.evalTemplateId ?? ""}
                          onChange={(e) =>
                            void patchScenarioMeta(sc.id, { evalTemplateId: e.target.value })
                          }
                          className="h-8 rounded-md border bg-background px-1.5 text-xs"
                        >
                          <option value="">{t("settings.scenarios.evalTemplateNone")}</option>
                          {evalTemplates.map((tpl) => (
                            <option key={tpl.id} value={tpl.id}>
                              {tpl.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button
                        size="sm"
                        variant="outline"
                        className={`h-8 text-xs ${confirmDelete === scDelKey ? "border-destructive text-destructive" : ""}`}
                        onClick={() => void removeScenario(sc.id)}
                      >
                        {confirmDelete === scDelKey
                          ? t("settings.stages.deleteConfirm")
                          : t("settings.scenarios.delete")}
                      </Button>
                    </div>
                  )}

                  {/* Stage list (single-stage scenarios simply show one row). */}
                  <div className="flex flex-col gap-1.5">
                    {sc.order.map((stageId) => {
                      const opened = openStage === stageId;
                      const modified =
                        !!file.overrides[stageId] ||
                        isCustomSalesStage(stageId) ||
                        !!customScenarioOf(stageId);
                      return (
                        <div key={stageId} className="rounded-md border">
                          <button
                            type="button"
                            onClick={() => toggleStage(sc, stageId)}
                            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
                          >
                            {opened ? (
                              <ChevronDown className="size-3 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="size-3 text-muted-foreground" />
                            )}
                            <span className="flex-1 font-medium">
                              {sc.names[stageId] ?? stageId}
                            </span>
                            {sc.builtin && modified && (
                              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                                {t("settings.stages.modified")}
                              </span>
                            )}
                          </button>

                          {opened && draft && (
                            <StageDraftForm
                              draft={draft}
                              setDraft={setDraft}
                              nameLocked={sc.builtin && isBuiltinSalesStage(stageId)}
                              canReset={
                                sc.builtin &&
                                !isCustomSalesStage(stageId) &&
                                !!file.overrides[stageId]
                              }
                              canDelete={isCustomSalesStage(stageId) || !!customScenarioOf(stageId)}
                              confirmingDelete={confirmDelete === stageId}
                              onSave={() => void saveStage(sc)}
                              onReset={() => void resetBuiltinStage()}
                              onDelete={() => void removeStage()}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Add stage: sales keeps its insert-after splice; custom
                      scenarios append. Typed builtins stay single-stage. */}
                  {sc.id === "sales" && (
                    <div className="flex items-center gap-2 pt-1">
                      <Input
                        value={newStageName}
                        placeholder={t("settings.stages.newName")}
                        onChange={(e) => setNewStageName(e.target.value)}
                        className="h-8 flex-1"
                      />
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        {t("settings.stages.insertAfter")}
                        <select
                          value={newAfter}
                          onChange={(e) => setNewAfter(e.target.value)}
                          className="h-8 rounded-md border bg-background px-1.5 text-xs"
                        >
                          {sc.order.map((s) => (
                            <option key={s} value={s}>
                              {sc.names[s] ?? s}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button
                        size="sm"
                        className="h-8 text-xs"
                        disabled={!newStageName.trim()}
                        onClick={() => void addSalesStage()}
                      >
                        <Plus className="size-3.5" />
                        {t("settings.stages.add")}
                      </Button>
                    </div>
                  )}
                  {custom && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-fit text-xs"
                      onClick={() => void addScenarioStage(sc.id)}
                    >
                      <Plus className="size-3" />
                      {t("settings.stages.add")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add a new scenario. */}
      <div className="flex items-center gap-2 pt-1">
        <Input
          value={newScenarioName}
          placeholder={t("settings.scenarios.newName")}
          onChange={(e) => setNewScenarioName(e.target.value)}
          className="h-8 flex-1"
        />
        <Button
          size="sm"
          className="h-8 text-xs"
          disabled={!newScenarioName.trim()}
          onClick={() => void addScenario()}
        >
          <Plus className="size-3.5" />
          {t("settings.scenarios.add")}
        </Button>
      </div>
    </section>
  );
}
