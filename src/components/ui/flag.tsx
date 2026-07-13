import { cn } from "../../lib/utils";

/**
 * Round country flag from the vendored circle-flags set in `/public/flags`
 * (ISO 3166-1 alpha-2 code, e.g. `us`, `tw`, `jp`). Assets are self-hosted —
 * no CDN or runtime library. Renders nothing for an unknown/empty code so it
 * degrades gracefully next to the text label.
 */
export function Flag({ code, className }: { code?: string; className?: string }) {
  if (!code) return null;
  return (
    <img
      src={`/flags/${code}.svg`}
      alt=""
      aria-hidden
      loading="lazy"
      className={cn("size-4 shrink-0 rounded-full", className)}
    />
  );
}
