#!/usr/bin/env python3
"""Regenerate the voice-typing start/stop cues in src-tauri/sounds/.

Both cues are a short, rounded "bloop": a single sine tone with a 4 ms attack
and a fast exponential decay, 220 ms long, 48 kHz mono 16-bit. The start cue
sits higher than the stop cue so the two read as "on" and "off".
Synthesised rather than downloaded, so there is no license to track.

Run from the repository root: python3 scripts/sounds/generate-cues.py
"""
import math
import struct
import wave
from pathlib import Path

SR = 48000
OUT = Path(__file__).resolve().parents[2] / "src-tauri" / "sounds"


def render(fn, dur):
    n = int(SR * dur)
    out = [fn(i / SR) for i in range(n)]
    fade = int(0.003 * SR)  # 3 ms fades so neither end clicks
    for i in range(fade):
        out[i] *= i / fade
        out[-1 - i] *= i / fade
    peak = max(abs(x) for x in out) or 1
    return [x / peak * 0.7 for x in out]  # about -3 dBFS


def bloop(f0, f1, dur=0.22):
    def sample(t):
        env = min(1.0, t / 0.004) * math.exp(-t / 0.06)
        return env * math.sin(2 * math.pi * (f0 * t + (f1 - f0) * t * 0.5))

    return render(sample, dur)


def write(name, signal):
    with wave.open(str(OUT / name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(
            b"".join(struct.pack("<h", int(max(-1, min(1, x)) * 32767)) for x in signal)
        )


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    write("cue-start.wav", bloop(520, 980))
    write("cue-stop.wav", bloop(900, 420))
