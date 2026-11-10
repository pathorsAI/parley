//! Who is using the microphone, from the capability consent store.
//!
//! Windows records every app's microphone use under
//! `HKCU\…\CapabilityAccessManager\ConsentStore\microphone`: packaged apps as
//! subkeys named by package family, desktop apps under `NonPackaged` as their
//! exe path with `#` for `\`. Each has `LastUsedTimeStart` / `LastUsedTimeStop`
//! (FILETIMEs); a stop of 0 after a start means the app is using the mic now.
//! The same store drives the taskbar's "in use" microphone icon.

use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use super::{decode_nonpackaged_key, exe_display_name, packaged_display_name, Holder};

const CONSENT_STORE: &str =
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

fn in_use(key: &RegKey) -> bool {
    let start = key.get_value::<u64, _>("LastUsedTimeStart").unwrap_or(0);
    let stop = key.get_value::<u64, _>("LastUsedTimeStop").unwrap_or(1);
    start != 0 && stop == 0
}

pub(super) fn mic_holders() -> Vec<Holder> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(root) = hkcu.open_subkey(CONSENT_STORE) else {
        return Vec::new();
    };
    let own = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().to_lowercase());
    let mut holders = Vec::new();
    for name in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&name) else {
            continue;
        };
        if !name.eq_ignore_ascii_case("NonPackaged") {
            if in_use(&key) {
                holders.push(Holder::Process {
                    app_name: Some(packaged_display_name(&name)),
                    id: name,
                });
            }
            continue;
        }
        for encoded in key.enum_keys().flatten() {
            let Ok(app) = key.open_subkey(&encoded) else {
                continue;
            };
            if !in_use(&app) {
                continue;
            }
            let (path, exe) = decode_nonpackaged_key(&encoded);
            if own.as_deref() == Some(path.to_lowercase().as_str()) {
                continue;
            }
            holders.push(Holder::Process {
                app_name: Some(exe_display_name(&exe)),
                id: exe,
            });
        }
    }
    holders
}
