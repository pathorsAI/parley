import { Swords } from "lucide-react";
import { useStore } from "../../lib/store";
import { runWargameDetect } from "../../lib/wargame/engine";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WargameCard } from "./WargameCard";

/**
 * War-game tab: one button auto-detects THEM's key arguments from the transcript
 * and renders a card per argument (premises, the premise NOT to concede, and
 * multiple response angles), each branch war-gameable on demand.
 *
 * Detection state lives in the store (see lib/wargame/engine), so it can also be
 * triggered by the replay "re-evaluate at this moment" button. This panel is just
 * a view of that state.
 */
export function WargamePanel() {
  const { t } = useI18n();
  const segmentCount = useStore((s) => s.segments.length);
  const args = useStore((s) => s.wargameArgs);
  const status = useStore((s) => s.wargameStatus);
  const message = useStore((s) => s.wargameMessage);

  const busy = status === "running";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b p-2.5">
        <Button onClick={() => void runWargameDetect()} disabled={busy} size="sm" className="gap-1.5">
          <Swords className="size-3.5" />
          {busy ? t("wargame.detecting") : args.length > 0 ? t("wargame.redetect") : t("wargame.detect")}
        </Button>
        <span className="text-[10px] text-muted-foreground">
          {t("ask.contextCount", { count: segmentCount })}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-3 py-3">
          {args.length === 0 && !busy && (
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
