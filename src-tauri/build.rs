fn main() {
    // The virtual-mic driver (virtualmic/ParleyMicrophone.driver) is a bundled
    // resource produced by CI (see .github/workflows/release.yml), not committed.
    // tauri-build hard-fails on a missing resource path, so materialize an empty
    // placeholder for dev/local builds — the runtime treats a tiny file as "not
    // bundled" and falls back to the locally built pkg (see virtual_mic.rs).
    let driver = std::path::Path::new("virtualmic/ParleyMicrophone.driver");
    if !driver.exists() {
        std::fs::create_dir_all(driver).expect("create placeholder driver dir");
    }

    tauri_build::build()
}
