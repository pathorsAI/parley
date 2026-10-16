//! Machine facts the on-device STT provider sizes its models against: physical
//! memory (total and currently available), free disk space on a volume, the
//! physical core count, the GPU, and (Windows) whether a Vulkan loader is
//! installed. See `local_stt::local_stt_hardware`.
//!
//! Hand-rolled on purpose: `sysinfo` would bring a second major version of the
//! `windows` crate (plus `ntapi`/`winapi`) onto Windows, which Cargo.toml asks
//! us not to do. Each probe is a single OS call — `sysctl`/`host_statistics64`/
//! `statfs` on macOS, `GlobalMemoryStatusEx`/`GetDiskFreeSpaceExW`/
//! `GetLogicalProcessorInformationEx`/DXGI/`LoadLibraryExW` on Windows,
//! `/proc/meminfo`/`statvfs` on Linux. Every probe returns `None` instead of
//! guessing when the OS refuses.

use std::path::Path;

/// Installed physical memory, in bytes.
pub fn total_ram_bytes() -> Option<u64> {
    imp::total_ram()
}

/// Memory the OS could hand to a new allocation right now without paging, in
/// bytes. macOS: free + inactive + purgeable + speculative pages (what can be
/// reclaimed without swapping). Windows: `ullAvailPhys`. Linux: `MemAvailable`.
pub fn available_ram_bytes() -> Option<u64> {
    imp::available_ram()
}

/// Physical CPU cores (not SMT threads). Falls back to the logical count when
/// the OS will not say.
pub fn physical_cores() -> u32 {
    imp::physical_cores().filter(|&n| n > 0).unwrap_or_else(|| {
        std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1)
    })
}

/// Free space available to this user on the volume holding `path`. `path`
/// need not exist: the nearest existing ancestor is measured instead.
pub fn free_disk_bytes(path: &Path) -> Option<u64> {
    let existing = path.ancestors().find(|p| p.exists())?;
    imp::free_disk(existing)
}

// --- GPU ------------------------------------------------------------------------

/// One display adapter, as the OS lists it (DXGI on Windows).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GpuAdapter {
    pub name: String,
    /// PCI vendor id (0x10DE NVIDIA, 0x1002 AMD, 0x8086 Intel, 0x1414 Microsoft).
    pub vendor_id: u32,
    /// Memory on the card itself (DXGI `DedicatedVideoMemory`).
    pub dedicated_vram_bytes: u64,
    /// A software rasterizer (DXGI_ADAPTER_FLAG_SOFTWARE, e.g. WARP).
    pub software: bool,
}

/// Microsoft's PCI vendor id: the "Microsoft Basic Render Driver" (WARP) and
/// the basic display adapter a VM or a driverless PC falls back to. Never a
/// GPU whisper.cpp could use.
pub const VENDOR_MICROSOFT: u32 = 0x1414;

/// An adapter with less dedicated memory than this is an integrated GPU that
/// works out of system RAM. Intel iGPUs report 128 MiB, AMD APUs their BIOS
/// carve-out (usually 512 MiB); real discrete cards start at 2 GiB nowadays.
/// An APU whose carve-out is set to several GiB counts as having that much
/// VRAM, which is what it is: memory reserved for the GPU.
pub const SHARED_GPU_BELOW_BYTES: u64 = 1 << 30;

/// The GPU whisper.cpp would decode on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gpu {
    pub name: String,
    /// Dedicated video memory; `None` when the OS does not say (Apple Silicon).
    pub vram_bytes: Option<u64>,
    /// Shares system RAM (an integrated GPU, or Apple's unified memory): its
    /// "VRAM" is the RAM the fit rules already check.
    pub shared: bool,
}

/// The adapter to run on: hardware adapters only (no software rasterizer, no
/// Microsoft basic adapter), the one with the most dedicated memory first —
/// which is also the discrete GPU of a hybrid laptop. Pure.
pub fn best_gpu(adapters: &[GpuAdapter]) -> Option<Gpu> {
    adapters
        .iter()
        .filter(|a| !a.software && a.vendor_id != VENDOR_MICROSOFT)
        .max_by_key(|a| a.dedicated_vram_bytes)
        .map(|a| Gpu {
            name: a.name.trim().to_string(),
            vram_bytes: Some(a.dedicated_vram_bytes),
            shared: a.dedicated_vram_bytes < SHARED_GPU_BELOW_BYTES,
        })
}

/// The display adapters of this machine. Windows only (DXGI); empty elsewhere.
pub fn gpu_adapters() -> Vec<GpuAdapter> {
    imp::gpu_adapters()
}

/// The chip's marketing name ("Apple M2 Pro") on macOS; `None` elsewhere.
pub fn chip_name() -> Option<String> {
    imp::chip_name()
}

/// Whether a Vulkan loader (`vulkan-1.dll`) is installed, and the instance API
/// version it offers (`VK_MAKE_API_VERSION` packing). The loader ships with GPU
/// drivers, not with Windows: a VM, a PC on the basic display adapter or one
/// with very old drivers has none. Windows only; always `Missing` elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VulkanLoader {
    Missing,
    // Only the Windows probe finds one; the decision logic and its tests use
    // it everywhere.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Present {
        api_version: u32,
    },
}

/// `VK_MAKE_API_VERSION(0, major, minor, 0)`.
pub const fn vk_api_version(major: u32, minor: u32) -> u32 {
    (major << 22) | (minor << 12)
}

/// Probe for the Vulkan loader. Loads it from System32 only — where GPU drivers
/// install it, and where the delay-load hook in `vulkan_delayload.rs` loads it
/// from — so a stray copy next to the app can neither fake nor hijack it.
pub fn vulkan_loader() -> VulkanLoader {
    imp::vulkan_loader()
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::{c_void, CStr};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    // `libc` marks its copies of these deprecated in favour of the `mach2`
    // crate; they are plain libSystem symbols, so declare them here instead.
    extern "C" {
        fn mach_host_self() -> libc::mach_port_t;
        static mach_task_self_: libc::mach_port_t;
        fn mach_port_deallocate(task: libc::mach_port_t, name: libc::mach_port_t) -> i32;
    }

    fn sysctl_u64(name: &CStr) -> Option<u64> {
        let mut value: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: `value` is a u64 buffer of `len` bytes; integer sysctls write
        // 4 or 8 bytes (little-endian, so a 4-byte write into a zeroed u64
        // reads back correctly).
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut u64).cast::<c_void>(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        (rc == 0 && (len == 4 || len == 8)).then_some(value)
    }

    pub fn total_ram() -> Option<u64> {
        sysctl_u64(c"hw.memsize")
    }

    pub fn chip_name() -> Option<String> {
        let name = c"machdep.cpu.brand_string";
        let mut len: usize = 0;
        // SAFETY: the first call only asks for the length; the second fills a
        // buffer of exactly that many bytes (a NUL-terminated string).
        unsafe {
            if libc::sysctlbyname(
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut len,
                std::ptr::null_mut(),
                0,
            ) != 0
                || len == 0
            {
                return None;
            }
            let mut buf = vec![0u8; len];
            if libc::sysctlbyname(
                name.as_ptr(),
                buf.as_mut_ptr().cast::<c_void>(),
                &mut len,
                std::ptr::null_mut(),
                0,
            ) != 0
            {
                return None;
            }
            let text = CStr::from_bytes_until_nul(&buf).ok()?.to_str().ok()?.trim();
            (!text.is_empty()).then(|| text.to_string())
        }
    }

    pub fn gpu_adapters() -> Vec<super::GpuAdapter> {
        Vec::new()
    }

    pub fn vulkan_loader() -> super::VulkanLoader {
        super::VulkanLoader::Missing
    }

    pub fn physical_cores() -> Option<u32> {
        sysctl_u64(c"hw.physicalcpu").map(|n| n as u32)
    }

    pub fn available_ram() -> Option<u64> {
        // SAFETY: plain mach calls; `stats` is sized by HOST_VM_INFO64_COUNT
        // exactly as host_statistics64 expects, and the host port right we
        // receive is released again.
        unsafe {
            let host = mach_host_self();
            let mut stats: libc::vm_statistics64 = std::mem::zeroed();
            let mut count = libc::HOST_VM_INFO64_COUNT;
            let rc = libc::host_statistics64(
                host,
                libc::HOST_VM_INFO64,
                (&mut stats as *mut libc::vm_statistics64).cast(),
                &mut count,
            );
            mach_port_deallocate(mach_task_self_, host);
            if rc != libc::KERN_SUCCESS {
                return None;
            }
            let page = libc::sysconf(libc::_SC_PAGESIZE);
            if page <= 0 {
                return None;
            }
            let pages = u64::from(stats.free_count)
                + u64::from(stats.inactive_count)
                + u64::from(stats.purgeable_count)
                + u64::from(stats.speculative_count);
            Some(pages * page as u64)
        }
    }

    pub fn free_disk(path: &Path) -> Option<u64> {
        let mut c = path.as_os_str().as_bytes().to_vec();
        c.push(0);
        // `statfs`, not `statvfs`: Darwin's statvfs has 32-bit block counts.
        // SAFETY: `c` is NUL-terminated; `buf` is a zeroed statfs.
        unsafe {
            let mut buf: libc::statfs = std::mem::zeroed();
            if libc::statfs(c.as_ptr().cast(), &mut buf) != 0 {
                return None;
            }
            Some(buf.f_bavail.saturating_mul(u64::from(buf.f_bsize)))
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::SystemInformation::{
        GetLogicalProcessorInformationEx, GlobalMemoryStatusEx, RelationProcessorCore,
        MEMORYSTATUSEX, SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
    };

    fn memory_status() -> Option<MEMORYSTATUSEX> {
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // SAFETY: `status` is initialised with its own size, as required.
        unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
        Some(status)
    }

    pub fn total_ram() -> Option<u64> {
        memory_status().map(|s| s.ullTotalPhys)
    }

    pub fn available_ram() -> Option<u64> {
        memory_status().map(|s| s.ullAvailPhys)
    }

    pub fn physical_cores() -> Option<u32> {
        let mut len: u32 = 0;
        // SAFETY: the first call only asks for the buffer size (it fails with
        // ERROR_INSUFFICIENT_BUFFER and fills `len`); the second fills a
        // buffer of exactly that size, which is walked by each record's `Size`.
        unsafe {
            let _ = GetLogicalProcessorInformationEx(RelationProcessorCore, None, &mut len);
            if len == 0 {
                return None;
            }
            // u64 storage keeps the records suitably aligned.
            let mut buf = vec![0u64; (len as usize).div_ceil(8)];
            let ptr = buf
                .as_mut_ptr()
                .cast::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>();
            GetLogicalProcessorInformationEx(RelationProcessorCore, Some(ptr), &mut len).ok()?;
            let base = buf.as_ptr().cast::<u8>();
            let mut offset = 0usize;
            let mut cores = 0u32;
            while offset < len as usize {
                let record = &*base
                    .add(offset)
                    .cast::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>();
                if record.Size == 0 {
                    break;
                }
                if record.Relationship == RelationProcessorCore {
                    cores += 1;
                }
                offset += record.Size as usize;
            }
            (cores > 0).then_some(cores)
        }
    }

    pub fn free_disk(path: &Path) -> Option<u64> {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free: u64 = 0;
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None) }.ok()?;
        Some(free)
    }

    pub fn chip_name() -> Option<String> {
        None
    }

    /// Every adapter DXGI lists, in its order. `EnumAdapters1` ends with
    /// DXGI_ERROR_NOT_FOUND; any other failure also just ends the list.
    pub fn gpu_adapters() -> Vec<super::GpuAdapter> {
        use windows::Win32::Graphics::Dxgi::{
            CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
        };
        let mut out = Vec::new();
        // SAFETY: plain COM calls on interfaces windows-rs owns and releases;
        // `Description` is a fixed, NUL-padded UTF-16 array.
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
                return out;
            };
            for index in 0u32.. {
                let Ok(adapter) = factory.EnumAdapters1(index) else {
                    break;
                };
                let Ok(desc) = adapter.GetDesc1() else {
                    continue;
                };
                let len = desc
                    .Description
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(desc.Description.len());
                out.push(super::GpuAdapter {
                    name: String::from_utf16_lossy(&desc.Description[..len]),
                    vendor_id: desc.VendorId,
                    dedicated_vram_bytes: desc.DedicatedVideoMemory as u64,
                    software: desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0,
                });
            }
        }
        out
    }

    pub fn vulkan_loader() -> super::VulkanLoader {
        use std::ffi::{c_char, c_void};
        use windows::core::{s, w};
        use windows::Win32::System::LibraryLoader::{
            GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
        };

        type GetInstanceProcAddr =
            unsafe extern "system" fn(*mut c_void, *const c_char) -> *const c_void;
        type EnumerateInstanceVersion = unsafe extern "system" fn(*mut u32) -> i32;

        // SAFETY: the module stays loaded (never freed: ggml loads the same
        // DLL for decoding, and a load/unload cycle buys nothing). The two
        // entry points are transmuted to their documented Vulkan signatures;
        // VKAPI_CALL is the platform calling convention on x64.
        unsafe {
            let Ok(module) = LoadLibraryExW(w!("vulkan-1.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32)
            else {
                return super::VulkanLoader::Missing;
            };
            let Some(gipa) = GetProcAddress(module, s!("vkGetInstanceProcAddr")) else {
                return super::VulkanLoader::Missing;
            };
            let gipa: GetInstanceProcAddr = std::mem::transmute(gipa);
            let enumerate = gipa(std::ptr::null_mut(), c"vkEnumerateInstanceVersion".as_ptr());
            // A Vulkan 1.0 loader has no vkEnumerateInstanceVersion.
            if enumerate.is_null() {
                return super::VulkanLoader::Present {
                    api_version: super::vk_api_version(1, 0),
                };
            }
            let enumerate: EnumerateInstanceVersion = std::mem::transmute(enumerate);
            let mut version = 0u32;
            if enumerate(&mut version) != 0 {
                return super::VulkanLoader::Missing;
            }
            super::VulkanLoader::Present {
                api_version: version,
            }
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    /// A `/proc/meminfo` field, in bytes (the file reports kB).
    fn meminfo(field: &str) -> Option<u64> {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        text.lines().find_map(|line| {
            let rest = line.strip_prefix(field)?.strip_prefix(':')?;
            let kb: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
            Some(kb * 1024)
        })
    }

    pub fn total_ram() -> Option<u64> {
        meminfo("MemTotal")
    }

    pub fn available_ram() -> Option<u64> {
        meminfo("MemAvailable")
    }

    pub fn physical_cores() -> Option<u32> {
        None
    }

    pub fn chip_name() -> Option<String> {
        None
    }

    pub fn gpu_adapters() -> Vec<super::GpuAdapter> {
        Vec::new()
    }

    pub fn vulkan_loader() -> super::VulkanLoader {
        super::VulkanLoader::Missing
    }

    pub fn free_disk(path: &Path) -> Option<u64> {
        let mut c = path.as_os_str().as_bytes().to_vec();
        c.push(0);
        // SAFETY: `c` is NUL-terminated; `buf` is a zeroed statvfs.
        unsafe {
            let mut buf: libc::statvfs = std::mem::zeroed();
            if libc::statvfs(c.as_ptr().cast(), &mut buf) != 0 {
                return None;
            }
            #[allow(clippy::unnecessary_cast)]
            Some((buf.f_bavail as u64).saturating_mul(buf.f_frsize as u64))
        }
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
mod imp {
    use std::path::Path;
    pub fn total_ram() -> Option<u64> {
        None
    }
    pub fn available_ram() -> Option<u64> {
        None
    }
    pub fn physical_cores() -> Option<u32> {
        None
    }
    pub fn free_disk(_: &Path) -> Option<u64> {
        None
    }
    pub fn chip_name() -> Option<String> {
        None
    }
    pub fn gpu_adapters() -> Vec<super::GpuAdapter> {
        Vec::new()
    }
    pub fn vulkan_loader() -> super::VulkanLoader {
        super::VulkanLoader::Missing
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The probes answer on the machine running the tests, with sane values.
    /// `--nocapture` prints them.
    #[test]
    fn the_probes_answer_on_this_machine() {
        let total = total_ram_bytes().expect("total RAM");
        let available = available_ram_bytes().expect("available RAM");
        let cores = physical_cores();
        let disk = free_disk_bytes(&std::env::temp_dir()).expect("free disk");
        println!(
            "total_ram={total} available_ram={available} physical_cores={cores} free_disk(tmp)={disk}"
        );
        assert!(total > 512 * 1024 * 1024);
        assert!(available > 0 && available <= total);
        assert!(cores >= 1);
        assert!(disk > 0);
    }

    fn adapter(name: &str, vendor_id: u32, vram_mib: u64, software: bool) -> GpuAdapter {
        GpuAdapter {
            name: name.to_string(),
            vendor_id,
            dedicated_vram_bytes: vram_mib << 20,
            software,
        }
    }

    #[test]
    fn the_best_gpu_skips_software_adapters_and_prefers_dedicated_memory() {
        let basic = adapter("Microsoft Basic Render Driver", VENDOR_MICROSOFT, 0, true);
        let igpu = adapter("Intel(R) UHD Graphics 770", 0x8086, 128, false);
        let dgpu = adapter(
            "NVIDIA GeForce RTX 4060 Laptop GPU ",
            0x10DE,
            8 << 10,
            false,
        );
        // A hybrid laptop: the discrete card wins, whatever DXGI's order.
        assert_eq!(
            best_gpu(&[igpu.clone(), basic.clone(), dgpu.clone()]),
            Some(Gpu {
                name: "NVIDIA GeForce RTX 4060 Laptop GPU".into(),
                vram_bytes: Some(8 << 30),
                shared: false,
            })
        );
        // iGPU only: shared memory.
        assert_eq!(
            best_gpu(&[basic.clone(), igpu]),
            Some(Gpu {
                name: "Intel(R) UHD Graphics 770".into(),
                vram_bytes: Some(128 << 20),
                shared: true,
            })
        );
        // A VM: only the basic adapter, which is no GPU at all. Microsoft's
        // vendor id is skipped even when the software flag is not set.
        assert_eq!(best_gpu(&[basic]), None);
        assert_eq!(
            best_gpu(&[adapter(
                "Microsoft Basic Display Adapter",
                VENDOR_MICROSOFT,
                0,
                false
            )]),
            None
        );
        assert_eq!(best_gpu(&[]), None);
        // An APU with a 4 GiB carve-out counts as 4 GiB of VRAM.
        let apu = adapter("AMD Radeon 780M Graphics", 0x1002, 4 << 10, false);
        assert_eq!(best_gpu(&[apu]).map(|g| g.shared), Some(false));
    }

    #[test]
    fn vulkan_versions_pack_like_vk_make_api_version() {
        assert_eq!(vk_api_version(1, 0), 0x0040_0000);
        assert_eq!(vk_api_version(1, 2), 0x0040_2000);
        assert!(vk_api_version(1, 3) > vk_api_version(1, 2));
        // A patch level never reaches the next minor version.
        assert!(vk_api_version(1, 1) + 0xFFF < vk_api_version(1, 2));
    }

    #[test]
    fn the_gpu_probes_answer_on_this_machine() {
        let adapters = gpu_adapters();
        let loader = vulkan_loader();
        println!(
            "adapters={adapters:?} loader={loader:?} chip={:?}",
            chip_name()
        );
        if !cfg!(target_os = "windows") {
            assert!(adapters.is_empty());
            assert_eq!(loader, VulkanLoader::Missing);
        }
        if cfg!(target_os = "macos") {
            assert!(chip_name().is_some());
        }
    }

    #[test]
    fn a_missing_path_measures_its_nearest_existing_ancestor() {
        let missing = std::env::temp_dir()
            .join(format!("parley-hw-{}", uuid::Uuid::new_v4()))
            .join("a")
            .join("b");
        assert!(!missing.exists());
        assert!(free_disk_bytes(&missing).is_some());
    }
}
