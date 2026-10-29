import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Per-meeting context, bound to the store. Shown wherever a meeting is set up
 * (meeting draft, meeting window, ingest wizard, re-analyze dialog). One
 * free-text field: a BATNA, target or bottom line is written into it like any
 * other background. Per-deal, NOT the global Settings profile.
 *
 * The separate BATNA / target / bottom-line fields are gone from new setups;
 * they still show — and still feed the prompts — on a meeting that already
 * has one filled in, so that value stays visible and editable.
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
  const legacyNegotiation = !!(batna.trim() || target.trim() || floor.trim());
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
      {legacyNegotiation && (
      <div className="flex flex-col gap-2">
        <SetupField label={t("analyze.batnaLabel")} value={batna} placeholder={t("analyze.batnaPlaceholder")} onChange={(v) => setField("meetingBatna", v)} />
        <SetupField label={t("analyze.targetLabel")} value={target} placeholder={t("analyze.targetPlaceholder")} onChange={(v) => setField("meetingTarget", v)} />
        <SetupField label={t("analyze.floorLabel")} value={floor} placeholder={t("analyze.floorPlaceholder")} onChange={(v) => setField("meetingFloor", v)} />
      </div>
      )}
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
