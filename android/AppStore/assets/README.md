# Play store graphics — checklist and how to make them

Everything Play Console → Grow → Store presence → Main store listing asks for
under **Graphics**, what already exists in this repo, and the exact commands for
the parts that have to be produced.

| Asset | Play's spec | Required? | Status |
| --- | --- | --- | --- |
| App icon | 512 × 512 px, 32-bit PNG, ≤ 1 MB, no transparency needed — Play applies its own rounded mask and shadow | Yes | **Done** — [`icon-512.png`](icon-512.png) |
| Feature graphic | 1024 × 500 px, PNG or JPEG, ≤ 15 MB, no transparency | Yes | **Done** — per-locale, see below |
| Phone screenshots | 2–8 per locale, PNG or JPEG, ≤ 8 MB each, each side 320–3,840 px; ship ≥ 1080 px on the short edge | Yes (≥ 2) | **Missing** — capture them, see below |
| 7" / 10" tablet screenshots | same rules at tablet sizes | Only if the listing claims tablet support | Not planned for 0.1.0 |
| Promo video | a YouTube URL | No | Not planned. (Not to be confused with the **foreground-service demo video**, which *is* required — see [`../review-notes.md`](../review-notes.md).) |

Assets are per-locale in Play: upload one set to **English (United States)** and
one to **Chinese (Traditional) – Taiwan**. The icon and feature graphic are
shared; the screenshots are not, because the app's UI is fully bilingual.

## The icon — already exported

[`icon-512.png`](icon-512.png) is a 512 × 512 render of the vector source
`app-icon.svg` at the repo root — the same artwork as the desktop, iOS and
launcher icons, not a redraw. It was produced with `rsvg-convert` (Homebrew
`librsvg`) straight from the vector, so nothing was upscaled:

```bash
# from the repo root
sed 's/rx="232"/rx="0"/; s/rx="226"/rx="0"/' app-icon.svg > /tmp/parley-icon-square.svg
rsvg-convert -w 512 -h 512 /tmp/parley-icon-square.svg -o android/AppStore/assets/icon-512.png
magick android/AppStore/assets/icon-512.png -alpha set -define png:color-type=6 \
  png32:android/AppStore/assets/icon-512.png     # 32-bit RGBA, fully opaque
```

**Why the corner radius is stripped.** `app-icon.svg` draws its own rounded
tile (`rx="232"`), which is right for iOS and the desktop. Play masks the icon
itself, so a pre-rounded upload gets rounded twice and shows a dark sliver at
each corner. Overriding `rx` to 0 makes the artwork full-bleed and leaves the
rounding to Play — the mark, gradient, and colors are untouched. If you ever
need the pre-rounded version, drop the `sed` and run `rsvg-convert` on
`app-icon.svg` directly.

Other icon sources in the repo, for reference — none of them is the right thing
to upload:

- `app-icon.png` (repo root) — 1024 × 1024, pre-rounded, would need downscaling.
- `src-tauri/icons/icon.png` — 512 × 512 but pre-rounded (desktop bundle icon).
- `android/app/src/main/res/mipmap-*/ic_launcher*.png` — 48–192 px launcher
  assets; far below Play's 512 px, and the adaptive-icon foreground is not the
  store artwork.

## Feature graphic — done

1024 × 500, shown at the top of the store page and in some Play surfaces, often
**cropped** and sometimes with a play-button overlay dropped in the middle — so
nothing load-bearing sits dead-centre or in the outer ~15%.

| Locale | Upload |
| --- | --- |
| English (United States) | [`feature-graphic-1024x500-en.png`](feature-graphic-1024x500-en.png) |
| Chinese (Traditional) – Taiwan | [`feature-graphic-1024x500-zh-TW.png`](feature-graphic-1024x500-zh-TW.png) |

Vector sources live beside them (`feature-graphic-en.svg`,
`feature-graphic-zh-TW.svg`); edit those, never the PNG. Re-render with:

```bash
cd android/AppStore/assets
rsvg-convert -w 1024 -h 500 feature-graphic-en.svg    -o feature-graphic-1024x500-en.png
rsvg-convert -w 1024 -h 500 feature-graphic-zh-TW.svg -o feature-graphic-1024x500-zh-TW.png
```

**Design notes**, so a later edit doesn't drift off-brand:

- Ground and gradient stops are lifted verbatim from `app-icon.svg` — background
  `#1b1f29` → `#0a0b0e`, mark `#5eead4` → `#38bdf8` → `#818cf8`.
- The monogram is the icon's own path data at `0.146x`, not a redraw, so the
  lockup and the launcher icon can never disagree. Its bounding box (strokes and
  the dot included) is x 323–688, y 263–761 in icon units; the group translate
  puts that box's top-left at (72, 206). Changing the scale means recomputing
  that translate.
- The art reads left-to-right as **audio becoming text**: waveform bars resolve
  into transcript lines, sharing one gradient so the eye follows the transition.
  That is the product in one image, and it survives being scaled down to a
  thumbnail — which a screenshot of the UI would not.
- The tagline is deliberately short (Play renders this small); the full pitch
  belongs in the description, not here.
- zh-TW sets the tagline in `PingFang TC` (the wordmark stays Latin). If you
  re-render on a machine without it, check the tagline didn't fall back to a
  font with no CJK coverage — the failure is silent tofu boxes.

## Phone screenshots — to be captured

**There is no demo mode in the Android app.** iOS captures its set from
`ScreenshotDemo.swift` with fixed fictional fixtures and no network
(`ios/AppStore/screenshots/README.md`); Android has no equivalent, so frames
have to come from a signed-in account with real cloud data. Two rules follow,
and they are not negotiable:

- **Never capture a real customer meeting.** Use the review account or a
  throwaway account seeded with fictional content — the iOS set's fictional
  renewal negotiation / discovery call / quarterly review is the model, and the
  demo address there is `alex@example.com` in the RFC-reserved domain.
- **Only real frames from a real build.** No mockups, no rendered device
  frames with invented UI.

`[TODO: confirm with Jack]` — porting a `ScreenshotDemo`-style debug mode to
Android is the durable fix and would make this section a single command, the way
it is on iOS.

The set to capture (≥ 2 required; 4 tells the story):

| File | Screen | What it sells |
| --- | --- | --- |
| `01-library.png` | Recordings list | The result is kept: titles, durations, live vs imported. |
| `02-record.png` | Live meeting | The transcript is already there while people are still talking. |
| `03-import.png` | Import in progress | The Android-only feature: an existing audio file becoming text. |
| `04-transcript.png` | Recording detail | A transcript you read and quote from, speaker by speaker. |

### Emulator

AVD **`parley-test` (Pixel 7, API 35) already exists on Jack's machine** — use
it. Pixel 7 is 1080 × 2400, so `screencap` output needs no rescaling to clear
Play's 1080 px bar.

```bash
# 0. paths (Android Studio default on macOS)
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"

# 1. boot it
emulator -avd parley-test -no-snapshot-load &
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'

# 2. install the build you are actually shipping
cd android && ./gradlew installRelease   # installDebug is fine for a first pass
cd ..

# 3. a clean status bar, same convention as the iOS set (9:41, full battery, wifi)
adb shell settings put global sysui_demo_allowed 1
demo() { adb shell am broadcast -a com.android.systemui.demo "$@" >/dev/null; }
demo -e command enter
demo -e command clock -e hhmm 0941
demo -e command battery -e level 100 -e plugged false
demo -e command network -e wifi show -e level 4
demo -e command network -e mobile show -e datatype none -e level 4
demo -e command notifications -e visible false
```

### Capture

```bash
mkdir -p android/AppStore/assets/screenshots/{en-US,zh-TW}

# drive the app by hand to each screen, then:
adb exec-out screencap -p > android/AppStore/assets/screenshots/en-US/01-library.png
adb exec-out screencap -p > android/AppStore/assets/screenshots/en-US/02-record.png
adb exec-out screencap -p > android/AppStore/assets/screenshots/en-US/03-import.png
adb exec-out screencap -p > android/AppStore/assets/screenshots/en-US/04-transcript.png

# verify every frame before uploading
for f in android/AppStore/assets/screenshots/*/*.png; do
  printf '%s ' "$f"; sips -g pixelWidth -g pixelHeight "$f" | tail -2 | tr -d '\n'; echo
done
```

`exec-out` (not `shell`) matters: `adb shell screencap` mangles the PNG with
CRLF translation on some hosts, `exec-out` streams the bytes untouched.

### The second locale

The app follows the system language and has a full `values-zh-rTW` string table,
so the Chinese set is the same walk with the app's locale switched. On API 33+
this needs no root:

```bash
adb shell cmd locale set-app-locales com.pathors.parley --user current --locales zh-TW
# … capture into screenshots/zh-TW/ …
adb shell cmd locale set-app-locales com.pathors.parley --user current --locales en-US
```

Fallback, if that command is unavailable — switch the whole emulator (root works
on an emulator image, not on a physical device):

```bash
adb root
adb shell setprop persist.sys.locale zh-TW
adb shell stop && adb shell start
adb wait-for-device
```

### If Play's uploader complains about the aspect ratio

Play documents 16:9 / 9:16 with each side 320–3,840 px. A Pixel 7 frame is
1080 × 2400 (9:20), taller than 9:16; it is normally accepted, but if the
uploader refuses it, pad to an exact 9:16 rather than squashing:

```bash
magick input.png -resize 1080x1920 -background '#0a0b0e' -gravity center \
  -extent 1080x1920 output.png
```

## When you change the UI

Recapture. The screenshots are the one part of this listing that silently goes
stale — the copy in [`../listing-en.md`](../listing-en.md) and
[`../listing-zh-TW.md`](../listing-zh-TW.md) is reviewed on every release
because it is text in a diff, but a screenshot of last quarter's library screen
looks fine right up until a user notices the app does not look like that.
