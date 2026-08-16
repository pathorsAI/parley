#!/usr/bin/env bash
#
# Capture the App Store screenshot set for every shipping locale.
#
#   ios/AppStore/capture-screenshots.sh                 # build, then capture
#   ios/AppStore/capture-screenshots.sh --no-build      # reuse the last build
#   ios/AppStore/capture-screenshots.sh --device "iPhone 17 Pro Max"
#
# Frames come out of a DEBUG-only demo mode (App/Parley/ScreenshotDemo.swift):
# the app is launched with `-ParleyDemo signedIn -ParleyDemoRoute <route>`,
# serves fixed fictional fixtures instead of the cloud, and lands on the screen
# the frame needs before it draws. Nothing here needs the review account, a
# network, or a single tap — so the same command reproduces the same pixels next
# release.
#
# Default device is the iPhone 17 Pro Max because its native 1320×2868 is
# exactly the App Store 6.9-inch slot: no rescaling step, no aspect drift.

set -euo pipefail

DEVICE="iPhone 17 Pro Max"
BUILD=1
BUNDLE_ID="com.pathors.parley.ios"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(dirname "$HERE")"
DERIVED="$IOS_DIR/App/.build-screenshots"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) BUILD=0; shift ;;
    --device) DEVICE="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# locale key : AppleLanguages : AppleLocale
LOCALES=(
  "en-US:en:en_US"
  "zh-Hant:zh-Hant:zh_TW"
)

# file name : demo route ("-" = no route, capture whatever the app opens on)
FRAMES=(
  "01-welcome:-"
  "02-record:record"
  "03-library:library"
  "04-transcript:transcript"
  "05-voice-keyboard:keyboard"
  "06-settings:settings"
)

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }

say "Booting $DEVICE"
UDID="$(xcrun simctl list devices available -j \
  | python3 -c "
import json,sys
name=sys.argv[1]
for runtime in json.load(sys.stdin)['devices'].values():
    for d in runtime:
        if d['name']==name:
            print(d['udid']); raise SystemExit
raise SystemExit('no available simulator named '+name)
" "$DEVICE")"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b

if [[ $BUILD -eq 1 ]]; then
  say "Building Parley (Debug — demo mode is #if DEBUG)"
  (cd "$IOS_DIR/App" && xcodegen generate >/dev/null)
  xcodebuild -project "$IOS_DIR/App/Parley.xcodeproj" -scheme Parley \
    -destination "id=$UDID" -derivedDataPath "$DERIVED" \
    -quiet build
fi

APP="$(find "$DERIVED/Build/Products" -name 'Parley.app' -maxdepth 3 | head -1)"
[[ -n "$APP" ]] || { echo "no Parley.app under $DERIVED — run without --no-build" >&2; exit 1; }

say "Installing $APP"
xcrun simctl install "$UDID" "$APP"

# A believable, constant status bar. Without this the frames carry whatever
# time and battery the machine happened to have, and Apple's own screenshots
# have set 9:41 since 2007.
xcrun simctl status_bar "$UDID" override \
  --time "9:41" --batteryState charged --batteryLevel 100 \
  --cellularMode active --cellularBars 4 --wifiMode active --wifiBars 3 \
  --dataNetwork wifi

# The app follows the system appearance, so without this the set is light or
# dark depending on how the simulator was last left — half the reason a
# "re-capture" could come back looking like a different product. The shipping
# set is light.
xcrun simctl ui "$UDID" appearance light

capture() {  # $1 = destination png
  # Let the frame settle before the shutter: navigation animations and the
  # transcript's scroll-to-bottom both land within a beat.
  sleep 2
  xcrun simctl io "$UDID" screenshot --type=png "$1" >/dev/null
}

for entry in "${LOCALES[@]}"; do
  IFS=: read -r locale lang region <<<"$entry"
  outdir="$HERE/screenshots/$locale"
  mkdir -p "$outdir"
  say "Capturing $locale"

  for frame in "${FRAMES[@]}"; do
    IFS=: read -r name route <<<"$frame"
    mode="signedIn"
    [[ "$name" == "01-welcome" ]] && mode="signedOut"

    # One cold launch per frame, with the route as a launch argument.
    #
    # DO NOT "optimise" this back into one launch plus five `simctl openurl`
    # calls. It was written that way, and as of the iOS 26.5 simulator runtime
    # SpringBoard interposes an "Open in "Parley"?" confirmation on every
    # incoming URL. `simctl` cannot dismiss it, so all five routed frames came
    # out as the launch tab dimmed behind a modal — at the right dimensions,
    # which is precisely why nobody noticed. A launch argument is read inside
    # the process; SpringBoard never gets a say. Relaunching costs ~4s a frame.
    launch_args=(-ParleyDemo "$mode" -AppleLanguages "($lang)" -AppleLocale "$region")
    if [[ "$route" != "-" ]]; then
      launch_args+=(-ParleyDemoRoute "$route")
    fi

    xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
    xcrun simctl launch "$UDID" "$BUNDLE_ID" "${launch_args[@]}" >/dev/null

    # Always wait out the cold launch. `UILaunchScreen: {}` is a blank white
    # screen, and shooting into it produced an all-white "welcome" frame that
    # still had the right dimensions — the dimension check passes, the frame is
    # useless, and nobody notices until it is on the store.
    sleep 4

    capture "$outdir/$name.png"
    printf '   %s/%s.png\n' "$locale" "$name"
  done
done

xcrun simctl status_bar "$UDID" clear
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true

say "Verifying frames"
verify_args=("$HERE/screenshots")
for entry in "${LOCALES[@]}"; do verify_args+=("${entry%%:*}"); done
verify_args+=("--")
for frame in "${FRAMES[@]}"; do verify_args+=("${frame%%:*}"); done

python3 - "${verify_args[@]}" <<'PY'
# What this checks, and what it cannot.
#
# The old version checked 1320×2868 and "not a uniform white rectangle", and
# that is how a whole release's worth of frames came out as the same Record
# screen behind an "Open in "Parley"?" alert and still passed. Right size, not
# blank, completely wrong picture. So the checks below are relative — every
# frame is compared against the others, which is what makes "they are all the
# same screen" visible without teaching the script what any screen looks like.
#
# Catches: a missing frame; the wrong slot dimensions; a frame shot into the
# blank launch screen; two frames of the same locale that are the same picture
# (routing silently not applied, a modal pinning several frames to one screen,
# a stale file left behind by a partial run); and a locale pair where the same
# frame is pixel-for-pixel identical across en-US and zh-Hant, which means the
# language argument did not take.
#
# Does NOT catch: a modal or a wrong screen that happens to differ from every
# other frame — one frame stuck behind an alert while the other five are fine
# still passes. Nor clipped text, a missing font, a wrong colour, or English
# copy inside a Chinese layout. Those need eyes; look at the PNGs.
import pathlib, struct, subprocess, sys, tempfile, zlib

argv = sys.argv[1:]
root = pathlib.Path(argv[0])
split = argv.index("--")
locales, frames = argv[1:split], argv[split + 1:]

SLOT = (1320, 2868)
GRID = (44, 96)  # w, h — coarse enough to ignore antialiasing, fine enough to
#                  separate two screens that share a chrome
# Thresholds, with the margin measured on the shipping set (2026-08-17) so a
# future tweak can see how much room it is eating into:
BLANK_SIGMA = 0.05  # blankest real frame: σ=0.111
SAME_SCREEN = 0.02  # closest two frames of one locale: Δ=0.038
LOCALE_DELTA = 0.002  # closest en/zh pair of one frame: Δ=0.019


def png_gray(path):
    """A GRID-sized greyscale thumbnail, 0..1, using only sips and the stdlib.

    sips does the resampling (it is the one image tool macOS is guaranteed to
    have); the thumbnail is then small enough that decoding the PNG by hand
    costs nothing. Adding numpy/Pillow here would make the screenshot set
    un-verifiable on a clean machine, which is the opposite of the point.
    """
    with tempfile.TemporaryDirectory() as tmp:
        small = pathlib.Path(tmp) / "s.png"
        subprocess.run(
            ["sips", "--resampleHeightWidth", str(GRID[1]), str(GRID[0]),
             str(path), "--out", str(small)],
            check=True, capture_output=True)
        data = small.read_bytes()

    pos, idat = 8, b""
    while pos < len(data):
        (length,), kind = struct.unpack(">I", data[pos:pos + 4]), data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            w, h, depth, colour = struct.unpack(">IIBB", body[:10])
            interlace = body[12]
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    if depth != 8 or interlace or colour not in (0, 2, 4, 6):
        raise SystemExit(f"unexpected PNG from sips: depth={depth} colour={colour}")

    n = {0: 1, 2: 3, 4: 2, 6: 4}[colour]
    raw, stride = zlib.decompress(idat), w * n
    out, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - n] if i >= n else 0
            b = prev[i]
            c = prev[i - n] if i >= n else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
        prev = line
        for x in range(w):
            px = line[x * n:x * n + n]
            g = px[0] if colour in (0, 4) else 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2]
            out.append(g / 255.0)
    return out


def sigma(g):
    m = sum(g) / len(g)
    return (sum((v - m) ** 2 for v in g) / len(g)) ** 0.5


def delta(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


notes = {}  # "locale/name.png" -> [complaint, ...]
grids = {}


def complain(locale, name, note):
    notes.setdefault(f"{locale}/{name}.png", []).append(note)


for locale in locales:
    for name in frames:
        png = root / locale / f"{name}.png"
        if not png.exists():
            complain(locale, name, "missing")
            continue
        out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(png)],
                             capture_output=True, text=True).stdout
        dims = tuple(int(l.split(":")[1]) for l in out.splitlines() if "pixel" in l)
        if dims != SLOT:
            complain(locale, name, f"{dims[0]}×{dims[1]}, not the 6.9-inch slot")
        grids[(locale, name)] = g = png_gray(png)
        if sigma(g) < BLANK_SIGMA:
            complain(locale, name,
                     f"near-uniform (σ={sigma(g):.3f}) — probably the launch screen")

    # Every frame in a set is a different screen of the app; two that match are
    # one screen captured twice.
    for i, a in enumerate(frames):
        for b in frames[i + 1:]:
            if (locale, a) not in grids or (locale, b) not in grids:
                continue
            d = delta(grids[(locale, a)], grids[(locale, b)])
            if d < SAME_SCREEN:
                complain(locale, a, f"same picture as {b}.png (Δ={d:.3f}) — routing did not take")
                complain(locale, b, f"same picture as {a}.png (Δ={d:.3f}) — routing did not take")

for name in frames:
    pairs = [l for l in locales if (l, name) in grids]
    for i, a in enumerate(pairs):
        for b in pairs[i + 1:]:
            d = delta(grids[(a, name)], grids[(b, name)])
            if d < LOCALE_DELTA:
                complain(a, name, f"identical to the {b} capture (Δ={d:.4f}) — locale did not take")

for locale in locales:
    for name in frames:
        key = f"{locale}/{name}.png"
        bad = notes.get(key)
        print(f"  [{'BAD' if bad else 'OK '}] {key}" + ("  " + "; ".join(bad) if bad else ""))

if notes:
    print(f"\n  {len(notes)} frame(s) are not usable — fix the cause and re-capture.")
    raise SystemExit(1)
print("\n  Dimensions, content and mutual distinctness check out. Now look at them:")
print("  the checks above cannot see a clipped label, a missing font, or English")
print("  copy in the Chinese set.")
PY

say "Done — upload ios/AppStore/screenshots/<locale>/ to the matching App Store Connect localization"
