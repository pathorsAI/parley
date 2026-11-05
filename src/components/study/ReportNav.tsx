import { useEffect, useState } from "react";

/**
 * A long report's section nav, on the right: one entry per section, the one being
 * read highlighted, a click scrolling to it. Sticks while the report scrolls;
 * on a narrow pane it becomes a row above the report. Shared by 評分 and
 * 總結; the sections it points at are found by id.
 *
 * Lay it out in a `@container` grid: `grid-cols-1 @min-[680px]:grid-cols-
 * [minmax(0,1fr)_128px]`, with the report column given `order-1
 * @min-[680px]:order-none` so the nav sits above it when narrow.
 */
export function ReportNav({ items, label }: Readonly<{ items: { id: string; label: string }[]; label: string }>) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  const ids = items.map((i) => i.id).join(",");
  useEffect(() => {
    const sections = ids
      .split(",")
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => !!el);
    if (sections.length === 0) return;
    // The section whose top has passed the upper third of the pane is current.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "0px 0px -65% 0px" },
    );
    for (const el of sections) observer.observe(el);
    return () => observer.disconnect();
  }, [ids]);
  return (
    <nav
      aria-label={label}
      className="order-0 flex flex-row flex-wrap gap-1 border-b pb-2 text-xs @min-[680px]:sticky @min-[680px]:top-2 @min-[680px]:order-none @min-[680px]:flex-col @min-[680px]:self-start @min-[680px]:border-b-0 @min-[680px]:border-l @min-[680px]:pb-0 @min-[680px]:pl-2.5"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={active === item.id ? "true" : undefined}
          onClick={() => {
            setActive(item.id);
            document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className={`cursor-pointer truncate rounded-md px-2 py-1 text-left transition-colors ${
            active === item.id ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

