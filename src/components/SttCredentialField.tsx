import type { ComponentType, ReactNode } from "react";
import { PasswordInput } from "@/components/ui/password-input";
import type { SttProviderInfo } from "../lib/transcription/registry";
import type { Settings } from "../lib/types";

/**
 * The credential half of a transcription-provider picker, chosen by the
 * registry's `credential` capability rather than by provider id. Shared by
 * Settings › Transcription and the onboarding account step, which differ only
 * in the surrounding markup — each passes its own:
 *
 * - `cloudSession` (hosted Parley): `cloudSessionNote`, a line saying whose
 *   account it runs on — there is no key field;
 * - `localModel` (on-device): `localModelPicker`, the model picker;
 * - `apiKey` (BYOK): the key input bound to the provider's settings field,
 *   optionally wrapped in `KeyInputWrapper` (Settings puts it under a
 *   labelled field).
 */
export function SttCredentialField({
  info,
  settings,
  patch,
  cloudSessionNote,
  localModelPicker,
  KeyInputWrapper,
  keyInputClassName,
}: Readonly<{
  info: SttProviderInfo;
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  cloudSessionNote: ReactNode;
  localModelPicker: ReactNode;
  KeyInputWrapper?: ComponentType<{ info: SttProviderInfo; children: ReactNode }>;
  keyInputClassName?: string;
}>) {
  if (info.credential === "cloudSession") return <>{cloudSessionNote}</>;
  if (info.credential === "localModel") return <>{localModelPicker}</>;
  const field = info.apiKeyField;
  if (!field) return null;
  const input = (
    <PasswordInput
      autoComplete="off"
      placeholder={info.keyPlaceholder}
      className={keyInputClassName}
      value={(settings[field] as string) ?? ""}
      onChange={(e) => patch({ [field]: e.target.value } as Partial<Settings>)}
    />
  );
  return KeyInputWrapper ? <KeyInputWrapper info={info}>{input}</KeyInputWrapper> : input;
}
