import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2 } from "lucide-react";
import { useStore } from "../lib/store";
import { LANGUAGE_OPTIONS, useI18n, type TranslationKey } from "../i18n";
import { broadcastSettings } from "../lib/settingsSync";
import { isTauri } from "../lib/tauriEvents";
import { LevelMeter } from "../components/LevelMeter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVIDERS, PROVIDER_BY_ID, isReasoningModel } from "../lib/ai/providers";
import type { AppLanguage, EvalDef, LlmProvider, Settings } from "../lib/types";

type Category = "basic" | "provider" | "transcription" | "evaluations" | "todos";

const NAV: { id: Category; labelKey: TranslationKey }[] = [
  { id: "basic", labelKey: "settings.nav.basic" },
  { id: "provider", labelKey: "settings.nav.provider" },
  { id: "transcription", labelKey: "settings.nav.transcription" },
  { id: "evaluations", labelKey: "settings.nav.evaluations" },
  { id: "todos", labelKey: "settings.nav.todos" },
];

export function SettingsApp() {
  const { t } = useI18n();
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [cat, setCat] = useState<Category>("basic");
  const [devices, setDevices] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [newTplName, setNewTplName] = useState("");
  const info = PROVIDER_BY_ID[settings.provider];
  const providerLabel = info.label;

  function patch(p: Partial<Settings>) {
    updateSettings(p);
    void broadcastSettings({ ...useStore.getState().settings });
  }

  useEffect(() => {
    if (!isTauri()) return;
    invoke<string[]>("list_input_devices").then(setDevices).catch(() => {});
    return () => {
      void invoke("stop_mic_test").catch(() => {});
    };
  }, []);

  async function toggleTest() {
    if (testing) {
      await invoke("stop_mic_test").catch(() => {});
      setTesting(false);
    } else {
      await invoke("start_mic_test", { inputDevice: settings.inputDevice }).catch(() => {});
      setTesting(true);
    }
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Left nav */}
      <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r bg-muted/30 p-2">
        <div className="px-2 pb-2 pt-1 text-sm font-semibold tracking-tight">{t("common.settings")}</div>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setCat(n.id)}
            className={`rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
              cat === n.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {t(n.labelKey)}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <p className="mb-5 text-xs text-muted-foreground">{t("settings.note")}</p>

        {cat === "basic" && (
          <Section title={t("settings.basic.title")}>
            <Field label={t("settings.basic.language")}>
              <Select value={settings.language} onValueChange={(v) => patch({ language: v as AppLanguage })}>
                <SelectTrigger className="w-full max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((language) => (
                    <SelectItem key={language.value} value={language.value}>
                      {language.nativeLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="max-w-sm text-[11px] text-muted-foreground">{t("settings.basic.languageHelp")}</p>
            </Field>
          </Section>
        )}

        {cat === "provider" && (
          <Section title={t("settings.provider.title")}>
            <Field label={t("settings.provider.provider")}>
              <Select value={settings.provider} onValueChange={(v) => patch({ provider: v as LlmProvider })}>
                <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex items-center gap-2">
                        <img src={p.icon} alt="" className="size-4 rounded-sm" />
                        {p.label}
                        {p.note && <span className="text-[10px] text-muted-foreground">{p.note}</span>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("settings.provider.apiKey", { provider: providerLabel })}>
              <Input
                type="password"
                autoComplete="off"
                placeholder={info.keyPlaceholder}
                className="max-w-sm"
                value={settings[info.apiKeyField]}
                onChange={(e) => patch({ [info.apiKeyField]: e.target.value } as Partial<Settings>)}
              />
            </Field>
            {info.kind === "openai-compatible" &&
              (isReasoningModel(settings.models[settings.provider].ask) ||
                isReasoningModel(settings.models[settings.provider].eval)) && (
              <Field label={t("settings.provider.reasoning")}>
                <Select value={settings.reasoningEffort} onValueChange={(v) => patch({ reasoningEffort: v as Settings["reasoningEffort"] })}>
                  <SelectTrigger className="w-full max-w-[180px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">{t("settings.provider.low")}</SelectItem>
                    <SelectItem value="medium">{t("settings.provider.medium")}</SelectItem>
                    <SelectItem value="high">{t("settings.provider.high")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
            <div className="flex flex-col gap-3 border-t pt-4">
              <p className="text-[11px] text-muted-foreground">
                {t("settings.provider.models", {
                  provider: providerLabel,
                  suffix: info.kind === "anthropic" ? "" : t("settings.provider.slugSuffix"),
                })}
              </p>
              <Field label={t("settings.provider.askModel")}>
                <ModelSelect
                  provider={settings.provider}
                  value={settings.models[settings.provider].ask}
                  onChange={(v) => patchModel(patch, settings, settings.provider, "ask", v)}
                />
              </Field>
              <Field label={t("settings.provider.evalModel")}>
                <ModelSelect
                  provider={settings.provider}
                  value={settings.models[settings.provider].eval}
                  onChange={(v) => patchModel(patch, settings, settings.provider, "eval", v)}
                />
              </Field>
            </div>
          </Section>
        )}

        {cat === "transcription" && (
          <Section title={t("settings.transcription.title")}>
            <Field label={t("settings.transcription.sonioxKey")}>
              <Input type="password" autoComplete="off" placeholder="…" className="max-w-sm" value={settings.sonioxApiKey} onChange={(e) => patch({ sonioxApiKey: e.target.value })} />
            </Field>
            <Field label={t("settings.transcription.microphone")}>
              <div className="flex max-w-sm flex-col gap-2">
                <Select
                  value={settings.inputDevice || "__default__"}
                  onValueChange={async (v) => {
                    const dev = v === "__default__" ? "" : v;
                    patch({ inputDevice: dev });
                    if (testing) {
                      await invoke("stop_mic_test").catch(() => {});
                      await invoke("start_mic_test", { inputDevice: dev }).catch(() => {});
                    }
                  }}
                >
                  <SelectTrigger className="w-full"><SelectValue placeholder={t("settings.transcription.systemDefault")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">{t("settings.transcription.systemDefault")}</SelectItem>
                    {devices.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <Button variant={testing ? "destructive" : "outline"} size="sm" className="h-7 px-2 text-[11px]" onClick={toggleTest}>
                    {testing ? t("settings.transcription.stopTest") : t("settings.transcription.testMic")}
                  </Button>
                  <LevelMeter source="test" className="h-2 flex-1" />
                </div>
              </div>
            </Field>
            <p className="max-w-md text-[11px] text-muted-foreground">
              {t("settings.transcription.help")}
            </p>
          </Section>
        )}

        {cat === "evaluations" && (
          <Section title={t("settings.evaluations.title")}>
            {/* Template library: apply a preset set, or save the current set. */}
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <p className="text-[11px] font-medium text-muted-foreground">{t("settings.evaluations.templateHelp")}</p>
              <div className="flex flex-col gap-1.5">
                {settings.evalTemplates.map((tpl) => (
                  <div key={tpl.id} className="flex items-center gap-2">
                    <span className="flex-1 truncate text-sm">
                      {tpl.name}
                      <span className="ml-1.5 text-[10px] text-muted-foreground">
                        {t("settings.evaluations.templateMeta", {
                          type: tpl.builtin ? t("common.builtin") : t("common.custom"),
                          count: tpl.evals.length,
                        })}
                      </span>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() =>
                        patch({ evaluations: tpl.evals.map((e) => ({ ...e })) })
                      }
                    >
                      {t("common.apply")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => patch({ evalTemplates: settings.evalTemplates.filter((t) => t.id !== tpl.id) })}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Input
                  value={newTplName}
                  onChange={(e) => setNewTplName(e.target.value)}
                  placeholder={t("settings.evaluations.newTemplateName")}
                  className="h-7 text-xs"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  disabled={!newTplName.trim()}
                  onClick={() => {
                    const name = newTplName.trim();
                    // Overwrite a custom template with the same name, else add new.
                    const evals = settings.evaluations.map((e) => ({ ...e }));
                    const exists = settings.evalTemplates.find((t) => !t.builtin && t.name === name);
                    const next = exists
                      ? settings.evalTemplates.map((t) => (t.id === exists.id ? { ...t, evals } : t))
                      : [...settings.evalTemplates, { id: crypto.randomUUID(), name, evals }];
                    patch({ evalTemplates: next });
                    setNewTplName("");
                  }}
                >
                  {t("settings.evaluations.saveTemplate")}
                </Button>
              </div>
            </div>

            {/* Active set used in meetings. */}
            <p className="text-[11px] text-muted-foreground">
              {t("settings.evaluations.activeHelp")}
            </p>
            <div className="flex flex-col gap-4">
              {settings.evaluations.map((ev) => (
                <EvalEditor
                  key={ev.id}
                  ev={ev}
                  onChange={(p) => patch({ evaluations: settings.evaluations.map((x) => (x.id === ev.id ? { ...x, ...p } : x)) })}
                  onDelete={() => patch({ evaluations: settings.evaluations.filter((x) => x.id !== ev.id) })}
                />
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() =>
                patch({
                  evaluations: [
                    ...settings.evaluations,
                    { id: crypto.randomUUID(), name: t("settings.evaluations.defaultNewName"), description: "", prompt: "" },
                  ],
                })
              }
            >
              <Plus className="size-3.5" /> {t("settings.evaluations.newEvaluation")}
            </Button>
          </Section>
        )}

        {cat === "todos" && (
          <Section title={t("settings.todos.title")}>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.todos.help")}
            </p>
            <div className="flex flex-col gap-4">
              {settings.todoTemplates.map((tpl) => (
                <TodoTemplateEditor
                  key={tpl.id}
                  tpl={tpl}
                  onChange={(p) => patch({ todoTemplates: settings.todoTemplates.map((x) => (x.id === tpl.id ? { ...x, ...p } : x)) })}
                  onDelete={() => patch({ todoTemplates: settings.todoTemplates.filter((x) => x.id !== tpl.id) })}
                />
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() =>
                patch({
                  todoTemplates: [
                    ...settings.todoTemplates,
                    { id: crypto.randomUUID(), name: t("settings.todos.defaultNewName"), items: [""] },
                  ],
                })
              }
            >
              <Plus className="size-3.5" /> {t("settings.todos.addTemplate")}
            </Button>
          </Section>
        )}
      </div>
    </div>
  );
}

function patchModel(
  patch: (p: Partial<Settings>) => void,
  settings: Settings,
  provider: LlmProvider,
  kind: "ask" | "eval",
  value: string
) {
  patch({ models: { ...settings.models, [provider]: { ...settings.models[provider], [kind]: value } } });
}

function ModelSelect({
  provider,
  value,
  onChange,
}: {
  provider: LlmProvider;
  value: string;
  onChange: (v: string) => void;
}) {
  // Always include the current value so a custom/persisted id stays selectable.
  const options = Array.from(new Set([...PROVIDER_BY_ID[provider].models, value].filter(Boolean)));
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((m) => (
          <SelectItem key={m} value={m}>
            {m}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function EvalEditor({
  ev,
  onChange,
  onDelete,
}: {
  ev: EvalDef;
  onChange: (p: Partial<EvalDef>) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input value={ev.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={t("settings.evaluations.namePlaceholder")} className="h-8 font-medium" />
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onDelete}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Input value={ev.description} onChange={(e) => onChange({ description: e.target.value })} placeholder={t("settings.evaluations.descriptionPlaceholder")} className="h-8 text-xs" />
      <Textarea value={ev.prompt} onChange={(e) => onChange({ prompt: e.target.value })} placeholder={t("settings.evaluations.promptPlaceholder")} rows={3} className="resize-none text-xs" />
    </div>
  );
}

function TodoTemplateEditor({
  tpl,
  onChange,
  onDelete,
}: {
  tpl: import("../lib/types").TodoTemplate;
  onChange: (p: Partial<import("../lib/types").TodoTemplate>) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input value={tpl.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={t("settings.todos.templateName")} className="h-8 font-medium" />
        <span className="shrink-0 text-[10px] text-muted-foreground">{tpl.builtin ? t("common.builtin") : t("common.custom")}</span>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onDelete}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        {tpl.items.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={it}
              onChange={(e) => onChange({ items: tpl.items.map((x, j) => (j === i ? e.target.value : x)) })}
              placeholder={t("settings.todos.itemPlaceholder")}
              className="h-8 text-xs"
            />
            <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => onChange({ items: tpl.items.filter((_, j) => j !== i) })}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button variant="ghost" size="sm" className="w-fit text-[11px]" onClick={() => onChange({ items: [...tpl.items, ""] })}>
        <Plus className="size-3.5" /> {t("settings.todos.addItem")}
      </Button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
