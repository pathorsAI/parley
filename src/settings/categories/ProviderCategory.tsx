import { useEffect, useState } from "react";
import { Loader2, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PROVIDERS, PROVIDER_BY_ID, isReasoningModel, type ProviderTagTone } from "../../lib/ai/providers";
import { missingProviderRequirement } from "../../lib/ai/settings";
import { runConnectionTest, type ConnectionTestResult } from "../../lib/ai/connectionTest";
import { isProviderListed } from "../../lib/providerListing";
import type { LlmProvider, LlmWorkload, ReasoningEffort, Settings } from "../../lib/types";
import { useI18n } from "../../i18n";
import { Field, Section } from "../fields";
import type { Patch, ProviderListing, SettingsPanelProps } from "./types";

/** Tailwind classes for each provider tag tone (status tokens adapt to light/dark). */
const PROVIDER_TAG_TONES: Record<ProviderTagTone, string> = {
  smart: "bg-primary/10 text-primary",
  fast: "bg-warning text-warning-foreground",
  local: "bg-success text-success-foreground",
  value: "bg-info text-info-foreground",
  default: "bg-muted text-muted-foreground",
};

/** Settings › Provider: one card per LLM lane — provider, key, model. */
export function ProviderCategory({
  settings,
  patch,
  listing,
  cloudEmail,
}: Readonly<SettingsPanelProps & { listing: ProviderListing; cloudEmail: string }>) {
  const { t } = useI18n();
  return (
    <Section title={t("settings.provider.title")}>
      <p className="-mt-1 max-w-md text-[11px] text-muted-foreground">
        {t("settings.provider.workloadsIntro")}
      </p>
      {WORKLOADS.map((wl) => {
        const prov = settings.llmProviders[wl];
        const winfo = PROVIDER_BY_ID[prov];
        return (
          <div key={wl} className="flex flex-col gap-3 rounded-lg border p-3">
            <div>
              <p className="text-xs font-semibold">{t(`settings.provider.workload.${wl}`)}</p>
              <p className="text-[11px] text-muted-foreground">
                {t(`settings.provider.workload.${wl}.hint`)}
              </p>
            </div>
            <Field label={t("settings.provider.provider")}>
              <Select
                value={prov}
                onValueChange={(v) =>
                  patch({ llmProviders: { ...settings.llmProviders, [wl]: v as LlmProvider } })
                }
              >
                <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.filter(
                    // The hosted "parley" provider only exists in the cloud build
                    // and only when signed in (auth IS the gate) — hide it in the
                    // OSS edition and when signed out.
                    (p) => isProviderListed(p, listing),
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
            {winfo.userSuppliedBaseUrl ? (
              // A self-hosted endpoint: URL first, then the optional key,
              // then a free-text model id — and a live connection test,
              // because three things can be wrong and none of them would
              // surface until the middle of a meeting otherwise.
              <CustomEndpointFields workload={wl} settings={settings} patch={patch} />
            ) : (
              <FixedEndpointFields
                workload={wl}
                settings={settings}
                patch={patch}
                cloudEmail={cloudEmail}
              />
            )}
          </div>
        );
      })}
    </Section>
  );
}

function patchModel(
  patch: Patch,
  settings: Settings,
  provider: LlmProvider,
  workload: LlmWorkload,
  value: string
) {
  patch({ models: { ...settings.models, [provider]: { ...settings.models[provider], [workload]: value } } });
}

/** The two LLM lanes, in display order (#131). */
const WORKLOADS = ["realtime", "deep"] as const;

/** Sentinel option that switches the picker into free-text "custom model" mode. */
const CUSTOM_MODEL = "__custom__";

function ModelSelect({
  provider,
  value,
  onChange,
}: Readonly<{
  provider: LlmProvider;
  value: string;
  onChange: (v: string) => void;
}>) {
  const { t } = useI18n();
  const presets = PROVIDER_BY_ID[provider].models;
  // A provider with no curated list (the self-hosted "custom" one) has nothing
  // to pick from — only its operator knows what the server serves — so it is
  // free text and stays free text.
  const freeTextOnly = presets.length === 0;
  // Custom (free-text) mode: on by default when the saved id isn't a listed
  // preset (e.g. a brand-new model the user typed in before).
  const [custom, setCustom] = useState(() => freeTextOnly || (!!value && !presets.includes(value)));
  // Re-infer when the provider changes (different presets + value).
  useEffect(() => {
    setCustom(freeTextOnly || (!!value && !presets.includes(value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  if (custom) {
    return (
      <div className="flex max-w-sm flex-col gap-1.5">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t(
            freeTextOnly
              ? "settings.provider.serverModelPlaceholder"
              : "settings.provider.customModelPlaceholder"
          )}
          className="font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        {!freeTextOnly && (
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
        )}
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

/**
 * Key + model fields for a provider whose endpoint is fixed by the registry —
 * every provider except the self-hosted one. The hosted "parley" provider is
 * the degenerate case: no key, no model picker, just who the usage bills to.
 */
function FixedEndpointFields({
  workload: wl,
  settings,
  patch,
  cloudEmail,
}: Readonly<{
  workload: LlmWorkload;
  settings: Settings;
  patch: Patch;
  cloudEmail: string;
}>) {
  const { t } = useI18n();
  const prov = settings.llmProviders[wl];
  const winfo = PROVIDER_BY_ID[prov];
  if (winfo.requiresAccount) {
    // Hosted provider: no key, no model picker — the server forces the real
    // model. Just confirm who the usage bills to.
    return (
      <p className="text-[11px] text-muted-foreground">
        {t("settings.account.useParley.note", { email: cloudEmail })}
      </p>
    );
  }
  return (
    <>
      <Field label={t("settings.provider.apiKey", { provider: winfo.label })}>
        <PasswordInput
          autoComplete="off"
          placeholder={winfo.requiresKey === false ? t("settings.provider.noKeyNeeded") : winfo.keyPlaceholder}
          className="max-w-sm"
          disabled={winfo.requiresKey === false}
          value={settings[winfo.apiKeyField]}
          onChange={(e) => patch({ [winfo.apiKeyField]: e.target.value } as Partial<Settings>)}
        />
      </Field>
      <Field label={t("settings.provider.model")}>
        <ModelSelect
          provider={prov}
          value={settings.models[prov][wl]}
          onChange={(v) => patchModel(patch, settings, prov, wl, v)}
        />
        {winfo.kind === "openai-compatible" && isReasoningModel(settings.models[prov][wl]) && (
          <ReasoningEffortSelect
            label={t("settings.provider.reasoning")}
            value={settings.reasoningEffort[wl]}
            onChange={(v) => patch({ reasoningEffort: { ...settings.reasoningEffort, [wl]: v } })}
          />
        )}
        <p className="text-[11px] text-muted-foreground">
          {t("settings.provider.models", {
            provider: winfo.label,
            suffix: winfo.kind === "anthropic" ? "" : t("settings.provider.slugSuffix"),
          })}
        </p>
      </Field>
    </>
  );
}

/**
 * Settings for a provider whose endpoint the user supplies (the "custom"
 * OpenAI-compatible provider): base URL, optional key, free-text model id, and
 * a one-shot connection test.
 *
 * The test matters more than it looks. Pointing Parley at a self-hosted model
 * means getting a URL, an optional key and a model id all right at once, and
 * every one of them fails the same way at runtime (`AI_APICallError`) — during
 * a meeting, which is the worst possible moment to debug a URL. One throwaway
 * completion here answers "does this work" before the meeting starts.
 *
 * Base URL and key are shared by both lanes (one endpoint, one credential), so
 * editing them in the realtime card also changes the deep card. The model id is
 * per-lane, like every other provider.
 */
function CustomEndpointFields({
  workload,
  settings,
  patch,
}: Readonly<{
  workload: LlmWorkload;
  settings: Settings;
  patch: Patch;
}>) {
  const { t } = useI18n();
  const provider = settings.llmProviders[workload];
  const info = PROVIDER_BY_ID[provider];
  const [probing, setProbing] = useState(false);
  const [outcome, setOutcome] = useState<ConnectionTestResult | null>(null);
  const missing = missingProviderRequirement(settings, workload);

  async function probe() {
    setProbing(true);
    setOutcome(null);
    try {
      setOutcome(await runConnectionTest(settings, workload));
    } finally {
      setProbing(false);
    }
  }

  return (
    <>
      <Field label={t("settings.provider.baseUrl")}>
        <Input
          value={settings.customBaseUrl}
          onChange={(e) => {
            setOutcome(null);
            patch({ customBaseUrl: e.target.value });
          }}
          placeholder="http://localhost:8000/v1"
          className="max-w-sm font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        {/* No `/v1` is appended for the user: gateways disagree about the
            prefix, and rewriting a URL they typed turns a 404 into a mystery. */}
        <p className="text-[11px] text-muted-foreground">{t("settings.provider.baseUrlHint")}</p>
      </Field>
      <Field label={t("settings.provider.apiKey", { provider: info.label })}>
        <PasswordInput
          autoComplete="off"
          placeholder={t("settings.provider.apiKeyOptional")}
          className="max-w-sm"
          value={settings.customApiKey}
          onChange={(e) => {
            setOutcome(null);
            patch({ customApiKey: e.target.value });
          }}
        />
      </Field>
      <Field label={t("settings.provider.model")}>
        <ModelSelect
          provider={provider}
          value={settings.models[provider][workload]}
          onChange={(v) => {
            setOutcome(null);
            patchModel(patch, settings, provider, workload, v);
          }}
        />
        {isReasoningModel(settings.models[provider][workload]) && (
          <ReasoningEffortSelect
            label={t("settings.provider.reasoning")}
            value={settings.reasoningEffort[workload]}
            onChange={(v) => patch({ reasoningEffort: { ...settings.reasoningEffort, [workload]: v } })}
          />
        )}
      </Field>
      <div className="flex flex-col gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-fit text-xs"
          disabled={probing || missing !== null}
          onClick={probe}
        >
          {probing ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
          {probing ? t("settings.provider.test.running") : t("settings.provider.test.run")}
        </Button>
        {missing !== null && (
          <p className="text-[11px] text-muted-foreground">{t("settings.provider.test.needsConfig")}</p>
        )}
        {outcome?.ok && (
          <p className="text-[11px] text-success-foreground">
            {t("settings.provider.test.ok", {
              model: outcome.model,
              ms: String(outcome.ms),
            })}
          </p>
        )}
        {outcome && !outcome.ok && (
          <p className="max-w-md text-[11px] leading-relaxed text-destructive">
            {t(outcome.error.key, outcome.error.vars)}
          </p>
        )}
      </div>
    </>
  );
}

function ReasoningEffortSelect({
  label,
  value,
  onChange,
}: Readonly<{
  label: string;
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
}>) {
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
