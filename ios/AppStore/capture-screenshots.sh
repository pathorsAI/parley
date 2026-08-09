#!/usr/bin/env bash
#
# Capture the App Store screenshot set for every shipping locale.
#
#   ios/AppStore/capture-screenshots.sh                 # build, then capture
#   ios/AppStore/capture-screenshots.sh --no-build      # reuse the last build
#   ios/AppStore/capture-screenshots.sh --device "iPhone 17 Pro Max"
#
# Frames come out of a DEBUG-only demo mode (App/Parley/ScreenshotDemo.swift):
# the app is launched with `-ParleyDemo signedIn`, serves fixed fictional
# fixtures instead of the cloud, and is driven entirely by `parley://demo/…`
# URLs. Nothing here needs the review account, a network, or a single tap — so
# the same command reproduces the same pixels next release.
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

# file name : parley://demo route ("-" = no route, capture the launch screen)
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

capture() {  # $1 = destination png
  # Let the frame settle before the shutter: navigation animations and the
  # transcript's scroll-to-bottom both land within a beat.
  sleep 1.5
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

    xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
    xcrun simctl launch "$UDID" "$BUNDLE_ID" \
      -ParleyDemo "$mode" \
      -AppleLanguages "($lang)" -AppleLocale "$region" >/dev/null

    if [[ "$route" != "-" ]]; then
      # The URL has to arrive after the scene is up. Delivered too early it is
      # swallowed before SwiftUI subscribes and the frame silently comes out on
      # whichever tab launched — which is exactly the kind of wrong screenshot
      # nobody notices until it is on the store.
      sleep 4
      xcrun simctl openurl "$UDID" "parley://demo/$route"
    fi

    capture "$outdir/$name.png"
    printf '   %s/%s.png\n' "$locale" "$name"
  done
done

xcrun simctl status_bar "$UDID" clear
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true

say "Verifying dimensions"
python3 - "$HERE/screenshots" <<'PY'
import pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
ok = True
for png in sorted(root.rglob("*.png")):
    if png.parent.name not in {"en-US", "zh-Hant"}:
        continue
    out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(png)],
                         capture_output=True, text=True).stdout
    dims = tuple(int(l.split(":")[1]) for l in out.splitlines() if ":" in l and l.strip()[0] in "pP" and "pixel" in l)
    mark = "OK " if dims == (1320, 2868) else "??"
    if dims != (1320, 2868):
        ok = False
    print(f"  [{mark}] {png.parent.name}/{png.name}  {dims[0]}×{dims[1]}")
if not ok:
    print("\n  Frames are not 1320×2868 (the 6.9-inch slot). Capture on an "
          "iPhone 17 Pro Max, or rescale before upload.")
PY

say "Done — upload ios/AppStore/screenshots/<locale>/ to the matching App Store Connect localization"
