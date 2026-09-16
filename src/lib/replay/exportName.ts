/**
 * A display title is not a filename — turning one into the other, once, here.
 *
 * Recordings nobody has renamed are auto-titled with a localized timestamp
 * (`Live meeting · 9/16/2026, 2:30:15 PM`, `會議紀錄 · 2026/9/16 下午2:30:15`).
 * Both `/` and `:` are perfectly ordinary in a macOS display name and illegal in
 * a Windows one — `:` is also how Windows spells a drive and an alternate data
 * stream — so handing such a title to the save dialog as its pre-filled name got
 * it rejected, and every un-renamed recording was simply un-exportable on
 * Windows. Same for the quieter traps: a trailing dot or space, which Windows
 * silently drops so the path you asked for is not the file you get, and the DOS
 * device names, which no directory will ever hold.
 *
 * Illegal characters are REPLACED, not deleted, so `Q3 Review: Acme` stays
 * readable as `Q3 Review- Acme`. Non-ASCII is left alone: CJK is legal in
 * filenames on both platforms and this app is Traditional-Chinese-first, so
 * "sanitizing" it away would mangle the common case rather than protect it.
 */

/** What a title with nothing usable left in it becomes. */
export const FALLBACK_EXPORT_NAME = "recording";

/**
 * Cap for the whole filename, extension included. Both platforms allow 255 per
 * path component, but Windows counts characters while APFS and ext4 count UTF-8
 * BYTES — and a Traditional Chinese character costs three of those. 80 keeps the
 * worst case (240 bytes plus extension) inside every limit, and a title longer
 * than that stopped being a useful filename well before it stopped being legal.
 */
const MAX_NAME_CHARS = 80;

/** What Windows rejects outright. Unix only objects to `/`, but a name has to
 *  survive being carried between the two, so the whole set goes. */
const ILLEGAL_PUNCT = /[<>:"/\\|?*]/g;

/** A title that already ends in an extension keeps it out of the result, so an
 *  imported `interview.m4a` doesn't come back as `interview.m4a.m4a`. The stem
 *  is captured rather than the suffix matched on its own, so a title that is
 *  nothing BUT a suffix (`.hidden`) keeps its text instead of vanishing. */
const TRAILING_EXT = /^(.+)\.[^./\\]+$/;

/** Leading dot hides the file on macOS; a trailing dot or space is dropped by
 *  Windows. Dashes go too — they are usually ours, left by a replacement. */
const EDGE_NOISE_LEAD = /^[\s.-]+/;
const EDGE_NOISE_TRAIL = /[\s.-]+$/;

/** The DOS device names, still reserved in every Windows directory. */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A filename that both macOS and Windows will accept, built from a recording's
 * display title and the extension the audio file actually has. Safe to hand
 * straight to the dialog plugin's `defaultPath`.
 */
export function safeExportFileName(title: string, ext: string): string {
  const suffix = normalizeExt(ext);
  const cleaned = trimEdges(replaceIllegal(title.replace(TRAILING_EXT, "$1"))) || FALLBACK_EXPORT_NAME;
  const base = truncate(escapeDeviceName(cleaned), MAX_NAME_CHARS - suffix.length);
  return `${base}${suffix}`;
}

/** Control characters — the C0 block and DEL — are unprintable and illegal or
 *  mangled in a filename everywhere; they ride in through pasted titles. Tested
 *  by code point rather than written into a character class, where they would be
 *  invisible to anyone reading the source. */
function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

function replaceIllegal(name: string): string {
  const printable = Array.from(name, (ch) => (isControl(ch) ? "-" : ch)).join("");
  return printable.replace(ILLEGAL_PUNCT, "-");
}

function trimEdges(name: string): string {
  return name.replace(EDGE_NOISE_LEAD, "").replace(EDGE_NOISE_TRAIL, "");
}

/** `.ogg` from `ogg`, `.ogg`, or `..ogg`; nothing at all from an empty or
 *  entirely illegal extension, rather than a name ending in a bare dot. */
function normalizeExt(ext: string): string {
  const cleaned = ext.replace(/^\.+/, "").replace(ILLEGAL_PUNCT, "");
  return cleaned ? `.${cleaned}` : "";
}

/**
 * Windows reserves the device names with OR without an extension — `NUL.txt` is
 * as unopenable as `NUL` — so the test is on the stem, and the escape hatch goes
 * on the stem too, keeping any inner suffix the title carried.
 */
function escapeDeviceName(base: string): string {
  const dot = base.indexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  if (!RESERVED_DEVICE.test(stem)) return base;
  return `${stem}_${dot === -1 ? "" : base.slice(dot)}`;
}

/** Cut to `max` characters, then re-trim: the cut can expose a trailing dot or
 *  space that Windows would quietly drop right back off again. */
function truncate(base: string, max: number): string {
  if (base.length <= max) return base;
  return trimEdges(base.slice(0, Math.max(1, max))) || FALLBACK_EXPORT_NAME;
}
