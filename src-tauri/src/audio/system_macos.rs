//! System-audio capture on macOS via the Core Audio process-tap API
//! (`AudioHardwareCreateProcessTap`, macOS 14.2+). We create a global tap of all
//! system output, wrap it in a private aggregate device, and pull the tapped
//! frames through an IOProc — no virtual audio device (BlackHole) and no
//! screen-recording permission required.
//!
//! This is the "them" source (the remote participants' audio). It is behind the
//! [`AudioSource`] trait so a ScreenCaptureKit-based source (broader macOS
//! version support) and a Windows WASAPI loopback source can be added later
//! without touching the rest of the app.
//!
//! NOTE: runtime capture requires the `com.apple.security.device.audio-input`
//! entitlement (see src-tauri/entitlements.plist) and TCC approval. If tap setup
//! fails, this source logs and exits cleanly — the meeting continues mic-only.

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks the modern compiler
// flags; the generated code is correct, so quiet the noise.
#![allow(unexpected_cfgs)]

use std::ffi::{c_void, CStr};
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Result};
use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use coreaudio_sys::{
    AudioBufferList, AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID,
    AudioDeviceStart, AudioDeviceStop, AudioObjectGetPropertyData, AudioObjectID,
    AudioObjectPropertyAddress, AudioStreamBasicDescription, AudioTimeStamp, OSStatus,
};
use objc::runtime::Object;
use objc::{class, msg_send, sel, sel_impl};
use tokio::sync::mpsc::UnboundedSender;

use super::resample::LinearResampler;
use super::{AudioSource, TARGET_SAMPLE_RATE};

// Property selectors / scopes (four-char codes). Defined locally because the tap
// selectors are newer than what coreaudio-sys exposes.
const K_AUDIO_TAP_PROPERTY_FORMAT: u32 = fourcc(b"tfmt");
const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = fourcc(b"glob");
const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;

const fn fourcc(b: &[u8; 4]) -> u32 {
    ((b[0] as u32) << 24) | ((b[1] as u32) << 16) | ((b[2] as u32) << 8) | (b[3] as u32)
}

// Process-tap + aggregate-device functions from the CoreAudio framework, which
// is already linked via coreaudio-sys.
extern "C" {
    fn AudioHardwareCreateProcessTap(
        in_description: *mut Object,
        out_tap_id: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyProcessTap(in_tap_id: AudioObjectID) -> OSStatus;
    fn AudioHardwareCreateAggregateDevice(
        in_description: *const c_void, // CFDictionaryRef
        out_device_id: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyAggregateDevice(in_device_id: AudioObjectID) -> OSStatus;
}

/// System-audio capture ("them").
pub struct SystemAudio;

impl AudioSource for SystemAudio {
    fn start(
        &self,
        tx: UnboundedSender<Vec<i16>>,
        running: Arc<AtomicBool>,
    ) -> Result<JoinHandle<()>> {
        let handle = std::thread::spawn(move || {
            if let Err(e) = run(tx, running) {
                eprintln!("[system] tap capture unavailable, continuing mic-only: {e}");
            }
        });
        Ok(handle)
    }
}

/// State handed to the realtime IOProc. Lives (boxed) for the device's lifetime.
struct TapContext {
    tx: UnboundedSender<Vec<i16>>,
    resampler: LinearResampler,
}

fn run(tx: UnboundedSender<Vec<i16>>, running: Arc<AtomicBool>) -> Result<()> {
    unsafe {
        // 1. Describe a global stereo tap of all system output.
        let empty: *mut Object = msg_send![class!(NSArray), array];
        let desc: *mut Object = msg_send![class!(CATapDescription), alloc];
        if desc.is_null() {
            return Err(anyhow!("CATapDescription unavailable (needs macOS 14.2+)"));
        }
        let desc: *mut Object = msg_send![desc, initStereoGlobalTapButExcludeProcesses: empty];

        // 2. Create the process tap and read its UUID (used as the sub-tap UID).
        let mut tap_id: AudioObjectID = 0;
        let status = AudioHardwareCreateProcessTap(desc, &mut tap_id);
        if status != 0 || tap_id == 0 {
            let _: () = msg_send![desc, release];
            return Err(anyhow!("AudioHardwareCreateProcessTap failed: {status}"));
        }
        let uid = tap_uuid_string(desc);

        // 3. Wrap the tap in a private aggregate device we can run an IOProc on.
        let sub_tap = CFDictionary::from_CFType_pairs(&[
            (CFString::new("uid").as_CFType(), CFString::new(&uid).as_CFType()),
            (CFString::new("drift").as_CFType(), CFBoolean::true_value().as_CFType()),
        ]);
        let tap_list = CFArray::from_CFTypes(&[sub_tap]);
        let agg_desc = CFDictionary::from_CFType_pairs(&[
            (CFString::new("name").as_CFType(), CFString::new("Parley System Tap").as_CFType()),
            (
                CFString::new("uid").as_CFType(),
                CFString::new(&format!("com.pathors.parley.agg.{uid}")).as_CFType(),
            ),
            (CFString::new("private").as_CFType(), CFBoolean::true_value().as_CFType()),
            (CFString::new("stacked").as_CFType(), CFBoolean::false_value().as_CFType()),
            (CFString::new("taps").as_CFType(), tap_list.as_CFType()),
            (CFString::new("tapautostart").as_CFType(), CFBoolean::true_value().as_CFType()),
        ]);

        let mut agg_id: AudioObjectID = 0;
        let status = AudioHardwareCreateAggregateDevice(
            agg_desc.as_concrete_TypeRef() as *const c_void,
            &mut agg_id,
        );
        if status != 0 || agg_id == 0 {
            AudioHardwareDestroyProcessTap(tap_id);
            let _: () = msg_send![desc, release];
            return Err(anyhow!("AudioHardwareCreateAggregateDevice failed: {status}"));
        }

        // 4. Read the tap's audio format to configure the resampler.
        let in_rate = tap_sample_rate(tap_id).unwrap_or(48_000.0);
        eprintln!("[system] tap @ {in_rate} Hz → {TARGET_SAMPLE_RATE} Hz mono");

        // 5. Install + start the IOProc.
        let ctx = Box::new(TapContext {
            tx,
            resampler: LinearResampler::new(in_rate as u32, TARGET_SAMPLE_RATE),
        });
        let ctx_ptr = Box::into_raw(ctx) as *mut c_void;

        let mut proc_id: AudioDeviceIOProcID = None;
        let status = AudioDeviceCreateIOProcID(agg_id, Some(io_proc), ctx_ptr, &mut proc_id);
        if status != 0 || proc_id.is_none() {
            drop(Box::from_raw(ctx_ptr as *mut TapContext));
            AudioHardwareDestroyAggregateDevice(agg_id);
            AudioHardwareDestroyProcessTap(tap_id);
            let _: () = msg_send![desc, release];
            return Err(anyhow!("AudioDeviceCreateIOProcID failed: {status}"));
        }
        AudioDeviceStart(agg_id, proc_id);

        // 6. Hold the device open until the meeting stops, then tear everything down.
        while running.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(100));
        }
        AudioDeviceStop(agg_id, proc_id);
        AudioDeviceDestroyIOProcID(agg_id, proc_id);
        AudioHardwareDestroyAggregateDevice(agg_id);
        AudioHardwareDestroyProcessTap(tap_id);
        drop(Box::from_raw(ctx_ptr as *mut TapContext));
        let _: () = msg_send![desc, release];
    }
    Ok(())
}

/// Realtime callback: downmix the tapped interleaved float frames to mono,
/// resample to 16 kHz, and forward as i16 PCM. Runs on a CoreAudio thread.
unsafe extern "C" fn io_proc(
    _device: AudioObjectID,
    _now: *const AudioTimeStamp,
    in_input: *const AudioBufferList,
    _in_time: *const AudioTimeStamp,
    _out_data: *mut AudioBufferList,
    _out_time: *const AudioTimeStamp,
    client: *mut c_void,
) -> OSStatus {
    if client.is_null() || in_input.is_null() {
        return 0;
    }
    let ctx = &mut *(client as *mut TapContext);
    let list = &*in_input;
    if list.mNumberBuffers == 0 {
        return 0;
    }
    let buf = &list.mBuffers[0];
    let channels = buf.mNumberChannels.max(1) as usize;
    let sample_count = (buf.mDataByteSize as usize) / std::mem::size_of::<f32>();
    if buf.mData.is_null() || sample_count == 0 {
        return 0;
    }
    let samples = std::slice::from_raw_parts(buf.mData as *const f32, sample_count);

    let frames = sample_count / channels;
    let mut mono = Vec::with_capacity(frames);
    for f in 0..frames {
        let mut acc = 0.0f32;
        for c in 0..channels {
            acc += samples[f * channels + c];
        }
        mono.push(acc / channels as f32);
    }
    let mut out = Vec::new();
    ctx.resampler.process(&mono, &mut out);
    if !out.is_empty() {
        let _ = ctx.tx.send(out);
    }
    0
}

/// Read the tap's UUID string via the CATapDescription ObjC object.
unsafe fn tap_uuid_string(desc: *mut Object) -> String {
    let uuid: *mut Object = msg_send![desc, UUID];
    if uuid.is_null() {
        return String::new();
    }
    let uuid_str: *mut Object = msg_send![uuid, UUIDString];
    let cstr: *const c_char = msg_send![uuid_str, UTF8String];
    if cstr.is_null() {
        return String::new();
    }
    CStr::from_ptr(cstr).to_string_lossy().into_owned()
}

/// Query the tapped stream's sample rate.
unsafe fn tap_sample_rate(tap_id: AudioObjectID) -> Option<f64> {
    let mut asbd = std::mem::zeroed::<AudioStreamBasicDescription>();
    let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
    let addr = AudioObjectPropertyAddress {
        mSelector: K_AUDIO_TAP_PROPERTY_FORMAT,
        mScope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        mElement: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let status = AudioObjectGetPropertyData(
        tap_id,
        &addr,
        0,
        std::ptr::null(),
        &mut size,
        &mut asbd as *mut _ as *mut c_void,
    );
    if status == 0 && asbd.mSampleRate > 0.0 {
        Some(asbd.mSampleRate)
    } else {
        None
    }
}
