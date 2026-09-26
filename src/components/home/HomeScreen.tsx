import { ArrowRight, ClipboardList, FileAudio, Import, Keyboard, Mic, X } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_GETTING_STARTED, useStore } from "../../lib/store";
import { loadHistoryEntry } from "../../lib/history/history";
import { startImportFlow } from "../../lib/replay/ingest";
import { beginMeeting } from "../../lib/meeting/start";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import type { LibraryTree } from "../shell/useLibraryTree";
import { GettingStarted, openSampleRecording } from "./GettingStarted";
import {
  GETTING_STARTED_STEPS,
  isGettingStartedVisible,
  useHint,
} from "../../lib/onboarding/gettingStarted";
import { shortcutCaps } from "../../lib/voiceTyping/caps";

/**
 * The idle landing (R8c). Before this, idle showed the live cockpit with three
 * empty columns — a screen for a meeting that wasn't happening — while all
 * browsing weight fell on the 240px tree. Home flips that: the cockpit exists
 * only while a meeting runs; idle surfaces what the user actually acts on next
 * (start / recent recordings / import).
 */
export function HomeScreen({ tree }: Readonly<{ tree: LibraryTree }>) {
  const { t, language } = useI18n();
  const userName = useStore((s) => s.settings.userName);
  const openLibrary = useStore((s) => s.openLibrary);
  const gettingStarted = useStore((s) => s.settings.gettingStarted) ?? DEFAULT_GETTING_STARTED;
  const voiceTypingEnabled = useStore((s) => s.settings.voiceTypingEnabled);
  const voiceTypingShortcut = useStore((s) => s.settings.voiceTypingShortcut);
  const [voiceHintVisible, dismissVoiceHint] = useHint("home.voiceTyping");
  const showChecklist = isGettingStartedVisible(gettingStarted);
  // The lap is done: point at the other half of Parley, once.
  const showVoiceTyping =
    voiceHintVisible &&
    voiceTypingEnabled &&
    GETTING_STARTED_STEPS.every((step) => gettingStarted[step]);

  const folderName = (id: string | null | undefined) =>
    id ? tree.personalFolders.find((f) => f.id === id)?.name : undefined;
  const recent = tree.summaries.slice(0, 6);
  const locale = language === "en" ? "en-US" : "zh-TW";

  // Staged entrance: sections land in reading order (start → recent), then the
  // recent rows cascade. Delays are inline so the sequence stays put
  // when a section is conditionally absent.
  const delay = (ms: number) => ({ animationDelay: `${ms}ms` });

  const openSample = () => {
    void openSampleRecording(t).catch((e) => {
      log.error("home: sample failed", { error: String(e) });
      toast.error(String(e instanceof Error ? e.message : e));
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-10">
        {/* ── Start ─────────────────────────────────────────────────────── */}
        <section className="animate-fade-up flex flex-col gap-3">
          <h1 className="text-2xl font-bold tracking-tight">
            {userName ? t("home.greetingNamed", { name: userName }) : t("home.greeting")}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="h-9"
              onClick={() =>
                beginMeeting().catch((e) => {
                  log.error("home: start failed", { error: String(e) });
                  toast.error(String(e instanceof Error ? e.message : e));
                })
              }
            >
              <Mic className="size-4" />
              {t("titlebar.startMeeting")}
            </Button>
            <Button
              variant="outline"
              className="h-9"
              onClick={() =>
                startImportFlow().catch((e) => {
                  log.error("home: import failed", { error: String(e) });
                  toast.error(String(e instanceof Error ? e.message : e));
                })
              }
            >
              <Import className="size-4" />
              {t("home.import")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("home.dropHint")}</p>
        </section>

        {/* ── Getting started (first lap) ─────────────────────────────────── */}
        {showChecklist && (
          <GettingStarted
            state={gettingStarted}
            latestId={tree.summaries[0]?.id ?? null}
            style={delay(90)}
          />
        )}
        {showVoiceTyping && (
          <p
            className="animate-fade-up flex items-center gap-2 text-xs text-muted-foreground"
            style={delay(90)}
          >
            <Keyboard className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {t("home.voiceTypingBanner", {
                shortcut: shortcutCaps(voiceTypingShortcut, t),
              })}
            </span>
            <button
              type="button"
              aria-label={t("common.dismiss")}
              title={t("common.dismiss")}
              onClick={dismissVoiceHint}
              className="grid size-5 shrink-0 cursor-pointer place-items-center rounded hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </p>
        )}

        {/* ── Recent recordings ───────────────────────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <div className="animate-fade-up flex items-center gap-2" style={delay(180)}>
            <h2 className="text-xs font-semibold text-muted-foreground">
              {t("home.recent")}
            </h2>
            {/* Six is a shortcut, not a browser (#330) — this is the way out of it. */}
            {tree.summaries.length > recent.length && (
              <button
                type="button"
                onClick={() => openLibrary({ kind: "personal", node: { kind: "all" } })}
                className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded px-1 text-xs text-primary transition-colors hover:text-primary/80"
              >
                {t("home.viewAll")}
                <ArrowRight className="size-3" />
              </button>
            )}
          </div>
          {recent.length === 0 && (
            <div
              className="animate-fade-up flex flex-col items-center gap-2 rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground"
              style={delay(220)}
            >
              <p>{t("home.emptyRecordings")}</p>
              {/* The checklist already offers the sample — don't say it twice. */}
              {!showChecklist && (
                <Button variant="ghost" size="sm" onClick={openSample}>
                  {t("home.gs.useSample")}
                </Button>
              )}
            </div>
          )}
          {/* One list, rows split by hairlines — no box around each recording. */}
          {recent.length > 0 && (
            <div className="flex flex-col divide-y divide-border">
              {recent.map((e, i) => {
                const folder = folderName(e.folderId);
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() =>
                      void loadHistoryEntry(e.id).catch((err) => {
                        log.error("home: open recording failed", { id: e.id, error: String(err) });
                        toast.error(String(err instanceof Error ? err.message : err));
                      })
                    }
                    className="animate-fade-up flex cursor-pointer items-center gap-2.5 rounded-none px-2 py-2.5 text-left transition-colors hover:bg-muted/60"
                    style={delay(220 + i * 40)}
                  >
                    <FileAudio className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{e.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {new Date(e.createdAt).toLocaleDateString(locale, {
                          month: "short",
                          day: "numeric",
                        })}
                        {folder ? ` · ${folder}` : ""}
                        {e.snippet ? ` · ${e.snippet}` : ""}
                      </span>
                    </span>
                    {(e.actionItemsCount ?? 0) > 0 && (
                      <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
                        <ClipboardList className="size-3.5" />
                        {e.actionItemsCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
