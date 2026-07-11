import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { useStore } from "../../lib/store";

/** Turn `[m:ss]` timestamps into markdown links with a `#t=<seconds>` href so
 *  the renderer can make them clickable. */
function linkifyTimestamps(md: string): string {
  return md.replace(/\[(\d{1,2}):(\d{2})\]/g, (_, m: string, s: string) => {
    const seconds = Number(m) * 60 + Number(s);
    return `[${m}:${s}](#t=${seconds})`;
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
            className="rounded bg-sky-500/15 px-1 font-mono text-[0.85em] text-sky-300 no-underline hover:bg-sky-500/25"
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
}: Readonly<{ markdown: string; onJump?: () => void; onTimestamp?: (ms: number) => void }>) {
  const setHighlightMs = useStore((s) => s.setHighlightMs);
  const components = makeMarkdownComponents(onTimestamp ?? setHighlightMs, onJump);

  return (
    <div className="prose prose-invert prose-sm max-w-none select-text text-foreground prose-p:my-1.5 prose-headings:mb-1 prose-headings:mt-3 prose-ul:my-1.5 prose-li:my-0.5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {linkifyTimestamps(markdown || "…")}
      </ReactMarkdown>
    </div>
  );
}
