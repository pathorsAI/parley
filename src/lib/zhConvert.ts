// OpenCC dictionaries are large, so load them only once transcript text arrives.
let convertPromise: Promise<(s: string) => string> | null = null;

async function getConverter(): Promise<(s: string) => string> {
  convertPromise ??= import("opencc-js/cn2t").then((OpenCC) =>
    OpenCC.Converter({ from: "cn", to: "tw" })
  );
  return convertPromise;
}

export async function toTraditional(text: string): Promise<string> {
  if (!text) return text;
  const convert = await getConverter();
  return convert(text);
}
