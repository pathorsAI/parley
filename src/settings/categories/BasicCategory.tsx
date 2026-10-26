import { Download, Loader2, Monitor, Moon, ScrollText, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Flag } from "../../components/ui/flag";
import { CLOUD_ENABLED } from "../../lib/flags";
import { isTauri } from "../../lib/tauriEvents";
import { settingsBroadcastSettled } from "../../lib/store";
import { resetGettingStarted } from "../../lib/onboarding/gettingStarted";
import type { AppLanguage, AppTheme } from "../../lib/types";
import { LANGUAGE_OPTIONS, useI18n } from "../../i18n";
import { LaunchAtLoginField } from "../LaunchAtLoginField";
import { Field, Section } from "../fields";
import type { SettingsPanelProps } from "./types";

/** Bring the main window forward and close Settings so it isn't hidden behind it. */
async function focusMainWindow() {
  if (!isTauri()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await (await WebviewWindow.getByLabel("main"))?.setFocus();
    await getCurrentWindow().close();
  } catch {
    /* ignore */
  }
}

/** Settings › Basic: profile, language, theme, setup hand-offs, updates. */
export function BasicCategory({
  settings,
  patch,
  appVersion,
  updateChecking,
  updateMsg,
  onCheckForUpdates,
  releaseNotesLoading,
  onShowReleaseNotes,
}: Readonly<
  SettingsPanelProps & {
    appVersion: string;
    updateChecking: boolean;
    updateMsg: string;
    onCheckForUpdates: () => Promise<void>;
    releaseNotesLoading: boolean;
    onShowReleaseNotes: () => Promise<void>;
  }
>) {
  const { t } = useI18n();
  return (
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
                <Flag code={language.flag} />
                {language.nativeLabel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
      {/* App-wide, so it lives here rather than under Voice Typing: the
          MCP server also comes up at login. The help text names voice
          typing, the main reason to turn it on. */}
      <LaunchAtLoginField />
      <Field label={t("settings.basic.setup")}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-fit text-xs"
            onClick={async () => {
              patch({ onboarded: false, onboardingStep: 0, onboardingStepId: "" });
              // The onboarding renders on the MAIN window — bring it forward
              // and close this Settings window so it isn't hidden behind it.
              await focusMainWindow();
            }}
          >
            {t("settings.basic.rerunSetup")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-fit text-xs"
            onClick={async () => {
              // The checklist lives on the main window's Home — same hand-off,
              // once the reset has reached the main window.
              resetGettingStarted();
              await settingsBroadcastSettled();
              await focusMainWindow();
            }}
          >
            {t("settings.basic.showGettingStarted")}
          </Button>
        </div>
      </Field>
      <Field label={t("settings.update.title")}>
        {appVersion && (
          <p className="flex items-center gap-2 text-sm">
            {t("settings.update.current", { version: appVersion })}
            <EditionBadge />
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-fit text-xs"
            disabled={updateChecking}
            onClick={onCheckForUpdates}
          >
            {updateChecking ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {t("settings.update.check")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-fit text-xs"
            disabled={releaseNotesLoading}
            onClick={onShowReleaseNotes}
          >
            {releaseNotesLoading ? <Loader2 className="size-3.5 animate-spin" /> : <ScrollText className="size-3.5" />}
            {t("settings.update.releaseLogs")}
          </Button>
          {updateMsg && <span className="text-[11px] text-muted-foreground">{updateMsg}</span>}
        </div>
        <p className="max-w-sm text-[11px] text-muted-foreground">{t("settings.update.help")}</p>
      </Field>
    </Section>
  );
}

/** Build-edition tag (Official vs OSS) shown next to the current version. */
function EditionBadge() {
  const { t } = useI18n();
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-muted text-muted-foreground"
      title={CLOUD_ENABLED ? t("settings.edition.official.hint") : t("settings.edition.oss.hint")}
    >
      {CLOUD_ENABLED ? t("settings.edition.official") : t("settings.edition.oss")}
    </span>
  );
}
