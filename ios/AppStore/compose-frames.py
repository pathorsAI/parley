#!/usr/bin/env python3
"""App Store frames: headline, the phone in a bezel, callouts that point at the UI.

The store page sells, so it is allowed more than the app: navy, brand-blue and
light-grey grounds in turn, one word of each headline in the accent colour, and
white tags that name what the screen shows. The screens themselves are the
app's own demo-mode captures, except 02 (drawn by draw-voice-typing.py, because
the keyboard cannot appear inside the demo app) and 07 (a drawn iPhone-to-Mac
diagram).

usage: compose2.py <raw_dir> <out_dir> <fonts_dir> <frames.json>

frames.json: list of
  {"out": "01-record", "raw": "record", "bg": "navy|blue|white",
   "title": {"zh-Hant": "...<em>word</em>...", "en-US": "..."},
   "callouts": [{"y": 520, "side": "left|right", "text": {"zh-Hant": "...", "en-US": "..."}}],
   "kind": "phone" | "diagram"}
Callout y is in raw-capture pixels (the 1320x2868 screenshot), so it points at
the element it names whatever the frame layout does.
"""
import time, html, json, pathlib, subprocess, sys, tempfile

raw_dir, out_dir, fonts_dir, frames_file = map(pathlib.Path, sys.argv[1:5])
frames = json.loads(frames_file.read_text(encoding="utf-8"))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def render(html_path, out_png, w, h):
    """Headless Chrome screenshot. Each call gets its own throwaway profile —
    back-to-back runs sharing the default one fail now and then on its lock —
    and a failed call is retried twice before giving up."""
    for attempt in range(3):
        with tempfile.TemporaryDirectory() as profile:
            done = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                                   "--allow-file-access-from-files", f"--user-data-dir={profile}",
                                   f"--window-size={w},{h}", "--force-device-scale-factor=1",
                                   f"--screenshot={out_png}", pathlib.Path(html_path).as_uri()],
                                  capture_output=True, timeout=120)
        if done.returncode == 0:
            return
        time.sleep(2 * (attempt + 1))
    raise SystemExit(f"Chrome could not render {out_png}: {done.stderr.decode(errors='replace')[-400:]}")
W, H = 1320, 2868
BG = {"navy": ("#0C1620", "#FFFFFF", "#2DB6F3"),
      "blue": ("#1469D4", "#FFFFFF", "#BFE6FF"),
      "white": ("#F4F6F9", "#111318", "#1469D4")}
PHONE_W, BEZEL, SCREEN_R = 1000, 24, 100
SCREEN_W = PHONE_W - 2 * BEZEL
SCALE = SCREEN_W / W

CSS = """
@font-face{{font-family:DM;src:url('{f}/DMSans-Bold.ttf');font-weight:700}}
@font-face{{font-family:DM;src:url('{f}/DMSans-SemiBold.ttf');font-weight:600}}
@font-face{{font-family:DM;src:url('{f}/DMSans-Medium.ttf');font-weight:500}}
*{{box-sizing:border-box}}
html,body{{margin:0;width:{W}px;height:{H}px;background:{bg};overflow:hidden;font-family:DM,"PingFang TC",sans-serif}}
h1{{position:absolute;top:190px;left:80px;right:80px;margin:0;text-align:center;color:{ink};
  font-weight:700;font-size:{size}px;line-height:1.18;letter-spacing:-.015em}}
h1 em{{font-style:normal;color:{accent}}}
.phone{{position:absolute;left:{pl}px;top:{pt}px;width:{PW}px;padding:{B}px;background:#0B0D10;
  border-radius:{PR}px;box-shadow:0 60px 120px rgba(0,0,0,.28),inset 0 0 0 3px #2A2F36}}
.phone img{{display:block;width:100%;border-radius:{SR}px}}
.co{{position:absolute;display:flex;align-items:center;gap:22px;padding:30px 44px;border-radius:999px;
  background:#FFFFFF;color:#111318;font-weight:600;font-size:{cs}px;white-space:nowrap;
  box-shadow:0 24px 60px rgba(8,20,40,.22)}}
.co b{{width:22px;height:22px;border-radius:50%;background:#1469D4;flex:none}}
"""

def phone_frame(f, locale, bg, ink, accent):
    title = f["title"][locale]
    lines = title.count("<br>") + 1
    size = 112 if locale.startswith("zh") else 100
    pt = 190 + int(size * 1.18 * lines) + 120
    pl = (W - PHONE_W) // 2
    img = (raw_dir / locale / f"{f['raw']}.png").resolve().as_uri()
    cs = 52 if locale.startswith("zh") else 46
    cos = []
    for c in f.get("callouts", []):
        y = pt + BEZEL + int(c["y"] * SCALE) - 50
        pos = "left:40px" if c["side"] == "left" else "right:40px"
        cos.append(f'<div class="co" style="top:{y}px;{pos}"><b></b>{html.escape(c["text"][locale])}</div>')
    css = CSS.format(f=fonts_dir.resolve().as_uri(), W=W, H=H, bg=bg, ink=ink, accent=accent, size=size,
                     pl=pl, pt=pt, PW=PHONE_W, B=BEZEL, PR=SCREEN_R + BEZEL, SR=SCREEN_R, cs=cs)
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{css}</style></head><body>
<h1>{title}</h1><div class="phone"><img src="{img}"></div>{''.join(cos)}</body></html>"""

def diagram_frame(f, locale, bg, ink, accent):
    """iPhone on the left, the Mac's report on the right, the sync between them."""
    title = f["title"][locale]
    zh = locale.startswith("zh")
    size = 112 if zh else 100
    css = CSS.format(f=fonts_dir.resolve().as_uri(), W=W, H=H, bg=bg, ink=ink, accent=accent, size=size,
                     pl=0, pt=0, PW=0, B=0, PR=0, SR=0, cs=48)
    img = (raw_dir / locale / f"{f['raw']}.png").resolve().as_uri()
    t = f["diagram"][locale]
    bars = "".join(f'<div class="row"><span>{html.escape(k)}</span><i style="width:{v}%"></i></div>' for k, v in t["bars"])
    items = "".join(f"<li>{html.escape(x)}</li>" for x in t["items"])
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{css}
.mac{{position:absolute;left:90px;right:90px;top:740px;height:1060px;background:#fff;border-radius:40px;
  border:18px solid #0B0D10;box-shadow:0 60px 130px rgba(0,0,0,.32);padding:70px 80px 0 80px;overflow:hidden}}
.mac h3{{margin:0 0 12px;font:700 50px/1.25 DM,"PingFang TC";color:#111318}}
.mac .sub{{font:500 32px DM,"PingFang TC";color:#6B7280;margin-bottom:44px}}
.mac ul{{margin:0 0 50px;padding-left:36px;font:500 36px/1.7 DM,"PingFang TC";color:#3A4049}}
.row{{max-width:560px;display:flex;align-items:center;gap:26px;margin:22px 0;font:600 32px DM,"PingFang TC";color:#3A4049}}
.row span{{width:190px;flex:none}}
.row i{{display:block;height:24px;border-radius:12px;background:#1469D4}}
.base{{position:absolute;left:30px;right:30px;top:1800px;height:56px;background:#C9CED6;border-radius:0 0 50px 50px}}
.mini{{position:absolute;right:70px;top:1330px;width:450px;padding:16px;background:#0B0D10;border-radius:76px;
  box-shadow:0 50px 110px rgba(0,0,0,.35)}}
.mini img{{width:100%;display:block;border-radius:62px}}
.pill{{position:absolute;left:110px;top:1980px;display:flex;align-items:center;gap:20px;padding:26px 44px;border-radius:999px;
  background:#fff;color:#111318;font:600 46px DM,"PingFang TC";box-shadow:0 24px 60px rgba(8,20,40,.25)}}
.pill b{{width:22px;height:22px;border-radius:50%;background:#1469D4}}
.cap{{position:absolute;left:80px;right:80px;top:2500px;text-align:center;font:500 54px/1.55 DM,"PingFang TC";color:{ink};opacity:.92}}
</style></head><body>
<h1>{title}</h1>
<div class="mac"><h3>{html.escape(t["mac_title"])}</h3><div class="sub">{html.escape(t["mac_sub"])}</div><ul>{items}</ul>{bars}</div>
<div class="base"></div>
<div class="mini"><img src="{img}"></div>
<div class="pill"><b></b>{html.escape(t["sync"])}</div>
<div class="cap">{t["caption"]}</div>
</body></html>"""

for f in frames:
    bg, ink, accent = BG[f["bg"]]
    for locale in ("zh-Hant", "en-US"):
        doc = (diagram_frame if f.get("kind") == "diagram" else phone_frame)(f, locale, bg, ink, accent)
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as t:
            t.write(doc)
        out = out_dir / locale / f"{f['out']}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        render(t.name, out, W, H)
        print(out)
