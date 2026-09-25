/**
 * Build parley.tw into _site/.
 *
 *   bun scripts/build-website.ts            # → _site/
 *   bun scripts/build-website.ts out/dir    # → out/dir/
 *
 * Renders website/src/home.html once per language:
 *
 *   _site/index.html      zh-TW (lang="zh-Hant-TW"), the main site
 *   _site/en/index.html   English
 *
 * and copies everything else under website/ verbatim (the legal pages, CSS, JS,
 * assets), except the build inputs (src/, tools/) and repo-only files.
 *
 * Zero dependencies: only node:fs/node:path, so it runs under Bun in CI and under
 * Node inside vitest (tests/website-build.test.ts imports buildWebsite()).
 *
 * The build fails — rather than shipping a half-translated page — when the two
 * dictionaries do not have the same keys, when the template uses a key that is
 * missing, when a key is never used, or when a placeholder survives rendering.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://parley.tw";

/** Per-language settings the dictionaries don't carry. */
const LANGS = {
  zh: {
    dict: "zh-TW.json",
    htmlLang: "zh-Hant-TW",
    dir: "", // served at /
    ogLocale: "zh_TW",
  },
  en: {
    dict: "en.json",
    htmlLang: "en",
    dir: "en/",
    ogLocale: "en_US",
  },
} as const;
type Lang = keyof typeof LANGS;
const OTHER: Record<Lang, Lang> = { zh: "en", en: "zh" };

/** Top-level entries of website/ that are build inputs or repo docs, not site files. */
const NOT_COPIED = new Set(["src", "tools", "README.md", "site.config.json", ".DS_Store"]);

/** Dictionary keys script.js needs at runtime; shipped in a JSON island. */
const PAGE_DATA_KEYS = {
  speakerA: "demo.speakerA",
  speakerB: "demo.speakerB",
  line1: "demo.line1",
  line2: "demo.line2",
  ctaMac: "cta.mac",
  ctaWindows: "cta.windows",
  ctaIphone: "cta.iphone",
  ctaAppStore: "cta.appStore",
  ctaAndroid: "cta.android",
  ctaDesktop: "cta.desktop",
} as const;

export interface SiteConfig {
  /** Cloudflare Web Analytics site token (public: it ships in the page). Empty = no beacon. */
  cloudflareWebAnalyticsToken?: string;
}

export interface BuildOptions {
  /** Directory holding website/ (defaults to this repo). */
  root?: string;
  /** Output directory, wiped first (defaults to <root>/_site). */
  outDir?: string;
  /** Overrides website/site.config.json. */
  config?: SiteConfig;
}

export interface BuildResult {
  outDir: string;
  pages: Record<Lang, string>;
}

type Dict = Record<string, string>;

function readJson<T>(file: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    throw new Error(`build-website: cannot read ${file}: ${(err as Error).message}`);
  }
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** JSON that is safe inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function loadDicts(srcDir: string): Record<Lang, Dict> {
  const dicts = {} as Record<Lang, Dict>;
  for (const lang of Object.keys(LANGS) as Lang[]) {
    const file = path.join(srcDir, "i18n", LANGS[lang].dict);
    const dict = readJson<Dict>(file);
    for (const [key, value] of Object.entries(dict)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`build-website: ${LANGS[lang].dict}: "${key}" must be a non-empty string`);
      }
    }
    dicts[lang] = dict;
  }
  const zhKeys = new Set(Object.keys(dicts.zh));
  const enKeys = new Set(Object.keys(dicts.en));
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
  if (onlyZh.length || onlyEn.length) {
    const lines = [
      ...onlyZh.map((k) => `  only in ${LANGS.zh.dict}: ${k}`),
      ...onlyEn.map((k) => `  only in ${LANGS.en.dict}: ${k}`),
    ];
    throw new Error(`build-website: the dictionaries must have identical keys\n${lines.join("\n")}`);
  }
  return dicts;
}

function beaconTag(token: string | undefined): string {
  const t = (token ?? "").trim();
  if (!t) return "";
  if (!/^[A-Za-z0-9]+$/.test(t)) {
    throw new Error("build-website: cloudflareWebAnalyticsToken must be alphanumeric");
  }
  // Cloudflare's own snippet, verbatim apart from the token.
  return (
    `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" ` +
    `data-cf-beacon='{"token": "${t}"}'></script>`
  );
}

function pageUrl(lang: Lang): string {
  return `${ORIGIN}/${LANGS[lang].dir}`;
}

function jsonLd(lang: Lang, dict: Dict): string {
  return scriptJson({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Parley",
    url: pageUrl(lang),
    inLanguage: LANGS[lang].htmlLang,
    description: stripTags(dict["meta.description"]),
    applicationCategory: "BusinessApplication",
    operatingSystem: "macOS, Windows, iOS, Android",
    featureList: stripTags(dict["ld.features"]),
    image: `${ORIGIN}/assets/og-${lang}.png`,
    downloadUrl: [
      "https://api.parley.tw/download?platform=macos",
      "https://api.parley.tw/download?platform=windows",
      "https://apps.apple.com/app/id6795031201",
      "https://play.google.com/store/apps/details?id=com.pathors.parley",
    ],
    license: "https://www.apache.org/licenses/LICENSE-2.0",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    author: { "@type": "Organization", name: "Pathors AI", url: "https://pathors.com" },
    publisher: { "@type": "Organization", name: "Pathors AI", url: "https://pathors.com" },
  });
}

function render(
  template: string,
  lang: Lang,
  dict: Dict,
  rms: number[],
  beacon: string,
  used: Set<string>,
): string {
  const other = OTHER[lang];
  const base = LANGS[lang].dir ? "../" : "";
  const pageData = Object.fromEntries(
    Object.entries(PAGE_DATA_KEYS).map(([name, key]) => {
      used.add(key);
      return [name, stripTags(dict[key])];
    }),
  );
  const computed: Record<string, string> = {
    "@lang": lang,
    "@htmlLang": LANGS[lang].htmlLang,
    "@altHtmlLang": LANGS[other].htmlLang,
    "@base": base,
    "@canonical": pageUrl(lang),
    "@url.zh": pageUrl("zh"),
    "@url.en": pageUrl("en"),
    "@altHref": lang === "zh" ? "en/" : "../",
    "@ogImage": `${ORIGIN}/assets/og-${lang}.png`,
    "@ogLocale": LANGS[lang].ogLocale,
    "@ogLocaleAlt": LANGS[other].ogLocale,
    "@legalQuery": lang === "en" ? "?lang=en" : "",
    "@jsonld": jsonLd(lang, dict),
    "@pagedata": scriptJson({ ...pageData, rms }),
    "@beacon": beacon,
  };
  used.add("meta.description");
  used.add("ld.features");

  const source = template.replace(/<!--#[\s\S]*?-->\n?/g, "");
  const missing = new Set<string>();
  const out = source.replace(/\{\{\s*([@\w.-]+)(\|attr)?\s*\}\}/g, (_m, key: string, attr?: string) => {
    let value: string | undefined;
    if (key.startsWith("@")) value = computed[key];
    else {
      value = dict[key];
      used.add(key);
    }
    if (value === undefined) {
      missing.add(key);
      return "";
    }
    return attr ? escapeAttr(stripTags(value)) : value;
  });
  if (missing.size) {
    throw new Error(
      `build-website: home.html uses keys that ${lang} does not define: ${[...missing].join(", ")}`,
    );
  }
  const leftover = out.match(/\{\{[^}]*\}\}/);
  if (leftover) throw new Error(`build-website: unresolved placeholder ${leftover[0]} (${lang})`);
  return out;
}

/** True when `child` is `parent` or somewhere below it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function copyTree(from: string, to: string, skip: Set<string>) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name === ".DS_Store") continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, new Set());
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

export function buildWebsite(options: BuildOptions = {}): BuildResult {
  const root = path.resolve(options.root ?? REPO);
  const siteDir = path.join(root, "website");
  const srcDir = path.join(siteDir, "src");
  const outDir = path.resolve(options.outDir ?? path.join(root, "_site"));

  // The output is wiped first, so it must neither contain website/ nor sit inside it.
  if (isWithin(outDir, siteDir) || isWithin(siteDir, outDir)) {
    throw new Error(`build-website: refusing to write into ${outDir}`);
  }

  const config = options.config ?? readJson<SiteConfig>(path.join(siteDir, "site.config.json"));
  const beacon = beaconTag(config.cloudflareWebAnalyticsToken);
  const dicts = loadDicts(srcDir);
  const template = fs.readFileSync(path.join(srcDir, "home.html"), "utf8");
  const rms = readJson<Record<Lang, number[]>>(path.join(srcDir, "rms.json"));

  fs.rmSync(outDir, { recursive: true, force: true });
  copyTree(siteDir, outDir, NOT_COPIED);

  const pages = {} as Record<Lang, string>;
  for (const lang of Object.keys(LANGS) as Lang[]) {
    const data = rms[lang];
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(`build-website: rms.json has no "${lang}" samples`);
    }
    const used = new Set<string>();
    const html = render(template, lang, dicts[lang], data, beacon, used);
    const unused = Object.keys(dicts[lang]).filter((k) => !used.has(k));
    if (unused.length) {
      throw new Error(`build-website: ${LANGS[lang].dict} has keys no page uses: ${unused.join(", ")}`);
    }
    const file = path.join(outDir, LANGS[lang].dir, "index.html");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    pages[lang] = file;
  }
  return { outDir, pages };
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const outArg = process.argv[2];
  const result = buildWebsite(outArg ? { outDir: outArg } : {});
  const shown = path.relative(process.cwd(), result.outDir) || ".";
  console.log(`built ${shown}/index.html and ${shown}/en/index.html`);
}
