import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { useStore } from "../../lib/store";

/** A cited moment: `[m:ss]` as the prompts ask for, plus the shapes models
 *  drift into — `[h:mm:ss]`, a range (`[6:52–7:10]`, linked at its start),
 *  full-width brackets (`【6:52】`) and brackets the model escaped (`\[6:52\]`).
 *  Not when already a link (`[6:52](…)`). */
const STAMP = String.raw`\\?[[【]\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\s*[-‐‑‒–—―−~～]\s*[\d:]+)?\s*\\?[\]】](?!\()`;
const TIMESTAMP = new RegExp(STAMP, "g");
/** The same citations sitting alone in parentheses, `（[3:18]、[30:36]）`. */
const STAMP_NC = STAMP.replace("(?:(\\d{1,2}):)?(\\d{1,3}):(\\d{2})", "(?:\\d{1,2}:)?\\d{1,3}:\\d{2}");
const WRAPPED = new RegExp(String.raw`\s*[（(]\s*((?:${STAMP_NC})(?:\s*[、,，;；]?\s*(?:${STAMP_NC}))*)\s*[）)]`, "g");

/** Turn cited timestamps into markdown links with a `#t=<seconds>` href so
 *  the renderer can make them clickable. The link text is the start time.
 *  The model sometimes wraps them in parentheses and sometimes doesn't; they
 *  all read the same way — bare, like 後續行動's — so the wrapping goes. */
export function linkifyTimestamps(md: string): string {
  return md
    .replace(WRAPPED, (_, inner: string) => ` ${inner.replace(/\s*[、,，;；]\s*/g, " ")}`)
    .replace(TIMESTAMP, (_, h: string | undefined, m: string, s: string) => {
      const seconds = Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
      return `[${h ? `${h}:${m.padStart(2, "0")}` : m}:${s}](#t=${seconds})`;
    });
}

/**
 * Renders the debrief markdown. `[m:ss]` timestamps become buttons that jump
 * the transcript to that moment — via `onTimestamp` when given (the study
 * report uses it to switch to the replay tab and seek), else via the store's
 * highlightMs signal (the live transcript scroll).
 */
function makeMarkdownComponents(jump: (ms: number) => void, onJump?: () => void): Components {
  return {
    a: ({ href, children }) => {
      if (href?.startsWith("#t=")) {
        const seconds = Number(href.slice(3));
        return (
          <button
            type="button"
            // Same look as 後續行動's timestamps: the time as a link.
            className="mx-0.5 cursor-pointer text-[0.9em] tabular-nums text-primary no-underline hover:underline"
            onClick={() => {
              jump(seconds * 1000);
              onJump?.();
            }}
          >
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
  };
}

export function ReportContent({
  markdown,
  onJump,
  onTimestamp,
  plain = false,
}: Readonly<{
  markdown: string;
  onJump?: () => void;
  onTimestamp?: (ms: number) => void;
  /** No rules at all: no table row lines, no horizontal rules, no underlined
   *  links (the 總結 tab reads as plain text blocks). */
  plain?: boolean;
}>) {
  const setHighlightMs = useStore((s) => s.setHighlightMs);
  const components = makeMarkdownComponents(onTimestamp ?? setHighlightMs, onJump);

  return (
    // `dark:prose-invert`, never a bare `prose-invert`: inverting unconditionally
    // paints headings, bold runs, table headers and quote borders WHITE, which in
    // light mode is white on white — the debrief lost every heading and kept only
    // its paragraphs, because `text-foreground` below colours those and nothing
    // else. Body text reading fine is exactly what made this hard to see.
    <div className={`prose prose-sm max-w-none select-text text-foreground dark:prose-invert prose-p:my-1.5 prose-headings:mb-1 prose-headings:mt-3 prose-ul:my-1.5 prose-li:my-0.5${plain ? " prose-hr:hidden prose-a:no-underline prose-thead:border-0 prose-tr:border-0 prose-blockquote:border-0 [&_td]:border-0 [&_th]:border-0" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {linkifyTimestamps(markdown || "…")}
      </ReactMarkdown>
    </div>
  );
}
