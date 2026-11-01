import { useI18n } from "../../i18n";

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
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: DRAWN.w, height: DRAWN.h, transform: `scale(${SCALE})` }}
      >
        {/* Back panel. */}
        <div className="absolute top-0 left-0 h-[106px] w-[151px] rounded-[8px] bg-[#e1e1e1] transition-colors duration-300 group-hover:bg-[#d4e5ef]" />
        {/* The two papers, rising a little on hover. */}
        <div className="absolute top-[10.9px] left-[9.89px] flex h-[116.122px] w-[111.626px] items-center justify-center transition-transform duration-300 ease-out group-hover:translate-x-[3.11px] group-hover:-translate-y-[10.9px]">
          <div className="h-[104.765px] w-[99.601px] rotate-7 rounded-[4px] bg-white/80 shadow-[0px_4px_7px_0px_rgba(0,0,0,0.1)]" />
        </div>
        <div className="absolute top-[31.16px] left-[29.14px] flex h-[95.204px] w-[106px] items-center justify-center transition-transform duration-300 ease-out group-hover:translate-x-[3.11px] group-hover:-translate-y-[10.89px]">
          <div className="h-[84.074px] w-[96.473px] rotate-7 rounded-[4px] bg-white shadow-[0px_4px_7px_0px_rgba(0,0,0,0.1)]" />
        </div>
        {/* The folder's front, its grey and blue washes crossfading. */}
        <img
          alt=""
          src="/library/folder-front.svg"
          className="absolute top-[29px] left-0 block h-[107px] w-[151px] max-w-none transition-opacity duration-300 group-hover:opacity-0"
        />
        <img
          alt=""
          src="/library/folder-front-hover.svg"
          className="absolute top-[29px] left-0 block h-[107px] w-[151px] max-w-none opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        />
        <div className="absolute top-[95px] right-[12px] left-[12px] flex flex-col gap-[2px] leading-normal">
          <p className="truncate text-[12px] text-[#333] transition-colors duration-300 group-hover:text-[#3b82f6]">
            {name}
          </p>
          <p className="text-[10px] text-[#a3a3a3]">{t("library.folderCard.count", { count })}</p>
        </div>
      </div>
    </button>
  );
}
