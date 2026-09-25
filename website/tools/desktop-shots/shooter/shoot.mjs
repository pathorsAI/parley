// Capture the Parley desktop screenshots from the built harness (../dist).
//
//   node shoot.mjs                 # every shot
//   node shoot.mjs live report     # only shots whose name starts with these
//
// Serves ../dist on an ephemeral localhost port for the duration of the run
// (closed on exit — nothing is left listening), drives headless Chrome with a
// macOS user agent at 1440×900 CSS px @2x, blocks every non-local request, and
// writes PNG (transparent rounded corners) + JPEG (white, ≤2000px wide) into
// ../out. Fails loudly on page errors or IPC commands the harness didn't expect.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../dist");
const OUT = path.resolve(HERE, "../out");
const TEXT = path.resolve(HERE, "../text"); // visible-text + aria/title dumps, for i18n-leak audits
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const W = 1440;
const H = 900;

/** name → harness query + optional post-ready action. */
const SHOTS = [];
for (const lang of ["zh", "en"]) {
  SHOTS.push({ name: `live-${lang}-light`, q: { scene: "live", lang, theme: "light" } });
  SHOTS.push({ name: `report-${lang}-light`, q: { scene: "report", lang, theme: "light" } });
  SHOTS.push({ name: `library-${lang}-light`, q: { scene: "library", lang, theme: "light" } });
  SHOTS.push({
    name: `library-cmdk-${lang}-light`,
    q: { scene: "library", lang, theme: "light" },
    after: async (page) => {
      // On macOS the menu bar owns ⌘K (NSMenu key equivalent) and forwards it
      // as a `menu://command` event — the harness exposes that same event.
      await page.evaluate(() => window.__MENU_COMMAND__("nav.jumpTo"));
      await new Promise((r) => setTimeout(r, 250));
      if (process.env.CMDK_QUERY !== "") {
        await page.keyboard.type(process.env.CMDK_QUERY ?? (lang === "zh" ? "續約" : "renew"), { delay: 30 });
      }
      await new Promise((r) => setTimeout(r, 600));
    },
  });
  SHOTS.push({ name: `home-${lang}-light`, q: { scene: "home", lang, theme: "light" } });
}
SHOTS.push({ name: "live-zh-dark", q: { scene: "live", lang: "zh", theme: "dark" } });

const filters = process.argv.slice(2);
const selected = filters.length ? SHOTS.filter((s) => filters.some((f) => s.name.startsWith(f))) : SHOTS;

// ── tiny static server over ../dist ─────────────────────────────────────────
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(DIST, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TEXT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--font-render-hinting=none", "--hide-scrollbars", "--force-color-profile=srgb"],
});

let failures = 0;
try {
  for (const shot of selected) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setUserAgent(MAC_UA);
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: shot.q.theme === "dark" ? "dark" : "light" },
    ]);
    const problems = [];
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const u = req.url();
      if (u.startsWith(origin) || u.startsWith("data:") || u.startsWith("blob:")) req.continue();
      else {
        problems.push(`blocked request: ${u}`);
        req.abort();
      }
    });
    page.on("response", (r) => {
      if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`);
    });

    const qs = new URLSearchParams(shot.q).toString();
    await page.goto(`${origin}/index.html?${qs}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => window.__SHOT_READY__ === true, { timeout: 20000 });
    if (shot.after) await shot.after(page);

    const log = await page.evaluate(() => window.__SHOT_LOG__ ?? []);
    const toasts = await page.$$eval("[data-sonner-toast]", (els) => els.map((e) => e.textContent));
    const text = await page.evaluate(() => {
      const attrs = [...document.querySelectorAll("[aria-label],[title],[placeholder]")].map((el) =>
        ["aria-label", "title", "placeholder"].map((a) => el.getAttribute(a)).filter(Boolean).join(" | "),
      );
      return `${document.body.innerText}\n--- attributes ---\n${attrs.join("\n")}`;
    });
    fs.writeFileSync(path.join(TEXT, `${shot.name}.txt`), text);
    const png = path.join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: png, omitBackground: true });
    const jpgFull = path.join(OUT, `${shot.name}.full.jpg`);
    await page.screenshot({ path: jpgFull, type: "jpeg", quality: 92 });
    const jpg = path.join(OUT, `${shot.name}.jpg`);
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "2000", jpgFull, "--out", jpg], {
      stdio: "ignore",
    });
    fs.rmSync(jpgFull);

    const notes = [...log, ...problems, ...toasts.map((t) => `toast: ${t}`)];
    console.log(`${shot.name}: ${notes.length ? "\n  " + notes.join("\n  ") : "ok"}`);
    if (toasts.length || problems.some((p) => p.startsWith("pageerror"))) failures++;
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
if (failures) {
  console.error(`${failures} shot(s) had errors or toasts — inspect before using.`);
  process.exitCode = 1;
}
