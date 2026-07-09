fn main() {
    // The virtual-mic installer (virtualmic/ParleyMicrophone.pkg) is a bundled
    // resource produced by CI (see .github/workflows/release.yml), not committed.
    // tauri-build hard-fails on a missing resource path, so materialize an empty
    // placeholder for dev/local builds — the runtime treats a tiny file as "not
    // bundled" and falls back to the locally built pkg (see virtual_mic.rs).
    let pkg = std::path::Path::new("virtualmic/ParleyMicrophone.pkg");
    if !pkg.exists() {
        std::fs::create_dir_all("virtualmic").expect("create virtualmic dir");
        std::fs::write(pkg, []).expect("write placeholder pkg");
    }

    tauri_build::build()
}
