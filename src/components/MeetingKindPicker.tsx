import { useStore } from "../lib/store";
import { MEETING_KINDS } from "../lib/analysis/lens";
import { chooseMeetingKind } from "../lib/analysis/kindTemplate";
import { useI18n } from "../i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MeetingKind } from "../lib/types";

/**
 * The ONE control for "what kind of meeting was this" — which picks both the
 * analysis lens (what the findings and brief look like) and the watcher set.
 *
 * It used to be a template picker that only changed the watchers, which is why
 * a design review filed under 通用 still came back scored like a negotiation:
 * the output shape wasn't on the menu at all.
 */
export function MeetingKindPicker({
  className = "",
  size = "sm",
}: Readonly<{ className?: string; size?: "sm" | "default" }>) {
  const { t } = useI18n();
  const kind = useStore((s) => s.meetingKind);
  const analysisStatus = useStore((s) => s.analysisStatus);
  // Nothing is pinned yet and the pass that would pin it is still running: say
  // so, rather than showing an empty box the user is tempted to fill in and
  // then have overwritten a second later.
  const detecting = kind === null && analysisStatus === "running";

  return (
    <Select value={kind ?? ""} onValueChange={(v) => chooseMeetingKind(v as MeetingKind)}>
      <SelectTrigger
        size={size}
        aria-label={t("meetingKind.label")}
        className={`text-[11px] ${className}`}
      >
        <SelectValue placeholder={detecting ? t("meetingKind.detecting") : t("meetingKind.label")} />
      </SelectTrigger>
      <SelectContent>
        {MEETING_KINDS.map((k) => (
          <SelectItem key={k} value={k}>
            <span className="flex flex-col items-start gap-0.5">
              <span>{t(`meetingKind.${k}`)}</span>
              <span className="text-[10px] text-muted-foreground">{t(`meetingKind.${k}.hint`)}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
