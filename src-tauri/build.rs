fn main() {
    // The Windows build compiles whisper.cpp with ggml's Vulkan backend (see the
    // Windows `whisper-rs` entry in Cargo.toml), and whisper-rs-sys links it
    // against `vulkan-1.lib`. `vulkan-1.dll` comes with GPU drivers, not with
    // Windows, so delay-load it: the app must still start on a PC without one.
    // `src/vulkan_delayload.rs` holds the hooks that make the missing DLL a
    // clean "no Vulkan" instead of a crash on first use; `/INCLUDE` makes the
    // linker take those hook symbols from this crate, not `delayimp.lib`'s
    // null defaults. MSVC only — the only Windows toolchain this app builds
    // with — and x86_64/aarch64, where C symbols carry no `_` prefix.
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if os == "windows" && env == "msvc" && arch != "x86" {
        println!("cargo:rustc-link-arg=/DELAYLOAD:vulkan-1.dll");
        println!("cargo:rustc-link-arg=delayimp.lib");
        println!("cargo:rustc-link-arg=/INCLUDE:__pfnDliNotifyHook2");
        println!("cargo:rustc-link-arg=/INCLUDE:__pfnDliFailureHook2");
    }
    tauri_build::build()
}
