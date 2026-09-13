#!/usr/bin/env bash
#
# Regenerate the DEBUG demo recording's audio.
#
#   ios/AppStore/make-demo-audio.sh
#
# Writes ios/App/Parley/DemoAudio/demo-renewal.ogg — the file the screenshot
# demo's featured recording plays (see ScreenshotDemo.audioURL). It is in the app
# target's sources but excluded from Release (project.yml), so it costs a Debug
# build ~300 KB and a shipped build nothing.
#
# Why a generated file and not a recording of a real meeting: the demo fixtures
# are all invented (ScreenshotDemo's type doc), and the audio has to be too. So
# the six turns of the fixture transcript are spoken by two system voices and
# placed at the timecodes the transcript claims for them. That is what makes the
# player worth screenshotting — the waveform has speech and silence in the right
# places, the playhead crosses the turns the transcript is showing, and tapping a
# timecode lands on the line it names.
#
# Needs `say` (macOS) and ffmpeg (brew install ffmpeg). Neither is needed to
# build the app — this runs by hand when the fixture transcript changes.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(dirname "$HERE")"
OUT_DIR="$IOS_DIR/App/Parley/DemoAudio"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)" >&2; exit 1; }

# start-ms : voice : text — the English side of ScreenshotDemo.lines, in the same
# order and at the same offsets. Voices come from `say -v '?'`; these two are
# both en and easily told apart. The Chinese side is not spoken: a stock system
# has no Traditional Chinese voice, and the waveform is the same shape either way.
LINES=(
  "12000:Daniel:We're happy with the platform overall. The blocker is the seat count. We budgeted for forty and the quote came back at eighty."
  "27000:Fred:Forty is the floor on the enterprise tier, so I can't go under it. What I can do is hold this year's price through the next renewal."
  "44000:Daniel:A price hold helps. What about the onboarding time you mentioned last week. You said two weeks?"
  "58000:Fred:Two weeks assumes your SSO is already on Okta. If it isn't, add a week for the identity mapping."
  "76000:Daniel:It is. Send the revised quote with the price hold in writing and I'll take it to finance on Thursday."
  "92000:Fred:I'll have it to you tomorrow morning, and I'll include the security questionnaire your team asked for."
)

# 105 s of silence to lay the turns onto: the last one starts at 92 s and runs
# about ten, and a recording that ends on the final syllable reads as truncated.
TOTAL_MS=105000

inputs=()
filters=()
index=0
for entry in "${LINES[@]}"; do
  offset="${entry%%:*}"
  rest="${entry#*:}"
  voice="${rest%%:*}"
  text="${rest#*:}"
  spoken="$SCRATCH/line-$index.wav"
  # A voice that isn't installed falls back to the default rather than failing:
  # the fixture only needs two distinguishable speakers.
  # `.wav` and not `.aiff`: `say` rejects a little-endian data format in a
  # big-endian container, and the message it gives for it is "fmt?".
  say -v "$voice" -o "$spoken" --data-format=LEI16@16000 "$text" 2>/dev/null \
    || say -o "$spoken" --data-format=LEI16@16000 "$text"
  inputs+=(-i "$spoken")
  filters+=("[$index:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,adelay=${offset}|${offset}[d$index];")
  index=$((index + 1))
done

mix=""
for ((i = 0; i < index; i++)); do mix+="[d$i]"; done

wav="$SCRATCH/assembled.wav"
ffmpeg -hide_banner -loglevel error -y \
  "${inputs[@]}" \
  -filter_complex "$(IFS=; echo "${filters[*]}")${mix}amix=inputs=${index}:normalize=0,apad,atrim=0:$(echo "scale=3; $TOTAL_MS/1000" | bc)[out]" \
  -map "[out]" -ac 1 -ar 16000 -c:a pcm_s16le "$wav"

mkdir -p "$OUT_DIR"

# The last step goes through the app's *own* encoder rather than ffmpeg's, so
# the bytes in the bundle are the bytes a recording on a phone produces — which
# is the whole point of playing this file in the simulator.
echo "▸ Encoding with OggOpusEncoder (via ParleyKit tests)"
PARLEY_DEMO_AUDIO_IN="$wav" \
PARLEY_DEMO_AUDIO_OUT="$OUT_DIR/demo-renewal.ogg" \
  swift test --package-path "$IOS_DIR/ParleyKit" \
    --filter 'DemoAudioFixtureTests/testWriteDemoAudio' 2>&1 | tail -3

ls -l "$OUT_DIR/demo-renewal.ogg"
