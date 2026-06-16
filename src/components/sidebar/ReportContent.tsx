import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
 * the transcript to that moment (via the store's highlightMs signal).
 */
export function ReportContent({ markdown, onJump }: { markdown: string; onJump?: () => void }) {
  const setHighlightMs = useStore((s) => s.setHighlightMs);

  return (
    <div className="prose prose-invert prose-sm max-w-none select-text text-foreground prose-p:my-1.5 prose-headings:mb-1 prose-headings:mt-3 prose-ul:my-1.5 prose-li:my-0.5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("#t=")) {
              const seconds = Number(href.slice(3));
              return (
                <button
                  type="button"
                  className="rounded bg-sky-500/15 px-1 font-mono text-[0.85em] text-sky-300 no-underline hover:bg-sky-500/25"
                  onClick={() => {
                    setHighlightMs(seconds * 1000);
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
        }}
      >
        {linkifyTimestamps(markdown || "…")}
      </ReactMarkdown>
    </div>
  );
}
