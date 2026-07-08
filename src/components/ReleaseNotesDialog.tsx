import { ExternalLink, Sparkles, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import type { ComponentPropsWithoutRef } from "react";
import remarkGfm from "remark-gfm";
import { useI18n } from "../i18n";
import type { ReleaseNotes } from "../lib/releaseNotes";
import { isTauri } from "../lib/tauriEvents";
import { log } from "../lib/log";
import { Button } from "@/components/ui/button";

interface ReleaseNotesDialogProps {
  notes: ReleaseNotes;
  onClose: () => void;
}

function openExternal(url: string) {
  if (isTauri()) {
    openUrl(url).catch((error) => log.warn("release-notes: open link failed", { error: String(error), url }));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function MarkdownLink({ children, ...props }: Readonly<ComponentPropsWithoutRef<"a"> & ExtraProps>) {
  return (
    <a
      {...props}
      href={props.href}
      onClick={(event) => {
        if (!props.href) return;
        event.preventDefault();
        openExternal(props.href);
      }}
    >
      {children}
    </a>
  );
}

export function ReleaseNotesDialog({ notes, onClose }: Readonly<ReleaseNotesDialogProps>) {
  const { t } = useI18n();
  const body = notes.body.trim();

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
      <button
        type="button"
        aria-label={t("releaseNotes.close")}
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div className="relative flex max-h-[86vh] w-full max-w-2xl flex-col rounded-xl border bg-background shadow-xl">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Sparkles className="size-4 text-sky-500" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{t("releaseNotes.title", { version: notes.version })}</h2>
            <p className="text-[11px] text-muted-foreground">{t("releaseNotes.subtitle")}</p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {body ? (
            <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-a:text-sky-600 dark:prose-a:text-sky-300">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{ a: MarkdownLink }}
              >
                {body}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("releaseNotes.empty")}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          {notes.url && (
            <button
              type="button"
              onClick={() => openExternal(notes.url!)}
              className="mr-auto inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
              {t("releaseNotes.openGithub")}
            </button>
          )}
          <Button size="sm" className="h-8" onClick={onClose}>
            {t("common.done")}
          </Button>
        </div>
      </div>
    </div>
  );
}
