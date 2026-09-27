# Sample recording

The onboarding flow can load a short, scripted sales call into the library so a
new user sees transcript, analysis, replay and MCP working before recording
anything. This folder holds the scripts and the pipeline that renders them.

## Files

- `script.zh-TW.json`, `script.en.json` — the source scripts: title, meeting
  context, speaker names, the macOS voice and speaking rate per side, the gap
  between lines, the lines themselves, and the suggested questions shown after
  the sample loads.
- `render.ts` — renders every script into audio + a timed manifest.

Generated (committed, do not edit by hand):

- `public/sample/sample-<lang>.ogg` — the call, Ogg/Opus, 16 kHz mono, 24 kbps.
- `public/sample/sample.<lang>.json` — the rendered manifest: the script's
  metadata plus `durationMs` and `segments[{ speaker, startMs, endMs, text }]`.
- `src/lib/onboarding/sampleManifests/sample.<lang>.json` — an identical copy
  the app imports as a JSON module (Vite does not allow importing from
  `public/`). A test asserts the two copies match.

## Rendering

```sh
bun scripts/sample/render.ts        # all languages
bun scripts/sample/render.ts en     # one language
```

Requires macOS and `ffmpeg`/`ffprobe` (Homebrew's are picked up automatically).
Each line is spoken separately with `say`, decoded to 16 kHz PCM and laid end to
end with the script's `gapMs` of silence, so every segment's timestamps come
straight from the clip lengths — no speech-to-text alignment. The output is
bit-exact across runs with unchanged scripts.

## Changing voices or wording

The voices are macOS system voices (`say -v '?'` lists them). To swap one, edit
`voices` in the script JSON; to change pacing, edit `rate` (words per minute) or
`gapMs`. Then re-render and commit the regenerated files. If you change the
`id`, keep the `sample-` prefix — the app recognises sample entries by it (and
never pushes them to the cloud). Bump the version suffix when the content
changes meaningfully, so users who already loaded the old sample get the new
one as a separate entry rather than a stale match.
