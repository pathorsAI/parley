//! Install / detect the "Parley Microphone" virtual audio device (the HAL
//! loopback driver in `virtual-mic/`), so the live-translation output can reach
//! Google Meet & co. as a selectable microphone.
//!
//! The driver ships as a `.pkg` bundled into Parley.app as a resource (built and
//! signed by CI — see `.github/workflows/release.yml`). Installing means running
//! `/usr/sbin/installer` with admin rights: we go through `osascript`'s
//! `with administrator privileges`, which presents macOS's native password /
//! Touch ID dialog — the user never sees a Terminal or the pkg itself. That CLI
//! path also skips the Gatekeeper double-click check, so the pkg container
//! doesn't need an Installer-identity signature (the driver binary inside is
//! still Developer-ID signed by CI for notarization).
//!
//! Dev builds bundle only a zero-byte placeholder (see build.rs); the pkg lookup
//! then falls back to the locally built `virtual-mic/build/…pkg`.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Where coreaudiod loads HAL plug-ins from.
const HAL_DIR: &str = "/Library/Audio/Plug-Ins/HAL";
/// The driver bundle name (matches virtual-mic/CMakeLists DRIVER_NAME).
const DRIVER_BUNDLE: &str = "ParleyMicrophone.driver";
/// The device name the driver publishes (matches ParleyVirtualMic.cpp).
pub const DEVICE_NAME: &str = "Parley Microphone";

/// A real bundled pkg is hundreds of KB; the dev placeholder is 0 bytes.
const MIN_REAL_PKG_BYTES: u64 = 10_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualMicStatus {
    /// The device is live in CoreAudio (visible to output enumeration) — the
    /// definitive "it works" signal.
    device_visible: bool,
    /// The driver bundle exists on disk (it may still need a coreaudiod reload
    /// to become visible — postinstall does that, so normally these agree).
    driver_installed: bool,
    /// An installer pkg is available (bundled resource or local dev build).
    pkg_available: bool,
    /// The device name to look for / auto-select in the output picker.
    device_name: &'static str,
}

/// Locate a usable installer pkg: the bundled resource (release builds), else
/// the locally built one (dev). `None` when neither exists.
fn find_pkg(app: &AppHandle) -> Option<PathBuf> {
    // Release: bundled resource (CI drops the real pkg into virtualmic/).
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("virtualmic/ParleyMicrophone.pkg");
        if std::fs::metadata(&p).is_ok_and(|m| m.len() >= MIN_REAL_PKG_BYTES) {
            return Some(p);
        }
    }
    // Dev: the pkg built from the repo (virtual-mic/make-pkg.sh).
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../virtual-mic/build/ParleyMicrophone.pkg");
    if std::fs::metadata(&dev).is_ok_and(|m| m.len() >= MIN_REAL_PKG_BYTES) {
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
        pkg_available: find_pkg(&app).is_some(),
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

/// Install the Parley Microphone driver: native admin prompt → `installer -pkg`
/// → the pkg's postinstall reloads coreaudiod → the device appears. Returns once
/// the installer exits; the frontend then re-checks `virtual_mic_status`.
#[tauri::command]
pub async fn install_virtual_mic(app: AppHandle) -> Result<(), String> {
    let pkg = find_pkg(&app).ok_or_else(|| {
        "no installer pkg available (dev build without virtual-mic/build/ParleyMicrophone.pkg)"
            .to_string()
    })?;
    // Resolve symlinks (the dev fallback path crosses the repo) before handing
    // the path to `installer`.
    let pkg = pkg.canonicalize().map_err(|e| e.to_string())?;
    log::info!("virtual-mic: installing from {}", pkg.display());

    // The pkg path travels through argv and AppleScript's `quoted form of`, so
    // spaces (and anything else) in the path are safe — no shell injection.
    let script = "on run argv\n\
                  do shell script \"/usr/sbin/installer -pkg \" & quoted form of item 1 of argv & \" -target /\" \
                  with prompt \"Parley needs to install the Parley Microphone audio driver.\" \
                  with administrator privileges\n\
                  end run"
        .to_string();
    match run_osascript(script, &[&pkg.to_string_lossy()]).await {
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
