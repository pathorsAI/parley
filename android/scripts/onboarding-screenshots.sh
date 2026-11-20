#!/usr/bin/env bash
#
# Capture every onboarding step from a booted emulator (or device) with the
# debug build installed, through the same `parley://demo/<route>` deep links
# preview.sh uses. Run by .github/workflows/android-screenshots.yml so the
# wizard can be looked at without an Android toolchain; works locally too:
#
#   android/scripts/onboarding-screenshots.sh out/      # needs adb + a device
#
# Writes <out>/<lang>-<mode>/<nn>-<route>.png, plus the welcome demo at one
# frame per beat (welcome-t<seconds>.png). Emulator timing is loose, so the
# beat frames are approximate.

set -euo pipefail

OUT="${1:?usage: onboarding-screenshots.sh <out-dir>}"
PACKAGE="com.pathors.parley"

ROUTES=(
  onboarding-account onboarding-signed-in
  onboarding-org onboarding-invited onboarding-joined
  onboarding-perms onboarding-mic onboarding-context onboarding-done
)
# Seconds after launch: one frame inside each welcome beat
# (LapMotion.WelcomeSchedule starts: 0 / 1.8 / 3.4 / 6.4 / 8.3 / 11.0).
WELCOME_AT=(1 2.8 5 7.4 9.8 13)

open_route() {
  adb shell am force-stop "$PACKAGE"
  adb shell am start -W -a android.intent.action.VIEW -d "'parley://demo/$1'" "$PACKAGE" >/dev/null
}
shot() { adb exec-out screencap -p > "$1"; }

# On a slow CI emulator the launcher stops answering and its "isn't
# responding" dialog sits over every frame. Nothing here needs a home screen:
# turn the launcher off and error dialogs with it.
adb shell settings put global hide_error_dialogs 1 || true
for launcher in com.google.android.apps.nexuslauncher com.android.launcher3; do
  adb shell pm disable-user --user 0 "$launcher" >/dev/null 2>&1 || true
done
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true

# A clean status bar (AppStore/assets/README.md).
adb shell settings put global sysui_demo_allowed 1
demo() { adb shell am broadcast -a com.android.systemui.demo "$@" >/dev/null; }
demo -e command enter
demo -e command clock -e hhmm 0941
demo -e command battery -e level 100 -e plugged false
demo -e command network -e wifi show -e level 4
demo -e command notifications -e visible false

for combo in zh-TW:light en-US:light zh-TW:dark; do
  locale="${combo%%:*}"; mode="${combo##*:}"
  dir="$OUT/$locale-$mode"; mkdir -p "$dir"
  adb shell cmd uimode night "$([[ $mode == dark ]] && echo yes || echo no)" >/dev/null
  adb shell cmd locale set-app-locales "$PACKAGE" --locales "$locale" >/dev/null
  echo "▸ $locale $mode"

  open_route welcome
  start=$(date +%s.%N)
  for t in "${WELCOME_AT[@]}"; do
    now=$(date +%s.%N)
    wait=$(echo "$start + $t - $now" | bc)
    [[ $(echo "$wait > 0" | bc) == 1 ]] && sleep "$wait"
    shot "$dir/01-welcome-t$t.png"
  done

  n=2
  for route in "${ROUTES[@]}"; do
    open_route "$route"
    sleep 2.5
    shot "$dir/$(printf %02d $n)-$route.png"
    n=$((n + 1))
  done
done

adb shell cmd uimode night no >/dev/null
demo -e command exit
echo "✓ $(find "$OUT" -name '*.png' | wc -l | tr -d ' ') screenshots in $OUT"
