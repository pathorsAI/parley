// The parley.tw build (scripts/build-website.ts): both languages render, stay in
// step with each other, and ship nothing the site has retired.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWebsite } from "../scripts/build-website";

const REPO = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parley-site-"));
const TOKEN = "0123456789abcdef0123456789abcdef";

let zh = "";
let en = "";

/** Visible text: no scripts, styles, comments or tags. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

beforeAll(() => {
  const out = path.join(tmp, "plain");
  buildWebsite({ outDir: out, config: { cloudflareWebAnalyticsToken: "" } });
  zh = fs.readFileSync(path.join(out, "index.html"), "utf8");
  en = fs.readFileSync(path.join(out, "en", "index.html"), "utf8");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("website build", () => {
  it("renders the zh home at / and the English home at /en/", () => {
    expect(zh.length).toBeGreaterThan(1000);
    expect(en.length).toBeGreaterThan(1000);
    expect(zh).toMatch(/<html lang="zh-Hant-TW"/);
    expect(en).toMatch(/<html lang="en"/);
  });

  it("copies the rest of website/ but not the build inputs", () => {
    const out = path.join(tmp, "plain");
    for (const f of ["styles.css", "script.js", "CNAME", "privacy/index.html", "assets/og-zh.png"]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }
    for (const f of ["src", "tools", "site.config.json"]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(false);
    }
  });

  it("keeps the two dictionaries on identical keys", () => {
    const read = (f: string) =>
      Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, "website/src/i18n", f), "utf8"))).sort();
    expect(read("en.json")).toEqual(read("zh-TW.json"));
  });

  it("leaves no unresolved placeholders", () => {
    for (const html of [zh, en]) expect(html).not.toMatch(/\{\{/);
  });

  it("cross-links the languages with hreflang, including x-default", () => {
    for (const html of [zh, en]) {
      expect(html).toContain('<link rel="alternate" hreflang="zh-Hant-TW" href="https://parley.tw/">');
      expect(html).toContain('<link rel="alternate" hreflang="en" href="https://parley.tw/en/">');
      expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://parley.tw/">');
    }
    expect(zh).toContain('<link rel="canonical" href="https://parley.tw/">');
    expect(en).toContain('<link rel="canonical" href="https://parley.tw/en/">');
  });

  it("gives each language its own title, OG image and asset paths that work from /en/", () => {
    const title = (html: string) => html.match(/<title>([^<]*)<\/title>/)?.[1];
    expect(title(zh)).toBeTruthy();
    expect(title(zh)).not.toEqual(title(en));
    expect(zh).toContain('content="https://parley.tw/assets/og-zh.png"');
    expect(en).toContain('content="https://parley.tw/assets/og-en.png"');
    expect(zh).toContain('href="styles.css"');
    expect(en).toContain('href="../styles.css"');
    expect(en).toContain('src="../assets/shots/desktop-report-en.jpg"');
    expect(en).toContain('href="../privacy/?lang=en"');
  });

  it("describes the app in JSON-LD", () => {
    for (const html of [zh, en]) {
      const raw = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
      const ld = JSON.parse(raw ?? "{}");
      expect(ld["@type"]).toBe("SoftwareApplication");
      expect(ld.operatingSystem).toBe("macOS, Windows, iOS, Android");
      expect(ld.license).toContain("apache.org/licenses/LICENSE-2.0");
      expect(ld.offers.price).toBe("0");
      expect(ld.author.name).toBe("Pathors AI");
    }
  });

  it("inlines each language's own waveform data", () => {
    const rms = JSON.parse(fs.readFileSync(path.join(REPO, "website/src/rms.json"), "utf8"));
    const data = (html: string) =>
      JSON.parse(html.match(/<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
    expect(data(zh).rms).toEqual(rms.zh);
    expect(data(en).rms).toEqual(rms.en);
    expect(rms.zh).not.toEqual(rms.en);
  });

  it("omits the analytics beacon without a token and adds it with one", () => {
    for (const html of [zh, en]) expect(html).not.toContain("cloudflareinsights");

    const out = path.join(tmp, "beacon");
    buildWebsite({ outDir: out, config: { cloudflareWebAnalyticsToken: TOKEN } });
    for (const page of ["index.html", "en/index.html"]) {
      const html = fs.readFileSync(path.join(out, page), "utf8");
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head).toContain(
        `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${TOKEN}"}'></script>`,
      );
    }
  });

  it("does not load Google Fonts or any other font CDN", () => {
    const css = fs.readFileSync(path.join(REPO, "website/styles.css"), "utf8");
    for (const s of [zh, en, css]) expect(s).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it("does not ship the old tool count or retired features", () => {
    for (const html of [zh, en]) {
      expect(text(html)).not.toMatch(/(^|[^\d.:])48(?![\d.:])/);
      expect(html).not.toMatch(/48\s*(個\s*)?(MCP\s*)?(tools|工具)/i);
      expect(html).toMatch(/54/);
    }
    const retiredEn = /translat|interpreter|intel(ligence)? board|scenario|pre-flight|job interview|diligence/i;
    const retiredZh = /翻譯|口譯|情報|情境|行前|面試|盡職調查|盡調/;
    for (const html of [zh, en]) {
      expect(html).not.toMatch(retiredEn);
      expect(html).not.toMatch(retiredZh);
    }
  });

  it("fails on a key that only one dictionary has", () => {
    const root = path.join(tmp, "broken");
    fs.cpSync(path.join(REPO, "website"), path.join(root, "website"), {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}tools${path.sep}`) && !src.endsWith(`${path.sep}tools`),
    });
    const file = path.join(root, "website/src/i18n/en.json");
    const dict = JSON.parse(fs.readFileSync(file, "utf8"));
    dict["only.in.english"] = "x";
    fs.writeFileSync(file, JSON.stringify(dict));
    expect(() => buildWebsite({ root, outDir: path.join(root, "_site"), config: {} })).toThrow(/identical keys/);
  });

  it("fails when the template uses a key the dictionaries lack", () => {
    const root = path.join(tmp, "missing");
    fs.cpSync(path.join(REPO, "website"), path.join(root, "website"), {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}tools${path.sep}`) && !src.endsWith(`${path.sep}tools`),
    });
    const file = path.join(root, "website/src/home.html");
    fs.appendFileSync(file, "<p>{{no.such.key}}</p>");
    expect(() => buildWebsite({ root, outDir: path.join(root, "_site"), config: {} })).toThrow(/no\.such\.key/);
  });

  it("refuses to write into website/ itself", () => {
    expect(() => buildWebsite({ outDir: path.join(REPO, "website", "src") })).toThrow(/refusing/);
  });
});
