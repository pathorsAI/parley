//! Windows CI check for the delay-loaded Vulkan loader (see
//! `src/vulkan_delayload.rs`): build ggml's backend registry — the first point
//! at which ggml calls into `vulkan-1.dll` — and exit cleanly.
//!
//! ```text
//! cargo run --example vulkan_delayload_check --target x86_64-pc-windows-msvc
//! PARLEY_FORCE_NO_VULKAN_LOADER=1 cargo run --example vulkan_delayload_check ...
//! ```
//!
//! The first run takes whatever the machine has (a real loader, or none); the
//! second forces the missing-loader path in a debug build. Either one crashing
//! (a delay-load exception escaping ggml) fails the step. A small binary rather
//! than a lib unit test: the lib's test executable pulls in all of Tauri, and
//! Tauri test executables on Windows are known to fail to start without the
//! common-controls manifest tauri-build only gives the app binary. This one
//! links just whisper.cpp and the hooks.
//!
//! On other platforms this only prints whisper.cpp's system info.

// Links the app library, which holds the delay-load hooks that build.rs's
// `/INCLUDE` arguments name.
extern crate parley_lib;

fn main() {
    let info = whisper_rs::print_system_info();
    println!("whisper.cpp initialized its backends: {info}");
}
