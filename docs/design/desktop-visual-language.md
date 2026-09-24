# Desktop visual language

The macOS and Windows app shares one look with the rest of Pathors. The design
tokens use the **names** from the Pathors web app
(`apps/main-app/app/globals.css` in `pathorsAI/pathors`) and the **values** from
the iOS app and the landing site. The layout follows the conventions of the
desktop platform the app is running on.

Before this, the desktop app used shadcn's stock neutral palette: a near-black
primary, Geist, and raw Tailwind hues (sky, amber, emerald, violet, rose, cyan)
for speakers, findings, tabs and badges. It did not look like the iOS app, the
web app or the landing site. It also broke in light mode: the speaker pills used
`text-*-300` colours that only work on a dark page. The three Pathors surfaces
already shared a blue family, since the web app's `--brand` is the iOS dark-mode
primary. The desktop app was the only one not using it.

## The rules

1. **Blue is a signal, not a surface.** `primary` marks what is happening now
   (the selected row, the speaker who is talking, playback progress) and what
   can be clicked (links, the primary call to action). It is never a decorative
   fill behind content. The only filled blue surface is the primary button.
2. **Recording red outranks the blue.** `recording` means one thing: a
   recording is running. It is used for the titlebar's recording pill and its
   dot, and for nothing else. Destructive actions use `destructive`.
3. **Status comes from four soft surfaces, never from raw hues.** `info`,
   `success`, `warning` and `danger` each have a surface, a `-foreground` and a
   `-border`. A status dot uses the `-foreground` value. Raw Tailwind hue
   utilities (`text-amber-500`, `bg-sky-500/15`…) are not used anywhere in
   `src/`.
4. **No card-in-card.** Lists (recent recordings, findings, the library) are
   separated by hairlines or whitespace. Individual items are not boxed.
5. **Speakers are names, in plain text.** A speaker label is
   `text-xs font-semibold text-muted-foreground`, set on its own line above the
   turn it introduces. The speaker who is talking right now is `text-primary`.
   There are no per-speaker hues. The small identity dots in the speaker-naming
   UIs are blue for your own microphone and grey for everyone else.
6. **Section labels are sentence case.** `uppercase tracking-wide` has no
   effect on Chinese, so it only ever widened the letter spacing.

## Palette

All values live in `src/index.css`.

| token | light | dark | notes |
| --- | --- | --- | --- |
| `background` | white | `#0C1620` | dark is the iOS app's navy-black, derived from the landing site's `--v2-navy` |
| `foreground` | ink, `oklch(0.205 0.02 257)` | `oklch(0.94 0.012 250)` | the neutral scale leans cool (hue ≈ 250–257), not pure grey |
| `primary` | `oklch(0.6231 0.188 259.8)` | same | the web app's primary; the same value in both themes, as in main-app |
| `brand` | `#2DB6F3` | same | the Pathors logo colour (landing `--v2-sky`), for brand marks only |
| `recording` | `#E5322D` | `#FF453A` | the same pair as iOS `Theme.recording` |
| `info` / `success` / `warning` / `danger` | main-app's soft surfaces | re-tuned for the navy page | surface + `-foreground` + `-border` |
| `sidebar` | cool off-white | navy | translucent on the macOS main window (see below) |

## Typography

- **DM Sans** is the UI face, as on iOS and the landing site. It is bundled
  through `@fontsource-variable/dm-sans`, not loaded from a CDN.
- **Alexandria** (`font-display`) is used only for large standalone numerals
  and the wordmark. On desktop that means the recording timer in the titlebar.
  Always pair it with `tabular-nums` so a ticking clock does not shift sideways.
- Chinese falls through to PingFang TC on macOS and Microsoft JhengHei on
  Windows. The reasons are in the `--font-sans` comment in `src/index.css`.
- The interface uses the comfortable 14px density (`text-sm`). The live
  transcript is set a step larger, at 15px, because it is read at a glance
  during a call.

## Platform material

| | macOS | Windows |
| --- | --- | --- |
| Main window | undecorated and transparent, with a native `sidebar` vibrancy material (`windowEffects` in `tauri.macos.conf.json`, following the window's active state, 12pt radius) | undecorated and opaque (`tauri.windows.conf.json`) |
| Sidebar | `--sidebar` at 55% opacity, so the vibrancy shows through | solid `--sidebar` |
| Titlebar, content pane | opaque `background` | opaque `background` |

The vibrancy follows the window's `NSAppearance`. `useThemePreference` already
calls `setTheme` on the native window, so the material follows Parley's own
light/dark setting rather than the system's.

The macOS traffic lights and the Windows caption-button hover red keep their
native hex values in `TitleBar.tsx`. They copy the operating system, not the
brand.
