import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2 } from "lucide-react";
import { useStore } from "../lib/store";
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
import type { EvalDef, LlmProvider, Settings } from "../lib/types";

type Category = "provider" | "transcription" | "meeting" | "evaluations" | "todos";

const NAV: { id: Category; label: string }[] = [
  { id: "provider", label: "LLM Provider" },
  { id: "transcription", label: "Transcription" },
  { id: "meeting", label: "Meeting" },
  { id: "evaluations", label: "Evaluations" },
  { id: "todos", label: "TODO templates" },
];

export function SettingsApp() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [cat, setCat] = useState<Category>("provider");
  const [devices, setDevices] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const providerLabel = settings.provider === "anthropic" ? "Claude" : "OpenRouter";

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
        <div className="px-2 pb-2 pt-1 text-sm font-semibold tracking-tight">Settings</div>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setCat(n.id)}
            className={`rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
              cat === n.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {n.label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <p className="mb-5 text-xs text-muted-foreground">變更會即時套用到主視窗並自動儲存。</p>

        {cat === "provider" && (
          <Section title="LLM Provider">
            <Field label="Provider">
              <Select value={settings.provider} onValueChange={(v) => patch({ provider: v as LlmProvider })}>
                <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Claude (Anthropic 直連)</SelectItem>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={`${providerLabel} API key`}>
              {settings.provider === "anthropic" ? (
                <Input type="password" autoComplete="off" placeholder="sk-ant-…" className="max-w-sm" value={settings.anthropicApiKey} onChange={(e) => patch({ anthropicApiKey: e.target.value })} />
              ) : (
                <Input type="password" autoComplete="off" placeholder="sk-or-…" className="max-w-sm" value={settings.openrouterApiKey} onChange={(e) => patch({ openrouterApiKey: e.target.value })} />
              )}
            </Field>
            <div className="flex flex-col gap-3 border-t pt-4">
              <p className="text-[11px] text-muted-foreground">{providerLabel} models{settings.provider === "openrouter" ? "（slug）" : ""}</p>
              <Field label="Q&A — fast model (sidebar Ask)">
                <Input className="max-w-sm" value={settings.models[settings.provider].ask} onChange={(e) => patchModel(patch, settings, settings.provider, "ask", e.target.value)} />
              </Field>
              <Field label="Evaluations — deeper model">
                <Input className="max-w-sm" value={settings.models[settings.provider].eval} onChange={(e) => patchModel(patch, settings, settings.provider, "eval", e.target.value)} />
              </Field>
            </div>
          </Section>
        )}

        {cat === "transcription" && (
          <Section title="Transcription">
            <Field label="Soniox API key">
              <Input type="password" autoComplete="off" placeholder="…" className="max-w-sm" value={settings.sonioxApiKey} onChange={(e) => patch({ sonioxApiKey: e.target.value })} />
            </Field>
            <Field label="Microphone (input device)">
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
                  <SelectTrigger className="w-full"><SelectValue placeholder="System default" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">System default</SelectItem>
                    {devices.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <Button variant={testing ? "destructive" : "outline"} size="sm" className="h-7 px-2 text-[11px]" onClick={toggleTest}>
                    {testing ? "Stop test" : "Test mic"}
                  </Button>
                  <LevelMeter source="test" className="h-2 flex-1" />
                </div>
              </div>
            </Field>
            <p className="max-w-md text-[11px] text-muted-foreground">
              若錄音沒有聲音，多半是抓錯麥克風 — 換一個並用 Test 確認音量。系統音訊（對方）目前用 Core Audio tap，需簽章與授權才會有聲音。
            </p>
          </Section>
        )}

        {cat === "meeting" && (
          <Section title="Meeting context">
            <p className="text-[11px] text-muted-foreground">描述這場會議的性質與與會者角色，evaluation 與問答會用到。</p>
            <Textarea
              rows={6}
              className="max-w-xl resize-none"
              value={settings.meetingContext}
              onChange={(e) => patch({ meetingContext: e.target.value })}
              placeholder="例：A 輪募資談判。對方是投資人（重高），我是創辦人。重點：估值、董事席次、清算優先權…"
            />
          </Section>
        )}

        {cat === "evaluations" && (
          <Section title="Evaluations">
            <p className="text-[11px] text-muted-foreground">
              會議中監測的項目。auto 會依間隔自動重跑；manual 只在你按重跑時執行。
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
                    { id: crypto.randomUUID(), name: "新 evaluation", description: "", prompt: "", mode: "manual" },
                  ],
                })
              }
            >
              <Plus className="size-3.5" /> 新增 evaluation
            </Button>
          </Section>
        )}

        {cat === "todos" && (
          <Section title="TODO templates">
            <p className="text-[11px] text-muted-foreground">開始會議時自動帶入 TODO 清單的項目。</p>
            <div className="flex max-w-xl flex-col gap-2">
              {settings.todoTemplates.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input value={t} onChange={(e) => patch({ todoTemplates: settings.todoTemplates.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="待辦事項…" />
                  <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => patch({ todoTemplates: settings.todoTemplates.filter((_, j) => j !== i) })}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" className="w-fit" onClick={() => patch({ todoTemplates: [...settings.todoTemplates, ""] })}>
              <Plus className="size-3.5" /> 新增項目
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

function EvalEditor({
  ev,
  onChange,
  onDelete,
}: {
  ev: EvalDef;
  onChange: (p: Partial<EvalDef>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input value={ev.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="名稱" className="h-8 font-medium" />
        <Select value={ev.mode} onValueChange={(v) => onChange({ mode: v as "auto" | "manual" })}>
          <SelectTrigger size="sm" className="h-8 w-24 shrink-0"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">auto</SelectItem>
            <SelectItem value="manual">manual</SelectItem>
          </SelectContent>
        </Select>
        {ev.mode === "auto" && (
          <Input
            type="number"
            value={ev.autoEverySec ?? 60}
            onChange={(e) => onChange({ autoEverySec: Number(e.target.value) || 60 })}
            className="h-8 w-20 shrink-0"
            title="每幾秒重跑"
          />
        )}
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onDelete}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Input value={ev.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="一句話描述（顯示在卡片上）" className="h-8 text-xs" />
      <Textarea value={ev.prompt} onChange={(e) => onChange({ prompt: e.target.value })} placeholder="要 LLM 偵測什麼…" rows={3} className="resize-none text-xs" />
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
