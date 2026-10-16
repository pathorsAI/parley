//! Machine facts the on-device STT provider sizes its models against: physical
//! memory (total and currently available), free disk space on a volume, and the
//! physical core count. See `local_stt::local_stt_hardware`.
//!
//! Hand-rolled on purpose: `sysinfo` would bring a second major version of the
//! `windows` crate (plus `ntapi`/`winapi`) onto Windows, which Cargo.toml asks
//! us not to do. Each probe is a single OS call — `sysctl`/`host_statistics64`/
//! `statfs` on macOS, `GlobalMemoryStatusEx`/`GetDiskFreeSpaceExW`/
//! `GetLogicalProcessorInformationEx` on Windows, `/proc/meminfo`/`statvfs` on
//! Linux. Every probe returns `None` instead of guessing when the OS refuses.

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
