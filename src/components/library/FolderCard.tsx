import { useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { useI18n } from "../../i18n";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** The card's drawn size in the UX file (3541:9358 / 3541:9359), and the size
 *  it is shown at: the drawing is laid out in its own 151×136 coordinates and
 *  scaled as one, so the papers, the folder's tab and the text keep their
 *  proportions exactly. */
const DRAWN = { w: 151, h: 136 };
const SHOWN_W = 200;
const SCALE = SHOWN_W / DRAWN.w;

/**
 * One folder as a card, for an org's page: a grey back panel, two sheets of
 * paper tucked in, the folder's front with its tab, and the name and how many
 * recordings it holds. Under the pointer the back turns blue, the papers rise,
 * the front takes its blue wash and the name its blue — the design's hover
 * state, eased.
 */
export function FolderCard({
  name,
  count,
  onOpen,
}: Readonly<{ name: string; count: number; onOpen: () => void }>) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onOpen}
      title={name}
      className="group relative shrink-0 cursor-pointer rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ width: SHOWN_W, height: DRAWN.h * SCALE }}
    >
      <FolderDrawing hover>
        <p className="truncate text-[12px] text-[#333] transition-colors duration-500 ease-[var(--ob-ease)] group-hover:text-[#3b82f6]">
          {name}
        </p>
        <p className="text-[10px] text-[#a3a3a3]">{t("library.folderCard.count", { count })}</p>
      </FolderDrawing>
    </button>
  );
}

/**
 * The folder being created: the same grey card, its name typed straight into
 * the name's place — no field box, just the text and a caret. Enter (or
 * clicking away) creates it; Esc or an empty name drops the card.
 */
function DraftFolderCard({ onDone }: Readonly<{ onDone: (name: string | null) => void }>) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  // Enter / Esc unmount the field, and its blur then fires on the way out —
  // the first of the two settles it.
  const settled = useRef(false);
  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    onDone(commit && name.trim() ? name.trim() : null);
  };
  return (
    <div className="relative shrink-0" style={{ width: SHOWN_W, height: DRAWN.h * SCALE }}>
      <FolderDrawing>
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the card exists only because the user just asked to name a folder
          autoFocus
          value={name}
          aria-label={t("history.folder.namePlaceholder")}
          placeholder={t("history.folder.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(true);
            else if (e.key === "Escape") finish(false);
          }}
          onBlur={() => finish(true)}
          className="w-full min-w-0 border-0 bg-transparent p-0 text-[12px] leading-normal text-[#333] caret-[#3b82f6] outline-none placeholder:text-[#a3a3a3]"
        />
        <p className="text-[10px] text-[#a3a3a3]">{t("library.folderCard.count", { count: 0 })}</p>
      </FolderDrawing>
    </div>
  );
}

/** The folder drawing in its own 151×136 coordinates, scaled to the shown
 *  size; `children` fill the name slot. `hover` turns on the design's hover
 *  state under a `group` ancestor. */
function FolderDrawing({ hover = false, children }: Readonly<{ hover?: boolean; children: ReactNode }>) {
  const h = (cls: string) => (hover ? cls : "");
  return (
    <div
      className="absolute top-0 left-0 origin-top-left"
      style={{ width: DRAWN.w, height: DRAWN.h, transform: `scale(${SCALE})` }}
    >
      {/* Back panel. */}
      <div className={`absolute top-0 left-0 h-[106px] w-[151px] rounded-[8px] bg-[#e1e1e1] transition-colors duration-500 ease-[var(--ob-ease)] ${h("group-hover:bg-[#d4e5ef]")}`} />
      {/* The two papers, rising a little on hover. */}
      <div className={`absolute top-[10.9px] left-[9.89px] flex h-[116.122px] w-[111.626px] items-center justify-center folder-paper ${h("group-hover:translate-x-[3.11px] group-hover:-translate-y-[10.9px]")}`}>
        <div className="h-[104.765px] w-[99.601px] rotate-7 rounded-[4px] bg-white/80 shadow-[0px_4px_7px_0px_rgba(0,0,0,0.1)]" />
      </div>
      <div className={`absolute top-[31.16px] left-[29.14px] flex h-[95.204px] w-[106px] items-center justify-center folder-paper folder-paper-late ${h("group-hover:translate-x-[3.11px] group-hover:-translate-y-[10.89px]")}`}>
        <div className="h-[84.074px] w-[96.473px] rotate-7 rounded-[4px] bg-white shadow-[0px_4px_7px_0px_rgba(0,0,0,0.1)]" />
      </div>
      {/* The folder's front, its grey and blue washes crossfading. */}
      <img
        alt=""
        src="/library/folder-front.svg"
        className={`absolute top-[29px] left-0 block h-[107px] w-[151px] max-w-none transition-opacity duration-500 ease-[var(--ob-ease)] ${h("group-hover:opacity-0")}`}
      />
      {hover && (
        <img
          alt=""
          src="/library/folder-front-hover.svg"
          className="absolute top-[29px] left-0 block h-[107px] w-[151px] max-w-none opacity-0 transition-opacity duration-500 ease-[var(--ob-ease)] group-hover:opacity-100"
        />
      )}
      <div className="absolute top-[95px] right-[12px] left-[12px] flex flex-col gap-[2px] leading-normal">{children}</div>
    </div>
  );
}

/**
 * The first card on an org's page: 新增資料夾, from the UX file (3541:9360
 * default, 3541:9412 hover) — a pale-blue frame with a folder front and a
 * dashed + in a circle; on hover the frame deepens, the front widens and the +
 * fills. The whole card is the button, named by a 新增資料夾 tooltip. A click
 * adds a grey folder card right after it, its name typed into the card
 * ({@link DraftFolderCard}).
 */
export function NewFolderCard({ onCreate }: Readonly<{ onCreate: (name: string) => void }>) {
  const { t } = useI18n();
  const [drafting, setDrafting] = useState(false);
  const label = t("sidebar.menu.newFolder");

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={label}
              onClick={() => setDrafting(true)}
              className="group relative shrink-0 cursor-pointer rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ width: SHOWN_W, height: DRAWN.h * SCALE }}
            >
              <div
                className="absolute top-0 left-0 origin-top-left"
                style={{ width: DRAWN.w, height: DRAWN.h, transform: `scale(${SCALE})` }}
              >
                <div className="absolute top-0 left-0 h-[136px] w-[151px] rounded-[8px] bg-[#f6fcff] transition-colors duration-500 ease-[var(--ob-ease)] group-hover:bg-[#eef8ff]" />
                {/* Hover is #eef8ff, not the file's #e0edf4: that grey-blue read
                    muddy beside the front's clear blue. Same sky hue, and
                    kept well lighter than the front's top, so the opened front
                    still stands out from the frame behind it. */}
                {/* The front tips open. The hover drawing is the default one
                    sheared: same bottom edge, top edge 11px to the left — a
                    skewX of atan(11/107) about the bottom. So both layers shear
                    together while they crossfade: the default leans into the
                    hover shape, and the hover layer starts leaned back into the
                    default one. Nothing jumps; the folder opens. */}
                <img
                  alt=""
                  src="/library/folder-new-front.svg"
                  className="folder-open absolute top-[29px] left-0 block h-[107px] w-[151px] max-w-none origin-bottom group-hover:opacity-0 group-hover:skew-x-[5.87deg]"
                />
                <img
                  alt=""
                  src="/library/folder-new-front-hover.svg"
                  className="folder-open absolute top-[29px] left-[-11px] block h-[107px] w-[162px] max-w-none origin-bottom -skew-x-[5.87deg] opacity-0 group-hover:skew-x-0 group-hover:opacity-100"
                />
                <span className="absolute top-[69px] left-[63px] flex items-center rounded-full border border-dashed border-[rgba(59,130,246,0.3)] p-[4px] transition-[background-color,border-color,transform] duration-500 ease-[var(--ob-ease)] group-hover:scale-110 group-hover:border-[#3b82f6] group-hover:bg-[rgba(45,182,243,0.2)]">
                  <Plus className="size-[16px] text-[#3b82f6]" strokeWidth={2} />
                </span>
              </div>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {drafting && (
        <DraftFolderCard
          onDone={(name) => {
            setDrafting(false);
            if (name) onCreate(name);
          }}
        />
      )}
    </>
  );
}
