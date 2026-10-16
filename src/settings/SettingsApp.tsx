import { useState } from "react";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { CLOUD_ENABLED } from "../lib/flags";
import { useThemePreference } from "../lib/theme";
import { ReleaseNotesDialog } from "../components/ReleaseNotesDialog";
import { Toaster } from "@/components/ui/sonner";
import {
  useAppInfo,
  useGoogleSignIn,
  useInputDevices,
  useMcpActivity,
  useMeetingRecording,
  useMicTest,
  usePendingInvites,
  useReleaseNotes,
  useSettingsCategory,
  useUpdateCheck,
} from "./hooks";
import { AccountCategory } from "./categories/AccountCategory";
import { OrganizationsCategory } from "./categories/OrganizationsCategory";
import { BasicCategory } from "./categories/BasicCategory";
import { ProviderCategory } from "./categories/ProviderCategory";
import { TranscriptionCategory } from "./categories/TranscriptionCategory";
import { DictionaryCategory } from "./categories/DictionaryCategory";
import { VoiceTypingCategory } from "./categories/VoiceTypingCategory";
import { PermissionsCategory } from "./categories/PermissionsCategory";
import { EvaluationsCategory } from "./categories/EvaluationsCategory";
import { TodosCategory } from "./categories/TodosCategory";
import { McpCategory } from "./categories/McpCategory";
import { UsageCategory } from "./categories/UsageCategory";

/**
 * Settings — its own OS window (`#settings`), opened from any window via
 * lib/nav.ts. Deep-links land on a specific nav panel two ways: a fresh window
 * reads the category off its URL hash; an already-open window gets it pushed
 * over the `settings://navigate` event.
 *
 * This is the shell: the nav, the window's data (hooks.ts — called in a fixed
 * order, which is the order their effects run and clean up in), and the open
 * panel (categories/). State that must outlive switching panels lives here.
 */
export function SettingsApp() {
  const { t } = useI18n();
  useThemePreference();

  const settings = useStore((s) => s.settings);
  // Every edit here reaches the other windows: this window's store broadcasts
  // each settings update itself (settingsSync.installSettingsBroadcast).
  const patch = useStore((s) => s.updateSettings);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const listing = { cloudEnabled: CLOUD_ENABLED, signedIn: !!cloudAuth };
  const cloudEmail = cloudAuth?.user.email ?? "";

  const { cat, setCat, navQuery, setNavQuery, navMatches } = useSettingsCategory(cloudAuth, t);
  const [pendingInvites, setPendingInvites] = usePendingInvites(cloudAuth);
  const signIn = useGoogleSignIn(t);
  const devices = useInputDevices(cat);
  const { appVersion, templatesPath, logPath, mcpInfo } = useAppInfo();
  const mcpActivity = useMcpActivity(cat);
  const recording = useMeetingRecording();
  const { testing, toggleTest } = useMicTest(recording, settings.inputDevice, t);
  const update = useUpdateCheck(t);
  const notes = useReleaseNotes(t);
  const [newTplName, setNewTplName] = useState("");

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Toaster />
      {notes.releaseNotes && (
        <ReleaseNotesDialog
          notes={notes.releaseNotes}
          onClose={notes.closeReleaseNotes}
        />
      )}
      {/* Left nav */}
      <nav className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r bg-muted/30 p-2">
        <div className="px-2 pb-2 pt-1 text-sm font-semibold tracking-tight">{t("common.settings")}</div>
        <input
          value={navQuery}
          onChange={(e) => setNavQuery(e.target.value)}
          placeholder={t("settings.searchPlaceholder")}
          aria-label={t("settings.searchPlaceholder")}
          className="mb-1 h-7 w-full rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        {navMatches.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => setCat(n.id)}
            className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
              cat === n.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {t(n.labelKey)}
            {n.id === "organizations" && pendingInvites > 0 && (
              <span
                className="min-w-4 rounded-full bg-primary px-1.5 text-center text-[10px] leading-4 font-semibold text-primary-foreground"
                aria-label={t("settings.org.pendingBadge", { count: pendingInvites })}
              >
                {pendingInvites}
              </span>
            )}
          </button>
        ))}
        {navMatches.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">{t("settings.searchEmpty")}</p>
        )}
      </nav>

      {/* Content */}
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        {cat === "account" && CLOUD_ENABLED && (
          <AccountCategory
            settings={settings}
            patch={patch}
            cloudAuth={cloudAuth}
            signingIn={signIn.signingIn}
            signInAbort={signIn.signInAbort}
            onSignIn={signIn.doSignIn}
          />
        )}
        {cat === "organizations" && CLOUD_ENABLED && cloudAuth && (
          <OrganizationsCategory onPendingCount={setPendingInvites} />
        )}
        {cat === "basic" && (
          <BasicCategory
            settings={settings}
            patch={patch}
            appVersion={appVersion}
            updateChecking={update.updateChecking}
            updateMsg={update.updateMsg}
            onCheckForUpdates={update.checkForUpdates}
            releaseNotesLoading={notes.releaseNotesLoading}
            onShowReleaseNotes={notes.showReleaseNotes}
          />
        )}
        {cat === "provider" && (
          <ProviderCategory settings={settings} patch={patch} listing={listing} cloudEmail={cloudEmail} />
        )}
        {cat === "transcription" && (
          <TranscriptionCategory
            settings={settings}
            patch={patch}
            listing={listing}
            cloudEmail={cloudEmail}
            devices={devices}
            recording={recording}
            testing={testing}
            onToggleTest={toggleTest}
          />
        )}
        {cat === "dictionary" && <DictionaryCategory />}
        {cat === "voiceTyping" && <VoiceTypingCategory />}
        {cat === "permissions" && <PermissionsCategory />}
        {cat === "evaluations" && (
          <EvaluationsCategory
            settings={settings}
            patch={patch}
            newTplName={newTplName}
            setNewTplName={setNewTplName}
          />
        )}
        {cat === "todos" && <TodosCategory settings={settings} patch={patch} />}
        {cat === "mcp" && (
          <McpCategory
            settings={settings}
            patch={patch}
            mcpInfo={mcpInfo}
            mcpActivity={mcpActivity}
            templatesPath={templatesPath}
            logPath={logPath}
          />
        )}
        {cat === "usage" && <UsageCategory />}
      </div>
    </div>
  );
}
