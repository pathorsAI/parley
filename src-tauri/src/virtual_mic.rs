//! Install / detect the "Parley Microphone" virtual audio device (the HAL
//! loopback driver in `virtual-mic/`), so the live-translation output can reach
//! Google Meet & co. as a selectable microphone.
//!
//! The Developer-ID-signed `.driver` bundle ships inside Parley.app as a
//! resource (built and signed by CI — see `.github/workflows/release.yml`).
//! Installing is an admin copy into `/Library/Audio/Plug-Ins/HAL` via
//! `osascript`'s `with administrator privileges` — macOS's native password /
//! Touch ID dialog, no Terminal. (A `.pkg` container was tried first, but a
//! pkg nested in the app fails notarization without a separate "Developer ID
//! Installer" identity; a signed .driver resource passes.)
//!
//! Dev builds bundle only an empty placeholder dir (see build.rs); the lookup
//! then falls back to the locally built `virtual-mic/build/…driver`.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Where coreaudiod loads HAL plug-ins from.
const HAL_DIR: &str = "/Library/Audio/Plug-Ins/HAL";
/// The driver bundle name (matches virtual-mic/CMakeLists DRIVER_NAME).
const DRIVER_BUNDLE: &str = "ParleyMicrophone.driver";
/// The device name the driver publishes (matches ParleyVirtualMic.cpp).
pub const DEVICE_NAME: &str = "Parley Microphone";

/// A usable driver bundle has its Mach-O at this relative path; the dev
/// placeholder is an empty directory (see build.rs).
const DRIVER_BINARY: &str = "Contents/MacOS/ParleyMicrophone";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualMicStatus {
    /// The device is live in CoreAudio (visible to output enumeration) — the
    /// definitive "it works" signal.
    device_visible: bool,
    /// The driver bundle exists on disk (it may still need a coreaudiod reload
    /// to become visible — postinstall does that, so normally these agree).
    driver_installed: bool,
    /// An installable driver bundle is available (bundled resource or dev build).
    pkg_available: bool,
    /// The device name to look for / auto-select in the output picker.
    device_name: &'static str,
}

/// Locate a usable driver bundle: the bundled resource (release builds — CI
/// drops the signed .driver into virtualmic/), else the locally built one
/// (dev). `None` when neither exists.
fn find_driver(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("virtualmic/ParleyMicrophone.driver");
        if p.join(DRIVER_BINARY).exists() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../virtual-mic/build/ParleyMicrophone.driver");
    if dev.join(DRIVER_BINARY).exists() {
        return Some(dev);
    }
    None
}

#[tauri::command]
pub fn virtual_mic_status(app: AppHandle) -> VirtualMicStatus {
    let device_visible = crate::audio::playback::list_output_devices()
        .iter()
        .any(|d| d == DEVICE_NAME);
    let driver_installed = std::path::Path::new(HAL_DIR).join(DRIVER_BUNDLE).exists();
    VirtualMicStatus {
        device_visible,
        driver_installed,
        pkg_available: find_driver(&app).is_some(),
        device_name: DEVICE_NAME,
    }
}

/// Run an AppleScript that executes a privileged shell command, mapping the
/// dismissed-dialog case (AppleScript error -128) to a stable "cancelled" error
/// the frontend can treat as a non-failure.
async fn run_osascript(script: String, args: &[&str]) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new("/usr/bin/osascript");
    cmd.arg("-e").arg(script);
    for a in args {
        cmd.arg(a);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("osascript failed to start: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("-128") {
        Err("cancelled".into())
    } else {
        Err(err.trim().to_string())
    }
}

/// Install the Parley Microphone driver: native admin prompt → copy the bundled
/// (Developer-ID signed) .driver into the HAL folder → reload coreaudiod → the
/// device appears. A plain admin copy replaces the earlier .pkg route: a pkg
/// nested in the app fails notarization without a separate "Developer ID
/// Installer" identity, while a signed .driver resource passes.
#[tauri::command]
pub async fn install_virtual_mic(app: AppHandle) -> Result<(), String> {
    let driver = find_driver(&app).ok_or_else(|| {
        "no driver bundle available (dev build without virtual-mic/build/ParleyMicrophone.driver)"
            .to_string()
    })?;
    // Resolve symlinks (the dev fallback path crosses the repo) before handing
    // the path to the shell.
    let driver = driver.canonicalize().map_err(|e| e.to_string())?;
    log::info!("virtual-mic: installing from {}", driver.display());

    // The source path travels through argv and AppleScript's `quoted form of`,
    // so spaces (and anything else) in the path are safe — no shell injection.
    // The destination is a compile-time constant.
    let script = format!(
        "on run argv\n\
         do shell script \"mkdir -p '{HAL_DIR}' && rm -rf '{HAL_DIR}/{DRIVER_BUNDLE}' && \
         cp -R \" & quoted form of item 1 of argv & \" '{HAL_DIR}/{DRIVER_BUNDLE}' && \
         chown -R root:wheel '{HAL_DIR}/{DRIVER_BUNDLE}' && (killall coreaudiod || true)\" \
         with prompt \"Parley needs to install the Parley Microphone audio driver.\" \
         with administrator privileges\n\
         end run"
    );
    match run_osascript(script, &[&driver.to_string_lossy()]).await {
        Ok(()) => {
            log::info!("virtual-mic: installed");
            Ok(())
        }
        Err(e) => {
            if e == "cancelled" {
                log::info!("virtual-mic: install cancelled by user");
            } else {
                log::error!("virtual-mic: install failed: {e}");
            }
            Err(e)
        }
    }
}

/// Remove the driver (admin prompt) and reload coreaudiod. The removed path is a
/// compile-time constant — nothing user-controlled reaches the shell.
#[tauri::command]
pub async fn uninstall_virtual_mic() -> Result<(), String> {
    let script = format!(
        "do shell script \"rm -rf '{HAL_DIR}/{DRIVER_BUNDLE}' && (killall coreaudiod || true)\" \
         with prompt \"Parley will remove the Parley Microphone audio driver.\" \
         with administrator privileges"
    );
    match run_osascript(script, &[]).await {
        Ok(()) => {
            log::info!("virtual-mic: uninstalled");
            Ok(())
        }
        Err(e) => {
            if e != "cancelled" {
                log::error!("virtual-mic: uninstall failed: {e}");
            }
            Err(e)
        }
    }
}
