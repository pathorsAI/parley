import { Loader2, LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { log } from "../../lib/log";
import { isTauri } from "../../lib/tauriEvents";
import { signOut } from "../../lib/cloud/client";
import type { CloudAuth } from "../../lib/cloud/types";
import type { Settings, SetupMode } from "../../lib/types";
import { cloudRoutePatch, localRoutePatch } from "../../lib/onboarding/setupMode";
import type { TranslationKey } from "../../i18n/messages";
import { useI18n } from "../../i18n";
import { DestinationField } from "../../components/DestinationSheet";
import { Field, Section } from "../fields";
import { ApiKeysField } from "../ApiKeysField";
import type { SettingsPanelProps } from "./types";

/** Settings › Account: sign-in, the setup route, cloud sync, the default org
 *  share, and API keys. */
export function AccountCategory({
  settings,
  patch,
  cloudAuth,
  signingIn,
  signInAbort,
  onSignIn,
}: Readonly<
  SettingsPanelProps & {
    cloudAuth: CloudAuth | null;
    signingIn: boolean;
    signInAbort: React.RefObject<AbortController | null>;
    onSignIn: () => Promise<void>;
  }
>) {
  const { t } = useI18n();
  return (
    <Section title={t("settings.nav.account")}>
      <AccountSignInField
        cloudAuth={cloudAuth}
        signingIn={signingIn}
        signInAbort={signInAbort}
        onSignIn={onSignIn}
      />
      <SetupModeField settings={settings} patch={patch} signedIn={!!cloudAuth} />
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
            {/* Personal here means "don't share": the auto-share default
                only ever adds an org copy, so Personal has no folders. */}
            <DestinationField
              verb="share"
              title={t("settings.account.defaultSave.title")}
              personalFolders={false}
              allowKeepCopy={false}
              value={
                settings.defaultSaveLocation.scope === "org" &&
                settings.defaultSaveLocation.orgId
                  ? {
                      scope: "org",
                      orgId: settings.defaultSaveLocation.orgId,
                      folderId: settings.defaultSaveLocation.folderId ?? null,
                    }
                  : { scope: "personal", folderId: null }
              }
              onChange={(target) =>
                patch({
                  defaultSaveLocation:
                    target.scope === "org"
                      ? { scope: "org", orgId: target.orgId, folderId: target.folderId }
                      : { scope: "personal", folderId: null },
                })
              }
            />
            <p className="text-[11px] text-muted-foreground">{t("settings.account.defaultSave.desc")}</p>
            {!settings.syncEnabled && (
              <p className="text-[11px] text-warning-foreground">{t("settings.account.defaultSave.syncOffHint")}</p>
            )}
          </div>
        </Field>
      )}
      {cloudAuth && <ApiKeysField />}
    </Section>
  );
}

/** Account sign-in field: the signed-in profile card, or the Google sign-in form. */
function AccountSignInField({
  cloudAuth,
  signingIn,
  signInAbort,
  onSignIn,
}: Readonly<{
  cloudAuth: CloudAuth | null;
  signingIn: boolean;
  signInAbort: React.RefObject<AbortController | null>;
  onSignIn: () => Promise<void>;
}>) {
  const { t } = useI18n();
  return (
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
            onClick={() => signOut().catch((error) => log.error("settings: sign-out failed", { error: String(error) }))}
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
              onClick={() => onSignIn().catch((error) => log.error("settings: sign-in failed", { error: String(error) }))}
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
  );
}

/** Each route's name, the same words onboarding's two cards use. */
const SETUP_MODE_LABEL: Record<SetupMode, TranslationKey> = {
  cloud: "onboarding.account.cloud.tag",
  local: "onboarding.account.local.tag",
};

/**
 * Switch the setup route after onboarding. It is the same change as picking a
 * card there: Cloud puts transcription and AI on Parley's hosted models (and
 * needs a session — the hosted models ride it), Local moves anything hosted
 * off Parley to the user's own providers (see localRoutePatch). The MCP
 * connection Parley hands out follows it.
 */
function SetupModeField({
  settings,
  patch,
  signedIn,
}: Readonly<SettingsPanelProps & { signedIn: boolean }>) {
  const { t } = useI18n();
  const mode = settings.setupMode;
  const choose = (next: SetupMode) => {
    if (next === mode) return;
    patch(next === "cloud" ? cloudRoutePatch() : localRoutePatch(settings));
  };
  return (
    <Field label={t("settings.account.setup.title")}>
      <div className="flex max-w-md flex-col gap-1.5">
        <div
          role="radiogroup"
          aria-label={t("settings.account.setup.title")}
          className="grid grid-cols-2 overflow-hidden rounded-md border"
        >
          {(["cloud", "local"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              // Cloud can't be picked signed out; a cloud setup that has since
              // signed out still shows as selected until it is switched.
              disabled={m === "cloud" && !signedIn && mode !== "cloud"}
              onClick={() => choose(m)}
              className={`cursor-pointer py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                mode === m ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {t(SETUP_MODE_LABEL[m])}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">{t("settings.account.setup.desc")}</p>
        {!signedIn && <p className="text-[11px] text-muted-foreground">{t("settings.account.setup.signInFirst")}</p>}
      </div>
    </Field>
  );
}
