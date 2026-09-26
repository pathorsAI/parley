import { useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, Copy } from "lucide-react";
import {
  transcriptAsText,
  transcriptPlainText,
  transcriptWithTimestamps,
} from "../lib/store";
import type { TranscriptSegment } from "../lib/types";
import { useHint } from "../lib/onboarding/gettingStarted";
import { useHandoff } from "../lib/onboarding/useHandoff";
import { useI18n } from "../i18n";
import { cn } from "@/lib/utils";

/**
 * Copy-transcript control: a small dropdown. First, the hand-off: the transcript
 * wrapped in an analysis prompt with ready-made questions, to paste into
 * ChatGPT or Claude. Then three plain-text formats so the user can grab the
 * transcript in whatever shape they need —
 *   • plain text (just what was said),
 *   • with speaker labels (the default), or
 *   • with speaker labels + [m:ss] timestamps.
 * The trigger flashes a check + "copied" for ~2s after any variant is copied.
 */
export function TranscriptCopyMenu({
  segments,
  speakerNames,
  disabled,
}: Readonly<{
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
  disabled?: boolean;
}>) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handoff = useHandoff();
  // One-time explainer above the hand-off item: shown the first time the menu
  // opens, retired when that menu closes.
  const [hintVisible, dismissHint] = useHint("copy.handoff");

  function flashCopied() {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      flashCopied();
    } catch (e) {
      console.error("copy transcript failed", e);
    }
  }

  async function copyHandoff() {
    if (await handoff.copyPrompt()) flashCopied();
  }

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open && hintVisible) dismissHint();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors",
            "hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          )}
        >
          {copied ? <Check className="size-3 text-success-foreground" /> : <Copy className="size-3" />}
          {copied ? t("transcript.copied") : t("transcript.copy")}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[80] min-w-[200px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {hintVisible && (
            <p className="max-w-[240px] px-2 pb-1.5 pt-1 text-[11px] leading-snug text-muted-foreground">
              {t("transcript.copyHandoffExplainer")}
            </p>
          )}
          <Item
            label={t("transcript.copyHandoff")}
            hint={t("transcript.copyHandoffHint")}
            disabled={!handoff.canCopy}
            onSelect={() => void copyHandoff()}
          />
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <Item
            label={t("transcript.copyWithSpeaker")}
            hint={t("transcript.copyWithSpeakerHint")}
            onSelect={() => copy(transcriptAsText(segments, speakerNames))}
          />
          <Item
            label={t("transcript.copyPlain")}
            hint={t("transcript.copyPlainHint")}
            onSelect={() => copy(transcriptPlainText(segments))}
          />
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <Item
            label={t("transcript.copyWithTime")}
            hint={t("transcript.copyWithTimeHint")}
            onSelect={() => copy(transcriptWithTimestamps(segments, speakerNames))}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Item({
  label,
  hint,
  disabled,
  onSelect,
}: Readonly<{
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}>) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs outline-none",
        "data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {hint && <span className="truncate text-[10px] text-muted-foreground">{hint}</span>}
      </span>
    </DropdownMenu.Item>
  );
}
