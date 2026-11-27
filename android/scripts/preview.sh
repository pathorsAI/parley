#!/usr/bin/env bash
#
# Build Parley's debug APK, install it on a connected device or emulator, and
# open it straight on one screen, in one language, with the debug-only demo
# fixtures (app/src/main/kotlin/com/pathors/parley/screenshot/DemoMode.kt)
# instead of a real account. For previewing copy and layout changes locally —
# no sign-in, no network, nothing to tap through. The Android half of
# ios/scripts/preview.sh, with the same route names.
#
#   android/scripts/preview.sh                          # library, Traditional Chinese
#   android/scripts/preview.sh welcome en               # the signed-out welcome, English
#   android/scripts/preview.sh onboarding-mic zh        # the microphone check
#   android/scripts/preview.sh library --no-build       # reinstall nothing, just route
#   android/scripts/preview.sh --list                   # every route
#
# Options:
#   --no-build          skip ./gradlew installDebug, use what is installed
#   --device <serial>   which device, when more than one is connected
#                       (default: ANDROID_SERIAL, else the only one)
#   --dark / --light    force the system's night mode (affects every app)
#
# Limits:
#   - The language is set with `cmd locale set-app-locales`, which needs
#     Android 13 (API 33) or later. On older devices the app follows the
#     system language; change it in Settings, or use an API 33+ emulator.
#   - The route travels as a deep link (`parley://demo/<route>`), handled only
#     by debug builds. `parley://demo/off`, or killing the app, leaves demo mode.
#   - Demo mode is in memory only: after a process restart the app is back to
#     its real state, so run this again rather than relaunching from the icon.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(dirname "$HERE")"
PACKAGE="com.pathors.parley"

# Keep in step with DemoMode.handle() (and ios/scripts/preview.sh).
ROUTES=(
  "welcome:onboarding 1/7 — welcome (signed out)"
  "onboarding-account:onboarding 2/7 — choose how to run Parley: Cloud or Local (signed out)"
  "onboarding-signed-in:onboarding 2/7 — signed in to Cloud"
  "onboarding-org:onboarding 3/7 — organization: create one or go personal"
  "onboarding-invited:onboarding 3/7 — organization, with an invitation"
  "onboarding-joined:onboarding 3/7 — organization, already a member"
  "onboarding-perms:onboarding 4/7 — microphone (and notification) permission"
  "onboarding-mic:onboarding 5/7 — microphone check (tap Start test, then Stop)"
  "onboarding-context:onboarding 6/7 — about you and terms"
  "onboarding-done:onboarding 7/7 — you're all set"
  "library:the Library's overview (folders, recent recordings)"
  "library-all:the full list, as See all opens it"
  "library-folder-empty:an empty folder's page, as its card opens it"
  "library-org:the organization's library"
  "library-overview-drafts:the overview scrolled to its meeting drafts"
  "library-drafts:every meeting draft, as See all opens it"
  "library-draft:a meeting draft's read-only page"
  "library-draft-short:the same page for a draft with only a time and a folder"
  "transcript:a recording's transcript"
  "record:a meeting in progress"
  "settled:a meeting just finished, filing suggestion up"
  "adjust:the same, with the filing card's folder picker open"
  "account:the library with the account sheet open"
  "movetofolder:the folder picker over sixteen folders"
  "report:a recording's report, every artifact done"
  "report-analyzing:the report mid-pipeline"
  "report-menu:the report with the analysis menu open"
  "checklist:a new account's getting-started checklist"
  "checklist-partial:the checklist two of four done"
  "sample:the sample recording"
  "share-menu:the sample with its share menu open"
  "import-partial:an import saved, transcript completing later"
  "import-offline:the same, waiting for the network"
  "import-quota:an import stopped by the transcription quota"
  "import-signed-out:an import stopped by an expired session"
  "off:leave demo mode"
)

say()  { printf '\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

list_routes() {
  echo "Routes:"
  for entry in "${ROUTES[@]}"; do
    printf '  %-22s %s\n' "${entry%%:*}" "${entry#*:}"
  done
  echo
  echo "Languages: zh (Traditional Chinese, default), en"
}

ROUTE="library"
LANG_KEY="zh"
BUILD=1
NIGHT=""
positional=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list|-l) list_routes; exit 0 ;;
    --help|-h) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --no-build) BUILD=0; shift ;;
    --device) [[ $# -ge 2 ]] || fail "--device needs a serial (see: adb devices)"; export ANDROID_SERIAL="$2"; shift 2 ;;
    --dark) NIGHT="yes"; shift ;;
    --light) NIGHT="no"; shift ;;
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
  zh|zh-TW|zh-Hant) LOCALE="zh-TW" ;;
  en|en-US)         LOCALE="en-US" ;;
  *) fail "unknown language: $LANG_KEY (use zh or en)" ;;
esac

# ── Prerequisites ──────────────────────────────────────────────────────────
command -v adb >/dev/null || fail "adb is not on PATH. Install the Android SDK platform-tools (Android Studio › SDK Manager) and add them to PATH."
devices="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
if [[ -z "${ANDROID_SERIAL:-}" ]]; then
  count="$(printf '%s\n' "$devices" | grep -c . || true)"
  [[ "$count" -ge 1 ]] || fail "no device or emulator connected (adb devices is empty). Start an emulator, or plug in a phone with USB debugging on."
  [[ "$count" -eq 1 ]] || fail "more than one device connected; pick one with --device <serial>:"$'\n'"$devices"
fi

# ── Build ──────────────────────────────────────────────────────────────────
if [[ $BUILD -eq 1 ]]; then
  say "Building and installing Parley (debug — the demo mode only exists in debug builds)"
  (cd "$ANDROID_DIR" && ./gradlew --quiet :app:installDebug)
else
  adb shell pm path "$PACKAGE" >/dev/null 2>&1 || fail "Parley is not installed on the device — run without --no-build"
fi

# ── Appearance and language ────────────────────────────────────────────────
[[ -n "$NIGHT" ]] && adb shell cmd uimode night "$NIGHT" >/dev/null

sdk="$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
if [[ "${sdk:-0}" -ge 33 ]]; then
  adb shell cmd locale set-app-locales "$PACKAGE" --locales "$LOCALE" >/dev/null
else
  printf '\033[33m! Android %s cannot set a per-app language; the app follows the system language.\033[0m\n' "$sdk"
fi

# ── Launch ─────────────────────────────────────────────────────────────────
say "Opening '$ROUTE' in $LOCALE"
# A fresh process, so the language takes and no earlier demo state is left.
adb shell am force-stop "$PACKAGE"
# The inner quotes matter: adb passes the URL through the device's shell.
adb shell am start -W -a android.intent.action.VIEW -d "'parley://demo/$ROUTE'" "$PACKAGE" >/dev/null

echo
echo "Edit, then run again. Text lives in app/src/main/res/values*/strings.xml;"
echo "the demo's fictional data in app/src/main/kotlin/com/pathors/parley/screenshot/DemoMode.kt."
