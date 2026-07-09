# Parley Microphone — virtual audio driver

A macOS **AudioServerPlugIn** (HAL) virtual audio device named **“Parley
Microphone”**. It is a *loopback* device: audio an app plays **into** it (output
side) becomes available on its **input** side, so other apps (Google Meet, Zoom,
Teams…) can select **Parley Microphone** as their microphone.

This is what lets Parley’s live translation reach a meeting: the translate
pipeline plays the translated speech into this device, and the meeting app hears
it as the user’s mic.

```
Parley (translate) ──play──▶ [Parley Microphone] ──appears as mic──▶ Google Meet
                              (output side)          (input side)
```

Built on **[libASPL](https://github.com/gavv/libASPL)** (MIT), which supplies all
the AudioServerPlugIn property boilerplate. Our code
([`src/ParleyVirtualMic.cpp`](src/ParleyVirtualMic.cpp)) is just the two realtime
I/O callbacks plus one output + one input stream sharing a ring buffer. No
third-party runtime dependency — the driver is entirely Parley’s own.

Format: 48 kHz, stereo, 16-bit. Apps that want another rate resample
transparently.

## Build

Requires Xcode command-line tools + CMake.

```bash
./build.sh                  # → build/ParleyMicrophone.driver (arm64, host arch)
ARCHS="arm64;x86_64" ./build.sh   # universal (required for a shipped build)
```

libASPL is fetched (pinned commit) via CMake `FetchContent`. To build offline
against a local checkout: `LIBASPL_SRC=/path/to/libASPL ./build.sh`.

## Install (local development)

⚠️ Dev path — needs `sudo` and restarts `coreaudiod` (a brief audio glitch for
every app):

```bash
./install-dev.sh
```

It ad-hoc signs the bundle, copies it to `/Library/Audio/Plug-Ins/HAL/`, and
restarts coreaudiod. Then open **Audio MIDI Setup** (or any app’s mic list) and
you should see **Parley Microphone**.

Uninstall:

```bash
sudo rm -rf "/Library/Audio/Plug-Ins/HAL/ParleyMicrophone.driver" && sudo killall coreaudiod
```

## Using it with Parley

Once installed, **Parley Microphone** shows up as a normal output device, so the
Live Translation window’s **output-device picker lists it automatically** (no app
change needed). Select it there, then in Google Meet pick **Parley Microphone**
as the mic. Speak → Meet hears the translation.

## Shipping path (Phase 2 productization — TODO)

The dev install above is not what end users should do. To ship this inside
Parley:

1. **Universal build**: `ARCHS="arm64;x86_64"` so it runs on Intel + Apple
   Silicon (Parley ships `universal-apple-darwin`).
2. **Sign + notarize**: sign the `.driver` with the same **Developer ID
   Application** identity Parley already uses in CI
   (`CODESIGN_ID="Developer ID Application: … (TEAMID)" ./build.sh`), then
   notarize. Ad-hoc signing (dev) will not pass Gatekeeper.
3. **Bundle it** into `Parley.app` as a resource.
4. **First-run install from inside Parley**: ship a signed installer `.pkg`
   (Parley’s CI already has `productsign`) that drops the driver into
   `/Library/Audio/Plug-Ins/HAL/` with an admin prompt, then reloads coreaudiod.
   Detect “is the device present?” to gate the flow and offer repair/uninstall.
5. **Uninstall** on app removal.

None of this needs the Rust/TS app to change how it *routes* audio — the device
just needs to exist; the existing output picker does the rest.
