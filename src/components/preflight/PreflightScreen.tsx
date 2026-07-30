import { useRef, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { Loader2, Mic } from "lucide-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { useStore } from "../../lib/store";
import { beginMeeting } from "../../lib/meeting/start";
import { STT_BY_ID } from "../../lib/transcription/providers";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { SubjectPanel } from "./SubjectPanel";
import { ReviewPanel } from "./ReviewPanel";
import { PrepCopilot } from "./PrepCopilot";

/**
 * 會前 — the room you pass through on the way into a meeting.
 *
 * Three columns on ONE scroll each, not a next/next wizard: an experienced user
 * can land here and hit 開始 immediately, while everything that used to be
 * scattered across a titlebar chip, a two-level dialog and the accounts
 * workspace is now in front of them at the moment it matters. "Record now"
 * stays permanently available for the calls that start without warning.
 */
export function PreflightScreen() {
  const { t } = useI18n();
  const provider = useStore((s) => s.settings.transcriptionProvider);
  const inputDevice = useStore((s) => s.settings.inputDevice);
  const translateEnabled = useStore((s) => s.settings.meetingTranslateEnabled);
  const translateLanguage = useStore((s) => s.settings.translateTargetLanguage);
  const companyId = useStore((s) => s.meetingCompanyId);
  const hasContext = useStore((s) => !!s.meetingContext.trim());
  const hasAgenda = useStore((s) => s.todos.length > 0);
  // The escape hatch only means something while the screen is still blank —
  // once there IS a setup, "skip" would just be a second Start button.
  const untouched = !companyId && !hasContext && !hasAgenda;

  // Same re-entrancy shape as the titlebar's recorder cluster: the ref blocks
  // synchronously (before any re-render) so a double-click can't race two
  // transcription sessions open; `busy` just disables the button.
  const startingRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const saved = useDefaultLayout({
    id: "parley:preflight",
    panelIds: ["subject", "review", "prep"],
    storage: window.localStorage,
  });

  async function start() {
    if (startingRef.current) return;
    startingRef.current = true;
    setBusy(true);
    try {
      await beginMeeting();
    } catch (e) {
      log.error("preflight: start failed", { error: String(e) });
    } finally {
      startingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={saved.defaultLayout}
        onLayoutChanged={saved.onLayoutChanged}
      >
        <ResizablePanel id="subject" defaultSize={30} minSize="280px">
          <SubjectPanel />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="review" defaultSize={40} minSize="300px">
          <ReviewPanel />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="prep" defaultSize={30} minSize="300px">
          <PrepCopilot />
        </ResizablePanel>
      </ResizablePanelGroup>

      <div className="flex shrink-0 items-center gap-3 border-t px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Mic className="size-3 shrink-0" />
          <span className="truncate">
            {inputDevice || t("preflight.defaultMic")} · {STT_BY_ID[provider].label}
            {translateEnabled ? ` · ${translateLanguage.toUpperCase()}` : ""}
          </span>
        </span>
        <span className="flex-1" />
        {untouched && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-muted-foreground"
            disabled={busy}
            onClick={() => void start()}
            title={t("preflight.skipHint")}
          >
            {t("preflight.skip")}
          </Button>
        )}
        <Button size="sm" className="h-8" disabled={busy} onClick={() => void start()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Mic className="size-3.5" />}
          {companyId ? t("preflight.startLinked") : t("titlebar.startMeeting")}
        </Button>
      </div>
    </div>
  );
}
