#!/usr/bin/env python3
"""Draw the voice-typing screen: a chat app with the Parley keyboard dictating.

usage: draw-voice-typing.py <fonts_dir> <raw_dir>   → <raw_dir>/<locale>/voice.png (1320x2868)

The status bar is the real one, cut from <raw_dir>/<locale>/library.png, so run
this after the captures.

A drawing, not a capture: the keyboard extension cannot be shown inside the
demo app, and a capture of another company's messaging app is not ours to sell
with. Proportions follow the real keyboard's voice pane (KeyboardTheme metrics
at 3x): strip, round record button with the brand gradient, @ and ✕ on the
left, delete and return on the right.
"""
import pathlib, subprocess, sys, tempfile, time

fonts, out = map(pathlib.Path, sys.argv[1:3])
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

COPY = {
    "zh-Hant": dict(name="林經理", inbound=["明天的會議改到幾點？", "要我先準備什麼嗎？"],
                    outbound="下午三點在你們辦公室。", typed="報價單我今天先寄給你，",
                    partial="順便附上資安問卷", tabs=["英文", "注音"], hint="聆聽中"),
    "en-US": dict(name="Anna Lin", inbound=["What time is tomorrow's meeting?", "Anything I should prep?"],
                  outbound="3 pm at your office.", typed="I'll send the quote over today, ",
                  partial="with the security questionnaire", tabs=["ABC", "注音"], hint="Listening"),
}

MIC = '<svg viewBox="0 0 24 24" width="{s}" height="{s}"><rect x="9" y="3" width="6" height="11" rx="3" fill="{c}"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4" stroke="{c}" stroke-width="2" fill="none" stroke-linecap="round"/></svg>'

PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:DM;src:url('{fonts}/DMSans-Medium.ttf');font-weight:500}}
@font-face{{font-family:DM;src:url('{fonts}/DMSans-SemiBold.ttf');font-weight:600}}
@font-face{{font-family:DM;src:url('{fonts}/DMSans-Regular.ttf');font-weight:400}}
*{{box-sizing:border-box}}
html,body{{margin:0;width:1320px;height:2868px;background:#fff;overflow:hidden;
  font-family:DM,"PingFang TC",sans-serif;color:#111318}}
.status{{position:absolute;top:58px;left:150px;right:120px;display:flex;justify-content:space-between;
  font:600 52px DM}}
.island{{position:absolute;top:34px;left:50%;width:380px;height:112px;margin-left:-190px;
  background:#000;border-radius:60px}}
.head{{position:absolute;top:200px;left:0;right:0;height:230px;border-bottom:2px solid #ECEEF1;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}}
.av{{width:120px;height:120px;border-radius:60px;background:#E6E8EC;display:flex;align-items:center;
  justify-content:center;font:600 50px DM,"PingFang TC";color:#6B7280}}
.nm{{font:500 40px DM,"PingFang TC"}}
.back{{position:absolute;left:52px;top:80px;font:400 90px DM;color:#1469D4}}
.chat{{position:absolute;top:500px;left:60px;right:60px;display:flex;flex-direction:column;gap:26px}}
.b{{max-width:900px;padding:34px 46px;border-radius:56px;font:400 50px/1.35 DM,"PingFang TC"}}
.in{{align-self:flex-start;background:#EEF0F3}}
.out{{align-self:flex-end;background:#1469D4;color:#fff}}
.field{{position:absolute;left:44px;right:44px;top:1560px;min-height:150px;border:3px solid #E1E4E8;
  border-radius:75px;padding:38px 56px;font:400 50px/1.4 DM,"PingFang TC"}}
.field .p{{color:#9CA3AF}}
.caret{{display:inline-block;width:5px;height:58px;background:#1469D4;vertical-align:-10px;margin-left:4px}}
.kb{{position:absolute;left:0;right:0;bottom:0;height:1000px;background:#D5D8DE;border-radius:60px 60px 0 0}}
.strip{{position:absolute;top:34px;left:44px;right:44px;height:100px;display:flex;align-items:center;
  justify-content:space-between}}
.brand{{font:600 44px DM;color:#1469D4}}
.tabs{{display:flex;gap:10px;background:#C4C8CF;border-radius:50px;padding:8px}}
.tab{{padding:12px 34px;border-radius:40px;font:500 40px DM,"PingFang TC";color:#3A4049;display:flex;align-items:center}}
.tab.on{{background:#fff}}
.hint{{position:absolute;top:200px;left:0;right:0;text-align:center;font:500 44px DM,"PingFang TC";color:#4B525D}}
.rec{{position:absolute;top:300px;left:50%;width:330px;height:330px;margin-left:-165px;border-radius:50%;
  background:linear-gradient(135deg,#1469D4,#2DB6F3);box-shadow:0 0 0 34px rgba(20,105,212,.13),0 0 0 76px rgba(20,105,212,.07);
  display:flex;align-items:center;justify-content:center;gap:16px}}
.rec i{{display:block;width:16px;border-radius:8px;background:#fff}}
.disc{{position:absolute;width:150px;height:150px;border-radius:50%;background:#EEF0F3;display:flex;align-items:center;
  justify-content:center;font:500 58px DM;color:#3A4049}}
.foot{{position:absolute;bottom:60px;left:80px;right:80px;display:flex;justify-content:space-between;align-items:center}}
</style></head><body>
<img src="{statusbar}" style="position:absolute;top:0;left:0;width:1320px;height:2868px;clip-path:inset(0 0 2693px 0)">

<div class="head"><div class="back">‹</div><div class="av">{initial}</div><div class="nm">{name}</div></div>
<div class="chat">{bubbles}</div>
<div class="field">{typed}<span class="p">{partial}</span><span class="caret"></span></div>
<div class="kb">
  <div class="strip"><span class="brand">Parley</span>
    <div class="tabs"><span class="tab on">{mic_small}</span><span class="tab">{tab1}</span><span class="tab">{tab2}</span></div></div>
  <div class="hint">{hint}</div>
  <div class="rec"><i style="height:70px"></i><i style="height:130px"></i><i style="height:190px"></i><i style="height:110px"></i><i style="height:160px"></i><i style="height:80px"></i></div>
  <div class="disc" style="left:90px;top:330px">@</div>
  <div class="disc" style="left:90px;top:520px">✕</div>
  <div class="disc" style="right:90px;top:330px">⌫</div>
  <div class="disc" style="right:90px;top:520px">⏎</div>
  <div class="foot"><svg viewBox="0 0 24 24" width="72" height="72" fill="none" stroke="#3A4049" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>{mic_big}</div>
</div>
</body></html>"""

for locale, c in COPY.items():
    bubbles = "".join(f'<div class="b in">{t}</div>' for t in c["inbound"]) + f'<div class="b out">{c["outbound"]}</div>'
    doc = PAGE.format(fonts=fonts.resolve().as_uri(), statusbar=(out / locale / "library.png").resolve().as_uri(), initial=c["name"][0], name=c["name"], bubbles=bubbles,
                      typed=c["typed"], partial=c["partial"], tab1=c["tabs"][0], tab2=c["tabs"][1], hint=c["hint"],
                      mic_small=MIC.format(s=44, c="#1469D4"), mic_big=MIC.format(s=72, c="#3A4049"))
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as t:
        t.write(doc)
    dest = out / locale / "voice.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    render(t.name, dest, 1320, 2868)
    print(dest)
