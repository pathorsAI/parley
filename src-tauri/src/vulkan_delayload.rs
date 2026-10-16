//! Keeps a Windows PC without a Vulkan loader able to start the app and run
//! local transcription on the CPU.
//!
//! The Windows build compiles whisper.cpp with ggml's Vulkan backend
//! (whisper-rs `vulkan`), and whisper-rs-sys links it against `vulkan-1.lib`.
//! `vulkan-1.dll` ships with GPU drivers, not with Windows, so a plain import
//! would stop the app from launching at all on a VM or a PC on the basic
//! display adapter. `build.rs` therefore links with `/DELAYLOAD:vulkan-1.dll`:
//! the DLL is only looked for when ggml first calls into it.
//!
//! That first call is not under our control. ggml builds its backend registry
//! the first time whisper.cpp asks it anything — `whisper_init` logs the
//! device count even for a CPU-only context — and the registry constructor
//! calls `ggml_backend_vk_reg()`, which calls `vkGetInstanceProcAddr`. ggml
//! imports three functions from the loader — that one, plus
//! `vkGetPhysicalDeviceFeatures2` and `vkCmdCopyBuffer`, which it only reaches
//! once it has an instance and a device; everything else goes through its
//! dynamic dispatcher. Without the DLL the delay-load helper would raise a
//! structured exception there, which ggml's `catch (...)` does not catch under
//! MSVC's default `/EHsc`, and the app would crash on the first model load.
//!
//! The two hooks below turn that into a clean "no Vulkan":
//!
//! - the notify hook loads `vulkan-1.dll` from System32 only (where drivers
//!   install it; the same place `hardware::vulkan_loader` probes), and when it
//!   is not there hands the helper this executable's own module instead;
//! - `GetProcAddress` on that module then fails, and the failure hook answers
//!   `vkGetInstanceProcAddr` with [`stub_get_instance_proc_addr`], which only
//!   knows `vkEnumerateInstanceVersion` and reports Vulkan 1.0.
//!
//! ggml then stops at its own "Vulkan 1.2 required" check, throws a C++
//! exception it does catch, and registers no Vulkan backend: whisper.cpp runs
//! on the CPU. `local_stt` never asks for the GPU on such a machine anyway (it
//! probes the loader first); the hooks are what make the CPU path survive.
//!
//! The hook pointers are the documented `__pfnDliNotifyHook2` /
//! `__pfnDliFailureHook2` symbols from `delayimp.h`; `build.rs` forces them in
//! with `/INCLUDE` so the linker resolves them here before it looks at the
//! null defaults in `delayimp.lib`.

use std::ffi::{c_char, c_void, CStr};

/// `delayimp.h` notification codes.
const DLI_NOTE_PRE_LOAD_LIBRARY: u32 = 1;
const DLI_FAIL_LOAD_LIB: u32 = 3;
const DLI_FAIL_GET_PROC: u32 = 4;

const VULKAN_DLL: &str = "vulkan-1.dll";

/// Debug builds only: pretend `vulkan-1.dll` is not installed, so CI can run
/// the missing-loader path on a runner that has one (see
/// `examples/vulkan_delayload_check.rs`). Release builds ignore it.
const FORCE_MISSING_ENV: &str = "PARLEY_FORCE_NO_VULKAN_LOADER";

fn force_missing() -> bool {
    cfg!(debug_assertions) && std::env::var_os(FORCE_MISSING_ENV).is_some()
}

/// `DelayLoadProc` from `delayimp.h`.
#[repr(C)]
pub struct DelayLoadProc {
    import_by_name: i32,
    /// `szProcName` when imported by name, else the ordinal (a union in C).
    name_or_ordinal: *const c_char,
}

/// `DelayLoadInfo` from `delayimp.h`.
#[repr(C)]
pub struct DelayLoadInfo {
    cb: u32,
    pidd: *const c_void,
    ppfn: *mut *const c_void,
    sz_dll: *const c_char,
    dlp: DelayLoadProc,
    hmod_cur: *mut c_void,
    pfn_cur: *const c_void,
    dw_last_error: u32,
}

type DliHook = unsafe extern "system" fn(u32, *const DelayLoadInfo) -> *const c_void;

#[no_mangle]
#[used]
#[allow(non_upper_case_globals)]
pub static __pfnDliNotifyHook2: DliHook = notify_hook;

#[no_mangle]
#[used]
#[allow(non_upper_case_globals)]
pub static __pfnDliFailureHook2: DliHook = failure_hook;

/// Whether the delay-loaded DLL in `info` is the Vulkan loader.
///
/// # Safety
/// `info` must be null or point to a valid `DelayLoadInfo`.
unsafe fn is_vulkan(info: *const DelayLoadInfo) -> bool {
    if info.is_null() || (*info).sz_dll.is_null() {
        return false;
    }
    CStr::from_ptr((*info).sz_dll)
        .to_str()
        .is_ok_and(|dll| dll.eq_ignore_ascii_case(VULKAN_DLL))
}

/// The imported function's name, when it is imported by name.
///
/// # Safety
/// `info` must point to a valid `DelayLoadInfo`.
unsafe fn proc_name<'a>(info: *const DelayLoadInfo) -> Option<&'a CStr> {
    let dlp = &(*info).dlp;
    (dlp.import_by_name != 0 && !dlp.name_or_ordinal.is_null())
        .then(|| CStr::from_ptr(dlp.name_or_ordinal))
}

/// This executable's module: a valid handle that exports no Vulkan symbol.
fn own_module() -> *const c_void {
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    // SAFETY: a null name asks for the process's own module, which cannot fail.
    unsafe { GetModuleHandleW(None) }
        .map(|m| m.0 as *const c_void)
        .unwrap_or(std::ptr::null())
}

unsafe extern "system" fn notify_hook(notify: u32, info: *const DelayLoadInfo) -> *const c_void {
    if notify != DLI_NOTE_PRE_LOAD_LIBRARY || !is_vulkan(info) {
        return std::ptr::null();
    }
    use windows::core::w;
    use windows::Win32::System::LibraryLoader::{LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
    if force_missing() {
        log::info!("local-stt: {FORCE_MISSING_ENV} set; treating the Vulkan loader as missing");
        return own_module();
    }
    match LoadLibraryExW(w!("vulkan-1.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) {
        Ok(module) => module.0 as *const c_void,
        Err(_) => {
            log::info!("local-stt: no Vulkan loader in System32; whisper.cpp stays on the CPU");
            own_module()
        }
    }
}

unsafe extern "system" fn failure_hook(notify: u32, info: *const DelayLoadInfo) -> *const c_void {
    resolve_failure(notify, info)
}

/// The failure hook's decision, separate so a test can drive it.
///
/// # Safety
/// `info` must be null or point to a valid `DelayLoadInfo`.
unsafe fn resolve_failure(notify: u32, info: *const DelayLoadInfo) -> *const c_void {
    if !is_vulkan(info) {
        return std::ptr::null();
    }
    match notify {
        // Only reached if the notify hook was bypassed: same answer.
        DLI_FAIL_LOAD_LIB => own_module(),
        DLI_FAIL_GET_PROC => match proc_name(info) {
            Some(name) if name.to_bytes() == b"vkGetInstanceProcAddr" => {
                stub_get_instance_proc_addr as *const c_void
            }
            // ggml's other two imports are only called with a live instance,
            // which the stub never produces. Refusing keeps the helper's own
            // failure for anything unexpected.
            _ => std::ptr::null(),
        },
        _ => std::ptr::null(),
    }
}

/// `vkGetInstanceProcAddr` for a machine without Vulkan: knows only
/// `vkEnumerateInstanceVersion`, so ggml's instance init reads Vulkan 1.0 and
/// gives up before it calls anything else.
unsafe extern "system" fn stub_get_instance_proc_addr(
    _instance: *mut c_void,
    name: *const c_char,
) -> *const c_void {
    if !name.is_null() && CStr::from_ptr(name).to_bytes() == b"vkEnumerateInstanceVersion" {
        stub_enumerate_instance_version as *const c_void
    } else {
        std::ptr::null()
    }
}

/// `vkEnumerateInstanceVersion`: VK_SUCCESS, Vulkan 1.0.
unsafe extern "system" fn stub_enumerate_instance_version(version: *mut u32) -> i32 {
    if !version.is_null() {
        *version = crate::hardware::vk_api_version(1, 0);
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(dll: &CStr, name: &CStr) -> DelayLoadInfo {
        DelayLoadInfo {
            cb: std::mem::size_of::<DelayLoadInfo>() as u32,
            pidd: std::ptr::null(),
            ppfn: std::ptr::null_mut(),
            sz_dll: dll.as_ptr(),
            dlp: DelayLoadProc {
                import_by_name: 1,
                name_or_ordinal: name.as_ptr(),
            },
            hmod_cur: std::ptr::null_mut(),
            pfn_cur: std::ptr::null(),
            dw_last_error: 126,
        }
    }

    /// The layout `delayimp.h` has on x64: 4 + pad + 5 pointers' worth of
    /// fields + the 16-byte DelayLoadProc + 4 + pad = 72 bytes.
    #[test]
    fn the_structs_match_delayimp_h() {
        assert_eq!(std::mem::size_of::<DelayLoadProc>(), 16);
        assert_eq!(std::mem::size_of::<DelayLoadInfo>(), 72);
        assert_eq!(std::mem::offset_of!(DelayLoadInfo, sz_dll), 24);
        assert_eq!(std::mem::offset_of!(DelayLoadInfo, dlp), 32);
        assert_eq!(std::mem::offset_of!(DelayLoadInfo, hmod_cur), 48);
    }

    #[test]
    fn a_missing_loader_resolves_to_the_vulkan_1_0_stub() {
        let i = info(c"VULKAN-1.dll", c"vkGetInstanceProcAddr");
        // SAFETY: `i` is a valid DelayLoadInfo for the duration of the calls.
        unsafe {
            assert!(!resolve_failure(DLI_FAIL_LOAD_LIB, &i).is_null());
            let gipa = resolve_failure(DLI_FAIL_GET_PROC, &i);
            assert_eq!(gipa, stub_get_instance_proc_addr as *const c_void);
            let enumerate = stub_get_instance_proc_addr(
                std::ptr::null_mut(),
                c"vkEnumerateInstanceVersion".as_ptr(),
            );
            assert!(!enumerate.is_null());
            let enumerate: unsafe extern "system" fn(*mut u32) -> i32 =
                std::mem::transmute(enumerate);
            let mut version = 0;
            assert_eq!(enumerate(&mut version), 0);
            assert_eq!(version, crate::hardware::vk_api_version(1, 0));
            // Nothing else is answered: ggml must stop at the version check.
            assert!(stub_get_instance_proc_addr(
                std::ptr::null_mut(),
                c"vkCreateInstance".as_ptr()
            )
            .is_null());
        }
    }

    #[test]
    fn other_dlls_and_functions_keep_the_default_failure() {
        // SAFETY: as above.
        unsafe {
            let other = info(c"nvcuda.dll", c"vkGetInstanceProcAddr");
            assert!(resolve_failure(DLI_FAIL_GET_PROC, &other).is_null());
            assert!(resolve_failure(DLI_FAIL_LOAD_LIB, &other).is_null());
            let unknown = info(c"vulkan-1.dll", c"vkCreateInstance");
            assert!(resolve_failure(DLI_FAIL_GET_PROC, &unknown).is_null());
            assert!(resolve_failure(DLI_FAIL_GET_PROC, std::ptr::null()).is_null());
        }
    }
}
