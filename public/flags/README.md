# Circle flags

Self-hosted country flag SVGs used by the language pickers (`src/components/ui/flag.tsx`).

- Source: [HatScripts/circle-flags](https://github.com/HatScripts/circle-flags) (the flag set behind `react-circle-flags`).
- License: MIT.
- Files are named by ISO 3166-1 alpha-2 country code (e.g. `us.svg`, `tw.svg`, `jp.svg`).

Vendored on purpose — no CDN and no runtime library. To add a language, download the
matching flag from the source repo into this folder and set the `flag` field on the
language entry in `src/lib/translateLanguages.ts` or `src/i18n/messages.ts`.
