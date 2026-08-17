# Play store graphics — checklist and how to make them

Everything Play Console → Grow → Store presence → Main store listing asks for
under **Graphics**, what already exists in this repo, and the exact commands for
the parts that have to be produced.

| Asset | Play's spec | Required? | Status |
| --- | --- | --- | --- |
| App icon | 512 × 512 px, 32-bit PNG, ≤ 1 MB, no transparency needed — Play applies its own rounded mask and shadow | Yes | **Done** — [`icon-512.png`](icon-512.png) |
| Feature graphic | 1024 × 500 px, PNG or JPEG, ≤ 15 MB, no transparency | Yes | **Done** — per-locale, see below |
| Phone screenshots | 2–8 per locale, PNG or JPEG, ≤ 8 MB each, each side 320–3,840 px; ship ≥ 1080 px on the short edge | Yes (≥ 2) | **Done** — 4 per locale, see below |
| 7" / 10" tablet screenshots | same rules at tablet sizes | Only if the listing claims tablet support | Not planned for 0.1.0 |
| Promo video | a YouTube URL | No | Not planned. (Not to be confused with the **foreground-service demo video**, which *is* required — see below.) |
| Foreground-service demo video | a URL to a video of the feature in use; not part of the listing, it belongs to App content → Foreground service permissions | Yes, or the release is blocked | **Captured** — [`fgs-demo-video.mp4`](fgs-demo-video.mp4), still needs hosting. See [`../fgs-declaration.md`](../fgs-declaration.md) |

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

## Phone screenshots — captured

Committed, both locales, ready to upload:

| File | Screen | What it sells |
| --- | --- | --- |
| `01-library.png` | Recordings list | The result is kept: titles, durations, live vs **imported**. |
| `02-transcript.png` | Recording detail | Findings and action items up top, the transcript below — what you actually come back for. |
| `03-meeting.png` | Live meeting | The transcript is already there while people are still talking. |
| `04-account.png` | Account | Plan and usage, and that the account is the user's to delete. |

`screenshots/en-US/` and `screenshots/zh-TW/`, 1080 × 2400 each, straight from a
real debug build on the `parley-test` AVD — no mockups, no rendered device
frames, no invented UI.

### They come from demo mode, not a real account

`com.pathors.parley.screenshot.DemoMode` is the Android counterpart of iOS's
`ScreenshotDemo.swift`: fixed fictional fixtures, debug builds only, **no
network at all**. That last part is the point — it means a capture run can never
put a real customer's meeting on a public store page, and it works offline.

```bash
adb shell am start -a android.intent.action.VIEW -d "'parley://demo/library'"
adb shell am start -a android.intent.action.VIEW -d "'parley://demo/transcript'"
adb shell am start -a android.intent.action.VIEW -d "'parley://demo/record'"
adb shell am start -a android.intent.action.VIEW -d "'parley://demo/account'"
adb shell am start -a android.intent.action.VIEW -d "'parley://demo/off'"    # back to reality
```

**Keep the inner single quotes.** Without them the device shell eats everything
from `?` onward, and the intent arrives with no path — the same trap that makes
`parley://auth-callback?token=…` silently do nothing when tested by hand.

The fixtures are deliberately fictional (北風工業 / Northwind Industrial,
晴光實驗室 / Sunlit Labs, 子午線 / Meridian) and exist in both languages, so the
two locale sets tell the same story rather than being a translation of one walk.

To re-capture after a UI change, boot the AVD, install a **debug** build (demo
mode is compiled out of release), fire the links above, and `adb exec-out
screencap` each screen. `02-transcript` opens at the top showing findings and
action items; scroll down first if you want a transcript-led frame instead.

### Emulator

AVD **`parley-test` (Pixel 7, API 35) already exists on Jack's machine** — use
it. Pixel 7 is 1080 × 2400, so `screencap` output needs no rescaling to clear
Play's 1080 px bar.

```bash
# 0. paths (Android Studio default on macOS)
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"   # Homebrew android-commandlinetools
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

## The foreground-service demo video

[`fgs-demo-video.mp4`](fgs-demo-video.mp4) — 30.4 s, 1080 × 2400, H.264, ~640 KB,
silent. It is **not** a store-listing asset: it belongs to Play Console → App
content → Foreground service permissions, which takes a **URL**, so the file has
to be uploaded as an unlisted YouTube video before the declaration can be
completed. The field-by-field answers, and what the video is allowed to claim,
are in [`../fgs-declaration.md`](../fgs-declaration.md).

It is captured the same way as the screenshots — `parley-test` AVD, debug build,
demo mode — with two differences, both of which matter.

**One: the status bar keeps its notifications.** The screenshot recipe above
ends with `demo -e command notifications -e visible false`; here it must not,
because the ongoing notification *is* the subject. Run every other line of the
sysui demo block, and skip that one.

**Two: `RECORD_AUDIO` has to be granted.** Demo mode normally starts no service
and posts no notification. `MeetingService.startDemoNotification` runs the real
service in notification-only mode — real channel, real chronometer, real stop
action, real `FOREGROUND_SERVICE_TYPE_MICROPHONE`, no `MeetingSession` and no
microphone behind it — but only when demo mode is on **and** `RECORD_AUDIO` is
already granted, because from Android 14 the platform refuses a
`microphone`-typed foreground service without it. A plain screenshot run never
grants it, so screenshot captures stay notification-free exactly as before.

```bash
adb shell pm grant com.pathors.parley android.permission.RECORD_AUDIO
adb shell pm grant com.pathors.parley android.permission.POST_NOTIFICATIONS

# The emulator posts its own ongoing "Serial console enabled" notification,
# which must not appear in a video going to Google. It has FLAG_ONGOING_EVENT,
# so "Clear all" will not shift it — snooze it by key instead.
adb shell cmd notification list          # find the key: -1|android|<id>|null|1000
adb shell cmd notification snooze --for 3600000 "'-1|android|55|null|1000'"
```

Then reset to a **fresh** library (the demo transcript only grows for the first
16 s of each visit to the recording screen, so a stale session films a frozen
one), and drive the take:

```bash
adb shell am start -a android.intent.action.VIEW -d "'parley://demo/library'"
# … re-apply the sysui demo block, minus the notifications line …

adb shell screenrecord --bit-rate 6000000 --time-limit 33 /sdcard/fgs-demo.mp4 &
sleep 5;  adb shell input tap 539 2147            # "Record a meeting"
sleep 10                                          # transcript grows on screen
sleep 0;  adb shell cmd statusbar expand-notifications
sleep 6;  adb shell cmd statusbar collapse
sleep 6;  adb shell input tap 539 2285            # "Stop" — note the lower Y
sleep 6
wait
adb pull /sdcard/fgs-demo.mp4 && adb shell rm /sdcard/fgs-demo.mp4
```

`cmd statusbar expand-notifications` rather than a swipe: an edge swipe on a
loaded emulator misfires into the back gesture, and a swipe starting within 4 px
of the top edge is interpreted as the shade gesture only intermittently. The two
tap targets are **different Y values** — 2147 is "Record a meeting" on the
library, 2285 is "Stop" on the recording screen. Reusing the first for the second
silently no-ops and you get a take that never stops recording.

Finally, normalise the timing. `screenrecord` emits frames only when the screen
changes, so the raw file is variable-rate (~7 fps here) and ends the instant the
last frame is drawn — which lops off the closing shot:

```bash
ffmpeg -i fgs-demo.mp4 \
  -vf "tpad=stop_mode=clone:stop_duration=3,fps=30,format=yuv420p" \
  -c:v libx264 -preset slow -crf 26 -movflags +faststart -an \
  fgs-demo-video.mp4
```

Verify before committing — a black or truncated capture is the failure mode, and
it is not obvious from the file size:

```bash
ffprobe -v error -show_entries format=duration,size -show_entries \
  stream=width,height,codec_name -of default=nw=1 fgs-demo-video.mp4
# mean luma per frame; a black capture sits near 0, this one runs 175–217
ffmpeg -v error -i fgs-demo-video.mp4 \
  -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null -
```

### If `screenrecord` comes back black or zero-length

It does on some emulator GPU configurations. Fall back to a frame sequence and
assemble it:

```bash
for i in $(seq 1 300); do adb exec-out screencap -p > frame-$(printf %04d $i).png; done
ffmpeg -framerate 10 -i frame-%04d.png -c:v libx264 -pix_fmt yuv420p out.mp4
```

The committed file did **not** need this route — `screenrecord` worked on
`parley-test` with `-gpu swiftshader_indirect`.

## When you change the UI

Recapture. The screenshots are the one part of this listing that silently goes
stale — the copy in [`../listing-en.md`](../listing-en.md) and
[`../listing-zh-TW.md`](../listing-zh-TW.md) is reviewed on every release
because it is text in a diff, but a screenshot of last quarter's library screen
looks fine right up until a user notices the app does not look like that.
