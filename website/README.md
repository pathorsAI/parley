# parley.tw

The official site for Parley: a static site with a tiny, dependency-free build.
Traditional Chinese is the main site at `/`, English is at `/en/`, and the two
carry the same content — the zh-TW copy is written as a peer, not translated
after the fact.

```
website/
  src/
    home.html          # the home page template (one file, both languages)
    i18n/zh-TW.json    # every string on the home page, zh-TW
    i18n/en.json       # …and English; the key sets must be identical
    rms.json           # hero waveform data, per language (see "Hero waveform")
  styles.css           # the whole look: tokens, light + dark, responsive
  script.js            # progressive enhancement only (see below)
  site.config.json     # build settings (analytics token)
  assets/              # fonts, screenshots, OG cards, logos, the Play badge
  support/ privacy/ account-deletion/   # legal pages, copied as-is (bilingual, own toggle)
  legal.css legal.js   # their styles and language toggle
  sitemap.xml robots.txt CNAME
  tools/               # generators for the screenshots, OG cards and waveform (not deployed)
```

## Build and preview

```bash
bun scripts/build-website.ts                      # → _site/ (gitignored)
python3 -m http.server -d _site 4178              # open http://localhost:4178 and /en/
```

Stop the server when you are done. The build:

- renders `src/home.html` twice, into `_site/index.html` (`lang="zh-Hant-TW"`) and
  `_site/en/index.html` (`lang="en"`), each with its own title, description, canonical URL,
  `hreflang` alternates (zh-Hant-TW, en, x-default → `/`), Open Graph/Twitter card and image,
  and schema.org `SoftwareApplication` JSON-LD;
- copies everything else under `website/` into `_site/`, except `src/`, `tools/`, this README
  and `site.config.json`;
- **fails** if the two dictionaries have different keys, if the template uses a key that does
  not exist, if a key is never used, or if any `{{…}}` survives rendering.

`tests/website-build.test.ts` runs the build into a temp dir as part of `bunx vitest run`.
The deploy workflow (`.github/workflows/deploy-website.yml`) runs the same build and publishes
`_site/` to GitHub Pages on every push to `main` that touches `website/` or the build script.

## Changing the copy

Every visible string on the home page lives in `src/i18n/zh-TW.json` and `src/i18n/en.json`.

1. Add the key to **both** files. Values are HTML (`<b>`, `<br>`, `<kbd>`, `<span class="ts">`
   are used); escape a literal `&` as `&amp;`.
2. Use it in `src/home.html`: `{{my.key}}` inserts the HTML, `{{my.key|attr}}` inserts it
   escaped for an attribute (tags stripped) — use that for `alt`, `aria-label` and `content`.
3. `bun scripts/build-website.ts` tells you about anything missing or unused.

Values computed by the build are written `{{@name}}` (`@base` for asset paths that also work
from `/en/`, `@lang`, `@canonical`, …). Comments that start with `<!--#` are template notes and
are stripped from the output.

The English hero line is the product's long-standing headline; the zh-TW one is its peer. Do
not publish free-tier numbers — the wording is "a free allowance that covers everyday use".
Retired features (live translation, interpreter, the intel board, scenarios, job-interview or
diligence use cases) must not come back; the test suite checks for them.

## What script.js does

The page is complete without JavaScript: the Mac download is the default call to action, the
hero transcript is shown in full and every section is visible. With it:

- **OS-aware downloads** — iPhone/iPad visitors get the App Store first, Android visitors
  Google Play, Windows visitors the Windows installer, everyone else the Mac. The download row
  reorders itself the same way. The Google Play badge is Google's unmodified artwork and is
  never restyled into a button.
- **Language suggestion** — no redirect. If the browser's language disagrees with the page, a
  thin bar offers the other language; dismissing it is remembered in `localStorage`.
- **Hero demo** — the transcript types itself in time with a canvas waveform, speakers resolve
  from "…" to 講者 A/B (Speaker A/B), unsettled words stay grey. The demo is `aria-hidden`; a
  visually hidden copy of the two lines is there for screen readers.
- **A 160ms fade** as sections scroll into view (opacity only), the copy button on the MCP
  command, the small-screen menu.

`prefers-reduced-motion` gets the full transcript, a static waveform and no fades.

## Hero waveform

`src/rms.json` is the **measured loudness of synthesized speech of the exact two hero lines**,
not a drawing. `tools/hero-rms/generate.py` (macOS) speaks `demo.line1` and `demo.line2` with
`say` (zh: Meijia, en: Samantha), converts them to 16 kHz mono with `afconvert`, takes the RMS
of every 85 ms hop (the cadence of the iOS `WaveformView`), normalises to `(x / max)^0.6`, and
puts ten samples of true silence between the two turns. The page uses those zeros as the turn
boundary, so the text only advances while someone is talking.

Change either hero line → regenerate, then rebuild:

```bash
python3 website/tools/hero-rms/generate.py
```

## Screenshots

Desktop screenshots are rendered from the real app frontend by the harness in
`tools/desktop-shots/` (see its README). The iPhone ones are the App Store screenshots in
`ios/AppStore/screenshots/{zh-Hant,en-US}/`. To refresh what the site shows:

```bash
# 1. desktop: render → website/tools/desktop-shots/out/
cd website/tools/desktop-shots && (cd shooter && bun install) \
  && ../../../node_modules/.bin/vite build --config vite.config.ts \
  && node shooter/shoot.mjs live report library && cd -

# 2. publish web versions (each file must stay under 250 KB)
O=website/tools/desktop-shots/out; A=website/assets/shots
for l in zh en; do for s in live report; do
  cwebp -q 82 -m 6 -resize 2000 0 $O/$s-$l-light.png -o $A/desktop-$s-$l.webp
  cp $O/$s-$l-light.jpg $A/desktop-$s-$l.jpg
done; done
cp $O/library-en-light.jpg $A/desktop-library-en.jpg     # used by the repo README

for l in zh:zh-Hant en:en-US; do for s in record:02-record library:03-library; do
  cwebp -q 82 -m 6 -resize 600 0 ios/AppStore/screenshots/${l#*:}/${s#*:}.png -o $A/iphone-${s%%:*}-${l%%:*}.webp
  sips -s format jpeg -s formatOptions 80 -Z 1304 ios/AppStore/screenshots/${l#*:}/${s#*:}.png --out $A/iphone-${s%%:*}-${l%%:*}.jpg
done; done
```

Screenshots stay light in the site's dark mode; they are framed with a hairline and a soft
shadow. The desktop harness uses fictional demo data (北風工業 / Northwind, 晴光實驗室 /
Halcyon Labs, 子午線 / Meridian).

## Open Graph cards

`assets/og-zh.png` and `assets/og-en.png` (1200×630) are rendered from `tools/og/og.html`,
filled with the hero strings and waveform data, by headless Chrome:

```bash
node website/tools/og/render.mjs
```

## Fonts

DM Sans (UI) and Alexandria (wordmark, timer) are self-hosted woff2 files in
`assets/fonts/`, copied from the repo's `@fontsource-variable/*` packages; no font CDN is used.
Chinese falls back to the system (PingFang TC, Noto Sans TC, Microsoft JhengHei). Both fonts are
under the SIL Open Font License 1.1 — see `assets/fonts/LICENSE-OFL.txt`.

## Analytics

The site uses Cloudflare Web Analytics, which sets no cookies. The build adds Cloudflare's
beacon to `<head>` only when `site.config.json` has a `cloudflareWebAnalyticsToken`; with an
empty string the pages ship with no analytics at all. The token is public (it is visible in the
page source). The privacy page describes what is collected.

## Deploying to GitHub Pages

1. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main` (any change under `website/` or to `scripts/build-website.ts`), or run
   **Deploy website** from the Actions tab.

## Custom domain with Cloudflare

The site is served at **`parley.tw`** (apex) via GitHub Pages + Cloudflare DNS.
To reproduce or move it:

1. **Tell GitHub the domain.** `website/CNAME` contains just the hostname (`parley.tw`); the
   build copies it into `_site/`, so every deploy keeps it.
2. **Add the DNS record in Cloudflare** (DNS → Records): `CNAME` `@` → `pathorsai.github.io`
   (Cloudflare flattens it), or GitHub's four A records `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153`, `185.199.111.153`.
3. **Proxy + SSL.** The record can stay **Proxied**. Set Cloudflare **SSL/TLS → Overview →
   Full** (not Flexible, which loops with Pages). In GitHub **Settings → Pages**, wait for the
   domain check and tick **Enforce HTTPS**. If that box is greyed out the first time, set the
   record to **DNS only** until GitHub issues the certificate, then flip it back.

The legal pages' URLs (`/support/`, `/privacy/`, `/account-deletion/`) are hard-coded in the
iOS and Android apps and in the store listings: do not move them.
