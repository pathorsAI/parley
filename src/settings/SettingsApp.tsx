import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { appLogDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { log } from "../lib/log";
import { Check, Copy, Download, Loader2, LogIn, LogOut, Monitor, Moon, PlugZap, Plus, Sun, Trash2 } from "lucide-react";
import { useStore } from "../lib/store";
import { LANGUAGE_OPTIONS, useI18n, type TranslationKey } from "../i18n";
import { broadcastSettings } from "../lib/settingsSync";
import { signInWithGoogle, signOut, CloudError } from "../lib/cloud/client";
import { CLOUD_ENABLED } from "../lib/flags";
import {
  createOrg,
  listMyOrgs,
  listOrgMembers,
  inviteToOrg,
  listMyInvitations,
  acceptInvitation,
  deleteOrg,
} from "../lib/cloud/orgs";
import type { CloudInvitation, CloudOrg, CloudOrgMember } from "../lib/cloud/types";
import { listCloudFolders, listOrgFolders, type CloudFolder } from "../lib/cloud/folders";
import { listLocalFolders, listenForFoldersUpdated, type Folder as LocalFolder } from "../lib/history/folders";
import { syncEnabled as cloudSyncEnabled } from "../lib/cloud/client";
import { isTauri } from "../lib/tauriEvents";
import { useThemePreference } from "../lib/theme";
import { LevelMeter } from "../components/LevelMeter";
import { UsagePanel } from "./UsagePanel";
import { STT_PROVIDERS, STT_BY_ID } from "../lib/transcription/providers";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
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
import {
  PROVIDERS,
  PROVIDER_BY_ID,
  isReasoningModel,
  type ProviderTagTone,
} from "../lib/ai/providers";

/** Tailwind classes for each provider tag tone (dark + light). */
const PROVIDER_TAG_TONES: Record<ProviderTagTone, string> = {
  smart: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  fast: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  local: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  value: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  default: "bg-muted text-muted-foreground",
};
import type { AppLanguage, AppLayout, AppTheme, DefaultSaveLocation, EvalDef, LlmProvider, ReasoningEffort, Settings, SttProviderId } from "../lib/types";
import { VoiceTypingSettings } from "./VoiceTypingSettings";
import { PermissionsPanel } from "./PermissionsPanel";

type Category =
  | "basic"
  | "account"
  | "provider"
  | "transcription"
  | "permissions"
  | "evaluations"
  | "todos"
  | "mcp"
  | "usage";

interface McpServerInfo {
  running: boolean;
  endpoint: string;
  templates_path: string;
}

// `cloudOnly` entries (the account/orgs page) are compiled out of the OSS edition,
// which has no sign-in at all — so they never appear in that build's nav.
const NAV: { id: Category; labelKey: TranslationKey; cloudOnly?: boolean }[] = [
  { id: "basic", labelKey: "settings.nav.basic" },
  { id: "account", labelKey: "settings.nav.account", cloudOnly: true },
  { id: "provider", labelKey: "settings.nav.provider" },
  { id: "transcription", labelKey: "settings.nav.transcription" },
  { id: "permissions", labelKey: "settings.nav.permissions" },
  { id: "evaluations", labelKey: "settings.nav.evaluations" },
  { id: "todos", labelKey: "settings.nav.todos" },
  { id: "mcp", labelKey: "settings.nav.mcp" },
  { id: "usage", labelKey: "settings.nav.usage" },
];

export function SettingsApp() {
  const { t } = useI18n();
  useThemePreference();

  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const [cat, setCat] = useState<Category>("basic");
  const [devices, setDevices] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  // A meeting is recording in the main window → lock the mic test + device picker
  // so changing the input can't disrupt the live capture.
  const [recording, setRecording] = useState(false);
  const [newTplName, setNewTplName] = useState("");
  const [templatesPath, setTemplatesPath] = useState("");
  const [mcpInfo, setMcpInfo] = useState<McpServerInfo | null>(null);
  const [logPath, setLogPath] = useState("");
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const cloudAuth = useStore((s) => s.cloudAuth);
  const [signingIn, setSigningIn] = useState(false);
  const signInAbort = useRef<AbortController | null>(null);

  async function doSignIn() {
    const controller = new AbortController();
    signInAbort.current = controller;
    setSigningIn(true);
    try {
      await signInWithGoogle(controller.signal);
    } catch (e) {
      // Don't toast a user-initiated cancel.
      if (!controller.signal.aborted) {
        const error = e instanceof Error ? e.message : String(e);
        toast.error(t("settings.account.signInFailed", { error }), {
          action: { label: t("toast.retry"), onClick: () => void doSignIn() },
        });
      }
    } finally {
      if (signInAbort.current === controller) signInAbort.current = null;
      setSigningIn(false);
    }
  }
  const info = PROVIDER_BY_ID[settings.provider];
  const providerLabel = info.label;
  const sttInfo = STT_BY_ID[settings.transcriptionProvider];

  function patch(p: Partial<Settings>) {
    updateSettings(p);
    void broadcastSettings({ ...useStore.getState().settings });
  }

  // Enumerate mic devices only on the Transcription tab — doing it on every
  // Settings open can trip the macOS microphone permission prompt.
  useEffect(() => {
    if (!isTauri() || cat !== "transcription") return;
    invoke<string[]>("list_input_devices").then(setDevices).catch(() => {});
  }, [cat]);

  useEffect(() => {
    if (!isTauri()) return;
    getVersion().then(setAppVersion).catch(() => {});
    invoke<string>("get_templates_path").then(setTemplatesPath).catch(() => {});
    appLogDir().then((d) => join(d, "parley.log")).then(setLogPath).catch(() => {});
    const refreshMcpInfo = () => {
      invoke<McpServerInfo>("get_mcp_server_info").then(setMcpInfo).catch(() => {});
    };
    refreshMcpInfo();
    const mcpTimer = window.setInterval(() => {
      if (!mcpInfo?.running) refreshMcpInfo();
    }, 1000);
    return () => {
      window.clearInterval(mcpTimer);
      void invoke("stop_mic_test").catch(() => {});
    };
  }, [mcpInfo?.running]);

  // Reflect the live meeting's recording state (query once, then follow the
  // broadcast `meeting://status`) so the mic controls lock while recording.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void invoke<boolean>("meeting_active")
      .then((a) => alive && setRecording(a))
      .catch(() => {});
    const un = listen<string>("meeting://status", (e) => {
      if (alive) setRecording(e.payload === "recording");
    });
    return () => {
      alive = false;
      void un.then((fn) => fn());
    };
  }, []);

  async function toggleTest() {
    if (recording) return; // the mic belongs to the meeting while recording
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
      <Toaster />
      {/* Left nav */}
      <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r bg-muted/30 p-2">
        <div className="px-2 pb-2 pt-1 text-sm font-semibold tracking-tight">{t("common.settings")}</div>
        {NAV.filter((n) => CLOUD_ENABLED || !n.cloudOnly).map((n) => (
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

        {cat === "account" && CLOUD_ENABLED && (
          <Section title={t("settings.nav.account")}>
            <Field label={t("settings.account.signIn")}>
              {cloudAuth ? (
                <div className="flex max-w-sm items-center gap-3 rounded-lg border p-2.5">
                  {cloudAuth.user.image ? (
                    <img src={cloudAuth.user.image} alt="" className="size-9 shrink-0 rounded-full" />
                  ) : (
                    <div className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-sm font-medium">
                      {(cloudAuth.user.name || cloudAuth.user.email).slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{cloudAuth.user.name || cloudAuth.user.email}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{cloudAuth.user.email}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => void signOut()}
                    title={t("settings.account.signOut")}
                    aria-label={t("settings.account.signOut")}
                  >
                    <LogOut className="size-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex max-w-sm flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      className="h-9 w-fit gap-2 text-xs"
                      disabled={signingIn || !isTauri()}
                      onClick={() => void doSignIn()}
                    >
                      {signingIn ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
                      {signingIn ? t("settings.account.signingIn") : t("settings.account.signInGoogle")}
                    </Button>
                    {signingIn && (
                      <button
                        type="button"
                        onClick={() => signInAbort.current?.abort()}
                        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {t("settings.account.cancel")}
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {isTauri() ? t("settings.account.signedOutHelp") : t("settings.account.desktopOnly")}
                  </p>
                </div>
              )}
            </Field>
            {cloudAuth && (
              <Field label={t("settings.account.sync.title")}>
                <div className="flex max-w-md flex-col gap-2 rounded-lg border p-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={settings.syncEnabled}
                      onChange={(e) => {
                        const on = e.target.checked;
                        const p: Partial<Settings> = { syncEnabled: on };
                        // An org default needs sync; turning sync off would leave the
                        // picker showing "Personal" while the stored value stays org
                        // (and silently reactivates on re-enable). Normalize it now.
                        if (!on && settings.defaultSaveLocation.scope === "org") {
                          p.defaultSaveLocation = { scope: "personal", folderId: null };
                        }
                        patch(p);
                      }}
                    />
                    {t("settings.account.sync.title")}
                  </label>
                  <p className="text-[11px] text-muted-foreground">{t("settings.account.sync.desc")}</p>
                </div>
              </Field>
            )}
            {cloudAuth && (
              <Field label={t("settings.account.defaultSave.title")}>
                <div className="flex max-w-md flex-col gap-2">
                  <DefaultSavePicker
                    value={settings.defaultSaveLocation}
                    syncOn={settings.syncEnabled}
                    onChange={(loc) => patch({ defaultSaveLocation: loc })}
                  />
                  <p className="text-[11px] text-muted-foreground">{t("settings.account.defaultSave.desc")}</p>
                  {!settings.syncEnabled && (
                    <p className="text-[11px] text-amber-500">{t("settings.account.defaultSave.syncOffHint")}</p>
                  )}
                </div>
              </Field>
            )}
            {cloudAuth && (
              <Field label={t("settings.account.org.title")}>
                <OrgPanel />
              </Field>
            )}
          </Section>
        )}

        {cat === "basic" && (
          <Section title={t("settings.basic.title")}>
            <Field label={t("settings.basic.name")}>
              <Input
                className="max-w-sm"
                placeholder={t("settings.basic.namePlaceholder")}
                value={settings.userName}
                onChange={(e) => patch({ userName: e.target.value })}
              />
            </Field>
            <Field label={t("settings.basic.role")}>
              <Input
                className="max-w-sm"
                placeholder={t("settings.basic.rolePlaceholder")}
                value={settings.userRole}
                onChange={(e) => patch({ userRole: e.target.value })}
              />
            </Field>
            <Field label={t("settings.basic.company")}>
              <Input
                className="max-w-sm"
                placeholder={t("settings.basic.companyPlaceholder")}
                value={settings.userCompany}
                onChange={(e) => patch({ userCompany: e.target.value })}
              />
              <p className="max-w-sm text-[11px] text-muted-foreground">{t("settings.basic.profileHelp")}</p>
            </Field>
            <Field label={t("settings.basic.background")}>
              <Textarea
                className="max-w-sm max-h-64 overflow-y-auto resize-none"
                rows={4}
                placeholder={t("settings.basic.backgroundPlaceholder")}
                value={settings.userBackground}
                onChange={(e) => patch({ userBackground: e.target.value })}
              />
              <p className="max-w-sm text-[11px] text-muted-foreground">{t("settings.basic.backgroundHelp")}</p>
            </Field>
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
            <Field label={t("settings.basic.theme")}>
              <div className="grid max-w-sm grid-cols-3 rounded-md bg-muted p-0.5">
                {(
                  [
                    ["light", t("settings.basic.themeLight"), Sun],
                    ["dark", t("settings.basic.themeDark"), Moon],
                    ["system", t("settings.basic.themeSystem"), Monitor],
                  ] as const
                ).map(([theme, label, Icon]) => (
                  <button
                    key={theme}
                    type="button"
                    aria-pressed={settings.theme === theme}
                    onClick={() => patch({ theme: theme as AppTheme })}
                    className={`flex h-8 items-center justify-center gap-1.5 rounded-[5px] px-2 text-sm transition-colors ${
                      settings.theme === theme
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label={t("settings.basic.layout")}>
              <div className="grid max-w-md grid-cols-3 gap-2">
                {(
                  [
                    ["full", t("settings.basic.layoutFull"), [t("meeting.transcript"), t("work.ask"), t("evaluations.title")]],
                    ["assistant", t("settings.basic.layoutAssistant"), [t("work.ask"), t("evaluations.title")]],
                    ["transcript", t("settings.basic.layoutTranscript"), [t("meeting.transcript"), t("work.ask")]],
                  ] as const
                ).map(([mode, label, cols]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => patch({ layout: mode as AppLayout })}
                    className={`flex flex-col items-center gap-1.5 rounded-lg border p-2 transition-colors ${
                      settings.layout === mode ? "border-primary bg-secondary" : "hover:bg-muted"
                    }`}
                  >
                    <div className="flex h-9 w-full gap-0.5">
                      {cols.map((c, i) => (
                        <div
                          key={i}
                          className="flex min-w-0 flex-1 items-center justify-center truncate rounded-sm bg-muted-foreground/20 px-1 text-[8px] text-muted-foreground"
                        >
                          {c}
                        </div>
                      ))}
                    </div>
                    <span className="text-[11px]">{label}</span>
                  </button>
                ))}
              </div>
            </Field>
            <Field label={t("settings.basic.setup")}>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-fit text-xs"
                onClick={async () => {
                  patch({ onboarded: false, onboardingStep: 0 });
                  // The onboarding renders on the MAIN window — bring it forward
                  // and close this Settings window so it isn't hidden behind it.
                  if (!isTauri()) return;
                  try {
                    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
                    const { getCurrentWindow } = await import("@tauri-apps/api/window");
                    await (await WebviewWindow.getByLabel("main"))?.setFocus();
                    await getCurrentWindow().close();
                  } catch {
                    /* ignore */
                  }
                }}
              >
                {t("settings.basic.rerunSetup")}
              </Button>
            </Field>
            <Field label={t("settings.update.title")}>
              {appVersion && (
                <p className="text-sm">
                  {t("settings.update.current", { version: appVersion })}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-fit text-xs"
                  disabled={updateChecking}
                  onClick={async () => {
                    setUpdateChecking(true);
                    setUpdateMsg("");
                    const { checkForUpdate } = await import("../lib/update");
                    const r = await checkForUpdate({ silent: false });
                    setUpdateMsg(r ? t("update.found", { version: r.version }) : t("update.upToDate"));
                    setUpdateChecking(false);
                  }}
                >
                  {updateChecking ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  {t("settings.update.check")}
                </Button>
                {updateMsg && <span className="text-[11px] text-muted-foreground">{updateMsg}</span>}
              </div>
              <p className="max-w-sm text-[11px] text-muted-foreground">{t("settings.update.help")}</p>
            </Field>
          </Section>
        )}

        {cat === "provider" && (
          <Section title={t("settings.provider.title")}>
            <Field label={t("settings.provider.provider")}>
              <Select value={settings.provider} onValueChange={(v) => patch({ provider: v as LlmProvider })}>
                <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.filter(
                    // The hosted "parley" provider only exists in the cloud build
                    // and only when signed in (auth IS the gate) — hide it in the
                    // OSS edition and when signed out.
                    (p) => p.id !== "parley" || (CLOUD_ENABLED && !!cloudAuth),
                  ).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex items-center gap-2">
                        <img src={p.icon} alt="" className="size-4 rounded-sm" />
                        {p.label}
                        {p.tag && (
                          <span
                            className={`rounded px-1.5 py-px text-[10px] font-medium ${PROVIDER_TAG_TONES[p.tag.tone]}`}
                          >
                            {t(p.tag.label)}
                          </span>
                        )}
                        {p.note && <span className="text-[10px] text-muted-foreground">{t(p.note)}</span>}
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
                placeholder={info.requiresKey === false ? t("settings.provider.noKeyNeeded") : info.keyPlaceholder}
                className="max-w-sm"
                disabled={info.requiresKey === false}
                value={settings[info.apiKeyField]}
                onChange={(e) => patch({ [info.apiKeyField]: e.target.value } as Partial<Settings>)}
              />
            </Field>
            {settings.provider === "parley" ? (
              // Hosted provider: no key, no model picker — the server forces the
              // real model behind "parley-fast"/"parley-smart". Just confirm who
              // the usage bills to.
              <div className="flex flex-col gap-2 border-t pt-4">
                <p className="text-[11px] text-muted-foreground">
                  {t("settings.account.useParley.note", {
                    email: cloudAuth?.user.email ?? "",
                  })}
                </p>
              </div>
            ) : (
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
                {info.kind === "openai-compatible" && isReasoningModel(settings.models[settings.provider].ask) && (
                  <ReasoningEffortSelect
                    label={t("settings.provider.askReasoning")}
                    value={settings.reasoningEffort.ask}
                    onChange={(v) =>
                      patch({ reasoningEffort: { ...settings.reasoningEffort, ask: v } })
                    }
                  />
                )}
              </Field>
              <Field label={t("settings.provider.evalModel")}>
                <ModelSelect
                  provider={settings.provider}
                  value={settings.models[settings.provider].eval}
                  onChange={(v) => patchModel(patch, settings, settings.provider, "eval", v)}
                />
                {info.kind === "openai-compatible" && isReasoningModel(settings.models[settings.provider].eval) && (
                  <ReasoningEffortSelect
                    label={t("settings.provider.evalReasoning")}
                    value={settings.reasoningEffort.eval}
                    onChange={(v) =>
                      patch({ reasoningEffort: { ...settings.reasoningEffort, eval: v } })
                    }
                  />
                )}
              </Field>
            </div>
            )}
          </Section>
        )}

        {cat === "transcription" && (
          <Section title={t("settings.transcription.title")}>
            <Field label={t("settings.transcription.provider")}>
              <Select
                value={settings.transcriptionProvider}
                onValueChange={(v) => patch({ transcriptionProvider: v as SttProviderId })}
              >
                <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STT_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex items-center gap-2">
                        <img src={p.icon} alt="" className="size-4 rounded-sm" />
                        {p.label}
                        {!p.diarization && (
                          <span className="rounded bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-600 dark:text-amber-300">
                            {t("settings.transcription.noDiarizationTag")}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("settings.transcription.apiKey", { provider: sttInfo.label })}>
              <Input
                type="password"
                autoComplete="off"
                placeholder={sttInfo.keyPlaceholder}
                className="max-w-sm"
                value={settings[sttInfo.apiKeyField] as string}
                onChange={(e) => patch({ [sttInfo.apiKeyField]: e.target.value } as Partial<Settings>)}
              />
            </Field>
            {!sttInfo.diarization && (
              <p className="max-w-md rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                {t("settings.transcription.noDiarizationWarning")}
              </p>
            )}
            <Field label={t("settings.transcription.speakerModel")}>
              <DiarizeModelField />
            </Field>
            <Field label={t("settings.transcription.microphone")}>
              <div className="flex max-w-sm flex-col gap-2">
                <Select
                  value={settings.inputDevice || "__default__"}
                  disabled={recording}
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
                  <Button
                    variant={testing ? "destructive" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={recording}
                    onClick={toggleTest}
                  >
                    {testing ? t("settings.transcription.stopTest") : t("settings.transcription.testMic")}
                  </Button>
                  <LevelMeter source="test" className="h-2 flex-1" />
                </div>
                {recording && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("settings.transcription.lockedWhileRecording")}
                  </p>
                )}
              </div>
            </Field>
            <p className="max-w-md text-[11px] text-muted-foreground">
              {t("settings.transcription.help")}
            </p>

            {/* Live delivery coaching (issue #22): mic-only pace/pitch/pause/tone. */}
            <div className="flex max-w-md flex-col gap-2 rounded-lg border p-3">
              <p className="text-xs font-medium">{t("settings.delivery.title")}</p>
              <p className="text-[11px] text-muted-foreground">{t("settings.delivery.desc")}</p>
              {(
                [
                  ["pace", "settings.delivery.pace"],
                  ["pitch", "settings.delivery.pitch"],
                  ["pauses", "settings.delivery.pauses"],
                  ["tone", "settings.delivery.tone"],
                ] as [keyof Settings["delivery"], TranslationKey][]
              ).map(([key, labelKey]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={settings.delivery[key]}
                    onChange={(e) =>
                      patch({ delivery: { ...settings.delivery, [key]: e.target.checked } })
                    }
                  />
                  {t(labelKey)}
                </label>
              ))}
            </div>
            <VoiceTypingSettings />
          </Section>
        )}

        {cat === "permissions" && (
          <Section title={t("settings.permissions.title")}>
            <PermissionsPanel />
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

        {cat === "mcp" && (
          <Section title={t("settings.mcp.title")}>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.mcp.description")}
            </p>

            <div className="flex max-w-xl items-center gap-3 rounded-lg border bg-muted/20 p-4">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground">
                <PlugZap className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span>{t("settings.mcp.status")}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      mcpInfo?.running
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                        : "bg-amber-500/15 text-amber-600 dark:text-amber-300"
                    }`}
                  >
                    {mcpInfo?.running ? t("settings.mcp.running") : t("settings.mcp.starting")}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1">
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {mcpInfo?.endpoint || t("settings.mcp.endpointPending")}
                  </p>
                  {mcpInfo?.endpoint && (
                    <CopyButton
                      iconOnly
                      value={mcpInfo.endpoint}
                      title={t("settings.mcp.copyUrl")}
                      className="size-6 shrink-0 text-muted-foreground"
                    />
                  )}
                </div>
              </div>
            </div>

            <Field label={t("settings.mcp.sharedFile")}>
              <div className="flex max-w-xl items-center gap-2">
                <Input
                  readOnly
                  value={templatesPath || mcpInfo?.templates_path || "Loading..."}
                  className="bg-muted/30 font-mono text-xs"
                />
                <CopyButton
                  className="h-9 shrink-0 gap-1"
                  value={templatesPath || mcpInfo?.templates_path || ""}
                  label={t("settings.mcp.copyPath")}
                  disabled={!templatesPath && !mcpInfo?.templates_path}
                />
              </div>
            </Field>

            <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold tracking-tight">{t("settings.mcp.claudeCodeInstructions")}</h3>
                <CopyButton
                  className="h-8 gap-1"
                  value={() =>
                    `claude mcp add --transport http parley-templates ${mcpInfo?.endpoint || "http://127.0.0.1:3011/mcp"}`
                  }
                  label={t("settings.mcp.copyCommand")}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">{t("settings.mcp.claudeCodeHelp")}</p>
              <pre className="rounded bg-muted p-2.5 font-mono text-xs text-foreground overflow-x-auto border">
                {`claude mcp add --transport http parley-templates ${mcpInfo?.endpoint || "http://127.0.0.1:3011/mcp"}`}
              </pre>
            </div>

            <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold tracking-tight">{t("settings.mcp.configInstructions")}</h3>
                <CopyButton
                  className="h-8 gap-1"
                  value={() =>
                    JSON.stringify(
                      {
                        mcpServers: {
                          "parley-templates": {
                            type: "http",
                            url: mcpInfo?.endpoint || "http://127.0.0.1:3011/mcp",
                          },
                        },
                      },
                      null,
                      2
                    )
                  }
                  label={t("settings.mcp.copyConfig")}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">{t("settings.mcp.configHelp")}</p>
              <pre className="rounded bg-muted p-2.5 font-mono text-xs text-foreground overflow-x-auto border">
                {`{
  "mcpServers": {
    "parley-templates": {
      "type": "http",
      "url": "${mcpInfo?.endpoint || "http://127.0.0.1:3011/mcp"}"
    }
  }
}`}
              </pre>
            </div>
          </Section>
        )}

        {cat === "mcp" && (
          <Section title={t("settings.logs.title")}>
            <p className="text-[11px] text-muted-foreground">{t("settings.logs.help")}</p>
            {logPath && (
              <pre className="overflow-x-auto rounded border bg-muted p-2.5 font-mono text-xs text-foreground">
                {logPath}
              </pre>
            )}
            <div className="flex items-center gap-2">
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
        )}

        {cat === "usage" && (
          <Section title={t("settings.usage.title")}>
            <UsagePanel />
          </Section>
        )}
      </div>
    </div>
  );
}

/** Copy-to-clipboard button with a 2s "copied" confirmation. */
function CopyButton({
  value,
  label,
  title,
  className,
  iconOnly,
  disabled,
}: {
  /** Text to copy, or a thunk evaluated at click time for computed values. */
  value: string | (() => string);
  label?: string;
  title?: string;
  className?: string;
  iconOnly?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(typeof value === "function" ? value() : value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  if (iconOnly) {
    return (
      <Button variant="ghost" size="icon" className={className} title={title} disabled={disabled} onClick={copy}>
        {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" className={className} title={title} disabled={disabled} onClick={copy}>
      {copied ? (
        <>
          <Check className="size-3.5 text-emerald-500" />
          <span>{t("settings.mcp.copied")}</span>
        </>
      ) : (
        <>
          <Copy className="size-3.5" />
          <span>{label}</span>
        </>
      )}
    </Button>
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

/** Sentinel option that switches the picker into free-text "custom model" mode. */
const CUSTOM_MODEL = "__custom__";

function ModelSelect({
  provider,
  value,
  onChange,
}: {
  provider: LlmProvider;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  const presets = PROVIDER_BY_ID[provider].models;
  // Custom (free-text) mode: on by default when the saved id isn't a listed
  // preset (e.g. a brand-new model the user typed in before).
  const [custom, setCustom] = useState(() => !!value && !presets.includes(value));
  // Re-infer when the provider changes (different presets + value).
  useEffect(() => {
    setCustom(!!value && !presets.includes(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  if (custom) {
    return (
      <div className="flex max-w-sm flex-col gap-1.5">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("settings.provider.customModelPlaceholder")}
          className="font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => {
            setCustom(false);
            onChange(presets[0] ?? "");
          }}
          className="w-fit text-[11px] text-muted-foreground hover:text-foreground"
        >
          {t("settings.provider.usePreset")}
        </button>
      </div>
    );
  }

  // Always include the current value so a persisted id stays selectable.
  const options = Array.from(new Set([...presets, value].filter(Boolean)));
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v === CUSTOM_MODEL) {
          setCustom(true);
          return;
        }
        onChange(v);
      }}
    >
      <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((m) => (
          <SelectItem key={m} value={m}>
            {m}
          </SelectItem>
        ))}
        <SelectItem value={CUSTOM_MODEL}>{t("settings.provider.customModel")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ReasoningEffortSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="mt-2 flex max-w-sm items-center gap-2">
      <span className="min-w-28 text-[11px] text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={(v) => onChange(v as ReasoningEffort)}>
        <SelectTrigger className="h-7 flex-1 text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="low">{t("settings.provider.low")}</SelectItem>
          <SelectItem value="medium">{t("settings.provider.medium")}</SelectItem>
          <SelectItem value="high">{t("settings.provider.high")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
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
      <Textarea value={ev.prompt} onChange={(e) => onChange({ prompt: e.target.value })} placeholder={t("settings.evaluations.promptPlaceholder")} rows={3} className="max-h-40 overflow-y-auto resize-none text-xs" />
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

/**
 * On-device speaker-diarization model: shows whether it's downloaded and offers a
 * manual download when it's missing — the recovery path for users who skipped the
 * onboarding step (previously the model could only ever be fetched there or
 * implicitly on first diarization). Reuses the Rust `diarize://progress` events
 * (stage `downloading-model`) for the progress bar, same as onboarding.
 */
function DiarizeModelField() {
  const { t } = useI18n();
  // null = still checking; true/false = known presence.
  const [present, setPresent] = useState<boolean | null>(null);
  const [status, setStatus] = useState<"idle" | "downloading" | "error">("idle");
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!isTauri()) {
      setPresent(false);
      return;
    }
    import("../lib/speakers/diarize")
      .then((m) => m.diarizeModelStatus())
      .then((s) => setPresent(s.present))
      .catch(() => setPresent(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Mirror onboarding's progress wiring so the bar fills while fetching.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<{ stage: string; received: number; total: number }>("diarize://progress", (e) => {
      if (alive && e.payload.stage === "downloading-model" && e.payload.total > 0) {
        setPct(Math.min(100, Math.round((e.payload.received / e.payload.total) * 100)));
      }
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  async function download() {
    if (status === "downloading") return;
    setStatus("downloading");
    setError(null);
    setPct(0);
    try {
      const { prefetchDiarizeModel } = await import("../lib/speakers/diarize");
      await prefetchDiarizeModel();
      setPresent(true);
      setStatus("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-2">
      {present === true ? (
        <span className="flex items-center gap-1.5 text-sm text-emerald-500">
          <Check className="size-4" />
          {t("settings.transcription.speakerModelInstalled")}
        </span>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            <span className="text-sm text-muted-foreground">
              {present === null ? "…" : t("settings.transcription.speakerModelMissing")}
            </span>
            <Button
              size="sm"
              className="h-7 gap-1.5 text-[11px]"
              disabled={status === "downloading" || present === null}
              onClick={() => void download()}
            >
              {status === "downloading" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {status === "downloading"
                ? t("settings.transcription.speakerModelDownloading", { percent: pct })
                : t("settings.transcription.speakerModelDownload")}
            </Button>
          </div>
          {status === "downloading" && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
          {error && (
            <p className="rounded-md bg-orange-500/10 px-2.5 py-1.5 text-[11px] text-orange-400">
              {t("settings.transcription.speakerModelFailed", { error })}
            </p>
          )}
        </>
      )}
      <p className="text-[11px] text-muted-foreground">{t("settings.transcription.speakerModelHelp")}</p>
    </div>
  );
}

/**
 * Organizations management: create an org, invite teammates by email, and accept
 * pending invitations. Talks to the cloud's better-auth `organization` plugin via
 * ../lib/cloud/orgs. Rendered only when signed in (its parent gates on `cloudAuth`).
 */
/** Button label while an action is in flight: a spinner + the text (no "…"). */
function Spinning({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1">
      <Loader2 className="size-3 animate-spin" />
      {label}
    </span>
  );
}

function OrgPanel() {
  const { t } = useI18n();
  const cloudAuth = useStore((s) => s.cloudAuth);
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  // Roster per org id (who's a member), shown under each org.
  const [members, setMembers] = useState<Record<string, CloudOrgMember[]>>({});
  const [invitations, setInvitations] = useState<CloudInvitation[]>([]);
  // Per-org invite inputs + pending flags, keyed by org id.
  const [inviteEmails, setInviteEmails] = useState<Record<string, string>>({});
  const [inviting, setInviting] = useState<Record<string, boolean>>({});
  const [newOrgName, setNewOrgName] = useState("");
  const [creating, setCreating] = useState(false);
  // Per-invitation accept flags, keyed by invitation id.
  const [accepting, setAccepting] = useState<Record<string, boolean>>({});
  // Org deletion: which org's danger zone is open, the retyped-name confirmation
  // value, and the in-flight flag — all keyed by org id. Deletion stays gated
  // until the typed value exactly matches the org name (the second confirmation).
  const [deletingOpen, setDeletingOpen] = useState<Record<string, boolean>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    try {
      const [myOrgs, myInvites] = await Promise.all([listMyOrgs(), listMyInvitations()]);
      setOrgs(myOrgs);
      setInvitations(myInvites);
      // Fetch each org's roster in parallel; a single org failing shouldn't blank
      // the others, so swallow per-org errors and just omit that roster.
      const rosters = await Promise.all(
        myOrgs.map((o) =>
          listOrgMembers(o.id)
            .then((m) => [o.id, m] as const)
            .catch(() => [o.id, [] as CloudOrgMember[]] as const),
        ),
      );
      setMembers(Object.fromEntries(rosters));
    } catch {
      toast.error(t("settings.account.org.loadFailed"));
    }
  }, [t]);

  // (Re)load whenever we have a session — including when sign-in just completed.
  useEffect(() => {
    if (cloudAuth) void reload();
  }, [cloudAuth, reload]);

  async function create() {
    const name = newOrgName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      await createOrg(name);
      toast.success(t("settings.account.org.created", { org: name }));
      setNewOrgName("");
      await reload();
    } catch (e) {
      toast.error(t("settings.account.org.createFailed", { error: cloudErrMsg(e) }));
    } finally {
      setCreating(false);
    }
  }

  // Turn a cloud failure into a human, localized reason. better-auth returns a
  // machine `code` on a 4xx; we translate the ones a user can actually act on, and
  // fall back to the backend's own message for anything unmapped (still far better
  // than a bare "→ 400").
  function cloudErrMsg(e: unknown): string {
    const code = e instanceof CloudError ? e.code : null;
    switch (code) {
      case "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION":
        return t("settings.account.org.errAlreadyMember");
      case "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION":
        return t("settings.account.org.errAlreadyInvited");
      case "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION":
        return t("settings.account.org.errNoInvitePermission");
      case "MEMBER_NOT_FOUND":
      case "ORGANIZATION_NOT_FOUND":
        return t("settings.account.org.errOrgGone");
      case "INVALID_EMAIL":
        return t("settings.account.org.errInvalidEmail");
      default:
        return e instanceof Error ? e.message : String(e);
    }
  }

  async function invite(orgId: string) {
    const email = (inviteEmails[orgId] ?? "").trim();
    if (!email || inviting[orgId]) return;
    setInviting((m) => ({ ...m, [orgId]: true }));
    try {
      await inviteToOrg(orgId, email);
      toast.success(t("settings.account.org.invited", { email }));
      setInviteEmails((m) => ({ ...m, [orgId]: "" }));
    } catch (e) {
      toast.error(t("settings.account.org.inviteFailed", { error: cloudErrMsg(e) }));
    } finally {
      setInviting((m) => ({ ...m, [orgId]: false }));
    }
  }

  async function accept(invitation: CloudInvitation) {
    if (accepting[invitation.id]) return;
    const name = invitation.organizationName ?? invitation.organizationId;
    setAccepting((m) => ({ ...m, [invitation.id]: true }));
    try {
      await acceptInvitation(invitation.id);
      toast.success(t("settings.account.org.joined", { org: name }));
      await reload();
    } catch (e) {
      toast.error(t("settings.account.org.acceptFailed", { error: cloudErrMsg(e) }));
    } finally {
      setAccepting((m) => ({ ...m, [invitation.id]: false }));
    }
  }

  async function remove(org: CloudOrg) {
    // Hard gate: never fire unless the retyped name matches exactly (trim both
    // sides so a stray trailing space in the org name can't make it un-typeable).
    if (deleting[org.id] || (deleteConfirm[org.id] ?? "").trim() !== org.name.trim()) return;
    setDeleting((m) => ({ ...m, [org.id]: true }));
    try {
      await deleteOrg(org.id);
      toast.success(t("settings.account.org.deleted", { org: org.name }));
      // The org is gone now; drop its per-org UI state so no stale keys linger.
      const drop = (m: Record<string, unknown>) => {
        const next = { ...m };
        delete next[org.id];
        return next;
      };
      setDeletingOpen((m) => drop(m) as Record<string, boolean>);
      setDeleteConfirm((m) => drop(m) as Record<string, string>);
      await reload();
    } catch (e) {
      toast.error(t("settings.account.org.deleteFailed", { error: cloudErrMsg(e) }));
    } finally {
      setDeleting((m) => ({ ...m, [org.id]: false }));
    }
  }

  return (
    <div className="flex max-w-sm flex-col gap-3">
      {/* My organizations */}
      {orgs.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("settings.account.org.noOrgs")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {orgs.map((org) => (
            <div key={org.id} className="flex flex-col gap-1.5 rounded-lg border p-2.5">
              <div className="truncate text-sm font-medium">{org.name}</div>

              {/* Roster — who's in this org (name/email, role, "you"). */}
              {(members[org.id]?.length ?? 0) > 0 && (
                <ul className="flex flex-col gap-1">
                  {members[org.id].map((mem) => (
                    <li key={mem.id} className="flex items-center gap-2">
                      {mem.image ? (
                        <img src={mem.image} alt="" className="size-5 shrink-0 rounded-full" />
                      ) : (
                        <div className="grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-[9px] font-medium">
                          {(mem.name || mem.email || "?").slice(0, 1).toUpperCase()}
                        </div>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[11px]">
                        {mem.name || mem.email}
                        {mem.userId === cloudAuth?.user.id && (
                          <span className="text-muted-foreground"> {t("settings.account.org.you")}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {mem.role === "owner"
                          ? t("settings.account.org.roleOwner")
                          : mem.role === "admin"
                            ? t("settings.account.org.roleAdmin")
                            : t("settings.account.org.roleMember")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Inviting is owner/admin-only — plain members can't (the server
                  403s), so don't show them an invite box they can't use. */}
              {(org.role === "owner" || org.role === "admin") && (
                <div className="flex items-center gap-2">
                  <Input
                    className="h-7 text-xs"
                    placeholder={t("settings.account.org.invitePlaceholder")}
                    value={inviteEmails[org.id] ?? ""}
                    onChange={(e) => setInviteEmails((m) => ({ ...m, [org.id]: e.target.value }))}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-[11px]"
                    disabled={inviting[org.id] || !(inviteEmails[org.id] ?? "").trim()}
                    onClick={() => void invite(org.id)}
                  >
                    {inviting[org.id] ? (
                      <Spinning label={t("settings.account.org.inviting")} />
                    ) : (
                      t("settings.account.org.invite")
                    )}
                  </Button>
                </div>
              )}

              {/* Danger zone — owner-only. Only the org's owner can delete it (the
                  server re-checks), so non-owners never see the affordance at all.
                  Deletion is intentionally awkward: first click reveals the panel;
                  the final button stays disabled until the org name is retyped
                  exactly — two deliberate confirmations before anything dies. */}
              {org.role === "owner" &&
                (!deletingOpen[org.id] ? (
                  <button
                    type="button"
                    aria-expanded={false}
                    className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
                    onClick={() => setDeletingOpen((m) => ({ ...m, [org.id]: true }))}
                  >
                    {t("settings.account.org.delete")}
                  </button>
                ) : (
                  <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2">
                    <p className="text-[11px] text-destructive">
                      {t("settings.account.org.deleteWarning")}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {t("settings.account.org.deleteConfirmPrompt", { org: org.name })}
                    </p>
                    <Input
                      className="h-7 text-xs"
                      placeholder={org.name}
                      value={deleteConfirm[org.id] ?? ""}
                      onChange={(e) => setDeleteConfirm((m) => ({ ...m, [org.id]: e.target.value }))}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        disabled={
                          deleting[org.id] ||
                          (deleteConfirm[org.id] ?? "").trim() !== org.name.trim()
                        }
                        onClick={() => void remove(org)}
                      >
                        {deleting[org.id] ? (
                          <Spinning label={t("settings.account.org.deleting")} />
                        ) : (
                          t("settings.account.org.deleteConfirm")
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        disabled={deleting[org.id]}
                        onClick={() => {
                          setDeletingOpen((m) => ({ ...m, [org.id]: false }));
                          setDeleteConfirm((m) => ({ ...m, [org.id]: "" }));
                        }}
                      >
                        {t("settings.account.org.deleteCancel")}
                      </Button>
                    </div>
                  </div>
                ))}
            </div>
          ))}
          {orgs.some((o) => o.role === "owner" || o.role === "admin") && (
            <p className="text-[11px] text-muted-foreground">{t("settings.account.org.inviteHint")}</p>
          )}
        </div>
      )}

      {/* Create organization */}
      <div className="flex items-center gap-2">
        <Input
          className="h-7 text-xs"
          placeholder={t("settings.account.org.createPlaceholder")}
          value={newOrgName}
          onChange={(e) => setNewOrgName(e.target.value)}
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          disabled={creating || !newOrgName.trim()}
          onClick={() => void create()}
        >
          {creating ? (
            <Spinning label={t("settings.account.org.creating")} />
          ) : (
            t("settings.account.org.create")
          )}
        </Button>
      </div>

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">{t("settings.account.org.pending")}</p>
          {invitations.map((inv) => (
            <div key={inv.id} className="flex items-center gap-2 rounded-lg border p-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">
                {inv.organizationName ?? inv.organizationId}
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="h-7 shrink-0 px-2 text-[11px]"
                disabled={accepting[inv.id]}
                onClick={() => void accept(inv)}
              >
                {accepting[inv.id] ? (
                  <Spinning label={t("settings.account.org.accepting")} />
                ) : (
                  t("settings.account.org.accept")
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Default-save-location picker: a native select grouping the personal root + folders
 * and — when cloud sync is on — each org's root + folders. Loads the folder lists
 * itself so the Settings window stays self-contained. Choosing an org folder makes
 * finished meetings auto-share into that team space (see history.ts resolveDefaultSave).
 */
function DefaultSavePicker({
  value,
  syncOn,
  onChange,
}: {
  value: DefaultSaveLocation;
  syncOn: boolean;
  onChange: (loc: DefaultSaveLocation) => void;
}) {
  const { t } = useI18n();
  const [personal, setPersonal] = useState<LocalFolder[]>(() => listLocalFolders());
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  const [orgFolders, setOrgFolders] = useState<Record<string, CloudFolder[]>>({});

  // Personal folders: prefer the cloud list when sync is on (cross-device truth).
  // Re-run when the toggle flips so enabling sync in an already-open window refreshes.
  useEffect(() => {
    void (async () => {
      if (!syncOn || !cloudSyncEnabled()) {
        setPersonal(listLocalFolders());
        return;
      }
      try {
        const cloud = await listCloudFolders();
        setPersonal(cloud.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt })));
      } catch {
        setPersonal(listLocalFolders());
      }
    })();
  }, [syncOn]);

  // Reflect personal-folder create/rename/delete done in the History window live.
  useEffect(() => {
    const un = listenForFoldersUpdated(() => setPersonal(listLocalFolders()));
    return () => void un.then((fn) => fn());
  }, []);

  // Org folders only matter for an org default, which needs sync on.
  useEffect(() => {
    if (!syncOn) return;
    let alive = true;
    void (async () => {
      try {
        const mine = await listMyOrgs();
        if (!alive) return;
        setOrgs(mine);
        const pairs = await Promise.all(
          mine.map(async (o) => [o.id, await listOrgFolders(o.id).catch(() => [])] as const),
        );
        if (alive) setOrgFolders(Object.fromEntries(pairs));
      } catch {
        /* leave orgs empty */
      }
    })();
    return () => {
      alive = false;
    };
  }, [syncOn]);

  const serialize = (loc: DefaultSaveLocation): string =>
    loc.scope === "personal"
      ? loc.folderId
        ? `personal:${loc.folderId}`
        : "personal"
      : loc.folderId
        ? `org:${loc.orgId}:${loc.folderId}`
        : `org:${loc.orgId}`;

  const parse = (v: string): DefaultSaveLocation => {
    if (v === "personal") return { scope: "personal", folderId: null };
    if (v.startsWith("personal:")) return { scope: "personal", folderId: v.slice("personal:".length) };
    const rest = v.slice("org:".length);
    const idx = rest.indexOf(":");
    return idx === -1
      ? { scope: "org", orgId: rest, folderId: null }
      : { scope: "org", orgId: rest.slice(0, idx), folderId: rest.slice(idx + 1) };
  };

  return (
    <select
      value={serialize(value)}
      onChange={(e) => onChange(parse(e.target.value))}
      className="h-9 max-w-md rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
    >
      <optgroup label={t("settings.account.defaultSave.personal")}>
        <option value="personal">{t("settings.account.defaultSave.root")}</option>
        {personal.map((f) => (
          <option key={f.id} value={`personal:${f.id}`}>
            {f.name}
          </option>
        ))}
      </optgroup>
      {syncOn &&
        orgs.map((o) => (
          <optgroup key={o.id} label={o.name}>
            <option value={`org:${o.id}`}>{t("settings.account.defaultSave.root")}</option>
            {(orgFolders[o.id] ?? []).map((f) => (
              <option key={f.id} value={`org:${o.id}:${f.id}`}>
                {f.name}
              </option>
            ))}
          </optgroup>
        ))}
    </select>
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
