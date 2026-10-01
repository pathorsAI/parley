#!/usr/bin/env python3
"""Measure the loudness that drives the hero waveform on parley.tw.

The hero shows two transcript lines being spoken, with a waveform underneath.
The waveform is not drawn by hand: this script synthesizes the exact two lines
(`demo.line1`, `demo.line2` in website/src/i18n/<lang>.json) with macOS `say`,
converts them to 16 kHz mono WAV with `afconvert`, and measures the RMS of
every 85 ms hop (the same cadence the iOS WaveformView samples at).

Per language the result is: turn 1, then GAP samples of true silence (0), then
turn 2. Values are normalised to the loudest hop and shaped with (x/max)^0.6 so
quiet syllables stay visible. The page treats a run of zeros as the turn
boundary, so the transcript only advances while someone is actually talking.

Writes website/src/rms.json as {"zh": [...], "en": [...]}. macOS only.

    python3 website/tools/hero-rms/generate.py
"""

import array
import json
import math
import os
import subprocess
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "../../src"))
OUT = os.path.join(SRC, "rms.json")

RATE = 16000
HOP_MS = 85
HOP = RATE * HOP_MS // 1000  # 1360 samples
GAP = 10  # zero samples between turns; the page needs a run of >= 8
EDGE_DB = -45.0  # hops quieter than this at either end of a turn are trimmed
LANGS = {
    # site language → (dictionary file, macOS voice)
    "zh": ("zh-TW.json", "Meijia"),
    "en": ("en.json", "Samantha"),
}


def synth(text, voice, workdir, name):
    aiff = os.path.join(workdir, f"{name}.aiff")
    wav = os.path.join(workdir, f"{name}.wav")
    subprocess.run(["say", "-v", voice, "-o", aiff, text], check=True)
    subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", "1", aiff, wav],
        check=True,
    )
    return wav


def hop_rms(path):
    with wave.open(path, "rb") as w:
        if w.getframerate() != RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            sys.exit(f"{path}: expected 16 kHz mono 16-bit, got something else")
        samples = array.array("h", w.readframes(w.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    out = []
    for i in range(0, len(samples), HOP):
        chunk = samples[i : i + HOP]
        if len(chunk) < HOP // 2:
            break
        out.append(math.sqrt(sum(s * s for s in chunk) / len(chunk)) / 32768.0)
    return out


def trim(values):
    """Drop the synthesizer's leading/trailing silence; keep everything between."""
    floor = 10 ** (EDGE_DB / 20)
    start = next(i for i, v in enumerate(values) if v > floor)
    end = len(values) - next(i for i, v in enumerate(reversed(values)) if v > floor)
    return values[start:end]


def main():
    result = {}
    with tempfile.TemporaryDirectory() as tmp:
        for lang, (dict_file, voice) in LANGS.items():
            with open(os.path.join(SRC, "i18n", dict_file), encoding="utf-8") as f:
                strings = json.load(f)
            turns = []
            for n, key in enumerate(("demo.line1", "demo.line2")):
                wav = synth(strings[key], voice, tmp, f"{lang}-{n}")
                turns.append(trim(hop_rms(wav)))
            peak = max(max(t) for t in turns)
            shaped = [[round((v / peak) ** 0.6, 3) for v in t] for t in turns]
            # A zero inside a turn would read as silence to the page; the true
            # silence is only the inserted gap.
            for t in shaped:
                for i, v in enumerate(t):
                    if v == 0:
                        t[i] = 0.001
            result[lang] = shaped[0] + [0] * GAP + shaped[1]
            secs = len(result[lang]) * HOP_MS / 1000
            print(f"{lang}: {voice}, {len(shaped[0])} + {GAP} + {len(shaped[1])} hops ({secs:.1f} s)")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main()
