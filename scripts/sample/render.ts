/**
 * Render the bundled sample recording (onboarding) from its scripts.
 *
 *   bun scripts/sample/render.ts            # render every script.*.json
 *   bun scripts/sample/render.ts en         # render only script.en.json
 *
 * For each `scripts/sample/script.<lang>.json`:
 *
 *   1. every line is spoken with macOS `say` (the speaker's voice, the script's
 *      rate) into its own AIFF,
 *   2. each clip is decoded to raw 16 kHz mono s16le PCM, so its exact length is
 *      its sample count (the same number ffprobe reports, without rounding),
 *   3. the clips are laid end to end with `gapMs` of silence between lines and a
 *      short lead-in/tail, so every line's startMs/endMs is known exactly — no
 *      STT alignment,
 *   4. the result is encoded to Ogg/Opus (16 kHz mono, 24 kbps) at
 *      `public/sample/<audio>`,
 *   5. the rendered manifest is written to `public/sample/sample.<lang>.json`
 *      and mirrored to `src/lib/onboarding/sampleManifests/` so the app can
 *      import it as a JSON module (files under public/ can't be imported).
 *
 * Requires macOS (`say`) and ffmpeg/ffprobe on PATH or in /opt/homebrew/bin.
 * Output is deterministic (bit-exact Ogg muxing, no timestamps), so re-running
 * with unchanged scripts yields identical files.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PUBLIC_OUT = path.join(REPO, "public", "sample");
const SRC_OUT = path.join(REPO, "src", "lib", "onboarding", "sampleManifests");

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2; // s16le mono
const LEAD_IN_MS = 300;
const TAIL_MS = 300;
const BITRATE = "24k";

type Side = "me" | "them";

interface Script {
  id: string;
  lang: string;
  title: string;
  audio: string;
  meetingKind: string;
  context: string;
  speakers: Record<Side, string>;
  voices: Record<Side, string>;
  rate: number;
  gapMs: number;
  lines: { speaker: Side; text: string }[];
  questions: string[];
  mcpQuestions: string[];
}

interface Segment {
  speaker: Side;
  startMs: number;
  endMs: number;
  text: string;
}

function findTool(name: string): string {
  const brew = `/opt/homebrew/bin/${name}`;
  return fs.existsSync(brew) ? brew : name;
}
const FFMPEG = findTool("ffmpeg");
const FFPROBE = findTool("ffprobe");

function run(cmd: string, args: string[]): Buffer {
  return execFileSync(cmd, args, { maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

/** Milliseconds → sample count, rounded to whole samples. */
function msToSamples(ms: number): number {
  return Math.round((ms * SAMPLE_RATE) / 1000);
}

/** Sample count → milliseconds, rounded to whole ms (manifest precision). */
function samplesToMs(samples: number): number {
  return Math.round((samples * 1000) / SAMPLE_RATE);
}

/** Speak one line into an AIFF and return it as raw 16 kHz mono PCM. */
function renderLine(text: string, voice: string, rate: number, tmp: string, index: number): Buffer {
  const aiff = path.join(tmp, `line-${String(index).padStart(2, "0")}.aiff`);
  run("say", ["-v", voice, "-r", String(rate), "-o", aiff, text]);
  const probed = Number(
    run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", aiff])
      .toString()
      .trim(),
  );
  const pcm = run(FFMPEG, [
    "-v", "error", "-i", aiff,
    "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-acodec", "pcm_s16le", "-",
  ]);
  const pcmMs = (pcm.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
  // Resampling can shift the length by a sample or two; anything more means the
  // decode went wrong and the timestamps would drift.
  if (Math.abs(pcmMs - probed * 1000) > 20) {
    throw new Error(`line ${index}: PCM length ${pcmMs.toFixed(1)} ms ≠ ffprobe ${probed * 1000} ms`);
  }
  return pcm;
}

function renderScript(file: string): void {
  const script = JSON.parse(fs.readFileSync(file, "utf8")) as Script;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `parley-sample-${script.lang}-`));
  try {
    const chunks: Buffer[] = [];
    const segments: Segment[] = [];
    let cursor = 0; // in samples

    const silence = (ms: number) => {
      const n = msToSamples(ms);
      chunks.push(Buffer.alloc(n * BYTES_PER_SAMPLE));
      cursor += n;
    };

    silence(LEAD_IN_MS);
    script.lines.forEach((line, i) => {
      if (i > 0) silence(script.gapMs);
      const voice = script.voices[line.speaker];
      const pcm = renderLine(line.text, voice, script.rate, tmp, i);
      const samples = pcm.length / BYTES_PER_SAMPLE;
      segments.push({
        speaker: line.speaker,
        startMs: samplesToMs(cursor),
        endMs: samplesToMs(cursor + samples),
        text: line.text,
      });
      chunks.push(pcm);
      cursor += samples;
      process.stdout.write(`  [${script.lang}] line ${i + 1}/${script.lines.length}\r`);
    });
    silence(TAIL_MS);
    const durationMs = samplesToMs(cursor);

    fs.mkdirSync(PUBLIC_OUT, { recursive: true });
    const rawPath = path.join(tmp, "all.pcm");
    fs.writeFileSync(rawPath, Buffer.concat(chunks));
    const oggPath = path.join(PUBLIC_OUT, script.audio);
    run(FFMPEG, [
      "-v", "error", "-y",
      "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", rawPath,
      "-c:a", "libopus", "-b:a", BITRATE, "-ar", String(SAMPLE_RATE), "-ac", "1",
      // Bit-exact: fixed Ogg serial and no encoder-version tag → reproducible bytes.
      "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1",
      oggPath,
    ]);

    const manifest = {
      id: script.id,
      lang: script.lang,
      title: script.title,
      audio: script.audio,
      durationMs,
      meetingKind: script.meetingKind,
      context: script.context,
      speakers: script.speakers,
      segments,
      questions: script.questions,
      mcpQuestions: script.mcpQuestions,
    };
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    const name = `sample.${script.lang}.json`;
    fs.writeFileSync(path.join(PUBLIC_OUT, name), json);
    fs.mkdirSync(SRC_OUT, { recursive: true });
    fs.writeFileSync(path.join(SRC_OUT, name), json);

    const kb = (fs.statSync(oggPath).size / 1024).toFixed(1);
    console.log(
      `[${script.lang}] ${script.audio}: ${(durationMs / 1000).toFixed(2)} s, ${kb} KB, ${segments.length} segments`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const only = process.argv[2];
const scripts = fs
  .readdirSync(HERE)
  .filter((f) => /^script\..+\.json$/.test(f))
  .filter((f) => !only || f === `script.${only}.json`)
  .sort();
if (scripts.length === 0) {
  console.error(only ? `no scripts/sample/script.${only}.json` : "no scripts found");
  process.exit(1);
}
for (const f of scripts) renderScript(path.join(HERE, f));
