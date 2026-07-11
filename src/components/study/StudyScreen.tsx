import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useStore, isTrimmed, meetingBriefText } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { generatePostMeetingReport } from "../../lib/ai/report";
import { runIntelExtraction } from "../../lib/intel/extract";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import type { MeetingType } from "../../lib/types";
import { ReplayScreen } from "../replay/ReplayScreen";
import { ReportContent } from "../sidebar/ReportContent";
import { DeliveryPanel } from "../delivery/DeliveryPanel";
import { IntelSections } from "../live/IntelligenceBoard";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TYPES: MeetingType[] = ["general", "negotiation", "sales", "partnership"];

/**
 * The STUDY tense: a loaded recording, viewed through four output pages
 * (titlebar-center tabs) — the brief, the intelligence board's final state,
 * the full transcript/player, and the delivery scorecard.
 */
export function StudyScreen() {
  const tab = useStore((s) => s.studyTab);
  switch (tab) {
    case "brief":
      return <BriefPage />;
    case "intel":
      return <IntelPage />;
    case "delivery":
      return (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-2xl px-6 py-5">
            <DeliveryPanel mode="replay" />
          </div>
        </ScrollArea>
      );
    default:
      return <ReplayScreen />;
  }
}

/** 重點: the auto-generated debrief (summary/commitments/next steps). */
function BriefPage() {
  const { t } = useI18n();
  const [report, setReport] = useState("");
  const [status, setStatus] = useState<"idle" | "generating" | "done">("idle");
  const keyMissing = useStore((s) => !hasProviderKey(s.settings));
  const started = useRef(false);

  async function generate() {
    const s = useStore.getState();
    setReport("");
    setStatus("generating");
    try {
      await generatePostMeetingReport({
        settings: s.settings,
        segments: s.segments.filter((seg) => !isTrimmed(seg, s.replayTrim)),
        evaluations: s.evaluations,
        todos: [],
        names: s.speakerNames,
        meetingContext: meetingBriefText(s),
        onDelta: (chunk) => setReport((prev) => prev + chunk),
      });
    } catch (e) {
      log.error("study: brief generation failed", { error: String(e) });
    } finally {
      setStatus("done");
    }
  }

  // The brief is the study tense's landing page — generate on first visit.
  useEffect(() => {
    if (started.current || keyMissing) return;
    started.current = true;
    void generate();
  }, [keyMissing]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-2xl px-6 py-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("study.brief")}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={status === "generating" || keyMissing}
            onClick={() => void generate()}
          >
            {status === "generating" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {report ? t("study.brief.regenerate") : t("study.brief.generate")}
          </Button>
        </div>
        {keyMissing && (
          <p className="text-sm text-muted-foreground">{t("study.brief.missingKey")}</p>
        )}
        {status === "generating" && !report && (
          <p className="text-sm text-muted-foreground">{t("study.brief.generating")}</p>
        )}
        {report && <ReportContent markdown={report} />}
      </div>
    </ScrollArea>
  );
}

/** 情報: the intelligence board run over the full recording. */
function IntelPage() {
  const { t } = useI18n();
  const meetingType = useStore((s) => s.settings.meetingType);
  const updateSettings = useStore((s) => s.updateSettings);
  const intel = useStore((s) => s.intel);
  const intelStatus = useStore((s) => s.intelStatus);
  const running = intelStatus === "running";

  // One extraction on entry (and on type switch) — a recording is static, so
  // no interval here, just the manual refresh.
  useEffect(() => {
    if (meetingType === "general") return;
    if (intel?.meetingType === meetingType) return;
    runIntelExtraction(meetingType).catch((e) =>
      log.warn("study: intel run failed", { error: String(e) })
    );
  }, [meetingType, intel?.meetingType]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-4xl px-6 py-5">
        <div className="mb-3 flex items-center gap-2">
          <Select
            value={meetingType}
            onValueChange={(v) => updateSettings({ meetingType: v as MeetingType })}
          >
            <SelectTrigger className="h-7 w-52 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((v) => (
                <SelectItem key={v} value={v}>
                  {t(`board.type.${v}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {meetingType !== "general" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              disabled={running}
              title={t("board.refresh")}
              onClick={() => void runIntelExtraction(meetingType)}
            >
              {running ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            </Button>
          )}
        </div>
        {meetingType === "general" ? (
          <p className="text-sm text-muted-foreground">{t("board.empty")}</p>
        ) : (
          <>
            {!intel && (
              <p className="text-sm text-muted-foreground">
                {running ? t("board.extracting") : t("board.empty")}
              </p>
            )}
            {intel?.meetingType === meetingType && (
              /* Bento: each section becomes a card, flowing into two masonry
                 columns on wide screens — the narrow-rail components read
                 terribly stretched across a full-width single column. */
              <div className="columns-1 gap-4 lg:columns-2 [&>div]:mb-4 [&>div]:break-inside-avoid [&>div]:rounded-xl [&>div]:border [&>div]:bg-background/60 [&>div]:p-3.5">
                <IntelSections />
              </div>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}
