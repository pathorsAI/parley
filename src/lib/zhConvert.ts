// OpenCC dictionaries are large, so they're code-split out of the main bundle
// and loaded lazily. Loading on the FIRST transcript event delayed the first
// caption (and the first dictation) by the whole dictionary parse — so entry
// points that will convert soon call preloadZhConverter() at startup instead.
let convertPromise: Promise<(s: string) => string> | null = null;

async function getConverter(): Promise<(s: string) => string> {
  convertPromise ??= import("opencc-js/cn2t").then((OpenCC) =>
    OpenCC.Converter({ from: "cn", to: "tw" })
  );
  return convertPromise;
}

/**
 * Kick off the dictionary load in the background so the first real
 * {@link toTraditional} call doesn't pay it on the critical path. Idempotent.
 * A failed load is uncached so the on-demand path retries (and surfaces the
 * error to its caller) instead of pinning a rejected promise forever.
 */
export function preloadZhConverter(): void {
  getConverter().catch(() => {
    convertPromise = null;
  });
}

export async function toTraditional(text: string): Promise<string> {
  if (!text) return text;
  const convert = await getConverter();
  return convert(text);
}
