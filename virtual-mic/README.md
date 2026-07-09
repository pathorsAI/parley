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

## Install

### For users — installer package (no Terminal)

```bash
./make-pkg.sh        # → build/ParleyMicrophone.pkg
```

Double-clicking the `.pkg` runs the **native macOS Installer** — a graphical
admin-password prompt, one click, done. No `sudo`, no Terminal. This is how
end users (and everyday installs) should do it, the same as Krisp / Loopback /
BlackHole. The bundled `postinstall` reloads `coreaudiod` so **Parley
Microphone** appears immediately.

> A shipped `.pkg` must be **signed** (`INSTALLER_ID=…`) with the driver inside
> it Developer-ID signed + notarized, or Gatekeeper blocks it — see below. The
> unsigned `.pkg` this produces installs fine locally for testing.

### For development — sudo script

⚠️ Iterating-on-the-driver path only. Needs `sudo` and restarts `coreaudiod`:

```bash
./install-dev.sh
```

Ad-hoc signs the bundle, copies it to `/Library/Audio/Plug-Ins/HAL/`, reloads
coreaudiod. Then open **Audio MIDI Setup** (or any app’s mic list) — you should
see **Parley Microphone**.

Uninstall (either path):

```bash
sudo rm -rf "/Library/Audio/Plug-Ins/HAL/ParleyMicrophone.driver" && sudo killall coreaudiod
```

## Using it with Parley

Once installed, **Parley Microphone** shows up as a normal output device, so the
Live Translation window’s **output-device picker lists it automatically** (no app
change needed). Select it there, then in Google Meet pick **Parley Microphone**
as the mic. Speak → Meet hears the translation.

## How it ships (wired up end-to-end)

End users never run any of the scripts above — the whole flow is automated:

1. **CI** (`.github/workflows/release.yml`, step “Build Parley Microphone
   driver + installer pkg”): builds the driver **universal**
   (`ARCHS="arm64;x86_64"`), signs the driver binary with the **Developer ID
   Application** identity (so app notarization accepts the nested code), packs
   it with `make-pkg.sh`, and drops the `.pkg` at
   `src-tauri/virtualmic/ParleyMicrophone.pkg` — which `tauri.conf.json`
   bundles into `Parley.app` as a resource.
2. **In-app one-click install** (`src-tauri/src/virtual_mic.rs` + the install
   card in the Live Translation window): when the device is absent, Parley
   shows “Install virtual microphone”; clicking runs the bundled pkg via
   `/usr/sbin/installer` under `osascript … with administrator privileges` —
   the user sees only macOS’s **native admin/Touch ID dialog**, no Terminal, no
   visible pkg. The pkg’s postinstall reloads coreaudiod; the UI polls until
   “Parley Microphone” appears and auto-selects it as the output device.
   - The `installer` CLI path doesn’t require the pkg *container* to be signed;
     if the optional `APPLE_INSTALLER_SIGNING_IDENTITY` secret is configured,
     CI signs it with `productsign` anyway (needed only for double-click
     installs of a standalone pkg).
3. **Uninstall**: the `uninstall_virtual_mic` command removes the driver (admin
   prompt) and reloads coreaudiod.
4. **Dev builds**: `build.rs` writes a zero-byte placeholder so tauri-build
   doesn’t fail on the missing resource; at runtime the pkg lookup falls back
   to `virtual-mic/build/ParleyMicrophone.pkg` (build it with the scripts
   above), and the install card explains when neither exists.

None of this changes how the app *routes* audio — the device just needs to
exist; the output picker does the rest.
