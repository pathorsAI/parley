//! Who is using the microphone, from CoreAudio.
//!
//! macOS 14.2 added an audio "process object" per client process; each says
//! whether it is running input (`kAudioProcessPropertyIsRunningInput`), its
//! PID and its bundle id. These are plain property reads — no TCC prompt, no
//! capture. Before 14.2 the system object has no process list, and the only
//! signal is `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default
//! input device: in use, by someone.

use std::ffi::c_void;
use std::mem::size_of;

use core_foundation::base::TCFType;
use core_foundation::string::{CFString, CFStringRef};
use coreaudio_sys::{
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectHasProperty,
    AudioObjectID, AudioObjectPropertyAddress,
};

use super::{app_name_from_path, Holder, Poll};

const fn fourcc(b: &[u8; 4]) -> u32 {
    ((b[0] as u32) << 24) | ((b[1] as u32) << 16) | ((b[2] as u32) << 8) | (b[3] as u32)
}

// Selectors, defined locally: the process-object ones are newer than some
// SDKs coreaudio-sys is generated against.
const SYSTEM_OBJECT: AudioObjectID = 1;
const SCOPE_GLOBAL: u32 = fourcc(b"glob");
const ELEMENT_MAIN: u32 = 0;
const PROCESS_OBJECT_LIST: u32 = fourcc(b"prs#");
const PROCESS_PID: u32 = fourcc(b"ppid");
const PROCESS_BUNDLE_ID: u32 = fourcc(b"pbid");
const PROCESS_IS_RUNNING_INPUT: u32 = fourcc(b"piri");
const DEFAULT_INPUT_DEVICE: u32 = fourcc(b"dIn ");
const DEVICE_IS_RUNNING_SOMEWHERE: u32 = fourcc(b"gone");

fn address(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: SCOPE_GLOBAL,
        mElement: ELEMENT_MAIN,
    }
}

/// Read a fixed-size property; None when it is missing or the read fails.
unsafe fn read<T: Copy>(object: AudioObjectID, selector: u32) -> Option<T> {
    let addr = address(selector);
    let mut value = std::mem::zeroed::<T>();
    let mut size = size_of::<T>() as u32;
    let status = AudioObjectGetPropertyData(
        object,
        &addr,
        0,
        std::ptr::null(),
        &mut size,
        &mut value as *mut T as *mut c_void,
    );
    (status == 0 && size as usize == size_of::<T>()).then_some(value)
}

/// The audio process objects, or None when this macOS has none (< 14.2).
unsafe fn process_objects() -> Option<Vec<AudioObjectID>> {
    let addr = address(PROCESS_OBJECT_LIST);
    if AudioObjectHasProperty(SYSTEM_OBJECT, &addr) == 0 {
        return None;
    }
    let mut size = 0u32;
    if AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &addr, 0, std::ptr::null(), &mut size) != 0 {
        return None;
    }
    let mut ids = vec![0 as AudioObjectID; size as usize / size_of::<AudioObjectID>()];
    if ids.is_empty() {
        return Some(ids);
    }
    let status = AudioObjectGetPropertyData(
        SYSTEM_OBJECT,
        &addr,
        0,
        std::ptr::null(),
        &mut size,
        ids.as_mut_ptr() as *mut c_void,
    );
    if status != 0 {
        return None;
    }
    ids.truncate(size as usize / size_of::<AudioObjectID>());
    Some(ids)
}

unsafe fn bundle_id(process: AudioObjectID) -> Option<String> {
    let raw: CFStringRef = read(process, PROCESS_BUNDLE_ID)?;
    if raw.is_null() {
        return None;
    }
    // The property hands over a +1 reference.
    let s = CFString::wrap_under_create_rule(raw).to_string();
    (!s.is_empty()).then_some(s)
}

fn executable_path(pid: i32) -> Option<String> {
    // PROC_PIDPATHINFO_MAXSIZE
    let mut buf = vec![0u8; 4 * 1024];
    let len = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
    if len <= 0 {
        return None;
    }
    buf.truncate(len as usize);
    String::from_utf8(buf).ok()
}

pub(super) fn mic_holders() -> Poll {
    unsafe {
        if let Some(objects) = process_objects() {
            let own = std::process::id() as i32;
            let mut holders = Vec::new();
            for object in objects {
                let running: u32 = read(object, PROCESS_IS_RUNNING_INPUT).unwrap_or(0);
                if running == 0 {
                    continue;
                }
                let pid: i32 = read(object, PROCESS_PID).unwrap_or(-1);
                if pid == own {
                    continue;
                }
                let path = if pid > 0 { executable_path(pid) } else { None };
                let id = bundle_id(object)
                    .or_else(|| {
                        path.as_deref()
                            .and_then(|p| p.rsplit('/').next())
                            .map(str::to_string)
                    })
                    .unwrap_or_default();
                holders.push(Holder::Process {
                    id,
                    app_name: path.as_deref().and_then(app_name_from_path),
                });
            }
            return Poll {
                holders,
                exact: true,
            };
        }
        let device: AudioObjectID = read(SYSTEM_OBJECT, DEFAULT_INPUT_DEVICE).unwrap_or(0);
        let running: u32 = if device == 0 {
            0
        } else {
            read(device, DEVICE_IS_RUNNING_SOMEWHERE).unwrap_or(0)
        };
        Poll {
            holders: if running != 0 {
                vec![Holder::Unidentified]
            } else {
                Vec::new()
            },
            exact: false,
        }
    }
}
