#!/usr/bin/env bash
#
# Build Parley for the iOS Simulator and open it straight on one screen, in one
# language, with the DEBUG-only demo fixtures (App/Parley/ScreenshotDemo.swift)
# instead of a real account. For previewing copy and layout changes locally —
# no sign-in, no network, nothing to tap through.
#
#   ios/scripts/preview.sh                      # library, Traditional Chinese
#   ios/scripts/preview.sh transcript en        # transcript, English
#   ios/scripts/preview.sh welcome              # the signed-out welcome screen
#   ios/scripts/preview.sh record zh --dark     # dark appearance
#   ios/scripts/preview.sh settings --no-build  # relaunch the last build only
#   ios/scripts/preview.sh --list               # every route
#
# Options:
#   --device "<name>"   simulator to use (default: iPhone 17 Pro, else the
#                       first available iPhone)
#   --no-build          skip xcodegen + xcodebuild, reuse the last build
#   --dark / --light    force the simulator's appearance
#
# The route travels as a launch argument (-ParleyDemoRoute), not through
# `simctl openurl`: since the iOS 26.5 runtime SpringBoard puts an
# "Open in "Parley"?" alert in front of every incoming URL, and no simctl
# command can dismiss it. See AppStore/capture-screenshots.sh for the history.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(dirname "$HERE")"
APP_DIR="$IOS_DIR/App"
DERIVED="$APP_DIR/build/preview"   # ios/App/build/ is gitignored
BUNDLE_ID="com.pathors.parley.ios"

# Keep in step with `route(_:)` in App/Parley/ScreenshotDemo.swift.
ROUTES=(
  "welcome:onboarding 1/7 — welcome (signed out)"
  "onboarding-account:onboarding 2/7 — choose how to run Parley: Cloud or Local (signed out)"
  "onboarding-signed-in:onboarding 2/7 — signed in to Cloud"
  "onboarding-org:onboarding 3/7 — organization: create one or go personal"
  "onboarding-invited:onboarding 3/7 — organization, with an invitation"
  "onboarding-joined:onboarding 3/7 — organization, already a member"
  "onboarding-perms:onboarding 4/7 — microphone permission"
  "onboarding-mic:onboarding 5/7 — microphone check (tap Start test, then Stop)"
  "onboarding-context:onboarding 6/7 — about you and terms"
  "onboarding-done:onboarding 7/7 — you're all set"
  "record:Record tab, a meeting in progress"
  "settled:a meeting just finished, filed into a folder"
  "adjust:the same, with the filing sheet open"
  "library:Library tab"
  "library-all:Library > See all: the full recordings list"
  "library-folder-empty:Library > an empty folder (the empty state)"
  "library-org:Library on the demo organization's scope"
  "draft:Library > a meeting draft's read-only page"
  "transcript:a recording's transcript"
  "summary:a recording's summary face"
  "jump:the summary, jumped to a lit transcript turn"
  "nosummary:a recording with no summary yet"
  "movetofolder:the folder picker over fifteen folders"
  "lap1:getting-started lap, step 1"
  "lap3:getting-started lap, step 3"
  "lapdone:getting-started lap, finished"
  "resetchecklist:Settings' 'show the getting-started list again', pressed"
  "settings:Settings tab"
  "keyboard:Settings, scrolled to the keyboard section"
  "voicehistory:Library > Voice typing history"
  "dictation:a voice-typing dictation in progress"
)

say()  { printf '\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

list_routes() {
  echo "Routes:"
  for entry in "${ROUTES[@]}"; do
    printf '  %-16s %s\n' "${entry%%:*}" "${entry#*:}"
  done
  echo
  echo "Languages: zh (Traditional Chinese, default), en"
}

ROUTE="library"
LANG_KEY="zh"
DEVICE=""
BUILD=1
APPEARANCE=""
positional=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list|-l) list_routes; exit 0 ;;
    --help|-h) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --no-build) BUILD=0; shift ;;
    --device) [[ $# -ge 2 ]] || fail "--device needs a simulator name"; DEVICE="$2"; shift 2 ;;
    --dark) APPEARANCE="dark"; shift ;;
    --light) APPEARANCE="light"; shift ;;
    -*) fail "unknown option: $1 (try --help)" ;;
    *) positional+=("$1"); shift ;;
  esac
done
[[ ${#positional[@]} -ge 1 ]] && ROUTE="${positional[0]}"
[[ ${#positional[@]} -ge 2 ]] && LANG_KEY="${positional[1]}"
[[ ${#positional[@]} -le 2 ]] || fail "too many arguments (try --help)"

known=0
for entry in "${ROUTES[@]}"; do [[ "${entry%%:*}" == "$ROUTE" ]] && known=1; done
if [[ $known -eq 0 ]]; then
  list_routes >&2
  fail "unknown route: $ROUTE"
fi

case "$LANG_KEY" in
  zh|zh-Hant|zh-TW) LANG_ARG="zh-Hant"; LOCALE_ARG="zh_TW" ;;
  en|en-US)         LANG_ARG="en";      LOCALE_ARG="en_US" ;;
  *) fail "unknown language: $LANG_KEY (use zh or en)" ;;
esac

# ── Prerequisites ──────────────────────────────────────────────────────────
command -v xcrun >/dev/null || fail "Xcode is not installed. Install it from the App Store, open it once, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
xcodebuild -version >/dev/null 2>&1 || fail "xcodebuild is not usable — the active developer directory is probably the Command Line Tools. Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
if [[ $BUILD -eq 1 ]]; then
  command -v xcodegen >/dev/null || fail "XcodeGen is not installed. Run: brew install xcodegen"
  # Xcode 26 ships without the Metal toolchain, and AuroraEdgeGlow.metal needs it.
  if ! xcrun -sdk iphoneos metal --version >/dev/null 2>&1; then
    say "Downloading the Metal toolchain (one time)"
    xcodebuild -downloadComponent MetalToolchain
  fi
fi

# ── Simulator ──────────────────────────────────────────────────────────────
UDID="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
wanted = sys.argv[1]
iphones = [d for rt, ds in json.load(sys.stdin)["devices"].items() if "iOS" in rt for d in ds
           if d["name"].startswith("iPhone")]
pick = None
if wanted:
    pick = next((d for d in iphones if d["name"] == wanted), None)
else:
    pick = next((d for d in iphones if d["name"] == "iPhone 17 Pro"), None) or \
           next((d for d in iphones if d["state"] == "Booted"), None) or \
           (iphones[-1] if iphones else None)
if pick:
    print(pick["udid"], pick["name"], sep="\t")
' "$DEVICE")"
[[ -n "$UDID" ]] || fail "no available iPhone simulator${DEVICE:+ named \"$DEVICE\"}. Install the iOS platform in Xcode > Settings > Components."
DEVICE_NAME="${UDID#*$'\t'}"
UDID="${UDID%%$'\t'*}"

say "Booting $DEVICE_NAME"
xcrun simctl boot "$UDID" 2>/dev/null || true
open -a Simulator --args -CurrentDeviceUDID "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
[[ -n "$APPEARANCE" ]] && xcrun simctl ui "$UDID" appearance "$APPEARANCE"

# ── Build ──────────────────────────────────────────────────────────────────
if [[ $BUILD -eq 1 ]]; then
  say "Generating the Xcode project"
  (cd "$APP_DIR" && xcodegen generate --quiet)
  say "Building Parley (Debug — the demo mode only exists in Debug)"
  xcodebuild -project "$APP_DIR/Parley.xcodeproj" -scheme Parley \
    -configuration Debug -destination "id=$UDID" -derivedDataPath "$DERIVED" \
    -quiet build
fi

APP="$(find "$DERIVED/Build/Products" -maxdepth 2 -name 'Parley.app' -path '*iphonesimulator*' 2>/dev/null | head -1)"
[[ -n "$APP" ]] || fail "no build found under $DERIVED — run without --no-build"

say "Installing"
xcrun simctl install "$UDID" "$APP"

# ── Launch ─────────────────────────────────────────────────────────────────
launch_args=(-AppleLanguages "($LANG_ARG)" -AppleLocale "$LOCALE_ARG")
if [[ "$ROUTE" == "welcome" ]]; then
  launch_args+=(-ParleyDemo signedOut)
elif [[ "$ROUTE" == "onboarding-account" ]]; then
  launch_args+=(-ParleyDemo signedOut -ParleyDemoRoute "$ROUTE")
else
  launch_args+=(-ParleyDemo signedIn -ParleyDemoRoute "$ROUTE")
fi

say "Opening '$ROUTE' in $LANG_ARG"
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl launch "$UDID" "$BUNDLE_ID" "${launch_args[@]}" >/dev/null

echo
echo "Edit, then run again. Text lives in App/Parley/Localizable.xcstrings;"
echo "the demo's fictional data in App/Parley/ScreenshotDemo.swift."
