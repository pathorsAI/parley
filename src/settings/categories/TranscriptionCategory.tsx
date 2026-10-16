import { useCallback, useEffect, useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { log } from "../../lib/log";
import { isTauri } from "../../lib/tauriEvents";
import { isProviderListed } from "../../lib/providerListing";
import { STT_PROVIDERS, STT_BY_ID, sttLabel } from "../../lib/transcription/providers";
import { useLocalSttModels } from "../../lib/transcription/useLocalSttModels";
import type { SttProviderInfo } from "../../lib/transcription/registry";
import type { Settings, SttProviderId } from "../../lib/types";
import * as ipc from "../../lib/ipc/commands";
import { DIARIZE_PROGRESS_EVENT, listenEvent } from "../../lib/ipc/events";
import { LevelMeter } from "../../components/LevelMeter";
import { LocalSttModelPicker } from "../../components/LocalSttModelPicker";
import { SttCredentialField } from "../../components/SttCredentialField";
import { useI18n, type TranslationKey } from "../../i18n";
import { Field, Section } from "../fields";
import type { ProviderListing, SettingsPanelProps } from "./types";

/** Settings › Transcription: STT provider + credential, speaker model,
 *  microphone (with a live test) and the delivery-coaching toggles. */
export function TranscriptionCategory({
  settings,
  patch,
  listing,
  cloudEmail,
  devices,
  recording,
  testing,
  onToggleTest,
}: Readonly<
  SettingsPanelProps & {
    listing: ProviderListing;
    cloudEmail: string;
    devices: string[];
    recording: boolean;
    testing: boolean;
    onToggleTest: () => Promise<void>;
  }
>) {
  const { t } = useI18n();
  const sttInfo = STT_BY_ID[settings.transcriptionProvider];
  return (
    <Section title={t("settings.transcription.title")}>
      <Field label={t("settings.transcription.provider")}>
        <Select
          value={settings.transcriptionProvider}
          onValueChange={(v) => patch({ transcriptionProvider: v as SttProviderId })}
        >
          <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STT_PROVIDERS.filter(
              // Hosted "parley" STT only exists in the cloud build and only
              // when signed in (the session token IS the credential).
              (p) => isProviderListed(p, listing),
            ).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex items-center gap-2">
                  <img src={p.icon} alt="" className="size-4 rounded-sm" />
                  {sttLabel(t, p)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {/* A cloud-session provider (hosted "parley") authenticates with the
          session token, not a user-entered key — show whose account it
          bills to instead. The on-device provider has no key at all: pick
          (and download) a model. */}
      <SttCredentialField
        info={sttInfo}
        settings={settings}
        patch={patch}
        cloudSessionNote={
          <p className="max-w-md text-[11px] text-muted-foreground">
            {t("settings.account.useParley.note", { email: cloudEmail })}
          </p>
        }
        localModelPicker={
          <Field label={t("localStt.picker.label")}>
            <LocalSttModelField
              value={settings.localSttModel}
              chosen={settings.localSttModelChosen}
              onChange={(id) => patch({ localSttModel: id, localSttModelChosen: true })}
              onAutoSelect={(id) => patch({ localSttModel: id })}
            />
          </Field>
        }
        KeyInputWrapper={SttKeyInputField}
        keyInputClassName="max-w-sm"
      />
      {!sttInfo.diarization && (
        <p className="max-w-md rounded-md border border-warning-border bg-warning px-3 py-2 text-[11px] leading-relaxed text-warning-foreground">
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
                await ipc.stopMicTest().catch((error) =>
                  log.warn("settings: stop mic test before device switch failed", {
                    error: String(error),
                  }),
                );
                await ipc.startMicTest({ inputDevice: dev }).catch((error) =>
                  log.warn("settings: restart mic test after device switch failed", {
                    inputDevice: dev,
                    error: String(error),
                  }),
                );
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
              onClick={onToggleTest}
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
          {/* Mic troubleshooting lives with the mic field, not as a
              section-wide footnote. */}
          <p className="text-[11px] text-muted-foreground">
            {t("settings.transcription.help")}
          </p>
        </div>
      </Field>

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
    </Section>
  );
}

/** The on-device model picker, owning its catalog/download state — mounted
 *  only while "local" is the selected provider. */
function LocalSttModelField({
  value,
  chosen,
  onChange,
  onAutoSelect,
}: Readonly<{
  value: string;
  chosen: boolean;
  onChange: (id: string) => void;
  onAutoSelect: (id: string) => void;
}>) {
  const local = useLocalSttModels();
  return (
    <div className="max-w-md">
      <LocalSttModelPicker
        value={value}
        onChange={onChange}
        local={local}
        chosen={chosen}
        onAutoSelect={onAutoSelect}
      />
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
    import("../../lib/speakers/diarize")
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
    listenEvent(DIARIZE_PROGRESS_EVENT, (e) => {
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
      const { prefetchDiarizeModel } = await import("../../lib/speakers/diarize");
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
        <span className="flex items-center gap-1.5 text-sm text-success-foreground">
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
              onClick={() => download().catch((error) => log.error("settings: update download failed", { error: String(error) }))}
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
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
          {error && (
            <p className="rounded-md bg-danger px-2.5 py-1.5 text-[11px] text-danger-foreground">
              {t("settings.transcription.speakerModelFailed", { error })}
            </p>
          )}
        </>
      )}
      <p className="text-[11px] text-muted-foreground">{t("settings.transcription.speakerModelHelp")}</p>
    </div>
  );
}

/** Settings › Transcription's labelled frame around a BYOK provider's key input. */
function SttKeyInputField({ info, children }: Readonly<{ info: SttProviderInfo; children: React.ReactNode }>) {
  const { t } = useI18n();
  return <Field label={t("settings.transcription.apiKey", { provider: info.label })}>{children}</Field>;
}
