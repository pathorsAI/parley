// Render the Open Graph cards: website/assets/og-zh.png and og-en.png (1200×630).
//
//   node website/tools/og/render.mjs      (or: bun website/tools/og/render.mjs)
//
// Fills og.html from the site's own strings (website/src/i18n/*.json) and hero
// loudness data (website/src/rms.json), so the card shows the same two lines and
// the same measured waveform as the hero, frozen partway into the second turn.
// Fonts are inlined as data: URLs because Chrome will not load @font-face files
// across file:// URLs.
//
// Headless Chrome can hang after writing a --screenshot, so it runs with its own
// throwaway profile and is killed as soon as the PNG appears.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "../..");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LANGS = {
  zh: { dict: "zh-TW.json", htmlLang: "zh-Hant-TW", url: "parley.tw", lag: 6 },
  en: { dict: "en.json", htmlLang: "en", url: "parley.tw/en", lag: 18 },
};

const font = (file) =>
  `data:font/woff2;base64,${fs.readFileSync(path.join(SITE, "assets/fonts", file)).toString("base64")}`;
const escapeHtml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function bars(rms, end, count) {
  const slice = rms.slice(Math.max(0, end - count), end);
  return slice
    .map((v, i) => {
      const cls = [i >= slice.length - 6 ? "new" : "", v < 0.05 ? "dot" : ""].filter(Boolean).join(" ");
      const h = v < 0.05 ? 3 : Math.max(4, Math.round(v * 40));
      return `<b${cls ? ` class="${cls}"` : ""} style="height:${h}px"></b>`;
    })
    .join("");
}

function secondTurnStart(rms) {
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] !== 0) continue;
    let j = i;
    while (j < rms.length && rms[j] === 0) j++;
    if (j - i >= 6) return j;
    i = j;
  }
  return 0;
}

async function shoot(html, out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parley-og-"));
  const page = path.join(dir, "og.html");
  fs.writeFileSync(page, html);
  fs.rmSync(out, { force: true });
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--force-color-profile=srgb",
      "--force-device-scale-factor=1",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--window-size=1200,630",
      "--virtual-time-budget=2000",
      `--screenshot=${out}`,
      `file://${page}`,
    ],
    { stdio: "ignore" },
  );
  try {
    const deadline = Date.now() + 30000;
    while (!(fs.existsSync(out) && fs.statSync(out).size > 0)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${out}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 300)); // let the write finish
  } finally {
    chrome.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const template = fs.readFileSync(path.join(HERE, "og.html"), "utf8");
const rmsAll = JSON.parse(fs.readFileSync(path.join(SITE, "src/rms.json"), "utf8"));
const fonts = {
  fontDmSans: font("dm-sans-latin-wght-normal.woff2"),
  fontAlexandria: font("alexandria-latin-wght-normal.woff2"),
};

for (const [lang, cfg] of Object.entries(LANGS)) {
  const t = JSON.parse(fs.readFileSync(path.join(SITE, "src/i18n", cfg.dict), "utf8"));
  const rms = rmsAll[lang];
  const line2 = t["demo.line2"];
  // Freeze 55% of the way into the second turn, like a moment of the live hero.
  let shown = Math.round(line2.length * 0.55);
  let settled = Math.max(0, shown - cfg.lag);
  if (lang === "en") {
    // Space-separated text: freeze on word boundaries, not mid-word.
    shown = line2.indexOf(" ", shown) === -1 ? line2.length : line2.indexOf(" ", shown);
    settled = Math.max(0, line2.lastIndexOf(" ", settled));
  }
  const start2 = secondTurnStart(rms);
  const at = start2 + Math.round((rms.length - start2) * 0.55);
  const values = {
    ...fonts,
    htmlLang: cfg.htmlLang,
    url: cfg.url,
    h1: t["hero.h1"],
    speakerA: escapeHtml(t["demo.speakerA"]),
    speakerB: escapeHtml(t["demo.speakerB"]),
    line1: escapeHtml(t["demo.line1"]),
    line2Settled: escapeHtml(line2.slice(0, settled)),
    line2Tail: escapeHtml(line2.slice(settled, shown)),
    recording: escapeHtml(t["demo.recording"]),
    bars: bars(rms, at, 40),
  };
  const html = template
    .replace(/<!--[\s\S]*?-->\n?/, "")
    .replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (!(k in values)) throw new Error(`og.html: no value for ${m}`);
      return values[k];
    });
  const out = path.join(SITE, "assets", `og-${lang}.png`);
  await shoot(html, out);
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}
