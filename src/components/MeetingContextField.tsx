import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Per-meeting context + principled-negotiation setup, bound to the store. Shown
 * right before an analysis runs (ingest wizard, re-analyze dialog, live context
 * button). The free-text context plus BATNA / target / bottom line all feed the
 * prompts — the latter three let the analysis reason about leverage, the ZOPA,
 * and how close you are to walking away. Per-deal, NOT the global Settings profile.
 */
export function MeetingContextField({
  rows = 3,
  autoFocus = false,
}: Readonly<{ rows?: number; autoFocus?: boolean }>) {
  const { t } = useI18n();
  const meetingContext = useStore((s) => s.meetingContext);
  const setMeetingContext = useStore((s) => s.setMeetingContext);
  const batna = useStore((s) => s.meetingBatna);
  const target = useStore((s) => s.meetingTarget);
  const floor = useStore((s) => s.meetingFloor);
  const setField = useStore((s) => s.setNegotiationField);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium">{t("analyze.contextLabel")}</Label>
        <Textarea
          rows={rows}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          value={meetingContext}
          onChange={(e) => setMeetingContext(e.target.value)}
          placeholder={t("meeting.contextPlaceholder")}
          className="max-h-48 overflow-y-auto resize-none text-xs"
        />
      </div>
      <div className="flex flex-col gap-2">
        <SetupField label={t("analyze.batnaLabel")} value={batna} placeholder={t("analyze.batnaPlaceholder")} onChange={(v) => setField("meetingBatna", v)} />
        <SetupField label={t("analyze.targetLabel")} value={target} placeholder={t("analyze.targetPlaceholder")} onChange={(v) => setField("meetingTarget", v)} />
        <SetupField label={t("analyze.floorLabel")} value={floor} placeholder={t("analyze.floorPlaceholder")} onChange={(v) => setField("meetingFloor", v)} />
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{t("analyze.contextHint")}</p>
    </div>
  );
}

function SetupField({
  label,
  value,
  placeholder,
  onChange,
}: Readonly<{
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}>) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-7 text-xs" />
    </div>
  );
}
