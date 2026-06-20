import { useState } from "react";
import { Swords } from "lucide-react";
import { useStore, visibleSegments } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WargameCard } from "./WargameCard";
import type { WargameArgument } from "../../lib/types";

type Phase = "idle" | "loading" | "done" | "error";

/**
 * War-game tab: one button auto-detects THEM's key arguments from the transcript
 * and renders a card per argument (premises, the premise NOT to concede, and
 * multiple response angles), each branch war-gameable on demand.
 */
export function WargamePanel() {
  const { t } = useI18n();
  const segmentCount = useStore((s) => s.segments.length);
  const [phase, setPhase] = useState<Phase>("idle");
  const [args, setArgs] = useState<WargameArgument[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function detect() {
    if (phase === "loading") return;
    const state = useStore.getState();
    const { settings, speakerNames, meetingContext } = state;
    // Replay-aware: in replay mode only analyze what was said up to the playhead.
    const segments = visibleSegments(state);

    if (!hasProviderKey(settings)) {
      setPhase("error");
      setMessage(t("wargame.missingKey"));
      return;
    }
    if (segments.filter((s) => s.isFinal && s.text.trim()).length === 0) {
      setPhase("error");
      setMessage(t("wargame.noTranscript"));
      return;
    }

    setPhase("loading");
    setMessage(null);
    try {
      const { detectArguments } = await import("../../lib/ai/wargame");
      const detected = await detectArguments({
        settings,
        segments,
        names: speakerNames,
        meetingContext,
      });
      setArgs(detected);
      if (detected.length === 0) {
        setPhase("done");
        setMessage(t("wargame.none"));
      } else {
        setPhase("done");
        setMessage(null);
      }
    } catch (err) {
      setPhase("error");
      setMessage(t("wargame.failed", { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  const busy = phase === "loading";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b p-2.5">
        <Button onClick={() => void detect()} disabled={busy} size="sm" className="gap-1.5">
          <Swords className="size-3.5" />
          {busy ? t("wargame.detecting") : args.length > 0 ? t("wargame.redetect") : t("wargame.detect")}
        </Button>
        <span className="text-[10px] text-muted-foreground">
          {t("ask.contextCount", { count: segmentCount })}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-3 py-3">
          {args.length === 0 && phase !== "loading" && (
            <p className="px-1 pt-4 text-center text-xs text-muted-foreground">
              {message ?? t("wargame.intro")}
            </p>
          )}

          {message && args.length > 0 && (
            <p className="px-1 text-xs text-muted-foreground">{message}</p>
          )}

          {busy && args.length === 0 && (
            <p className="px-1 pt-4 text-center text-xs text-muted-foreground">{t("wargame.detecting")}</p>
          )}

          {args.map((a) => (
            <WargameCard key={a.id} argument={a} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
