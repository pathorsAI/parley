#!/usr/bin/env python3
"""Put each store frame's headline above its raw simulator capture.

    compose-frames.py <raw_dir> <out_dir> <fonts_dir> <captions.json>

raw_dir holds <locale>/<frame>.png at 1320×2868 (what capture-screenshots.sh
shoots); captions.json maps <frame> → {<locale>: headline}, with <br> where the
line should break. Writes <out_dir>/<locale>/<frame>.png at the same size.

The page is the app's own: white, ink headline in DM Sans, the wordmark in
Alexandria and the brand blue, the capture under a hairline and a soft shadow.
No gradient and no device bezel — a bezel would put a second phone frame round
a screenshot that already has the Dynamic Island in it. Rendered by headless
Chrome because it is the one renderer on a Mac that shapes mixed Chinese and
Latin text the way the app does (PingFang for the CJK, DM Sans for the rest).
"""
import html, json, pathlib, subprocess, sys, tempfile

raw_dir, out_dir, fonts_dir, captions_file = map(pathlib.Path, sys.argv[1:5])
captions = json.loads(captions_file.read_text(encoding="utf-8"))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
W, H = 1320, 2868
TITLE_TOP, LINE = 250, 1.22

PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:DM;src:url('{fonts}/DMSans-Bold.ttf');font-weight:700}}
@font-face{{font-family:Alex;src:url('{fonts}/Alexandria-Bold.ttf');font-weight:700}}
html,body{{margin:0;width:{W}px;height:{H}px;background:#FFFFFF;overflow:hidden}}
.mark{{position:absolute;top:150px;left:0;right:0;text-align:center;
  font:700 44px Alex;color:#1469D4;letter-spacing:.01em}}
h1{{position:absolute;top:{top}px;left:90px;right:90px;margin:0;text-align:center;
  font:700 {size}px/{line} DM,"PingFang TC",sans-serif;color:#111318;letter-spacing:-.01em}}
.shot{{position:absolute;left:50%;top:{shot_top}px;width:1120px;transform:translateX(-50%);
  border-radius:78px;overflow:hidden;box-shadow:0 0 0 2px #E6E8EC,0 40px 90px rgba(17,19,24,.10)}}
.shot img{{display:block;width:100%}}
</style></head><body>
<div class="mark">Parley</div><h1>{title}</h1>
<div class="shot"><img src="{img}"></div>
</body></html>"""

for frame, by_locale in captions.items():
    for locale, title in by_locale.items():
        size = 104 if locale.startswith("zh") else 96
        lines = title.count("<br>") + 1
        shot_top = TITLE_TOP + int(size * LINE * lines) + 110
        raw = raw_dir / locale / f"{frame}.png"
        out = out_dir / locale / f"{frame}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        doc = PAGE.format(fonts=fonts_dir.resolve().as_uri(), W=W, H=H, top=TITLE_TOP,
                          size=size, line=LINE, shot_top=shot_top,
                          title=html.escape(title).replace("&lt;br&gt;", "<br>"),
                          img=raw.resolve().as_uri())
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as t:
            t.write(doc)
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        "--allow-file-access-from-files", f"--window-size={W},{H}",
                        "--force-device-scale-factor=1", f"--screenshot={out}",
                        pathlib.Path(t.name).as_uri()],
                       check=True, capture_output=True, timeout=120)
        print(f"   {locale}/{frame}.png")
