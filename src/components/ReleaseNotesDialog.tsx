import { ArrowUpRight } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import type { ComponentPropsWithoutRef } from "react";
import remarkGfm from "remark-gfm";
import { Dialog as DialogPrimitive } from "radix-ui";
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

function formatDate(iso: string | undefined, language: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(language === "en" ? "en-US" : "zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * What's-new dialog, shown once after an update and from Settings → release
 * logs. Notes are written as one plain-language lead paragraph followed by
 * bullets, so the lead is set larger and the bullets read as detail.
 */
export function ReleaseNotesDialog({ notes, onClose }: Readonly<ReleaseNotesDialogProps>) {
  const { t, language } = useI18n();
  const body = notes.body.trim();
  const date = formatDate(notes.publishedAt, language);

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[71] flex max-h-[80vh] w-[calc(100%-3rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <header className="flex items-center gap-3 px-6 pb-4 pt-6">
            <img src="/parley.svg" alt="" className="size-10 shrink-0 rounded-[10px]" draggable={false} />
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-base font-semibold leading-tight tracking-tight">
                {t("releaseNotes.title", { version: notes.version })}
              </DialogPrimitive.Title>
              {date && <p className="mt-1 text-xs text-muted-foreground">{date}</p>}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-2">
            {body ? (
              <div className="prose prose-sm max-w-none text-muted-foreground dark:prose-invert prose-p:my-0 prose-p:leading-relaxed prose-strong:font-medium prose-strong:text-foreground prose-ul:my-0 prose-ul:pl-4 prose-li:my-2 prose-li:leading-relaxed prose-li:marker:text-muted-foreground/50 prose-headings:mb-2 prose-headings:mt-5 prose-headings:text-sm prose-headings:text-foreground prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none [&>*+*]:mt-4 [&>p:first-child]:text-[15px] [&>p:first-child]:text-foreground">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
                  {body}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("releaseNotes.empty")}</p>
            )}
          </div>

          <footer className="flex items-center gap-2 px-6 pb-5 pt-5">
            {notes.url && (
              <button
                type="button"
                onClick={() => openExternal(notes.url!)}
                className="-ml-2 inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {t("releaseNotes.openGithub")}
                <ArrowUpRight className="size-3.5" />
              </button>
            )}
            <Button size="sm" className="ml-auto h-8 px-4" onClick={onClose} autoFocus>
              {t("common.done")}
            </Button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
